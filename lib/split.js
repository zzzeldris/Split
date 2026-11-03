// Splits a parsed receipt between people and works out what each friend owes the payer.
// Pure function: no network, no I/O. See .plans/bill-split-logic-spec.md.
//
// Output (the contract with PayPal settlement, plus an extra `breakdown` for the UI):
//   { payer: "Angela", shares: { Ben: 1210, Chris: 1210 }, currency: "CAD", breakdown: { ... } }
// All amounts in the output are integer cents. Only non-payers appear in shares/breakdown.

const SUPPORTED_CURRENCIES = new Set(["CAD"]);
const EPSILON = 1e-9;

export class SplitError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "SplitError";
    this.code = code;
    this.details = details;
  }
}

// Gives every item a stable id ("item-1", "item-2", ...). Call this right after parsing the receipt.
export function addItemIds(receipt) {
  return { ...receipt, items: receipt.items.map((item, i) => ({ ...item, id: `item-${i + 1}` })) };
}

function toCents(dollars, field, itemId) {
  if (typeof dollars !== "number" || !Number.isFinite(dollars) || dollars < 0) {
    const where = itemId ? ` on item ${itemId}` : "";
    throw new SplitError("INVALID_AMOUNT", `${field}${where} must be a number ≥ 0, got ${dollars}`, itemId ? { field, itemId } : { field });
  }
  return Math.round(dollars * 100);
}

function readReceipt(receipt) {
  const items = Array.isArray(receipt?.items) ? receipt.items : [];
  if (items.length === 0) throw new SplitError("NO_ITEMS", "The receipt has no items");

  const seenIds = new Set();
  const parsed = items.map((item) => {
    const id = item?.id;
    if (typeof id !== "string" || id === "") throw new SplitError("MISSING_ITEM_ID", `Item "${item?.name}" has no id`, { itemId: id });
    if (seenIds.has(id)) throw new SplitError("DUPLICATE_ITEM_ID", `Item id ${id} is used more than once`, { itemId: id });
    seenIds.add(id);
    return { id, name: item.name, cents: toCents(item.price, "price", id) };
  });

  const r = {
    items: parsed,
    discount: toCents(receipt.discount, "discount"),
    subtotal: toCents(receipt.subtotal, "subtotal"),
    tax: toCents(receipt.tax, "tax"),
    tip: toCents(receipt.tip, "tip"),
    total: toCents(receipt.total, "total"),
  };
  r.itemsTotal = parsed.reduce((sum, item) => sum + item.cents, 0);
  if (r.itemsTotal === 0) throw new SplitError("NO_ITEMS", "Every item on the receipt is $0.00");

  const checks = [
    ["items - discount = subtotal", r.itemsTotal - r.discount, r.subtotal],
    ["subtotal + tax + tip = total", r.subtotal + r.tax + r.tip, r.total],
  ];
  for (const [check, got, expected] of checks) {
    if (got !== expected) {
      throw new SplitError("TOTALS_MISMATCH", `Receipt doesn't add up: ${check} (got ${got}¢, receipt says ${expected}¢)`, { check, got, expected });
    }
  }
  return r;
}

function readPeople(people, payerId) {
  const list = Array.isArray(people) ? people : [];
  const byId = new Map();
  const byName = new Map(); // lowercased name -> person id
  const parsed = list.map((person) => {
    const id = person?.id;
    if (typeof id !== "string" || id === "") throw new SplitError("MISSING_PERSON_ID", `Person "${person?.name}" has no id`, { personId: id });
    if (byId.has(id)) throw new SplitError("DUPLICATE_PERSON_ID", `Person id ${id} is used more than once`, { personId: id });

    const name = typeof person.name === "string" ? person.name.trim() : "";
    if (name === "") throw new SplitError("EMPTY_NAME", `Person ${id} has no name`, { personId: id });
    const key = name.toLocaleLowerCase();
    if (byName.has(key)) {
      throw new SplitError("DUPLICATE_NAME", `Two people are called "${name}". Names must be different.`, { name, personIds: [byName.get(key), id] });
    }
    byName.set(key, id);

    const p = { id, name };
    byId.set(id, p);
    return p;
  });
  if (!byId.has(payerId)) throw new SplitError("PAYER_NOT_FOUND", `Payer ${payerId} is not in the list of people`, { payerId });
  return { list: parsed, byId };
}

function readAssignments(assignments, items, peopleById) {
  const itemIds = new Set(items.map((item) => item.id));
  const source = assignments && typeof assignments === "object" ? assignments : {};

  for (const [itemId, weights] of Object.entries(source)) {
    if (!itemIds.has(itemId)) throw new SplitError("UNKNOWN_ITEM", `Assignment refers to unknown item ${itemId}`, { itemId });
    for (const [personId, weight] of Object.entries(weights ?? {})) {
      if (!peopleById.has(personId)) {
        throw new SplitError("UNKNOWN_PERSON", `Item ${itemId} is assigned to unknown person ${personId}`, { itemId, personId });
      }
      if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0) {
        throw new SplitError("INVALID_WEIGHT", `Weight for ${personId} on item ${itemId} must be a number > 0, got ${weight}`, { itemId, personId, weight });
      }
    }
  }

  const unassigned = items.filter((item) => Object.keys(source[item.id] ?? {}).length === 0).map((item) => item.id);
  if (unassigned.length > 0) {
    throw new SplitError("UNASSIGNED_ITEMS", `${unassigned.length} item(s) are not assigned to anyone`, { itemIds: unassigned });
  }
  return source;
}

// Rounds exact amounts to whole cents so they sum to `total` exactly (largest remainder method).
// Leftover cents go to the largest fractional parts; ties go to the earlier person.
function largestRemainder(exacts, total) {
  const rows = exacts.map((exact, index) => {
    const nearest = Math.round(exact);
    const value = Math.abs(exact - nearest) < EPSILON ? nearest : exact; // ignore float noise
    const floor = Math.floor(value);
    return { index, floor, remainder: value - floor };
  });
  const leftover = total - rows.reduce((sum, row) => sum + row.floor, 0);
  if (leftover < 0 || leftover > rows.length) throw new Error(`Internal rounding error: ${leftover} cents left over`);

  const order = [...rows].sort((a, b) =>
    Math.abs(a.remainder - b.remainder) < EPSILON ? a.index - b.index : b.remainder - a.remainder,
  );
  const result = rows.map((row) => row.floor);
  for (let i = 0; i < leftover; i++) result[order[i].index] += 1;
  return result;
}

export function split({ receipt, people, payerId, assignments, currency = "CAD" }) {
  if (!SUPPORTED_CURRENCIES.has(currency)) {
    throw new SplitError("UNSUPPORTED_CURRENCY", `Currency ${currency} is not supported (only ${[...SUPPORTED_CURRENCIES].join(", ")})`, { currency });
  }
  const r = readReceipt(receipt);
  const { list: persons, byId } = readPeople(people, payerId);
  const assigned = readAssignments(assignments, r.items, byId);

  // Exact (unrounded) item portions per person.
  const lines = new Map(persons.map((p) => [p.id, []]));
  for (const item of r.items) {
    const weights = Object.entries(assigned[item.id]);
    const weightSum = weights.reduce((sum, [, w]) => sum + w, 0);
    for (const [personId, w] of weights) {
      lines.get(personId).push({ itemId: item.id, name: item.name, exact: (item.cents * w) / weightSum });
    }
  }
  const itemShare = persons.map((p) => lines.get(p.id).reduce((sum, line) => sum + line.exact, 0));

  // Discount, tax and tip are all proportional to item share, so each person owes total × share / items.
  const totals = largestRemainder(itemShare.map((s) => (r.total * s) / r.itemsTotal), r.total);

  const payer = byId.get(payerId);
  const shares = {};
  const breakdown = {};
  persons.forEach((p, i) => {
    if (p.id === payerId) return;
    const fraction = itemShare[i] / r.itemsTotal;
    const items = lines.get(p.id).map((line) => ({ itemId: line.itemId, name: line.name, portionCents: Math.round(line.exact) }));
    const itemsCents = items.reduce((sum, line) => sum + line.portionCents, 0);
    const discountCents = Math.round(r.discount * fraction);
    const taxCents = Math.round(r.tax * fraction);
    const tipCents = Math.round(r.tip * fraction);
    const totalCents = totals[i];

    shares[p.name] = totalCents;
    breakdown[p.name] = {
      items,
      itemsCents,
      discountCents,
      taxCents,
      tipCents,
      roundingCents: totalCents - (itemsCents - discountCents + taxCents + tipCents),
      totalCents,
    };
  });

  return { payer: payer.name, shares, currency, breakdown };
}
