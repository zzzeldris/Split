// Bills: one receipt that friends claim items from, then pay their share of. See
// .plans/receipt-claiming-spec.md. Every function returns [httpStatus, body] for server.js.
//
// Lifecycle: draft (payer reviews the scanned receipt) -> open (everyone claims items)
// -> locked (shares frozen, friends pay) -> settled (everyone paid). The payer can unlock
// a locked bill until someone's payment has started.
//
// Redis keys (all expire 7 days after the bill is created):
//   bill:{id}          hash   status, version, lockVersion, payer*, adminHash, receipt, printed, snapshot
//   bill:{id}:people   hash   personId -> { name, tokenHash, joinedAt }
//   bill:{id}:names    hash   lowercased name -> personId (HSETNX makes names unique)
//   bill:{id}:claims   hash   personId -> { itemId: pct }  (one field per person: no lost updates)
//   bill:{id}:pay      hash   personId -> { status, orderId, captureId, since }
//   bill:{id}:photo    string base64 JPEG, deleted once the bill is settled
//   order:{orderId}    string { billId, personId, lockVersion, cents }
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { computeShares, itemsCents, subtotalCents, totalCents, unclaimedItems } from "./shares.js";
import { cents } from "./receipt.js";

export const BILL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_IMAGE_BASE64 = 1_400_000; // ~1 MB image; the browser resizes to well under this
const MAX_PEOPLE = 20;
const MAX_ITEMS = 100;
const MAX_CENTS = 1_000_000;
const STALE_CAPTURE_MS = 2 * 60 * 1000; // a "capturing" mark older than this was a crashed request

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const centsToValue = (c) => (c / 100).toFixed(2);
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const sha256 = (s) => createHash("sha256").update(s).digest();
const newToken = () => randomBytes(32).toString("base64url");
const hashToken = (token) => sha256(token).toString("hex");
const parse = (json, fallback = null) => (json ? JSON.parse(json) : fallback);

function tokenMatches(token, hashHex) {
  if (!token || !hashHex) return false;
  const a = sha256(token);
  const b = Buffer.from(hashHex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

const K = {
  bill: (id) => `bill:${id}`,
  people: (id) => `bill:${id}:people`,
  names: (id) => `bill:${id}:names`,
  claims: (id) => `bill:${id}:claims`,
  pay: (id) => `bill:${id}:pay`,
  photo: (id) => `bill:${id}:photo`,
  order: (orderId) => `order:${orderId}`,
};

// Gemini's raw JSON (dollars) -> the stored receipt (cents), plus what was printed, for the review screen.
export function receiptFromScan(raw) {
  const items = [];
  let extraDiscount = 0;
  for (const item of Array.isArray(raw?.items) ? raw.items : []) {
    const price = cents(Number(item?.price) || 0);
    const name = String(item?.name ?? "").trim().slice(0, 80) || "Item";
    if (price < 0) extraDiscount += -price; // a discount printed as a negative line
    else items.push({ name, quantity: Number(item.quantity) > 0 ? Number(item.quantity) : 1, priceCents: price });
  }
  const nonNeg = (v) => Math.max(0, cents(Number(v) || 0));
  const receipt = {
    merchant: String(raw?.merchant ?? "").trim().slice(0, 100),
    items: items.slice(0, MAX_ITEMS).map((item, i) => ({ id: `i${i + 1}`, ...item })),
    discountCents: nonNeg(raw?.discount) + extraDiscount,
    taxCents: nonNeg(raw?.tax),
    tipCents: nonNeg(raw?.tip),
  };
  const printed = { subtotalCents: cents(Number(raw?.subtotal) || 0), totalCents: cents(Number(raw?.total) || 0), tipCents: receipt.tipCents };
  return { receipt, printed };
}

// Checks a receipt edited on the review screen. Item ids are reassigned: nobody has claimed anything yet.
function receiptFromInput(input) {
  if (!input || typeof input !== "object") return [null, "receipt is required"];
  const { merchant = "", items, discountCents, taxCents, tipCents } = input;
  if (typeof merchant !== "string" || merchant.length > 100) return [null, "merchant must be at most 100 characters"];
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) return [null, `A receipt needs 1 to ${MAX_ITEMS} items`];
  const clean = [];
  for (const [i, item] of items.entries()) {
    const name = typeof item?.name === "string" ? item.name.trim() : "";
    if (!name || name.length > 80) return [null, `Item ${i + 1} needs a name of at most 80 characters`];
    if (typeof item.quantity !== "number" || !(item.quantity > 0) || item.quantity > 1000) return [null, `Item ${i + 1} needs a quantity above 0`];
    if (!isInt(item.priceCents, 0, MAX_CENTS)) return [null, `Item ${i + 1} needs a price from $0 to $10,000`];
    clean.push({ id: `i${i + 1}`, name, quantity: item.quantity, priceCents: item.priceCents });
  }
  for (const [label, v] of [["discount", discountCents], ["tax", taxCents], ["tip", tipCents]]) {
    if (!isInt(v, 0, MAX_CENTS)) return [null, `${label} must be from $0 to $10,000`];
  }
  const receipt = { merchant: merchant.trim(), items: clean, discountCents, taxCents, tipCents };
  if (subtotalCents(receipt) < 0) return [null, "The discount is bigger than the items"];
  return [receipt, null];
}

export function createBills({ store, readReceiptImage, paypalPost, demoPasscode, currency = "CAD", now = () => Date.now() }) {
  const bump = (id) => store.hincrby(K.bill(id), "version", 1);

  async function loadBill(id) {
    const h = await store.hgetall(K.bill(id));
    if (!h.status) return null;
    return {
      id,
      status: h.status,
      version: Number(h.version),
      lockVersion: Number(h.lockVersion),
      expiresAt: Number(h.expiresAt),
      payer: { id: h.payerId, name: h.payerName, email: h.payerEmail },
      adminHash: h.adminHash,
      receipt: parse(h.receipt),
      printed: parse(h.printed),
      snapshot: parse(h.snapshot),
    };
  }

  async function loadPeople(id) {
    const raw = await store.hgetall(K.people(id));
    return Object.entries(raw)
      .map(([pid, json]) => ({ id: pid, ...JSON.parse(json) }))
      .sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id));
  }

  const loadClaims = async (id) =>
    Object.fromEntries(Object.entries(await store.hgetall(K.claims(id))).map(([pid, json]) => [pid, JSON.parse(json)]));

  // A "capturing" mark from a request that died mid-capture shouldn't block the bill forever.
  const loadPay = async (id) =>
    Object.fromEntries(
      Object.entries(await store.hgetall(K.pay(id))).map(([pid, json]) => {
        const p = JSON.parse(json);
        if (p.status === "capturing" && now() - p.since > STALE_CAPTURE_MS) p.status = "unpaid";
        return [pid, p];
      }),
    );

  const paymentStarted = (pay) => Object.values(pay).some((p) => ["capturing", "pending", "paid"].includes(p.status));

  async function requireAdmin(id, token) {
    const bill = await loadBill(id);
    if (!bill) return [null, [404, { error: "This bill has expired or doesn't exist" }]];
    if (!tokenMatches(token, bill.adminHash)) return [null, [403, { error: "Only the person who paid can do that" }]];
    return [bill, null];
  }

  function checkPasscode(passcode) {
    if (!demoPasscode) return true; // local development: no passcode configured
    return typeof passcode === "string" && timingSafeEqual(sha256(passcode), sha256(demoPasscode));
  }

  // ---------- Creating and reviewing ----------

  async function create({ passcode, payer, image } = {}) {
    if (!checkPasscode(passcode)) return [401, { error: "Wrong demo passcode" }];
    const name = typeof payer?.name === "string" ? payer.name.trim() : "";
    if (!name || name.length > 30) return [400, { error: "Enter your name (at most 30 characters)" }];
    if (typeof payer.email !== "string" || !EMAIL_RE.test(payer.email) || payer.email.length > 120) {
      return [400, { error: "Enter a valid PayPal email" }];
    }
    if (!IMAGE_TYPES.has(image?.mimeType) || typeof image.data !== "string" || image.data.length === 0) {
      return [400, { error: "Upload a JPEG, PNG or WebP photo of the receipt" }];
    }
    if (image.data.length > MAX_IMAGE_BASE64) return [413, { error: "The photo is too large" }];

    let scan;
    try {
      scan = receiptFromScan(await readReceiptImage(image));
    } catch (err) {
      console.error("Gemini failed to read a receipt:", err.message);
      return [502, { error: "Couldn't read that receipt. Try a clearer photo." }];
    }
    if (scan.receipt.items.length === 0) return [422, { error: "No items found on that receipt. Try a clearer photo." }];

    const id = randomUUID();
    const payerId = randomBytes(4).toString("hex");
    const adminToken = newToken();
    const payerToken = newToken();
    const createdAt = now();
    const expiresAt = createdAt + BILL_TTL_MS;

    await store.multi([
      ["HSET", K.bill(id),
        "status", "draft", "version", 1, "lockVersion", 0, "createdAt", createdAt, "expiresAt", expiresAt,
        "payerId", payerId, "payerName", name, "payerEmail", payer.email.trim(), "adminHash", hashToken(adminToken),
        "receipt", JSON.stringify(scan.receipt), "printed", JSON.stringify(scan.printed), "snapshot", ""],
      ["HSET", K.people(id), payerId, JSON.stringify({ name, tokenHash: hashToken(payerToken), joinedAt: createdAt })],
      ["HSET", K.names(id), name.toLocaleLowerCase(), payerId],
      ["HSET", K.claims(id), payerId, "{}"],
      ["SET", K.photo(id), image.data],
      ...[K.bill(id), K.people(id), K.names(id), K.claims(id), K.photo(id)].map((k) => ["PEXPIREAT", k, expiresAt]),
    ]);
    // `found` lets the "reading" screen show what the AI found before it moves on.
    const found = { merchant: scan.receipt.merchant, items: scan.receipt.items.map(({ name, priceCents }) => ({ name, priceCents })) };
    return [201, { billId: id, adminToken, payerId, payerToken, found }];
  }

  async function updateReceipt(id, adminToken, body = {}) {
    const [bill, err] = await requireAdmin(id, adminToken);
    if (err) return err;
    if (bill.status !== "draft") return [409, { error: "The receipt can only be edited before it's opened for claiming" }];
    const [receipt, problem] = receiptFromInput(body.receipt);
    if (problem) return [400, { error: problem }];
    await store.hset(K.bill(id), { receipt: JSON.stringify(receipt) });
    await bump(id);
    return [200, { ok: true }];
  }

  async function open(id, adminToken) {
    const [bill, err] = await requireAdmin(id, adminToken);
    if (err) return err;
    if (bill.status !== "draft") return [409, { error: "This bill is already open" }];
    if (itemsCents(bill.receipt) === 0) return [400, { error: "Every item is $0.00" }];
    await store.hset(K.bill(id), { status: "open" });
    await bump(id);
    return [200, { ok: true }];
  }

  // ---------- Reading ----------

  async function view(id, adminToken, since) {
    const bill = await loadBill(id);
    if (!bill) return [404, { error: "This bill has expired or doesn't exist" }];
    if (since != null && Number(since) === bill.version) return [304, null];

    const [people, claims, pay, hasPhoto] = await Promise.all([
      loadPeople(id), loadClaims(id), loadPay(id), store.get(K.photo(id)).then(Boolean),
    ]);
    const isAdmin = tokenMatches(adminToken, bill.adminHash);
    return [200, {
      id,
      status: bill.status,
      version: bill.version,
      currency,
      isAdmin,
      payer: { id: bill.payer.id, name: bill.payer.name },
      receipt: { ...bill.receipt, itemsCents: itemsCents(bill.receipt), subtotalCents: subtotalCents(bill.receipt), totalCents: totalCents(bill.receipt) },
      printed: bill.printed,
      people: people.map((p) => ({ id: p.id, name: p.name, taken: Boolean(p.tokenHash) })),
      claims,
      unclaimed: unclaimedItems(bill.receipt, claims),
      shares: bill.snapshot?.shares ?? null,
      pay: Object.fromEntries(Object.entries(pay).map(([pid, p]) => [pid, p.status === "capturing" ? "unpaid" : p.status])),
      unlockable: bill.status === "locked" && !paymentStarted(pay),
      hasPhoto,
      expiresAt: bill.expiresAt,
    }];
  }

  async function photo(id) {
    const data = await store.get(K.photo(id));
    return data ? Buffer.from(data, "base64") : null;
  }

  // ---------- People and claims ----------

  async function join(id, body = {}) {
    const bill = await loadBill(id);
    if (!bill) return [404, { error: "This bill has expired or doesn't exist" }];
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 30) return [400, { error: "Enter a name of at most 30 characters" }];
    const key = name.toLocaleLowerCase();
    const token = newToken();

    const existingId = await store.hget(K.names(id), key);
    if (existingId) {
      // Picking a name from the list. Only works if nobody holds it (new, or reset by the payer).
      if (!["open", "locked"].includes(bill.status)) return [409, { error: "This bill isn't open yet" }];
      const person = parse(await store.hget(K.people(id), existingId));
      if (person.tokenHash) return [409, { error: "Someone already picked that name" }];
      await store.hset(K.people(id), { [existingId]: JSON.stringify({ ...person, tokenHash: hashToken(token) }) });
      await bump(id);
      return [200, { personId: existingId, personToken: token, name: person.name }];
    }

    if (bill.status !== "open") return [409, { error: "New people can only join while items are being claimed" }];
    if ((await loadPeople(id)).length >= MAX_PEOPLE) return [409, { error: `A bill can have at most ${MAX_PEOPLE} people` }];
    const personId = randomBytes(4).toString("hex");
    if (!(await store.hsetnx(K.names(id), key, personId))) return [409, { error: "Someone already picked that name" }];
    await store.hset(K.people(id), { [personId]: JSON.stringify({ name, tokenHash: hashToken(token), joinedAt: now() }) });
    await store.hset(K.claims(id), { [personId]: "{}" });
    await bump(id);
    return [201, { personId, personToken: token, name }];
  }

  async function setClaims(id, personId, personToken, body = {}) {
    const bill = await loadBill(id);
    if (!bill) return [404, { error: "This bill has expired or doesn't exist" }];
    const person = parse(await store.hget(K.people(id), personId));
    if (!person || !tokenMatches(personToken, person.tokenHash)) {
      return [401, { error: "You're not signed in as this person. Pick your name again." }];
    }
    if (bill.status !== "open") return [409, { error: "The bill is locked, so claims can't change" }];

    const input = body.claims;
    if (!input || typeof input !== "object" || Array.isArray(input)) return [400, { error: "claims must be { itemId: percent }" }];
    const itemIds = new Set(bill.receipt.items.map((item) => item.id));
    const clean = {};
    for (const [itemId, pct] of Object.entries(input)) {
      if (!itemIds.has(itemId)) return [400, { error: `Unknown item ${itemId}` }];
      if (!isInt(pct, 0, 100)) return [400, { error: "Percentages must be whole numbers from 0 to 100" }];
      if (pct > 0) clean[itemId] = pct;
    }
    await store.hset(K.claims(id), { [personId]: JSON.stringify(clean) });
    await bump(id);
    return [200, { ok: true }];
  }

  async function resetPerson(id, adminToken, personId) {
    const [, err] = await requireAdmin(id, adminToken);
    if (err) return err;
    const person = parse(await store.hget(K.people(id), personId));
    if (!person) return [404, { error: "No such person" }];
    await store.hset(K.people(id), { [personId]: JSON.stringify({ ...person, tokenHash: null }) });
    await bump(id);
    return [200, { ok: true }];
  }

  // ---------- Locking ----------

  async function lock(id, adminToken) {
    const [bill, err] = await requireAdmin(id, adminToken);
    if (err) return err;
    if (bill.status !== "open") return [409, { error: "Only an open bill can be locked" }];

    const [people, claims] = await Promise.all([loadPeople(id), loadClaims(id)]);
    const result = computeShares(bill.receipt, people, bill.payer.id, claims);
    if (!result.ok) return [409, { error: "Some items haven't been claimed yet", unclaimed: result.unclaimed }];

    const lockVersion = bill.lockVersion + 1;
    const owing = Object.entries(result.shares).filter(([pid, c]) => pid !== bill.payer.id && c > 0);
    const status = owing.length === 0 ? "settled" : "locked"; // the payer had everything: nothing to collect
    await store.multi([
      ["HSET", K.bill(id), "status", status, "lockVersion", lockVersion, "snapshot", JSON.stringify({ lockVersion, shares: result.shares })],
      ["HINCRBY", K.bill(id), "version", 1],
      ...(status === "settled" ? [["DEL", K.photo(id)]] : []),
    ]);
    return [200, { ok: true, shares: result.shares }];
  }

  async function unlock(id, adminToken) {
    const [bill, err] = await requireAdmin(id, adminToken);
    if (err) return err;
    if (bill.status !== "locked") return [409, { error: "Only a locked bill can be unlocked" }];
    if (paymentStarted(await loadPay(id))) return [409, { error: "Someone has started paying, so the bill can't change now" }];
    await store.multi([
      ["HSET", K.bill(id), "status", "open", "snapshot", ""],
      ["HINCRBY", K.bill(id), "version", 1],
    ]);
    return [200, { ok: true }];
  }

  // ---------- Paying ----------

  // Body: { billId, personId }. Anyone may pay a share: paying for someone else does no harm.
  // The money goes straight to the payer's PayPal account (payee override), not to this app's account.
  async function createOrder({ billId, personId } = {}) {
    const bill = typeof billId === "string" ? await loadBill(billId) : null;
    if (!bill) return [404, { error: "This bill has expired or doesn't exist" }];
    if (bill.status !== "locked") return [409, { error: "This bill isn't ready for payment" }];
    const shareCents = bill.snapshot.shares[personId];
    if (personId === bill.payer.id || !(shareCents > 0)) return [404, { error: "That person doesn't owe anything on this bill" }];
    const pay = await loadPay(billId);
    if (["capturing", "pending", "paid"].includes(pay[personId]?.status)) {
      return [409, { error: `This share is already ${pay[personId].status === "capturing" ? "being paid" : pay[personId].status}` }];
    }

    const person = parse(await store.hget(K.people(billId), personId));
    const what = bill.receipt.merchant ? ` of ${bill.receipt.merchant}` : "";
    const { status, data } = await paypalPost("/v2/checkout/orders", {
      intent: "CAPTURE",
      purchase_units: [{
        payee: { email_address: bill.payer.email },
        description: `${person.name}'s share${what}`.slice(0, 127),
        amount: { currency_code: currency, value: centsToValue(shareCents) },
      }],
    });
    if (status !== 201) return [502, { error: "Could not create PayPal order" }];

    await store.set(K.order(data.id), JSON.stringify({ billId, personId, lockVersion: bill.lockVersion, cents: shareCents }));
    await store.pexpireat(K.order(data.id), bill.expiresAt);
    await store.hset(K.pay(billId), { [personId]: JSON.stringify({ status: "unpaid", orderId: data.id }) });
    await store.pexpireat(K.pay(billId), bill.expiresAt);
    return [200, { id: data.id }];
  }

  async function captureOrder(orderId) {
    // Only capture orders this server created for a bill.
    const ref = parse(await store.get(K.order(orderId)));
    if (!ref) return [404, { error: "Unknown order" }];
    const bill = await loadBill(ref.billId);
    // If the payer unlocked and relocked, this order is for an old amount. Refuse before charging anyone.
    if (!bill || bill.status !== "locked" || bill.lockVersion !== ref.lockVersion || bill.snapshot.shares[ref.personId] !== ref.cents) {
      return [409, { error: "The bill changed after this payment started. Reload the page and pay again." }];
    }
    const prev = (await loadPay(ref.billId))[ref.personId];
    if (["capturing", "pending", "paid"].includes(prev?.status)) return [409, { error: "This share is already being paid" }];

    // Mark the share as being paid so the payer can't unlock while PayPal captures it.
    const setPay = async (p) => {
      await store.hset(K.pay(ref.billId), { [ref.personId]: JSON.stringify({ orderId, ...p }) });
      await bump(ref.billId);
    };
    await setPay({ status: "capturing", since: now() });

    let result;
    try {
      result = await paypalPost(`/v2/checkout/orders/${orderId}/capture`);
    } catch (err) {
      await setPay({ status: "unpaid" });
      throw err;
    }
    const { status, data } = result;
    if (status === 422 && data.details?.[0]?.issue === "INSTRUMENT_DECLINED") {
      await setPay({ status: "unpaid" });
      return [422, { error: "INSTRUMENT_DECLINED" }];
    }
    if (status !== 201) {
      await setPay({ status: "unpaid" });
      return [502, { error: "Could not capture PayPal order" }];
    }

    // Report the capture's status, not the order's: an order can be COMPLETED while its
    // capture is still PENDING (e.g. under review).
    const capture = data.purchase_units?.[0]?.payments?.captures?.[0];
    const amountMatches = capture?.amount?.currency_code === currency && capture?.amount?.value === centsToValue(ref.cents);
    if (!amountMatches) {
      console.error(`Capture ${capture?.id} amount ${JSON.stringify(capture?.amount)} doesn't match share of ${ref.cents} cents`);
      await setPay({ status: "unpaid", captureId: capture?.id });
    } else if (capture.status === "COMPLETED" || capture.status === "PENDING") {
      await setPay({ status: capture.status === "COMPLETED" ? "paid" : "pending", captureId: capture.id });
      await settleIfDone(bill);
    } else {
      await setPay({ status: "unpaid", captureId: capture?.id });
    }
    return [200, { status: capture?.status, captureId: capture?.id, amount: capture?.amount }];
  }

  async function settleIfDone(bill) {
    const pay = await loadPay(bill.id);
    const owing = Object.entries(bill.snapshot.shares).filter(([pid, c]) => pid !== bill.payer.id && c > 0);
    if (owing.every(([pid]) => pay[pid]?.status === "paid")) {
      await store.multi([
        ["HSET", K.bill(bill.id), "status", "settled"],
        ["HINCRBY", K.bill(bill.id), "version", 1],
        ["DEL", K.photo(bill.id)],
      ]);
    }
  }

  return { create, updateReceipt, open, view, photo, join, setClaims, resetPerson, lock, unlock, createOrder, captureOrder };
}
