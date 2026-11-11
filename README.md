# Split

Photograph a receipt, let everyone claim what they had from their own phone, and settle up through PayPal.

Built for the PayPal AI Hackathon ("Build What's Next with PayPal and AI").

## How it works

1. **Scan.** The payer takes a photo of the receipt. Gemini reads it into structured line items, with the discount, subtotal, tax, tip and total.
2. **Review.** The payer checks the items and fixes anything Gemini got wrong. The page shows a warning if the items don't add up to the printed subtotal or total. If no tip was paid, the payer picks one (15 / 18 / 20 % or a custom amount).
3. **Claim.** The payer shares one link. Each friend opens it on their own phone, picks their name, and enters what percentage of each item they had. Every phone shows the claims live.
4. **Lock.** When every item is claimed, the payer locks the bill. Each person's share is then frozen. Tax, tip and discounts are split in proportion to what each person ordered, and the cents always add up exactly to the bill total.
5. **Pay.** Each friend pays their share straight to the payer's PayPal account. The bill page shows who has paid.

## Where the AI and PayPal come in

**Gemini** (`gemini-3.5-flash`, through `@google/genai`) turns a receipt photo into JSON that must match a fixed schema. The prompt handles weighed grocery items, discounts, and handwritten tips, and it ignores the "suggested tip" tables that many restaurant receipts print. The server checks the result in integer cents (items − discount = subtotal, subtotal + tax + tip = total), and the payer always reviews it before anyone is charged.

**PayPal** (Orders API v2 and the JavaScript SDK v6, sandbox) handles the settlement:

- Each friend's order sets a **payee override** to the payer's email, so the money goes straight to the payer. The app never holds funds.
- Each order is tied to the bill's lock version. If the payer unlocks the bill and the shares change, a stale order is refused before capture.
- On capture, the server checks the captured amount against the locked share.
- Requests to PayPal reuse a cached OAuth token, retry on transient errors, and send a `PayPal-Request-Id` so a retry can't charge twice.

## Tech stack

- **Server:** Node.js (≥ 22.9) with plain `node:http`, no framework.
- **Frontend:** one page of vanilla JavaScript (ES modules) and CSS. Phones poll the bill every 2.5 seconds and pause while the tab is hidden.
- **Storage:** Upstash Redis over its REST API, or an in-memory store when no Upstash credentials are set. Every bill expires after 7 days, and the receipt photo is deleted as soon as everyone has paid.
- **Hosting:** Render free plan, set up by `render.yaml`.

## Run it locally

You need Node.js 22.9 or newer, a [PayPal sandbox app](https://developer.paypal.com/dashboard/applications/sandbox) and a [Gemini API key](https://aistudio.google.com/apikey).

```sh
git clone https://github.com/zzzeldris/Split.git
cd Split
npm install
cp .env.example .env   # then fill in the values
npm start
```

Open <http://localhost:3000>.

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `PAYPAL_CLIENT_ID` | Yes | Client ID of your PayPal sandbox app |
| `PAYPAL_CLIENT_SECRET` | Yes | Secret of your PayPal sandbox app |
| `PAYPAL_ENVIRONMENT` | No | `sandbox` (default) or `live`. Live needs live credentials |
| `GEMINI_API_KEY` | Yes | Gemini API key |
| `PORT` | No | Port to listen on (default `3000`) |
| `UPSTASH_REDIS_REST_URL` | No | Upstash Redis REST URL. Without it, bills are kept in memory and lost on restart |
| `UPSTASH_REDIS_REST_TOKEN` | No | Upstash Redis REST token |
| `DEMO_PASSCODE` | No | If set, creating a bill needs this passcode. Bill links work without it |
| `PAYPAL_WEBHOOK_ID` | No | Enables the optional webhook at `/webhooks/paypal` |

### Try a payment in the sandbox

1. Create the bill with the email of a **sandbox personal account** as the payer's PayPal email.
2. Open the bill link in a second browser (or a private window) and join as a friend.
3. Claim items from both sides, lock the bill, and pay as the friend. Log in to the PayPal popup with a **different** sandbox personal account.

Sandbox accounts are under **Testing Tools → Sandbox Accounts** in the PayPal developer dashboard.

## Tests

```sh
npm test
```

The tests cover the split math (`lib/split.js`), the percentage-to-weight conversion (`lib/shares.js`) and the full bill lifecycle (`lib/bills.js`). They use fakes for Redis, Gemini and PayPal, so they need no credentials or network.

Use `npm test` rather than a bare `node --test`, which would also run `scripts/test.mjs` and call Gemini.

### Helper scripts

Run these from the project root so they find `.env`:

- `node scripts/test.mjs`: checks that the Gemini key works.
- `node scripts/receipt.mjs [image]`: reads the images in `test-receipts/` (or the given image) with Gemini and prints the JSON and the sum checks.
- `node scripts/check-store.mjs`: checks that the Upstash credentials work.

## Project layout

```
server.js         HTTP server, PayPal helpers, routes, webhook
lib/bills.js      Bill lifecycle: draft → open → locked → settled
lib/split.js      Split math: proportional tax, tip and discount, largest-remainder rounding
lib/shares.js     Turns percentage claims into split weights (shared with the browser)
lib/receipt.js    Gemini prompt, JSON schema and retries
lib/store.js      Upstash Redis REST client with an in-memory fallback
public/           Frontend (index.html, app.js, style.css)
scripts/          Standalone helper scripts
test/             Unit tests (node:test)
.plans/           Design specs
```

## Privacy

- Gemini is only called from the server. The API key never reaches the browser.
- The demo uses Gemini's free tier, where Google may use the data it receives to improve its models. Only try it with harmless receipts, and never with card numbers or other personal data.
- Payments run in the PayPal sandbox. No real money moves.

## Limitations

- Only CAD is supported.
- There are no accounts. Each person's identity is a token in their browser's local storage, and the payer's admin rights come from a secret token in their link.
- To change a receipt after the bill is open for claiming, start a new bill.

## License

[MIT](LICENSE)
