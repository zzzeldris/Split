// Turns a bill (receipt + people + percentage claims) into what each person owes.
// Pure code with no Node imports: the browser loads this too, for the live "You owe ≈" preview,
// so the preview and the server always agree.
//
// A receipt here is stored in integer cents:
//   { merchant, items: [{ id, name, quantity, priceCents }], discountCents, taxCents, tipCents }
// The bill total is always computed from those fields, never taken from the printed total.
import { split } from "./split.js";

export const itemsCents = (receipt) => receipt.items.reduce((sum, item) => sum + item.priceCents, 0);
export const subtotalCents = (receipt) => itemsCents(receipt) - receipt.discountCents;
export const totalCents = (receipt) => subtotalCents(receipt) + receipt.taxCents + receipt.tipCents;

// Items nobody has claimed. $0 items don't need a claim.
export function unclaimedItems(receipt, claims) {
  return receipt.items
    .filter((item) => item.priceCents > 0)
    .filter((item) => !Object.values(claims).some((c) => (c?.[item.id] ?? 0) > 0))
    .map((item) => item.id);
}

// For one item: [{ personId, pct, fraction }] for everyone who claimed it, with the claims
// normalized by their sum (50% + 10% -> 5/6 and 1/6). The UI shows this as "You 83% · Ben 17%".
export function itemClaims(itemId, people, claims) {
  const rows = people
    .map((p) => ({ personId: p.id, pct: claims[p.id]?.[itemId] ?? 0 }))
    .filter((r) => r.pct > 0);
  const sum = rows.reduce((s, r) => s + r.pct, 0);
  return rows.map((r) => ({ ...r, fraction: r.pct / sum }));
}

// people: [{ id, name }] in join order (ties in rounding go to the earlier person).
// claims: { personId: { itemId: pct } } with pct an integer from 0 to 100.
// Returns { ok: true, shares: { personId: cents } } including the payer, summing to the total,
// or { ok: false, unclaimed: [itemId] } while some item has no claim.
export function computeShares(receipt, people, payerId, claims) {
  const unclaimed = unclaimedItems(receipt, claims);
  if (unclaimed.length > 0) return { ok: false, unclaimed };

  const total = totalCents(receipt);
  const assignments = {};
  for (const item of receipt.items) {
    const weights = {};
    for (const p of people) {
      const pct = claims[p.id]?.[item.id] ?? 0;
      if (pct > 0) weights[p.id] = pct;
    }
    // split() wants every item assigned. A $0 item with no claims costs nothing, so give it to the payer.
    assignments[item.id] = Object.keys(weights).length > 0 ? weights : { [payerId]: 1 };
  }

  // split() reads dollars like Gemini returns them; cents / 100 round-trips exactly through its Math.round.
  const dollars = (c) => c / 100;
  const result = split({
    receipt: {
      items: receipt.items.map((item) => ({ id: item.id, name: item.name, price: dollars(item.priceCents) })),
      discount: dollars(receipt.discountCents),
      subtotal: dollars(subtotalCents(receipt)),
      tax: dollars(receipt.taxCents),
      tip: dollars(receipt.tipCents),
      total: dollars(total),
    },
    people,
    payerId,
    assignments,
  });

  // split() keys shares by name and leaves the payer out. Key by id and add the payer back.
  const idByName = new Map(people.map((p) => [p.name, p.id]));
  const shares = {};
  let othersCents = 0;
  for (const [name, cents] of Object.entries(result.shares)) {
    shares[idByName.get(name)] = cents;
    othersCents += cents;
  }
  shares[payerId] = total - othersCents;
  return { ok: true, shares };
}
