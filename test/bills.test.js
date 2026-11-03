// The whole bill lifecycle against the in-memory store, with fake Gemini and PayPal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../lib/store.js";
import { createBills, receiptFromScan } from "../lib/bills.js";

const SCAN = {
  merchant: "Test Diner",
  items: [
    { name: "Burger", quantity: 1, price: 20 },
    { name: "Fries", quantity: 1, price: 6 },
    { name: "Lemonade", quantity: 2, price: 10 },
  ],
  discount: 0, subtotal: 36, tax: 4.68, tip: 0, total: 40.68,
};
const IMAGE = { mimeType: "image/jpeg", data: Buffer.from("fake jpeg").toString("base64") };

function setup({ passcode = "letmein" } = {}) {
  const orders = new Map();
  let nextOrder = 1;
  const paypalPost = async (path, body) => {
    if (path === "/v2/checkout/orders") {
      const id = `ORDER${nextOrder++}`;
      orders.set(id, body.purchase_units[0]);
      return { status: 201, data: { id } };
    }
    const id = path.split("/")[4];
    const unit = orders.get(id);
    return { status: 201, data: { purchase_units: [{ payments: { captures: [{ id: `CAP-${id}`, status: "COMPLETED", amount: unit.amount }] } }] } };
  };
  const bills = createBills({
    store: createStore({}),
    readReceiptImage: async () => structuredClone(SCAN),
    paypalPost,
    demoPasscode: passcode,
  });
  return { bills, orders };
}

async function openBill(bills) {
  const [status, created] = await bills.create({ passcode: "letmein", payer: { name: "Angela", email: "angela@example.com" }, image: IMAGE });
  assert.equal(status, 201);
  const { billId, adminToken, payerId, payerToken } = created;
  assert.deepEqual(await bills.open(billId, adminToken), [200, { ok: true }]);
  const [, ben] = await bills.join(billId, { name: "Ben" });
  const [, chris] = await bills.join(billId, { name: "Chris" });
  return { billId, adminToken, payerId, payerToken, ben, chris };
}

test("receiptFromScan turns dollars into cents and negative lines into discount", () => {
  const { receipt, printed } = receiptFromScan({ ...SCAN, items: [...SCAN.items, { name: "Coupon", quantity: 1, price: -2.5 }] });
  assert.deepEqual(receipt.items.map((i) => [i.id, i.priceCents]), [["i1", 2000], ["i2", 600], ["i3", 1000]]);
  assert.equal(receipt.discountCents, 250);
  assert.equal(printed.totalCents, 4068);
});

test("wrong passcode is refused before Gemini is called", async () => {
  const { bills } = setup();
  const [status] = await bills.create({ passcode: "nope", payer: { name: "A", email: "a@example.com" }, image: IMAGE });
  assert.equal(status, 401);
});

test("full flow: claim, lock, pay, settle", async () => {
  const { bills, orders } = setup();
  const { billId, adminToken, payerId, payerToken, ben, chris } = await openBill(bills);

  // Each person sets only their own claims.
  assert.equal((await bills.setClaims(billId, payerId, payerToken, { claims: { i1: 100 } }))[0], 200);
  assert.equal((await bills.setClaims(billId, ben.personId, ben.personToken, { claims: { i2: 100, i3: 50 } }))[0], 200);
  assert.equal((await bills.setClaims(billId, ben.personId, chris.personToken, { claims: { i1: 100 } }))[0], 401);

  // Lemonade isn't fully covered by Ben's 50%, but it is claimed: normalization gives it all to Ben.
  // Chris claims nothing, so locking works and Chris owes 0.
  let [status, body] = await bills.lock(billId, adminToken);
  assert.equal(status, 200);
  // Items 2000 / 1600 of 3600, total 4068: Angela 2260, Ben 1808.
  assert.deepEqual(body.shares, { [payerId]: 2260, [ben.personId]: 1808, [chris.personId]: 0 });

  // Claims can't change once locked.
  assert.equal((await bills.setClaims(billId, chris.personId, chris.personToken, { claims: { i3: 50 } }))[0], 409);

  // Unlock, let Chris claim, lock again.
  assert.equal((await bills.unlock(billId, adminToken))[0], 200);
  await bills.setClaims(billId, chris.personId, chris.personToken, { claims: { i3: 50 } });
  [, body] = await bills.lock(billId, adminToken);
  assert.deepEqual(body.shares, { [payerId]: 2260, [ben.personId]: 1243, [chris.personId]: 565 });

  // The payer has nothing to pay.
  assert.equal((await bills.createOrder({ billId, personId: payerId }))[0], 404);

  // Ben pays: the order goes to the payer's email for exactly Ben's share.
  const [, order] = await bills.createOrder({ billId, personId: ben.personId });
  assert.deepEqual(orders.get(order.id).payee, { email_address: "angela@example.com" });
  assert.equal(orders.get(order.id).amount.value, "12.43");
  assert.equal((await bills.captureOrder(order.id))[1].status, "COMPLETED");

  // After a payment, the bill can't be unlocked.
  assert.equal((await bills.unlock(billId, adminToken))[0], 409);

  let [, v] = await bills.view(billId, null);
  assert.equal(v.status, "locked");
  assert.equal(v.pay[ben.personId], "paid");
  assert.equal(v.hasPhoto, true);

  const [, order2] = await bills.createOrder({ billId, personId: chris.personId });
  await bills.captureOrder(order2.id);
  [, v] = await bills.view(billId, null);
  assert.equal(v.status, "settled");
  assert.equal(v.hasPhoto, false);
});

test("an order from before an unlock can't be captured", async () => {
  const { bills } = setup();
  const { billId, adminToken, payerId, payerToken, ben } = await openBill(bills);
  await bills.setClaims(billId, payerId, payerToken, { claims: { i1: 100, i2: 100 } });
  await bills.setClaims(billId, ben.personId, ben.personToken, { claims: { i3: 100 } });
  await bills.lock(billId, adminToken);
  const [, stale] = await bills.createOrder({ billId, personId: ben.personId });

  await bills.unlock(billId, adminToken);
  await bills.setClaims(billId, ben.personId, ben.personToken, { claims: { i2: 100, i3: 100 } });
  await bills.lock(billId, adminToken);

  assert.equal((await bills.captureOrder(stale.id))[0], 409);
  const [, fresh] = await bills.createOrder({ billId, personId: ben.personId });
  assert.equal((await bills.captureOrder(fresh.id))[0], 200);
});

test("locking is refused while an item is unclaimed", async () => {
  const { bills } = setup();
  const { billId, adminToken, ben } = await openBill(bills);
  await bills.setClaims(billId, ben.personId, ben.personToken, { claims: { i1: 100 } });
  const [status, body] = await bills.lock(billId, adminToken);
  assert.equal(status, 409);
  assert.deepEqual(body.unclaimed, ["i2", "i3"]);
});

test("names are unique, and a reset name can be picked again", async () => {
  const { bills } = setup();
  const { billId, adminToken, ben } = await openBill(bills);
  assert.equal((await bills.join(billId, { name: "ben" }))[0], 409);
  assert.equal((await bills.resetPerson(billId, "wrong-token", ben.personId))[0], 403);
  await bills.setClaims(billId, ben.personId, ben.personToken, { claims: { i2: 100 } });
  assert.equal((await bills.resetPerson(billId, adminToken, ben.personId))[0], 200);

  const [status, again] = await bills.join(billId, { name: "Ben" });
  assert.equal(status, 200);
  assert.equal(again.personId, ben.personId);
  // The old device's token no longer works; the claims are kept.
  assert.equal((await bills.setClaims(billId, ben.personId, ben.personToken, { claims: {} }))[0], 401);
  const [, v] = await bills.view(billId, null);
  assert.deepEqual(v.claims[ben.personId], { i2: 100 });
});

test("view returns 304 when nothing changed, and hides the payer's email", async () => {
  const { bills } = setup();
  const { billId, adminToken } = await openBill(bills);
  const [, v] = await bills.view(billId, adminToken);
  assert.equal(v.isAdmin, true);
  assert.equal(JSON.stringify(v).includes("angela@example.com"), false);
  assert.equal((await bills.view(billId, null, v.version))[0], 304);
});

test("the receipt can be edited only while it's a draft", async () => {
  const { bills } = setup();
  const [, { billId, adminToken }] = await bills.create({ passcode: "letmein", payer: { name: "A", email: "a@example.com" }, image: IMAGE });
  const receipt = { merchant: "X", items: [{ name: "Soup", quantity: 1, priceCents: 900 }], discountCents: 0, taxCents: 117, tipCents: 150 };
  assert.equal((await bills.updateReceipt(billId, adminToken, { receipt }))[0], 200);
  const [, v] = await bills.view(billId, adminToken);
  assert.equal(v.receipt.totalCents, 1167);
  await bills.open(billId, adminToken);
  assert.equal((await bills.updateReceipt(billId, adminToken, { receipt }))[0], 409);
});
