# Spec: bill-split logic (plan step 3)

## Goal
A pure function takes the parsed receipt and the record of who had which items. It returns what each friend owes the payer, in integer cents. The output is the input to PayPal settlement (step 4, built by a teammate). There is no AI, no network and no I/O.

## Shared contract with the step 4 teammate
`split()` returns this shape. The first three fields are the agreed contract. `breakdown` is an extra field, and step 4 can ignore it.

```js
{
  payer: "Angela",                       // display name of the person who paid the bill
  shares: { Ben: 1210, Chris: 1210 },    // non-payers only, integer cents, keyed by name
  currency: "CAD",
  breakdown: {                           // non-payers only, for the UI ("why do I owe this?")
    Ben: {
      items: [{ itemId: "item-1", name: "Burger", portionCents: 750 }, ...],
      itemsCents: 1000,
      discountCents: 0,                  // positive number, subtracted
      taxCents: 130,
      tipCents: 80,
      roundingCents: 0,                  // totalCents − (items − discount + tax + tip); usually 0, at most a few ¢
      totalCents: 1210                   // always equals shares[name]
    },
    Chris: { ... }
  }
}
```

Tell the teammate about these differences from their example:
- `currency` is **`"CAD"`**, not `"USD"`. PayPal orders need `currency_code: "CAD"`, and the sandbox accounts must accept CAD.
- Names in the output are unique. Duplicates are rejected before the split runs.
- `breakdown` is new and optional for them.
- `shares` can be `{}` if the payer is the only person.

## Decisions (from the interview)
| Topic | Decision |
|---|---|
| Shared items | Each person on an item has a positive weight. Weights are normalized, so `{a: 3, b: 5}` means a pays 3/8 and b pays 5/8. The UI uses weight 1 for an even split. |
| Discount, tax, tip | All three are split in proportion to each person's item subtotal. There is no per-item taxable flag. |
| Payer | The bill is split across everyone, the payer included. Only non-payers appear in `shares` and `breakdown`. The payer's own portion is never passed on to anyone else, because she already paid it with the bill. |
| Rounding | Rounding happens once, on each person's total, using the largest-remainder method across **all** people (payer included). The payer's portion plus the sum of `shares` equals the receipt total exactly. |
| Unassigned items | Error. Every item must have at least one person. |
| Totals don't add up | Error. The same checks as `scripts/receipt.mjs`. |
| People with no items | Allowed. They owe 0 and still appear in `shares` with `0`. Step 4 skips 0-cent shares. |
| Item identity | Fixed `id` per item, given when the receipt is parsed. Assignments refer to item IDs, never array positions. |
| People identity | IDs are used inside the split (input). The output is keyed by display name (Option B). Names must be unique. |
| Currency | `"CAD"` only for now. The math assumes 2 decimal places. |

## API

File: `lib/split.js` (ESM, no dependencies).

```js
export function split({ receipt, people, payerId, assignments, currency = "CAD" })
export function addItemIds(receipt)   // returns a copy with items[i].id = "item-1", "item-2", ...
export class SplitError extends Error { code; details }
```

### Input
- `receipt`: output of the Gemini parser, in **dollars**, plus item IDs:
  `{ merchant, items: [{ id, name, quantity, price }], discount, subtotal, tax, tip, total }`.
  `price` is the line total. `discount` is positive.
- `people`: `[{ id, name }]`, in display order. The order breaks rounding ties.
- `payerId`: the `id` of one entry in `people`.
- `assignments`: `{ [itemId]: { [personId]: weight } }`.
  Example: `{ "item-1": { p2: 1 }, "item-2": { p1: 3, p2: 5 } }`.

`addItemIds` is meant for step 5 (`POST /api/receipt`), right after Gemini returns. Items the user adds later in the UI need IDs that are unique within the receipt. A counter or `crypto.randomUUID()` both work.

## Algorithm
1. **Validate** the input (see the error list below). Fail on the first problem and give a specific `code`.
2. **Convert dollars to cents** with `Math.round(x * 100)` for every price, discount, subtotal, tax, tip and total.
3. **Check totals** in cents: `Σ item cents − discount = subtotal` and `subtotal + tax + tip = total`.
4. **Item portions (exact, not rounded).** For each item with cents `c` and weights `w`: person p gets `c × w_p / Σw`. Sum these per person to get `S_p`. Let `I = Σ item cents`.
5. **Exact total per person:** `exact_p = total × S_p / I`. Because discount, tax and tip are all proportional to `S_p / I`, this single formula covers all three.
6. **Largest remainder:** `floor_p = ⌊exact_p⌋`. Hand out `total − Σ floor_p` extra cents, one at a time, to the people with the largest fractional part. Break ties by the order of `people`. Compare remainders with a small epsilon (1e-9) so float noise can't flip a tie.
7. **Output:** `shares[name] = rounded_p` for every non-payer. Build `breakdown` with each component rounded on its own for display: item portions, `discount × S_p / I`, `tax × S_p / I` and `tip × S_p / I`. Then `roundingCents = totalCents − (itemsCents − discountCents + taxCents + tipCents)`, so the breakdown always adds up to the share exactly.

Floats are fine here. The only result that must be exact is the integer total per person, and step 6 guarantees that.

## Errors (`SplitError.code`)
| Code | When | `details` |
|---|---|---|
| `UNSUPPORTED_CURRENCY` | currency is not `"CAD"` | `{ currency }` |
| `INVALID_AMOUNT` | any amount is missing, non-finite or negative | `{ field, itemId? }` |
| `NO_ITEMS` | `items` is empty, or every item is 0¢ (so `I = 0`) | — |
| `DUPLICATE_ITEM_ID` / `MISSING_ITEM_ID` | an item ID is repeated or missing | `{ itemId }` |
| `TOTALS_MISMATCH` | a check in step 3 fails | `{ check, got, expected }` (cents) |
| `EMPTY_NAME` | a name is empty after trimming | `{ personId }` |
| `DUPLICATE_NAME` | two names match after trimming, ignoring case ("Ben" vs " ben") | `{ name, personIds }` |
| `DUPLICATE_PERSON_ID` / `MISSING_PERSON_ID` | a person ID is repeated or missing | `{ personId }` |
| `PAYER_NOT_FOUND` | `payerId` is not in `people` | `{ payerId }` |
| `UNKNOWN_ITEM` | an assignment refers to an item ID that doesn't exist | `{ itemId }` |
| `UNKNOWN_PERSON` | an assignment refers to a person ID that doesn't exist | `{ itemId, personId }` |
| `INVALID_WEIGHT` | a weight is not a finite number greater than 0 | `{ itemId, personId, weight }` |
| `UNASSIGNED_ITEMS` | one or more items have no people | `{ itemIds: [...] }` (all of them, so the UI can highlight every one) |

Output names are trimmed display names.

## Tests (`test/split.test.js`, `node:test` + `node:assert/strict`)
Fixtures use made-up receipts only. Real receipts stay in the gitignored `test-receipts/`.
- The teammate's example: a 3630¢ bill, three equal eaters, Angela pays → `{ Ben: 1210, Chris: 1210 }`.
- Three-way split with odd cents (e.g. 1000¢ across 3 people). Shares plus the payer's portion = total, and no one is more than 1¢ from their exact share.
- Weighted shared item 3:5. Weights 30:50 give the same result as 3:5.
- Discount, tax and tip all non-zero (like the crumpled restaurant receipt). Tip = 0 and discount = 0 also work.
- A person with no items → share 0.
- The payer had everything → all shares are 0.
- Only the payer → `shares: {}`.
- Invariant over random receipts and weights (a property-style loop): `Σ shares + payer portion === total`, every share ≥ 0, and `breakdown` adds up to `shares`.
- The same input always gives the same output. Ties go to the earlier person in `people`.
- One test for every error code.

## Setup
No new dependencies or accounts are needed.
- Add `"test": "node --test test/"` to `package.json` scripts. A bare `node --test` would also pick up `scripts/test.mjs` and call Gemini. Node ≥ 20.11 is already required and includes `node:test`.
- Run the tests with `npm test`.

## Out of scope (later steps)
- Calling Gemini and adding item IDs during parsing (step 5 calls `addItemIds`).
- Creating PayPal orders from `shares` (step 4, teammate).
- UI for editing items, people and weights (step 5).
- Per-item tax flags, item-specific coupons, splitting by quantity, currencies other than CAD.
