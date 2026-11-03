# PayPal AI Hackathon project: AI receipt bill-splitter

## The hackathon
- PayPal AI Hackathon on Devpost ("Build What's Next with PayPal and AI"). Deadline: **Nov 12, 2026, 12:00 pm Pacific**.
- Team entry. The project must meaningfully use **both** PayPal's developer platform and AI.
- The submission needs a working demo, a demo video (under 3 min), a text description, and a public code repo.
- Optional sponsor prizes include "Best Use of APIMatic" (its Context Plugin gives AI coding tools PayPal API context). This is not required.

## The idea
A user photographs a receipt. AI (Gemini) reads it into structured items. The app splits the bill between people, with tax and tip split proportionally, and settles the debts via PayPal.

## Current codebase
- `server.js` is a plain `node:http` server (no Express). It has working PayPal **sandbox** checkout: OAuth token caching, `paypalPost` with retries and `PayPal-Request-Id`, `POST /api/orders`, `POST /api/orders/:id/capture`, `GET /api/config`, and an optional webhook at `/webhooks/paypal`. It's currently a demo T-shirt product, which needs replacing with the bill-split flow.
- `public/` is the frontend (vanilla JS, PayPal web SDK v6, loaded with a URL from `/api/config`).
- `scripts/` holds standalone experiment scripts. Run them from the project root (e.g. `node scripts/receipt.mjs`) so `dotenv` finds `.env`.
- `scripts/test.mjs` is a Gemini "hello" check. **It works**, so the key is valid.
- `test-receipts/` holds receipt photos for testing. It's gitignored (except `.gitkeep`) because receipts can contain personal data and the repo is public.
- `scripts/receipt.mjs` sends images from `test-receipts/` (or a path given as an argument) to Gemini (`@google/genai`, model `gemini-3.5-flash`, JSON output enforced with `responseJsonSchema`) and gets back `{ merchant, items:[{name,quantity,price}], discount, subtotal, tax, tip, total }`. `price` is the line total; `discount` is positive; `tip` is only a tip actually paid (not suggested-tip tables). It checks, in integer cents, that items − discount = subtotal and subtotal + tax + tip = total. **Works on all 3 test receipts** (grocery with weighed items, restaurant with suggested tips only, crumpled restaurant with a discount and handwritten tip).
- `lib/split.js` holds the bill-split logic. `split({ receipt, people, payerId, assignments, currency = "CAD" })` returns `{ payer, shares, currency, breakdown }`, which is the input to PayPal settlement. `shares` lists only non-payers, keyed by name, in integer cents. People and items have fixed IDs (`addItemIds(receipt)` adds item IDs after parsing). Shared items use weights (3:5 means 3/8 and 5/8). Names must be unique, and anything invalid throws a `SplitError` with a `code`. Only CAD is supported. Tests are in `test/split.test.js` and run with `npm test`, which runs `node --test test/`. Keep the `test/` path: a bare `node --test` would also run `scripts/test.mjs` and call Gemini.
- Run the server with `npm start` (uses `node --env-file=.env`). Standalone scripts load `.env` via `import "dotenv/config"`.

## Secrets
- `.env` holds `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `GEMINI_API_KEY` and `PORT`. It's gitignored, and the repo will be public, so never commit keys or print them.
- Call Gemini only from the server, never from browser code.
- The Gemini key is on the **free tier**, so Google may use the data it receives for training. Test only with harmless receipts. Don't use real personal or card data.

## Plan (in order)
1. ✅ Gemini key works (`scripts/test.mjs`).
2. ✅ Receipt photo → JSON (`scripts/receipt.mjs`). Works on the 3 test receipts.
3. ✅ Splitting logic (`lib/split.js`, spec in `.plans/bill-split-logic-spec.md`). Discount, tax and tip are split proportionally, and rounding uses the largest-remainder method so the cents add up exactly.
4. ⏳ PayPal settlement (teammate): reuse the existing order/capture helpers so each person pays their share (sandbox), or look into payment requests/payouts.
5. Wire it into the server and UI: an upload route (`POST /api/receipt`) that calls Gemini, a UI for assigning items to people, and payment.
6. Record a sandbox run, the demo video and the Devpost write-up before the deadline.
