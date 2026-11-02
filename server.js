import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { randomUUID } from "node:crypto";

const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PORT = 3000 } = process.env;
const PAYPAL_API = "https://api-m.sandbox.paypal.com";
const PUBLIC_DIR = join(import.meta.dirname, "public");

if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
  console.error("Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET. Fill them in in .env.");
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

  const capture = data.purchase_units?.[0]?.payments?.captures?.[0];
  return [200, { status: data.status, captureId: capture?.id, amount: capture?.amount }];
}

// ---------- HTTP server ----------

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new Error("Body too large");
  }
  return raw ? JSON.parse(raw) : {};
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

    if (req.method === "GET" && pathname === "/api/config") {
      return sendJson(res, 200, { clientId: PAYPAL_CLIENT_ID, currency: CURRENCY, products: PRODUCTS });
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
    console.error(err);
    sendJson(res, 500, { error: "Server error" });
  }
}).listen(PORT, () => {
  console.log(`Checkout running at http://localhost:${PORT}`);
});
