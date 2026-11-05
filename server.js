import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { createStore } from "./lib/store.js";
import { createBills } from "./lib/bills.js";
import { readReceiptImage } from "./lib/receipt.js";

const {
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_ENVIRONMENT = "sandbox",
  PAYPAL_WEBHOOK_ID,
  DEMO_PASSCODE,
  PORT = 3000,
} = process.env;

// One switch moves both the REST API and the browser SDK, so sandbox and live never mix.
const IS_LIVE = PAYPAL_ENVIRONMENT === "live";
const PAYPAL_API = IS_LIVE ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
const PAYPAL_SDK_URL = IS_LIVE
  ? "https://www.paypal.com/web-sdk/v6/core"
  : "https://www.sandbox.paypal.com/web-sdk/v6/core";
const PUBLIC_DIR = join(import.meta.dirname, "public");

if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
  console.error("Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET. Fill them in in .env.");
  process.exit(1);
}
if (!["sandbox", "live"].includes(PAYPAL_ENVIRONMENT)) {
  console.error(`PAYPAL_ENVIRONMENT must be "sandbox" or "live", got "${PAYPAL_ENVIRONMENT}".`);
  process.exit(1);
}

const CURRENCY = "CAD";

// ---------- PayPal REST helpers ----------

let cachedToken = null; // { value, expiresAt }

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;

  const credentials = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`PayPal auth failed (${res.status}): ${data.error_description ?? data.error}`);
  }

  // Refresh a minute early so a token never expires mid-request.
  cachedToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return cachedToken.value;
}

// POSTs to PayPal, retrying 429s and 5xx with backoff. The same PayPal-Request-Id
// is reused on retries so PayPal never processes the request twice.
async function paypalPost(path, body) {
  const requestId = randomUUID();

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${PAYPAL_API}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await getAccessToken()}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": requestId,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));

    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < 3) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    if (!res.ok) {
      // debug_id is what PayPal support asks for when you report a problem.
      console.error(`PayPal ${path} failed: ${res.status} ${data.name ?? ""} debug_id=${data.debug_id ?? "n/a"}`);
    }
    return { status: res.status, data };
  }
}

// ---------- Bills ----------
// Bills, claims and payments live in Redis (lib/store.js) so they survive a sleeping free host.
// Amounts are computed on the server, so a friend's browser can't change what gets charged.

const store = createStore();
const bills = createBills({ store, readReceiptImage, paypalPost, demoPasscode: DEMO_PASSCODE, currency: CURRENCY });

// ---------- Webhooks ----------

const seenEventIds = new Set(); // in-memory; use a database once you have one

async function verifyWebhook(headers, rawBody) {
  // The event is spliced in as raw text: re-serialising parsed JSON can change
  // its bytes and make PayPal's signature check fail.
  const fields = {
    auth_algo: headers["paypal-auth-algo"],
    cert_url: headers["paypal-cert-url"],
    transmission_id: headers["paypal-transmission-id"],
    transmission_sig: headers["paypal-transmission-sig"],
    transmission_time: headers["paypal-transmission-time"],
    webhook_id: PAYPAL_WEBHOOK_ID,
  };
  const body = `${JSON.stringify(fields).slice(0, -1)},"webhook_event":${rawBody}}`;

  const res = await fetch(`${PAYPAL_API}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await getAccessToken()}`, "Content-Type": "application/json" },
    body,
  });
  const data = await res.json().catch(() => ({}));
  return res.ok && data.verification_status === "SUCCESS";
}

function handleWebhookEvent(event) {
  const resource = event.resource ?? {};
  switch (event.event_type) {
    case "PAYMENT.CAPTURE.COMPLETED":
      console.log(`Capture ${resource.id} completed: ${resource.amount?.value} ${resource.amount?.currency_code}`);
      break;
    case "PAYMENT.CAPTURE.PENDING":
      console.log(`Capture ${resource.id} pending: ${resource.status_details?.reason ?? "unknown reason"}`);
      break;
    case "PAYMENT.CAPTURE.DENIED":
      console.log(`Capture ${resource.id} denied — do not fulfil this order`);
      break;
    default:
      console.log(`Ignoring webhook event ${event.event_type}`);
  }
}

async function handleWebhook(req, res) {
  const raw = await readBody(req, 100_000);

  // Answer 200 even when verification fails so PayPal doesn't keep retrying; just ignore it.
  if (!(await verifyWebhook(req.headers, raw))) {
    console.warn("Ignoring webhook with an invalid signature");
    return sendJson(res, 200, { ok: true });
  }

  const event = JSON.parse(raw);
  sendJson(res, 200, { ok: true }); // acknowledge before processing
  if (seenEventIds.has(event.id)) return; // PayPal may deliver the same event more than once
  seenEventIds.add(event.id);
  handleWebhookEvent(event);
}

// ---------- HTTP server ----------

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};
const LIB_DIR = join(import.meta.dirname, "lib");
// lib/ files the browser imports (the same split math the server uses). Nothing else in lib/ is served.
const BROWSER_LIB = new Set(["/lib/split.js", "/lib/shares.js"]);

function sendJson(res, status, body) {
  if (status === 304) {
    res.writeHead(304);
    return res.end();
  }
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "Body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req, limit = 10_000) {
  const raw = await readBody(req, limit);
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

const bearer = (req) => req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1] ?? null;

async function serveStatic(req, res) {
  const urlPath = new URL(req.url, "http://localhost").pathname;
  const filePath = BROWSER_LIB.has(urlPath)
    ? join(LIB_DIR, urlPath.slice("/lib/".length))
    : normalize(join(PUBLIC_DIR, urlPath === "/" ? "index.html" : urlPath));
  if (!BROWSER_LIB.has(urlPath) && !filePath.startsWith(PUBLIC_DIR + sep)) return sendJson(res, 404, { error: "Not found" });

  try {
    const file = await readFile(filePath);
    // no-cache = "check with the server first". Phones then pick up a new deploy at once,
    // and the service worker (sw.js) can never get stuck on an old copy of itself.
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(file);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

// [method, path pattern, handler(req, params, query)]. Handlers return [status, body].
const ID = "([0-9a-f-]{36})";
const PERSON = "([0-9a-f]{8})";
const routes = [
  ["GET", /^\/api\/config$/, () => [200, { clientId: PAYPAL_CLIENT_ID, sdkUrl: PAYPAL_SDK_URL, currency: CURRENCY, passcodeRequired: Boolean(DEMO_PASSCODE) }]],
  ["POST", /^\/api\/bills$/, async (req) => bills.create(await readJson(req, 1_500_000))],
  ["GET", new RegExp(`^\/api\/bills\/${ID}$`), (req, [id], q) => bills.view(id, bearer(req), q.get("since"))],
  ["PUT", new RegExp(`^\/api\/bills\/${ID}\/receipt$`), async (req, [id]) => bills.updateReceipt(id, bearer(req), await readJson(req, 50_000))],
  ["POST", new RegExp(`^\/api\/bills\/${ID}\/open$`), (req, [id]) => bills.open(id, bearer(req))],
  ["POST", new RegExp(`^\/api\/bills\/${ID}\/lock$`), (req, [id]) => bills.lock(id, bearer(req))],
  ["POST", new RegExp(`^\/api\/bills\/${ID}\/unlock$`), (req, [id]) => bills.unlock(id, bearer(req))],
  ["POST", new RegExp(`^\/api\/bills\/${ID}\/people$`), async (req, [id]) => bills.join(id, await readJson(req))],
  ["PUT", new RegExp(`^\/api\/bills\/${ID}\/people\/${PERSON}\/claims$`), async (req, [id, pid]) => bills.setClaims(id, pid, bearer(req), await readJson(req))],
  ["POST", new RegExp(`^\/api\/bills\/${ID}\/people\/${PERSON}\/reset$`), (req, [id, pid]) => bills.resetPerson(id, bearer(req), pid)],
  ["POST", /^\/api\/orders$/, async (req) => bills.createOrder(await readJson(req))],
  ["POST", /^\/api\/orders\/([A-Z0-9]+)\/capture$/, (req, [orderId]) => bills.captureOrder(orderId)],
];

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const { pathname } = url;

    // Requiring JSON blocks cross-site form posts: a browser can't send this
    // Content-Type to another origin without a CORS preflight, which we never approve.
    if ((req.method === "POST" || req.method === "PUT") && !req.headers["content-type"]?.startsWith("application/json")) {
      return sendJson(res, 415, { error: "Expected application/json" });
    }

    if (req.method === "POST" && pathname === "/webhooks/paypal" && PAYPAL_WEBHOOK_ID) {
      return handleWebhook(req, res);
    }

    const photo = pathname.match(new RegExp(`^\/api\/bills\/${ID}\/photo$`));
    if (req.method === "GET" && photo) {
      const image = await bills.photo(photo[1]);
      if (!image) return sendJson(res, 404, { error: "No photo for this bill" });
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600" });
      return res.end(image);
    }

    for (const [method, pattern, handler] of routes) {
      const match = req.method === method && pathname.match(pattern);
      if (match) return sendJson(res, ...(await handler(req, match.slice(1), url.searchParams)));
    }
    if (req.method === "GET") return serveStatic(req, res);

    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: "Server error" });
  }
}).listen(PORT, () => {
  console.log(`Bill splitter running at http://localhost:${PORT} (PayPal ${PAYPAL_ENVIRONMENT}, ${store.kind} store)`);
  if (store.kind === "memory") console.log("No UPSTASH_REDIS_REST_URL/TOKEN: bills are kept in memory and vanish on restart");
  if (!DEMO_PASSCODE) console.log("No DEMO_PASSCODE: anyone can create bills (fine locally, set it when deployed)");
  if (!PAYPAL_WEBHOOK_ID) console.log("Webhooks disabled: set PAYPAL_WEBHOOK_ID to enable /webhooks/paypal");
});
