import { test } from "node:test";
import assert from "node:assert/strict";
import { computeShares, itemClaims, totalCents, unclaimedItems } from "../lib/shares.js";

const receipt = (prices, { discountCents = 0, taxCents = 0, tipCents = 0 } = {}) => ({
  merchant: "Test Diner",
  items: prices.map((priceCents, i) => ({ id: `i${i + 1}`, name: `Item ${i + 1}`, quantity: 1, priceCents })),
  discountCents, taxCents, tipCents,
});
const people = [{ id: "pa", name: "Angela" }, { id: "pb", name: "Ben" }, { id: "pc", name: "Chris" }];
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

test("50% and 10% on one item split 5:1", () => {
  const r = receipt([600]);
  const { shares } = computeShares(r, people, "pa", { pa: {}, pb: { i1: 50 }, pc: { i1: 10 } });
  assert.deepEqual(shares, { pa: 0, pb: 500, pc: 100 });
  assert.deepEqual(itemClaims("i1", people, { pb: { i1: 50 }, pc: { i1: 10 } }).map((c) => c.fraction), [5 / 6, 1 / 6]);
});

test("two people both claiming 100% split 50/50", () => {
  const { shares } = computeShares(receipt([1000]), people, "pa", { pb: { i1: 100 }, pc: { i1: 100 } });
  assert.deepEqual(shares, { pa: 0, pb: 500, pc: 500 });
});

test("the payer's own share is included and all shares sum to the computed total", () => {
  const r = receipt([2000, 3000, 5000], { discountCents: 1000, taxCents: 1170, tipCents: 1500 });
  const { shares } = computeShares(r, people, "pa", { pa: { i3: 100 }, pb: { i1: 100 }, pc: { i2: 100 } });
  assert.deepEqual(shares, { pa: 5835, pb: 2334, pc: 3501 });
  assert.equal(sum(shares), totalCents(r));
});

test("unclaimed items block the split; $0 items need no claim", () => {
  const r = receipt([1000, 0, 500]);
  assert.deepEqual(unclaimedItems(r, { pb: { i1: 100 } }), ["i3"]);
  assert.deepEqual(computeShares(r, people, "pa", { pb: { i1: 100 } }), { ok: false, unclaimed: ["i3"] });
  const ok = computeShares(r, people, "pa", { pb: { i1: 100 }, pc: { i3: 100 } });
  assert.deepEqual(ok.shares, { pa: 0, pb: 1000, pc: 500 });
});

test("random bills: shares always sum exactly to the total", () => {
  for (let run = 0; run < 300; run++) {
    const n = 1 + Math.floor(Math.random() * 8);
    const prices = Array.from({ length: n }, () => Math.floor(Math.random() * 5000));
    prices[0] += 1; // at least one non-zero item
    const items = prices.reduce((a, b) => a + b, 0);
    const r = receipt(prices, {
      discountCents: Math.floor(Math.random() * items * 0.3),
      taxCents: Math.floor(Math.random() * 1500),
      tipCents: Math.floor(Math.random() * 2000),
    });
    const claims = { pa: {}, pb: {}, pc: {} };
    for (const item of r.items) {
      const claimers = people.filter(() => Math.random() < 0.5);
      for (const p of claimers.length ? claimers : [people[run % 3]]) claims[p.id][item.id] = 1 + Math.floor(Math.random() * 100);
    }
    const result = computeShares(r, people, "pa", claims);
    assert.equal(result.ok, true);
    assert.equal(sum(result.shares), totalCents(r), JSON.stringify({ prices, claims }));
    for (const c of Object.values(result.shares)) assert.ok(c >= 0);
  }
});
