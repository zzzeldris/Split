import { test } from "node:test";
import assert from "node:assert/strict";
import { split, addItemIds, SplitError } from "../lib/split.js";

// Builds a receipt (in dollars, like Gemini returns) from item prices in cents.
function makeReceipt(itemCents, { discount = 0, tax = 0, tip = 0 } = {}) {
  const items = itemCents.map((cents, i) => ({ id: `item-${i + 1}`, name: `Item ${i + 1}`, quantity: 1, price: cents / 100 }));
  const subtotal = itemCents.reduce((a, b) => a + b, 0) - discount;
  return { merchant: "Test Diner", items, discount: discount / 100, subtotal: subtotal / 100, tax: tax / 100, tip: tip / 100, total: (subtotal + tax + tip) / 100 };
}

const ABC = [
  { id: "a", name: "Angela" },
  { id: "b", name: "Ben" },
  { id: "c", name: "Chris" },
];

const sum = (obj) => Object.values(obj).reduce((a, b) => a + b, 0);

function assertError(fn, code) {
  assert.throws(fn, (err) => err instanceof SplitError && err.code === code, `expected SplitError ${code}`);
}

test("teammate's example: three equal eaters, Angela pays", () => {
  const receipt = makeReceipt([1000, 1000, 1000], { tax: 390, tip: 240 }); // total 3630
  const result = split({
    receipt,
    people: ABC,
    payerId: "a",
    assignments: { "item-1": { a: 1 }, "item-2": { b: 1 }, "item-3": { c: 1 } },
  });
  assert.equal(result.payer, "Angela");
  assert.deepEqual(result.shares, { Ben: 1210, Chris: 1210 });
  assert.equal(result.currency, "CAD");
  assert.deepEqual(result.breakdown.Ben, {
    items: [{ itemId: "item-2", name: "Item 2", portionCents: 1000 }],
    itemsCents: 1000,
    discountCents: 0,
    taxCents: 130,
    tipCents: 80,
    roundingCents: 0,
    totalCents: 1210,
  });
});

test("odd cents: leftover cent goes to the earlier person on a tie", () => {
  const receipt = makeReceipt([1000]);
  const shared = { "item-1": { a: 1, b: 1, c: 1 } };
  // Angela is first, so she (the payer) absorbs the extra cent.
  assert.deepEqual(split({ receipt, people: ABC, payerId: "a", assignments: shared }).shares, { Ben: 333, Chris: 333 });
  // With Ben first, Ben gets it.
  const reordered = [ABC[1], ABC[2], ABC[0]];
  assert.deepEqual(split({ receipt, people: reordered, payerId: "a", assignments: shared }).shares, { Ben: 334, Chris: 333 });
});

test("weighted shared item: 3:5 and 30:50 give the same result", () => {
  const receipt = makeReceipt([200, 800]);
  const run = (wb, wc) => split({ receipt, people: ABC, payerId: "a", assignments: { "item-1": { a: 1 }, "item-2": { b: wb, c: wc } } });
  assert.deepEqual(run(3, 5).shares, { Ben: 300, Chris: 500 });
  assert.deepEqual(run(30, 50), run(3, 5));
});

test("discount, tax and tip are split proportionally", () => {
  // Items 20/30/50 = 100.00, discount 10.00, tax 11.70, tip 15.00 -> total 116.70
  const receipt = makeReceipt([2000, 3000, 5000], { discount: 1000, tax: 1170, tip: 1500 });
  const result = split({ receipt, people: ABC, payerId: "a", assignments: { "item-1": { b: 1 }, "item-2": { c: 1 }, "item-3": { a: 1 } } });
  assert.deepEqual(result.shares, { Ben: 2334, Chris: 3501 });
  const ben = result.breakdown.Ben;
  assert.deepEqual([ben.itemsCents, ben.discountCents, ben.taxCents, ben.tipCents, ben.roundingCents], [2000, 200, 234, 300, 0]);
});

test("a person with no items owes 0", () => {
  const receipt = makeReceipt([1000, 500]);
  const result = split({ receipt, people: ABC, payerId: "a", assignments: { "item-1": { a: 1 }, "item-2": { b: 1 } } });
  assert.deepEqual(result.shares, { Ben: 500, Chris: 0 });
  assert.deepEqual(result.breakdown.Chris.items, []);
  assert.equal(result.breakdown.Chris.totalCents, 0);
});

test("payer had everything: all shares are 0", () => {
  const receipt = makeReceipt([1000], { tax: 130 });
  const result = split({ receipt, people: ABC, payerId: "a", assignments: { "item-1": { a: 1 } } });
  assert.deepEqual(result.shares, { Ben: 0, Chris: 0 });
});

test("only the payer: shares is empty", () => {
  const receipt = makeReceipt([1000]);
  const result = split({ receipt, people: [ABC[0]], payerId: "a", assignments: { "item-1": { a: 1 } } });
  assert.deepEqual(result.shares, {});
  assert.deepEqual(result.breakdown, {});
});

test("names are trimmed in the output", () => {
  const receipt = makeReceipt([1000]);
  const people = [{ id: "a", name: " Angela " }, { id: "b", name: "Ben  " }];
  const result = split({ receipt, people, payerId: "a", assignments: { "item-1": { b: 1 } } });
  assert.equal(result.payer, "Angela");
  assert.deepEqual(result.shares, { Ben: 1000 });
});

test("same input always gives the same output", () => {
  const receipt = makeReceipt([1001, 777], { tax: 233, tip: 199 });
  const input = { receipt, people: ABC, payerId: "a", assignments: { "item-1": { a: 1, b: 2, c: 3 }, "item-2": { b: 1, c: 1 } } };
  assert.deepEqual(split(input), split(input));
});

test("addItemIds gives each item a stable id and doesn't change the input", () => {
  const raw = { merchant: "X", items: [{ name: "A", quantity: 1, price: 1 }, { name: "B", quantity: 1, price: 2 }] };
  const withIds = addItemIds(raw);
  assert.deepEqual(withIds.items.map((i) => i.id), ["item-1", "item-2"]);
  assert.equal(raw.items[0].id, undefined);
});

// Seeded random generator so failures can be reproduced.
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("invariants hold on 500 random receipts", () => {
  const rand = mulberry32(42);
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const weightsPool = [1, 1, 1, 2, 3, 0.5, 7, 1.25];

  for (let run = 0; run < 500; run++) {
    const itemCents = Array.from({ length: int(1, 8) }, () => int(1, 5000));
    const itemsTotal = itemCents.reduce((a, b) => a + b, 0);
    const discount = rand() < 0.3 ? int(0, itemsTotal - 1) : 0;
    const receipt = makeReceipt(itemCents, { discount, tax: int(0, 2000), tip: rand() < 0.5 ? int(0, 3000) : 0 });
    const totalCents = Math.round(receipt.total * 100);

    // A payer who had nothing, so the friends' shares must sum to the whole total.
    const friends = Array.from({ length: int(1, 5) }, (_, i) => ({ id: `f${i}`, name: `Friend ${i}` }));
    const people = [{ id: "payer", name: "Payer" }, ...friends];
    const assignments = {};
    for (let i = 0; i < itemCents.length; i++) {
      const sharers = friends.filter(() => rand() < 0.5);
      if (sharers.length === 0) sharers.push(friends[int(0, friends.length - 1)]);
      assignments[`item-${i + 1}`] = Object.fromEntries(sharers.map((f) => [f.id, weightsPool[int(0, weightsPool.length - 1)]]));
    }

    const ctx = `run ${run}: ${JSON.stringify({ itemCents, discount, assignments })}`;
    const result = split({ receipt, people, payerId: "payer", assignments });
    assert.equal(sum(result.shares), totalCents, ctx);

    // Each share is within 1 cent of the exact share.
    for (const f of friends) {
      let exactItems = 0;
      for (const [itemId, weights] of Object.entries(assignments)) {
        if (!weights[f.id]) continue;
        const w = Object.values(weights).reduce((a, b) => a + b, 0);
        exactItems += (itemCents[Number(itemId.split("-")[1]) - 1] * weights[f.id]) / w;
      }
      const exact = (totalCents * exactItems) / itemsTotal;
      const share = result.shares[f.name];
      assert.ok(Number.isInteger(share) && share >= 0, ctx);
      assert.ok(Math.abs(share - exact) < 1, `${ctx} share ${share} vs exact ${exact}`);

      const b = result.breakdown[f.name];
      assert.equal(b.itemsCents - b.discountCents + b.taxCents + b.tipCents + b.roundingCents, share, ctx);
      assert.equal(b.totalCents, share, ctx);
    }
  }
});

// ---------- Errors ----------

const okInput = () => ({
  receipt: makeReceipt([1000, 500]),
  people: ABC.map((p) => ({ ...p })),
  payerId: "a",
  assignments: { "item-1": { a: 1 }, "item-2": { b: 1 } },
});

test("error: UNSUPPORTED_CURRENCY", () => {
  assertError(() => split({ ...okInput(), currency: "USD" }), "UNSUPPORTED_CURRENCY");
});

test("error: INVALID_AMOUNT", () => {
  const input = okInput();
  input.receipt.items[0].price = -1;
  assertError(() => split(input), "INVALID_AMOUNT");
  const input2 = okInput();
  input2.receipt.tax = undefined;
  assertError(() => split(input2), "INVALID_AMOUNT");
});

test("error: NO_ITEMS", () => {
  assertError(() => split({ ...okInput(), receipt: makeReceipt([]) }), "NO_ITEMS");
  assertError(() => split({ ...okInput(), receipt: makeReceipt([0, 0]) }), "NO_ITEMS");
});

test("error: MISSING_ITEM_ID and DUPLICATE_ITEM_ID", () => {
  const missing = okInput();
  delete missing.receipt.items[0].id;
  assertError(() => split(missing), "MISSING_ITEM_ID");
  const dup = okInput();
  dup.receipt.items[1].id = "item-1";
  assertError(() => split(dup), "DUPLICATE_ITEM_ID");
});

test("error: TOTALS_MISMATCH", () => {
  const badSubtotal = okInput();
  badSubtotal.receipt.subtotal = 14.99;
  assertError(() => split(badSubtotal), "TOTALS_MISMATCH");
  const badTotal = okInput();
  badTotal.receipt.total = 16;
  assertError(() => split(badTotal), "TOTALS_MISMATCH");
});

test("error: EMPTY_NAME", () => {
  const input = okInput();
  input.people[1].name = "   ";
  assertError(() => split(input), "EMPTY_NAME");
});

test("error: DUPLICATE_NAME (case and spaces ignored)", () => {
  const input = okInput();
  input.people[2].name = " ben";
  assert.throws(() => split(input), (err) => err.code === "DUPLICATE_NAME" && err.details.personIds.join() === "b,c");
});

test("error: MISSING_PERSON_ID and DUPLICATE_PERSON_ID", () => {
  const missing = okInput();
  delete missing.people[2].id;
  assertError(() => split(missing), "MISSING_PERSON_ID");
  const dup = okInput();
  dup.people[2].id = "b";
  assertError(() => split(dup), "DUPLICATE_PERSON_ID");
});

test("error: PAYER_NOT_FOUND", () => {
  assertError(() => split({ ...okInput(), payerId: "zz" }), "PAYER_NOT_FOUND");
});

test("error: UNKNOWN_ITEM", () => {
  const input = okInput();
  input.assignments["item-9"] = { a: 1 };
  assertError(() => split(input), "UNKNOWN_ITEM");
});

test("error: UNKNOWN_PERSON", () => {
  const input = okInput();
  input.assignments["item-2"] = { zz: 1 };
  assertError(() => split(input), "UNKNOWN_PERSON");
});

test("error: INVALID_WEIGHT", () => {
  for (const weight of [0, -1, NaN, Infinity, "2"]) {
    const input = okInput();
    input.assignments["item-2"] = { b: weight };
    assertError(() => split(input), "INVALID_WEIGHT");
  }
});

test("error: UNASSIGNED_ITEMS lists every unassigned item", () => {
  const input = { ...okInput(), receipt: makeReceipt([1000, 500, 250]), assignments: { "item-1": { a: 1 }, "item-3": {} } };
  assert.throws(() => split(input), (err) => err.code === "UNASSIGNED_ITEMS" && err.details.itemIds.join() === "item-2,item-3");
});
