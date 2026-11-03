# Spec: Receipt upload, live item claiming and settlement

Status: agreed in interview, 2026-11-03. Deadline: Nov 12, 2026, 12:00 pm Pacific.

## 1. Summary

The payer photographs a receipt. Gemini reads it into items. The payer checks and corrects the items, then shares one bill link. Each friend opens the link on their own phone, picks their name, and enters what percentage of each item they had. Every phone shows the claims live. When every item is claimed, the payer locks the bill. The server then freezes each person's share, and each friend pays the payer through PayPal (sandbox). The bill page shows who has paid.

This builds on the `paypal-settlement` branch. That branch already has server-side bills, PayPal orders with a payee override to the payer's email, and capture with an amount check. This spec replaces the hand-entered `shares` with shares computed from receipt claims, and moves bills from memory into Upstash Redis.

## 2. Decisions

| Topic | Decision |
|---|---|
| Who enters claims | Each friend, on their own phone, through one shared bill link |
| Claim input | A percentage for each item. Quick chips 0 / 25 / 50 / 100, plus a custom number field |
| Claims that don't sum to 100% | Normalize by the sum. 50% + 10% → 5:1 (83.3% / 16.7%). 100% + 100% → 50/50 |
| Unclaimed item (sum is 0) | Blocks locking. The item is highlighted |
| Payer's share | The payer claims items like everyone else. Their share shows as "already paid" and they get no pay button |
| Freezing shares | The payer taps **Lock**. The payer can **Unlock** until the first payment starts |
| Edit rights | Each person edits only their own claims. The payer can't edit other people's claims |
| Lost device | The payer can reset a name. The claims stay, and the next device to pick the name gets it |
| Identity | Pick an existing name or add a new one. A per-person token is kept in localStorage. No login |
| Payer authority | A secret admin token in the payer's link, kept in the URL fragment (`#admin=…`) |
| Payer's PayPal email | Typed when the bill is created (a sandbox personal account for the demo) |
| Wrong AI result | The payer always reviews an editable item table. If the totals don't match, the UI shows the difference |
| Tip | Use the printed tip if there is one, otherwise a 15 / 18 / 20 % / custom picker. The payer can always override it |
| Tax, discount, tip | Split in proportion to each person's item total. There are no per-item taxable flags |
| Currency | Always CAD (`CURRENCY` in `server.js`) |
| Rounding | Integer cents with the largest-remainder method. The shares sum exactly to the bill total |
| Live updates | Each phone polls every 2.5 s, and pauses while its tab is hidden |
| Payment status | Set on capture (unpaid / pending / paid). Polling shows it on every phone. No webhook is needed |
| Hosting | A free-plan host (e.g. Render) with a public HTTPS URL |
| Storage | Upstash Redis through its REST API, using plain `fetch` with no new npm package |
| Expiry | Every key for a bill has a 7-day TTL. The photo is deleted as soon as everyone has paid |
| Receipt photo | Resized in the browser (about 1600 px on the long side, JPEG). Stored until everyone has paid. Friends can view it |
| Abuse protection | Creating a bill (the Gemini call) needs a demo passcode. Bill links work without it |
| Video focus | Several phones claiming live, then paying |

## 3. User flows

### 3.1 The payer creates a bill
1. The payer opens `/` and enters the demo passcode, their name, their PayPal email, and a receipt photo (camera or file).
2. The browser resizes the photo to about 1600 px on the long side as JPEG (quality about 0.85, target under 500 KB). It sends the photo as base64 in JSON to `POST /api/bills`.
3. The server checks the passcode, calls Gemini, and saves a **draft** bill. It returns `{ billId, adminToken }`.
4. The browser saves the admin token in localStorage under the bill id and goes to `/?b=<billId>#admin=<token>`.

### 3.2 The payer reviews the receipt (draft)
- The page shows an editable table: name, quantity and price (the line total) for each item, plus discount, tax and tip. The payer can add and delete rows.
- **Check line:** the page shows items − discount = subtotal and the printed subtotal. If they differ, it shows a warning with the difference, for example "Items add up to $41.20, receipt subtotal is $42.70 (−$1.50)". It does the same for the total.
- **The bill total is always computed:** `total = Σ items − discount + tax + tip`. The printed total is shown only for comparison. This keeps the math consistent even when the scan isn't.
- **Tip:** if Gemini found a tip, it's pre-filled. If not, the payer sees 15 / 18 / 20 % / custom. The percentage applies to the subtotal after discount and before tax. The payer can also type an amount.
- The payer taps **Open for claiming**. The receipt can't be edited after this. (To fix the receipt, start a new bill. See §11.)
- The payer then sees the share link (copy button, Web Share API where available, and a QR code) and claims their own items on the same page.

### 3.3 A friend claims items (open)
1. The friend opens `/?b=<billId>`. If localStorage has no person token for this bill, the page asks "Who are you?": a list of unclaimed names, plus "Add me".
2. Picking or adding a name calls `POST /api/bills/:id/people`. The server returns a person token, which the page stores in localStorage.
3. Each item row shows:
   - name, quantity and price
   - chips 0 / 25 / 50 / 100 and a custom % field. The default is blank, which counts as 0
   - the claim status: "Unclaimed" (highlighted), or the claimers with their normalized shares, e.g. "You 83% · Ben 17%"
   - a small note when the claims don't sum to 100%, e.g. "claimed 160% → split 5:3"
4. A sticky footer shows **"You owe ≈ $X"**. The page computes it from the current claims with the same split function the server uses.
5. Each change is saved with a short debounce (about 400 ms) through `PUT /api/bills/:id/people/:name/claims`. It sends that person's whole claim map.
6. A "View receipt" button shows the stored photo.

### 3.4 Locking (payer)
- The **Lock** button is disabled while any item is unclaimed. Its tooltip names the unclaimed items.
- When the payer locks, the server reads all claims, computes the shares, and saves them as a frozen snapshot with a new `lockVersion`. Every phone switches to the locked view on its next poll.
- Before the first payment starts, the payer can **Unlock**. This returns the bill to open, deletes the snapshot, and lets claims change again.

### 3.5 Paying (locked)
- Each friend sees "You owe <payer> $X.XX" and the PayPal button, using the existing SDK v6 code in `public/app.js`.
- The payer sees everyone's status: unpaid / pending / paid, plus "already paid" for themselves.
- When every non-payer share is paid, the bill becomes **settled** and the server deletes the photo.

## 4. The split algorithm (`lib/split.js`, plain code, no AI)

Inputs: items `{ id, priceCents }`, people in join order, claims `claims[person][itemId] = pct` (a number from 0 to 100), and `totalCents`.

The method uses two rounding stages. All arithmetic uses integers, so the sums are exact.

1. **Split each item.** For each item, `W = Σ pct` over all people.
   - If `priceCents === 0`, skip the item. It needs no claim.
   - If `W === 0`, the item is **unclaimed**. Locking is not allowed (the function returns the list of unclaimed items).
   - Otherwise, split `priceCents` among the claimers in proportion to `pct / W`, using the largest remainder. The result is whole cents per person that sum exactly to `priceCents`.
2. **Item totals.** Each person's `itemCents` is the sum of their cents from step 1. Let `S = Σ itemCents`, which equals the sum of item prices.
3. **Spread the bill total.** Split `totalCents` (after discount, plus tax and tip) in proportion to `itemCents / S`, using the largest remainder again. Discount, tax and tip are all included through `totalCents`, so they are spread proportionally in one step.
4. **Output.** `{ shares: { person: cents }, unclaimed: [itemId] }`. The sum of `shares` equals `totalCents` exactly.

**Largest remainder** (allocate N cents by integer weights w): give each person `floor(N·w_j / Σw)`. Then hand out the remaining cents, one each, in order of largest remainder `(N·w_j) mod Σw`. Break ties by join order. Use `BigInt` (or check that the values stay safe) because `N·w` can be large.

**Edge cases:**
- `S === 0` (every item is free): locking is not allowed.
- Negative item prices: reject them in review. The discount is a separate positive field.
- A person with no claims gets a 0 share. They get no pay button and are left out of the "all paid" check.
- Percentages: integers from 0 to 100 only. The server rejects anything else.

**Tests (`node --test`, `test/split.test.js`):**
- The 50% / 10% example gives 5:1.
- 100% + 100% gives 50/50.
- A single claimer pays the whole item.
- A worked example with discount, tax and tip whose result is checked by hand.
- 1 cent split three ways gives `[1, 0, 0]` with a deterministic tie-break.
- A randomized property test: the shares always sum to `totalCents`, and each share is within 2 cents of its exact value.
- Unclaimed items are reported.

The browser loads the same module for the "You owe ≈" preview. Keep it free of Node-only imports, and serve it as `/lib/split.js`, or copy it into `public/`.

## 5. Data model (Upstash Redis)

Every key gets `EXPIRE 604800` (7 days) when the bill is created. Keys created later get the remaining TTL of the bill key, using `PEXPIRETIME` / `PTTL`.

| Key | Type | Contents |
|---|---|---|
| `bill:{id}` | hash | `meta` (JSON: payer `{name, email}`, `adminTokenHash`, `createdAt`), `receipt` (JSON: merchant, items `[{id, name, quantity, priceCents}]`, discount, tax, tip and printed totals in cents, `totalCents`), `status` (`draft` \| `open` \| `locked` \| `settled`), `lockVersion` (integer), `snapshot` (JSON of the frozen shares, present only while locked), `version` (integer, increased on every change, used to tell whether a poll returned anything new) |
| `bill:{id}:people` | hash | `name → JSON { tokenHash, joinedAt, order }`. A name is claimed with `HSETNX`, so two phones can't take the same name |
| `bill:{id}:claims` | hash | `name → JSON { itemId: pct }`. **There is one field per person.** One person's save can't overwrite another person's save (this prevents lost updates) |
| `bill:{id}:pay` | hash | `name → JSON { status: unpaid\|pending\|paid, orderId, captureId, lockVersion }` |
| `bill:{id}:photo` | string | base64 JPEG. Deleted when the bill is settled |
| `order:{paypalOrderId}` | string | JSON `{ billId, person, lockVersion, cents }`. Replaces the in-memory `orderIndex` |

**Rules:**
- **Lock:** the server reads `claims` and `people`, computes the shares, and writes `snapshot`, increments `lockVersion`, sets `status=locked` and increments `version`. It does all of this in one Upstash transaction (`/multi-exec`). A claim saved during the lock may be left out of the snapshot. That's acceptable, because the claim stays stored, and the payer can unlock and lock again.
- **Claims while locked:** the server rejects them with `409`, so the UI never shows edits that won't count.
- **Unlock:** allowed only if no `pay` entry has an `orderId`. So once any order has been created, unlocking is refused.
- **Capture check:** `order:{id}.lockVersion` must equal the bill's current `lockVersion`, and `cents` must equal the snapshot share. Otherwise the server refuses to capture.
- **Tokens:** 32 random bytes, base64url-encoded. Redis stores only the SHA-256 hash. The server compares hashes with `crypto.timingSafeEqual`.

`lib/redis.js` is a small wrapper: `redis(cmd, ...args)` → `POST UPSTASH_REDIS_REST_URL` with a JSON array body and a Bearer token, plus `multi([...cmds])`. It retries once on a network error.

## 6. HTTP API (in `server.js`, no Express)

| Method and path | Auth | Purpose |
|---|---|---|
| `POST /api/bills` | `passcode` in the body | Body: `{ passcode, payer: {name, email}, image: {mimeType, data} }`. Calls Gemini and creates a draft bill. Returns `{ billId, adminToken }`. Body limit 1 MB |
| `GET /api/bills/:id` | none (an admin token, if sent, adds admin fields) | Public view: payer name (never the email), receipt, status, people (names only), every person's claims, pay statuses, snapshot if locked, `version`. With `?since=<version>` it returns `304` when nothing changed |
| `GET /api/bills/:id/photo` | none | Returns the JPEG. `404` after the bill is settled |
| `PUT /api/bills/:id/receipt` | admin | Replaces the receipt while the bill is a draft. The server checks the items and recomputes `totalCents` |
| `POST /api/bills/:id/open` | admin | draft → open |
| `POST /api/bills/:id/people` | none | `{ name }` → `{ personToken }`. `409` if the name is taken. The payer is added automatically when the bill is created |
| `PUT /api/bills/:id/people/:name/claims` | person token | `{ claims: { itemId: pct } }`. Only allowed while the bill is open |
| `POST /api/bills/:id/people/:name/reset` | admin | Clears the name's `tokenHash` so the name can be picked again. The claims stay |
| `POST /api/bills/:id/lock` | admin | Fails with `409` and the list of unclaimed items if any item is unclaimed |
| `POST /api/bills/:id/unlock` | admin | Fails with `409` once any order exists |
| `POST /api/orders` | none | `{ billId, person }`. Reads the amount from the snapshot, writes `order:{id}`, and sets `pay.orderId`. Payee override to the payer's email, as now. Anyone may pay a share, because paying for someone else does no harm |
| `POST /api/orders/:id/capture` | none | Existing capture logic, plus the `lockVersion` and amount check, then updates `pay`. When every share is paid: `status=settled` and `DEL photo` |

Tokens are sent in an `Authorization: Bearer <token>` header. The admin token reaches the page through the URL fragment, which browsers don't send to the server or in `Referer`. The page then keeps it in localStorage.

The current hand-entered `createBill({ shares })` route and the `?bill=&person=` pay link are removed.

## 7. Gemini (`lib/receipt.js`)

- Move `MODEL`, `RECEIPT_SCHEMA`, `PROMPT` and `checkTotals` out of `scripts/receipt.mjs` into `lib/receipt.js`. Both the script and the server import them, so they share one prompt.
- The server accepts `image/jpeg`, `image/png` and `image/webp` only. If the result fails the schema, it returns `502 { error }`. If the cents check fails, it still returns the bill, and the review screen shows the mismatch.
- Item ids are assigned on the server (`i1`, `i2`, …). Claims refer to these ids, never to array positions.
- Gemini is only called from the server. The free tier may use uploaded images for training, so the create page says: "Sandbox demo: don't upload receipts with personal or card details."

## 8. Frontend (`public/`, vanilla JS, mobile-first)

There's one page, `index.html`. `app.js` chooses the view from the URL and the bill status:
- **No `b` param:** create form.
- **Draft + admin:** review table.
- **Open:** pick name (if needed), then the claim list with the sticky "You owe ≈" footer. The admin also sees the share panel, people list with reset buttons, and Lock.
- **Locked:** a pay view for friends, and a status board for the payer (Unlock is shown while it's still allowed).
- **Settled:** a done screen with everyone marked paid.

**Polling:** `GET /api/bills/:id?since=<version>` every 2.5 s. Stop while `document.hidden` and poll at once when the tab becomes visible again. Back off to 10 s after errors.

**Edits during polling:** while the person is editing, their own claims come from local state. Polls update everyone else's claims, the statuses and the view. This keeps the user's typing from being reset by a poll.

**The QR code for the share link:** use a small library from cdnjs with a pinned version, or skip QR codes and use the share sheet only if the time runs short.

## 9. Config and deploy

New environment variables: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` and `DEMO_PASSCODE`, alongside the existing PayPal and Gemini keys and `PORT`. Add them to `.env` locally and to the host's settings. Never commit them.

- **Host:** free-plan Render (or similar). Read `PORT` from the environment, as the server does now.
- **Start command:** `npm start` uses `--env-file=.env`, which fails when `.env` doesn't exist, as on the host. Fix: set the host's start command to `node server.js`, or switch the script to `--env-file-if-exists` (Node ≥ 22). Check the host's Node version first.
- **Warm-up:** free plans sleep when idle. Open the app about a minute before recording or judging. Bills survive the sleep, because they live in Redis.
- **PayPal:** sandbox. The payer uses a sandbox personal account email. Friends pay with other sandbox personal accounts. The webhook stays optional and is out of scope.

## 10. Error and edge cases

| Case | Behavior |
|---|---|
| Wrong passcode | `401`. The form shows "Wrong demo passcode" |
| Gemini timeout or bad JSON | `502`. The page shows "Couldn't read that receipt. Try a clearer photo" and keeps the form filled in |
| Totals don't match after the scan | A warning with the difference on the review screen. It doesn't block |
| Name taken by another device | `409`. The page shows "Someone already picked that name". The payer can reset the name |
| Claim saved after lock | `409`. The UI refreshes to the locked view |
| Payer unlocks after an order exists | `409` with "Someone has started paying" |
| Bill expired (TTL) or unknown id | `404`. The page shows "This bill has expired or doesn't exist" |
| Capture for a stale `lockVersion` or a different amount | The server refuses. The page shows an error. The order isn't captured, so nobody is charged |
| PayPal capture is PENDING | `pay.status=pending`. It counts as not yet paid for settling (the webhook is out of scope, so it stays pending) |
| A person with a 0 share | No pay button. Left out of the "all paid" check |

## 11. Out of scope and open points

- **Out of scope:** login, editing other people's claims, per-item taxable flags, other currencies, payouts and invoices, the PayPal webhook, native apps.
- **Receipt edits after opening:** these are locked out on purpose, so item ids and claims stay valid. If this hurts in practice, allow edits while open that only change prices and names, never delete items.
- **Pending captures:** a capture that stays pending never settles the bill or deletes the photo. The TTL still deletes everything after 7 days.

## 12. Build order

1. `lib/split.js` and its tests. This is plan step 3 in CLAUDE.md, and the rest depends on it.
2. `lib/redis.js`, then move bills and orders from the Maps to Redis, keeping the current routes working.
3. `lib/receipt.js` (shared with the script) and `POST /api/bills` with the passcode.
4. The review UI, then open, people and claims routes with the claim UI and polling.
5. Lock, unlock and snapshot, then move pay and capture over to the snapshot. Add the status board.
6. Settling and photo deletion. Check the TTL.
7. Deploy to the free host, then run a full sandbox flow with three phones.
8. Record the demo video (three phones claiming one restaurant receipt live, payer locks, two friends pay, the status board turns green). Then write the Devpost description.
