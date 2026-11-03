import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { randomUUID } from "node:crypto";

const {
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_ENVIRONMENT = "sandbox",
  PAYPAL_WEBHOOK_ID,
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

// Prices live on the server so the browser can't change what gets charged.
const PRODUCTS = {
  "hackathon-tee": { name: "Hackathon T-Shirt", price: "20.00" },
};
const CURRENCY = "USD";

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

// ---------- Routes ----------

async function createOrder({ productId, quantity }) {
  const product = PRODUCTS[productId];
  const qty = Number(quantity);
  if (!product || !Number.isInteger(qty) || qty < 1 || qty > 10) {
    return [400, { error: "Invalid product or quantity" }];
  }

  const total = (Number(product.price) * qty).toFixed(2);
  const { status, data } = await paypalPost("/v2/checkout/orders", {
    intent: "CAPTURE",
    purchase_units: [{
      amount: {
        currency_code: CURRENCY,
        value: total,
        breakdown: { item_total: { currency_code: CURRENCY, value: total } },
      },
      items: [{
        name: product.name,
        quantity: String(qty),
        unit_amount: { currency_code: CURRENCY, value: product.price },
      }],
    }],
  });

  if (status !== 201) return [502, { error: "Could not create PayPal order" }];
  return [200, { id: data.id }];
}

async function captureOrder(orderId) {
  const { status, data } = await paypalPost(`/v2/checkout/orders/${orderId}/capture`);

  if (status === 422 && data.details?.[0]?.issue === "INSTRUMENT_DECLINED") {
    return [422, { error: "INSTRUMENT_DECLINED" }];
  }
  if (status !== 201) return [502, { error: "Could not capture PayPal order" }];

  // Report the capture's status, not the order's: an order can be COMPLETED while its
  // capture is still PENDING (e.g. under review). Webhooks deliver the final outcome.
  const capture = data.purchase_units?.[0]?.payments?.captures?.[0];
  return [200, { status: capture?.status, captureId: capture?.id, amount: capture?.amount }];
}

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

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readBody(req, limit) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw new HttpError(413, "Body too large");
  }
  return raw;
}

async function readJson(req) {
  const raw = await readBody(req, 10_000);
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

async function serveStatic(req, res) {
  const urlPath = new URL(req.url, "http://localhost").pathname;
  const filePath = normalize(join(PUBLIC_DIR, urlPath === "/" ? "index.html" : urlPath));
  if (!filePath.startsWith(PUBLIC_DIR + sep)) return sendJson(res, 404, { error: "Not found" });

  try {
    const file = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
    res.end(file);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, "http://localhost");

    // Requiring JSON blocks cross-site form posts: a browser can't send this
    // Content-Type to another origin without a CORS preflight, which we never approve.
    if (req.method === "POST" && !req.headers["content-type"]?.startsWith("application/json")) {
      return sendJson(res, 415, { error: "Expected application/json" });
    }

    if (req.method === "GET" && pathname === "/api/config") {
      return sendJson(res, 200, {
        clientId: PAYPAL_CLIENT_ID,
        sdkUrl: PAYPAL_SDK_URL,
        currency: CURRENCY,
        products: PRODUCTS,
      });
    }
    if (req.method === "POST" && pathname === "/webhooks/paypal" && PAYPAL_WEBHOOK_ID) {
      return handleWebhook(req, res);
    }
    if (req.method === "POST" && pathname === "/api/orders") {
      return sendJson(res, ...(await createOrder(await readJson(req))));
    }
    const capture = pathname.match(/^\/api\/orders\/([A-Z0-9]+)\/capture$/);
    if (req.method === "POST" && capture) {
      return sendJson(res, ...(await captureOrder(capture[1])));
    }
    if (req.method === "GET") return serveStatic(req, res);

    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: "Server error" });
  }
}).listen(PORT, () => {
  console.log(`Checkout running at http://localhost:${PORT} (PayPal ${PAYPAL_ENVIRONMENT})`);
  if (!PAYPAL_WEBHOOK_ID) console.log("Webhooks disabled: set PAYPAL_WEBHOOK_ID to enable /webhooks/paypal");
});
