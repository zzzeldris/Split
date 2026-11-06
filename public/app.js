// One page for the whole flow. The URL decides the bill: /?b=<billId>. The payer's admin token
// arrives once in the URL fragment (#admin=...), which browsers never send to the server,
// and is then kept in localStorage.
import { computeShares, itemClaims } from "/lib/shares.js";

const app = document.getElementById("app");
const toastEl = document.getElementById("toast");
const params = new URLSearchParams(location.search);
const BILL_ID = params.get("b");
const SHOW_LOGIN = params.has("login");
const POLL_MS = 2500;

let config;
let bill = null; // the server's view of the bill
let me = null; // { personId, token } for this device
let adminToken = null;
let myClaims = {}; // this device's claims; the source of truth while editing
let zeroed = {}; // items this device explicitly set to 0%, so the 0% chip can show as chosen (the server stores no 0 claims)
let draft = null; // the payer's editable receipt while reviewing
let renderPending = false;
let pointerDown = false; // a tap is in progress: re-rendering now would swallow its click

// ---------- Small helpers ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const money = (cents) => new Intl.NumberFormat("en-CA", { style: "currency", currency: config?.currency ?? "CAD" }).format(cents / 100);
const toCents = (text) => {
  const n = Number(String(text).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const dollarsText = (cents) => (cents / 100).toFixed(2);

const storage = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } },
  del(key) { try { localStorage.removeItem(key); } catch { /* private mode */ } },
};

let toastTimer;
function toast(text, kind = "info") {
  toastEl.textContent = text;
  toastEl.className = kind;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 4000);
}

async function api(method, path, body, token) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = res.status === 304 ? null : await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

const nameOf = (personId) => bill.people.find((p) => p.id === personId)?.name ?? "Someone";
const isPayer = () => me?.personId === bill.payer.id;

// ---------- Loading and polling ----------

async function refresh() {
  const { status, data } = await api("GET", `/api/bills/${BILL_ID}${bill ? `?since=${bill.version}` : ""}`, undefined, adminToken);
  if (status === 304) return false;
  if (status !== 200) throw Object.assign(new Error(data?.error ?? "Couldn't load the bill"), { status });
  bill = data;
  if (me && !bill.people.some((p) => p.id === me.personId)) forgetMe();
  return true;
}

function forgetMe() {
  me = null;
  myClaims = {};
  storage.del(`person:${BILL_ID}`);
  zeroed = {};
  storage.del(`zero:${BILL_ID}`);
}

let pollTimer;
function schedulePoll(delay = POLL_MS) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, delay);
}

async function poll() {
  if (document.hidden) return; // resumed by visibilitychange
  try {
    if (await refresh()) render();
    schedulePoll();
  } catch (err) {
    if (err.status === 404) {
      bill = null;
      return render();
    }
    schedulePoll(10_000);
  }
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && BILL_ID) poll();
});

// Don't rebuild the page under someone's fingers: wait until they leave the field or finish the tap.
function render() {
  if (pointerDown || (app.contains(document.activeElement) && document.activeElement.tagName === "INPUT")) {
    renderPending = true;
    return;
  }
  renderPending = false;
  if (!BILL_ID) return SHOW_LOGIN ? renderLogin() : renderCreate();
  if (!bill) return renderMissing();
  if (bill.status === "draft") return bill.isAdmin ? renderReview() : renderWaiting();
  if (bill.status === "open") return me ? renderClaims() : renderPickName();
  return renderPayment();
}
app.addEventListener("focusout", () => setTimeout(() => renderPending && render(), 0));
app.addEventListener("pointerdown", () => (pointerDown = true), true);
const releasePointer = () => setTimeout(() => {
  pointerDown = false;
  if (renderPending) render();
}, 50); // after the click event, which fires right after pointerup
document.addEventListener("pointerup", releasePointer, true);
document.addEventListener("pointercancel", releasePointer, true);

// ---------- Create ----------

const CLOSE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
const CAMERA_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>`;
// Decorative loop that fills the empty scan card: a receipt is scanned, splits into coins and each coin
// flies to a friend with their share. Pure SVG + CSS (see .split-anim in style.css).
const SPLIT_ANIMATION = `
  <svg class="split-anim" viewBox="0 0 300 300" aria-hidden="true" focusable="false">
    <g class="sa-receipt">
      <path d="M100 30h100v120l-10-8-10 8-10-8-10 8-10-8-10 8-10-8-10 8-10-8-10 8z"/>
      <path class="sa-lines" d="M114 52h44M114 70h72M114 88h58M114 106h72M114 124h36"/>
    </g>
    <rect class="sa-scan" x="94" y="30" width="112" height="4" rx="2"/>
    ${[["a", -78], ["b", 0], ["c", 78]].map(([k, dx]) => `
      <g class="sa-chip sa-${k}" style="--dx:${dx}px;--dy:148px"><circle cx="150" cy="78" r="14"/><text x="150" y="83.5">$</text></g>`).join("")}
    ${[["a", 72, "A", "$12.40"], ["b", 150, "B", "$18.20"], ["c", 228, "C", "$9.10"]].map(([k, x, who, amount]) => `
      <g class="sa-avatar sa-${k}"><circle cx="${x}" cy="226" r="24"/><text x="${x}" y="232">${who}</text></g>
      <text class="sa-amount sa-${k}" x="${x}" y="270">${amount}</text>`).join("")}
  </svg>`;

function renderCreate() {
  app.innerHTML = `
    <form class="stack" id="create">
      <div class="scan-card" id="scan-card">
        <span class="corner tl"></span><span class="corner tr"></span><span class="corner bl"></span><span class="corner br"></span>
        <div class="scan-hint" id="scan-hint">
          ${SPLIT_ANIMATION}
        </div>
      </div>
      <label class="scan-action">
        <span class="scan-btn">${CAMERA_ICON}<input class="visually-hidden" name="photo" type="file" accept="image/*" required></span>
        <span id="scan-label">Scan receipt</span>
      </label>
      <section class="card stack" id="details" hidden>
        ${config.passcodeRequired ? `<label>Demo passcode<input name="passcode" required autocomplete="off"></label>` : ""}
        <label>Your name<input name="name" required maxlength="30" autocomplete="given-name"></label>
        <label>Your PayPal email<input name="email" type="email" required autocomplete="email"></label>
        <p class="small muted">Demo: no receipts with personal or card details.</p>
        <button class="primary" type="submit">Read receipt</button>
        <p class="error-text small" id="create-error"></p>
      </section>
    </form>`;

  // Show the chosen photo inside the frame so you can see what will be read, and only then ask for
  // the payer's details. Removing the photo hides them again.
  const photoInput = app.querySelector("input[name=photo]");
  const details = document.getElementById("details");
  const hint = document.getElementById("scan-hint");
  photoInput.addEventListener("change", () => {
    const card = document.getElementById("scan-card");
    card.querySelector("img")?.remove();
    const file = photoInput.files[0];
    details.hidden = !file;
    hint.hidden = !!file; // stops the animation behind the photo
    if (!file) {
      document.getElementById("scan-label").textContent = "Scan receipt";
      return;
    }
    const img = document.createElement("img");
    img.alt = "Your receipt photo";
    img.src = URL.createObjectURL(file);
    card.prepend(img);
    document.getElementById("scan-label").textContent = "Retake photo";
    const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
    details.scrollIntoView({ block: "nearest", behavior: calm ? "auto" : "smooth" });
  });

  const form = document.getElementById("create");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button");
    const errorEl = document.getElementById("create-error");
    const fields = new FormData(form);
    button.disabled = true;
    errorEl.textContent = "";
    try {
      button.textContent = "Shrinking photo…";
      const image = await resizeImage(fields.get("photo"));
      button.textContent = "Reading receipt with Gemini…";
      const { ok, data } = await api("POST", "/api/bills", {
        passcode: fields.get("passcode") ?? undefined,
        payer: { name: fields.get("name"), email: fields.get("email") },
        image,
      });
      if (!ok) throw new Error(data.error ?? "Something went wrong");
      storage.set(`admin:${data.billId}`, data.adminToken);
      storage.set(`person:${data.billId}`, { personId: data.payerId, token: data.payerToken });
      location.href = `/?b=${data.billId}`;
    } catch (err) {
      errorEl.textContent = err.message;
      button.disabled = false;
      button.textContent = "Read receipt";
    }
  });
}

// Scale to at most 1600 px on the long side and re-encode as JPEG, so uploads stay small.
async function resizeImage(file) {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("That file isn't an image this browser can read. Try a JPEG or PNG.");
  });
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  const dataUrl = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
  return { mimeType: "image/jpeg", data: dataUrl.slice(dataUrl.indexOf(",") + 1) };
}

// ---------- Log in (placeholder) ----------
// Planned: "Log in with PayPal" (OAuth) so the payer doesn't re-enter their name and email.
// Not wired up yet, so the button only says so.

function renderLogin() {
  app.innerHTML = `
    <a class="icon-btn left" href="/" aria-label="Back to scan">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>
    </a>
    <section class="card stack" style="gap:20px">
      <div class="stack">
        <h1>Log in</h1>
      </div>
      <button class="primary" id="paypal-login">Continue with PayPal</button>
    </section>`;
  document.getElementById("paypal-login").addEventListener("click", () => toast("PayPal login isn't connected yet."));
}

// ---------- Review (payer, draft) ----------

function draftTotals() {
  const items = draft.items.reduce((s, i) => s + i.priceCents, 0);
  const subtotal = items - draft.discountCents;
  return { items, subtotal, total: subtotal + draft.taxCents + draft.tipCents };
}

function renderReview() {
  draft ??= structuredClone({ ...bill.receipt });
  const t = draftTotals();
  const printed = bill.printed;
  const checks = [];
  if (printed.subtotalCents && t.subtotal !== printed.subtotalCents) {
    checks.push(`Items minus discount come to ${money(t.subtotal)}, but the receipt's subtotal is ${money(printed.subtotalCents)} (${t.subtotal > printed.subtotalCents ? "+" : "−"}${money(Math.abs(t.subtotal - printed.subtotalCents))}).`);
  }
  if (printed.totalCents && t.total !== printed.totalCents) {
    checks.push(`The total here is ${money(t.total)}, the receipt says ${money(printed.totalCents)}. That's fine if you changed the tip.`);
  }
  const tipPcts = [15, 18, 20];

  app.innerHTML = `
    <header class="stack">
      <h1>Check the receipt</h1>
      <button class="link small" id="photo" style="justify-self:start">View receipt photo</button>
    </header>
    ${checks.map((c) => `<p class="notice warn">${esc(c)}</p>`).join("")}
    <section class="card stack">
      <label>Place<input data-field="merchant" value="${esc(draft.merchant)}" maxlength="100"></label>
      <h2 class="section-title">Items</h2>
      <div class="edit-list">
        ${draft.items.map((item, i) => `
          <div class="edit-item">
            <div class="edit-top">
              <input aria-label="Item name" data-item="${i}" data-key="name" value="${esc(item.name)}" maxlength="80" placeholder="Item name">
              <button class="icon-only" aria-label="Remove ${esc(item.name) || "item"}" data-remove="${i}">${CLOSE_ICON}</button>
            </div>
            <div class="edit-bottom">
              <label class="mini">Qty<input data-item="${i}" data-key="quantity" value="${item.quantity}" inputmode="decimal"></label>
              <label class="mini">Price<input class="num" data-item="${i}" data-key="price" value="${dollarsText(item.priceCents)}" inputmode="decimal"></label>
            </div>
          </div>`).join("")}
      </div>
      <button id="add-item">+ Add item</button>
    </section>
    <section class="card stack">
      <div class="money-row"><span>Items</span><span class="num">${money(t.items)}</span></div>
      <div class="money-row"><label for="discount">Discount</label><input id="discount" class="num" data-money="discountCents" value="${dollarsText(draft.discountCents)}" inputmode="decimal"></div>
      <div class="money-row"><span>Subtotal</span><span class="num">${money(t.subtotal)}</span></div>
      <div class="money-row"><label for="tax">Tax</label><input id="tax" class="num" data-money="taxCents" value="${dollarsText(draft.taxCents)}" inputmode="decimal"></div>
      <div class="money-row"><label for="tip">Tip${printed.tipCents ? " (from receipt)" : ""}</label><input id="tip" class="num" data-money="tipCents" value="${dollarsText(draft.tipCents)}" inputmode="decimal"></div>
      <div class="chips" role="group" aria-label="Tip percentage">
        ${tipPcts.map((p) => `<button data-tip="${p}" aria-pressed="${draft.tipCents === Math.round(t.subtotal * p / 100)}">${p}%</button>`).join("")}
        <button data-tip="0" aria-pressed="${draft.tipCents === 0}">None</button>
      </div>
      <div class="money-row total-row"><strong>Total</strong><strong class="num">${money(t.total)}</strong></div>
    </section>
    <div class="footer"><div class="stack">
      <p class="error-text small" id="review-error"></p>
      <button class="primary" id="open">Looks right: let friends claim items</button>
    </div></div>`;

  // Typing updates the draft without re-rendering (so the field keeps focus); leaving it re-renders totals.
  app.querySelectorAll("input[data-item]").forEach((input) =>
    input.addEventListener("input", () => {
      const item = draft.items[Number(input.dataset.item)];
      if (input.dataset.key === "name") item.name = input.value;
      if (input.dataset.key === "quantity") item.quantity = Number(input.value) || 1;
      if (input.dataset.key === "price") item.priceCents = toCents(input.value);
      renderPending = true;
    }));
  app.querySelectorAll("input[data-money]").forEach((input) =>
    input.addEventListener("input", () => { draft[input.dataset.money] = toCents(input.value); renderPending = true; }));
  app.querySelector("[data-field=merchant]").addEventListener("input", (e) => { draft.merchant = e.target.value; });
  app.querySelectorAll("[data-remove]").forEach((b) => b.addEventListener("click", () => {
    draft.items.splice(Number(b.dataset.remove), 1);
    renderReview();
  }));
  document.getElementById("add-item").addEventListener("click", () => {
    draft.items.push({ name: "", quantity: 1, priceCents: 0 });
    renderReview();
    app.querySelector(`input[data-item="${draft.items.length - 1}"]`).focus();
  });
  app.querySelectorAll("[data-tip]").forEach((b) => b.addEventListener("click", () => {
    draft.tipCents = Math.round(draftTotals().subtotal * Number(b.dataset.tip) / 100);
    renderReview();
  }));
  document.getElementById("photo").addEventListener("click", () => window.open(`/api/bills/${BILL_ID}/photo`, "_blank"));
  document.getElementById("open").addEventListener("click", async (e) => {
    e.target.disabled = true;
    const errorEl = document.getElementById("review-error");
    const receipt = { ...draft, items: draft.items.map(({ name, quantity, priceCents }) => ({ name: name.trim(), quantity, priceCents })) };
    let res = await api("PUT", `/api/bills/${BILL_ID}/receipt`, { receipt }, adminToken);
    if (res.ok) res = await api("POST", `/api/bills/${BILL_ID}/open`, {}, adminToken);
    if (!res.ok) {
      errorEl.textContent = res.data.error ?? "Couldn't save the receipt";
      e.target.disabled = false;
      return;
    }
    draft = null;
    await refresh();
    render();
  });
}

function renderWaiting() {
  app.innerHTML = `
    <section class="card stack">
      <h1>Almost ready</h1>
      <p class="muted">${esc(bill.payer.name)} is checking the receipt.</p>
    </section>`;
}

function renderMissing() {
  app.innerHTML = `
    <section class="card stack">
      <h1>Bill not found</h1>
      <a href="/">Start a new bill</a>
    </section>`;
}

// ---------- Picking a name ----------

function renderPickName() {
  const free = bill.people.filter((p) => !p.taken);
  const canJoin = bill.status === "open";
  app.innerHTML = `
    ${billHeader()}
    <section class="card stack">
      <h2>Who are you?</h2>
      ${free.length ? `<div class="stack">${free.map((p) => `<button data-pick="${esc(p.name)}">I'm ${esc(p.name)}</button>`).join("")}</div>` : ""}
      ${canJoin ? `
        <form class="row" id="join">
          <input name="name" required maxlength="30" placeholder="Your name" aria-label="Your name" autocomplete="given-name">
          <button class="primary" type="submit">Join</button>
        </form>` : free.length ? "" : `<p class="muted">Everyone on this bill has already picked their name.</p>`}
      <p class="error-text small" id="join-error"></p>
    </section>
    ${bill.status !== "open" ? statusBoard() : ""}`;

  const join = async (name) => {
    const { ok, data } = await api("POST", `/api/bills/${BILL_ID}/people`, { name });
    if (!ok) return (document.getElementById("join-error").textContent = data.error);
    me = { personId: data.personId, token: data.personToken };
    storage.set(`person:${BILL_ID}`, me);
    await refresh();
    myClaims = { ...(bill.claims[me.personId] ?? {}) };
    render();
  };
  app.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => join(b.dataset.pick)));
  document.getElementById("join")?.addEventListener("submit", (e) => {
    e.preventDefault();
    join(new FormData(e.target).get("name"));
  });
}

function billHeader() {
  const r = bill.receipt;
  return `
    <header class="stack">
      <h1>${esc(r.merchant || "The bill")}</h1>
      <p class="muted">${money(r.totalCents)} total · paid by ${esc(bill.payer.name)}
        ${bill.hasPhoto ? ` · <a href="/api/bills/${BILL_ID}/photo" target="_blank" rel="noopener">receipt photo</a>` : ""}</p>
    </header>`;
}

// ---------- Claiming (open) ----------

// Everyone's claims as the server has them, with this device's unsaved edits on top.
const allClaims = () => ({ ...bill.claims, [me.personId]: myClaims });

// What I owe given the current claims. Exact once everything is claimed; before that it's
// my items' share of the total, which is what the final number will be (give or take a cent).
function myEstimate() {
  const claims = allClaims();
  const exact = computeShares(bill.receipt, bill.people, bill.payer.id, claims);
  if (exact.ok) return exact.shares[me.personId] ?? 0;
  const mine = bill.receipt.items.reduce((sum, item) => {
    const row = itemClaims(item.id, bill.people, claims).find((c) => c.personId === me.personId);
    return sum + (row ? item.priceCents * row.fraction : 0);
  }, 0);
  return Math.round((mine * bill.receipt.totalCents) / bill.receipt.itemsCents);
}

function renderClaims() {
  const claims = allClaims();
  const unclaimed = bill.receipt.items.filter((item) => item.priceCents > 0 && itemClaims(item.id, bill.people, claims).length === 0);
  const chips = [0, 25, 50, 100];

  app.innerHTML = `
    ${billHeader()}
    ${bill.isAdmin ? adminPanel(unclaimed) : ""}
    ${bill.receipt.items.map((item) => {
      const mine = myClaims[item.id] ?? 0;
      const rows = itemClaims(item.id, bill.people, claims);
      const sum = rows.reduce((s, r) => s + r.pct, 0);
      const status = rows.length === 0
        ? (item.priceCents > 0 ? "Nobody yet" : "Free")
        : rows.map((r) => `${r.personId === me.personId ? "You" : esc(nameOf(r.personId))} ${Math.round(r.fraction * 100)}%`).join(" · ");
      return `
        <section class="card item ${rows.length === 0 && item.priceCents > 0 ? "unclaimed" : ""}">
          <div class="row"><strong>${esc(item.name)}${item.quantity !== 1 ? ` <span class="muted">× ${item.quantity}</span>` : ""}</strong><span class="num">${money(item.priceCents)}</span></div>
          <div class="chips" role="group" aria-label="Your share of ${esc(item.name)}">
            ${chips.map((c) => `<button data-claim="${item.id}" data-pct="${c}" aria-pressed="${c === 0 ? mine === 0 && zeroed[item.id] === true : mine === c}">${c}%</button>`).join("")}
            <input aria-label="Custom percent for ${esc(item.name)}" data-custom="${item.id}" inputmode="numeric" placeholder="%" value="${chips.includes(mine) ? "" : mine}">
          </div>
          <p class="small muted">${status}${rows.length > 0 && sum !== 100 ? ` · split in proportion` : ""}</p>
        </section>`;
    }).join("")}
    <div class="footer"><div class="row">
      <div><div class="small muted">${isPayer() ? "Your part" : `You owe ${esc(bill.payer.name)}`}</div><div class="big num">≈ ${money(myEstimate())}</div></div>
      <p class="small muted" style="text-align:right">${unclaimed.length ? `${unclaimed.length} unclaimed` : isPayer() ? "" : `Waiting for ${esc(bill.payer.name)}`}</p>
    </div></div>`;

  app.querySelectorAll("[data-claim]").forEach((b) => b.addEventListener("click", () => {
    setMyClaim(b.dataset.claim, Number(b.dataset.pct), b.dataset.pct === "0");
    render();
  }));
  app.querySelectorAll("[data-custom]").forEach((input) => input.addEventListener("input", () => {
    const pct = Math.max(0, Math.min(100, Math.round(Number(input.value.replace(/\D/g, "")) || 0)));
    setMyClaim(input.dataset.custom, pct);
    renderPending = true;
  }));
  bindAdminPanel();
}

let saveTimer;
function setMyClaim(itemId, pct, explicitZero = false) {
  if (pct > 0) myClaims[itemId] = pct;
  else delete myClaims[itemId];
  if (explicitZero) zeroed[itemId] = true;
  else delete zeroed[itemId];
  storage.set(`zero:${BILL_ID}`, zeroed);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveClaims, 400);
}

async function saveClaims() {
  const { status, data } = await api("PUT", `/api/bills/${BILL_ID}/people/${me.personId}/claims`, { claims: myClaims }, me.token);
  if (status === 401) {
    toast("Your name was reset on this bill. Pick it again.", "error");
    forgetMe();
  } else if (status === 409) {
    toast(data.error, "error");
  } else if (status !== 200) {
    toast("Couldn't save. Check your connection.", "error");
    return;
  }
  if (await refresh().catch(() => false)) render();
}

// ---------- Payer controls ----------

function adminPanel(unclaimed = []) {
  const link = `${location.origin}/?b=${BILL_ID}`;
  return `
    <section class="card stack">
      <h2>Invite your friends</h2>
      <div class="row"><input readonly value="${esc(link)}" aria-label="Bill link" id="share-link"><button id="share">Share</button></div>
      <ul class="people">
        ${bill.people.map((p) => `
          <li><span>${esc(p.name)}${p.id === bill.payer.id ? " <span class='muted small'>(you)</span>" : ""}</span>
          ${p.id !== bill.payer.id && p.taken ? `<button class="link small" data-reset="${p.id}">Reset name</button>` : ""}</li>`).join("")}
      </ul>
      ${bill.status === "open" ? `
        <button class="primary" id="lock" ${unclaimed.length ? "disabled" : ""}>Lock &amp; request payment</button>` : ""}
      ${bill.unlockable ? `<button id="unlock">Unlock to change claims</button>` : ""}
    </section>`;
}

function bindAdminPanel() {
  document.getElementById("share")?.addEventListener("click", async () => {
    const url = document.getElementById("share-link").value;
    if (navigator.share) {
      navigator.share({ title: "Split the bill", text: `Claim what you had from ${bill.receipt.merchant || "the bill"}`, url }).catch(() => {});
    } else {
      await navigator.clipboard.writeText(url).catch(() => {});
      toast("Link copied");
    }
  });
  app.querySelectorAll("[data-reset]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm(`Let someone pick "${nameOf(b.dataset.reset)}" again? Their claims stay.`)) return;
    const { ok, data } = await api("POST", `/api/bills/${BILL_ID}/people/${b.dataset.reset}/reset`, {}, adminToken);
    if (!ok) toast(data.error, "error");
    if (await refresh()) render();
  }));
  for (const action of ["lock", "unlock"]) {
    document.getElementById(action)?.addEventListener("click", async (e) => {
      e.target.disabled = true;
      clearTimeout(saveTimer);
      if (bill.status === "open") await saveClaims(); // make sure my own last tap is in
      const { ok, data } = await api("POST", `/api/bills/${BILL_ID}/${action}`, {}, adminToken);
      if (!ok) toast(data.error, "error");
      await refresh();
      render();
    });
  }
}

// ---------- Paying (locked / settled) ----------

function statusBoard() {
  const shares = bill.shares ?? {};
  return `
    <section class="card stack">
      <h2>${bill.status === "settled" ? "All settled" : "Who's paid"}</h2>
      <ul class="people">
        ${bill.people.map((p) => {
          const isP = p.id === bill.payer.id;
          const cents = shares[p.id] ?? 0;
          const status = isP ? "paid the bill" : cents === 0 ? "owes nothing" : bill.pay[p.id] ?? "unpaid";
          const cls = isP || status === "paid" || cents === 0 ? "paid" : status === "pending" ? "pending" : "";
          return `<li><span>${esc(p.name)}${p.id === me?.personId ? " <span class='muted small'>(you)</span>" : ""}</span>
            <span class="row"><span class="num">${money(cents)}</span><span class="pill ${cls}">${esc(status)}</span></span></li>`;
        }).join("")}
      </ul>
    </section>`;
}

function myItemsList() {
  const claims = bill.claims;
  const rows = bill.receipt.items
    .map((item) => ({ item, row: itemClaims(item.id, bill.people, claims).find((c) => c.personId === me.personId) }))
    .filter((x) => x.row);
  if (rows.length === 0) return "";
  return `<ul class="people small muted">${rows.map(({ item, row }) =>
    `<li><span>${esc(item.name)}${row.fraction < 1 ? ` (${Math.round(row.fraction * 100)}%)` : ""}</span><span class="num">${money(Math.round(item.priceCents * row.fraction))}</span></li>`).join("")}
    <li><span>+ tax${bill.receipt.tipCents ? " & tip" : ""}${bill.receipt.discountCents ? ", − discount" : ""}</span><span></span></li></ul>`;
}

function renderPayment() {
  if (!me && bill.status === "locked" && bill.people.some((p) => !p.taken)) return renderPickName();
  const myCents = me ? bill.shares?.[me.personId] ?? 0 : 0;
  const myStatus = me ? bill.pay[me.personId] ?? "unpaid" : null;
  const owes = me && !isPayer() && myCents > 0;

  let mine = "";
  if (owes && myStatus === "paid") {
    mine = `<p class="notice ok">You paid ${money(myCents)}</p>`;
  } else if (owes && myStatus === "pending") {
    mine = `<p class="notice warn">Your ${money(myCents)} payment is pending</p>`;
  } else if (owes) {
    mine = `
      <div class="small muted">You owe ${esc(bill.payer.name)}</div>
      <div class="big num">${money(myCents)}</div>
      ${myItemsList()}
      <div id="paypal-slot"><p class="muted small">Loading PayPal…</p></div>`;
  } else if (me && !isPayer()) {
    mine = `<p class="notice ok">You owe nothing.</p>`;
  }

  app.innerHTML = `
    ${billHeader()}
    ${mine ? `<section class="card stack">${mine}</section>` : ""}
    ${bill.isAdmin && bill.status === "locked" ? adminPanel() : ""}
    ${statusBoard()}
    ${bill.status === "settled" && bill.isAdmin ? `<a href="/">Split another bill</a>` : ""}`;

  bindAdminPanel();
  if (owes && myStatus === "unpaid") mountPayPalButton(myCents);
}

// The PayPal SDK and the payment session are created once; the button element is re-created on render.
let paypalSession = null;
let paypalReady = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

async function setUpPayPal(amountCents) {
  await loadScript(config.sdkUrl);
  const sdk = await window.paypal.createInstance({ clientId: config.clientId, components: ["paypal-payments"], pageType: "checkout" });
  const methods = await sdk.findEligibleMethods({ currencyCode: config.currency, amount: dollarsText(amountCents) });
  if (!methods.isEligible("paypal")) throw new Error("PayPal isn't available for this browser or region.");
  paypalSession = sdk.createPayPalOneTimePaymentSession({
    onApprove,
    onCancel: () => toast("Payment cancelled."),
    onError: (err) => {
      console.error(err);
      toast("PayPal ran into a problem. Please try again.", "error");
    },
  });
}

async function mountPayPalButton(amountCents) {
  const slot = document.getElementById("paypal-slot");
  try {
    paypalReady ??= setUpPayPal(amountCents);
    await paypalReady;
  } catch (err) {
    console.error(err);
    paypalReady = null;
    if (slot) slot.innerHTML = `<p class="error-text">${esc(err.message)}</p>`;
    return;
  }
  if (!slot?.isConnected) return;
  slot.innerHTML = `<paypal-button type="pay" class="paypal-gold"></paypal-button>`;
  slot.querySelector("paypal-button").addEventListener("click", async () => {
    try {
      // start() needs the Promise itself, i.e. createOrder(), not createOrder.
      await paypalSession.start({ presentationMode: "auto" }, createOrder());
    } catch (err) {
      console.error(err);
      toast(err.message || "Couldn't start checkout. Please try again.", "error");
    }
  });
}

// The server looks up the amount and who gets paid; the browser only says which share.
async function createOrder() {
  const { ok, data } = await api("POST", "/api/orders", { billId: BILL_ID, personId: me.personId });
  if (!ok) throw new Error(data.error ?? "Could not create order");
  return { orderId: data.id };
}

async function onApprove({ orderId }) {
  toast("Finishing your payment…");
  const { ok, data } = await api("POST", `/api/orders/${orderId}/capture`, {});
  if (data.error === "INSTRUMENT_DECLINED") {
    toast("Your payment method was declined. Try again with a different one.", "error");
  } else if (ok && data.status === "PENDING") {
    toast("Payment pending review");
  } else if (!ok || data.status !== "COMPLETED") {
    toast(data.error ?? "Something went wrong capturing the payment. You have not been charged.", "error");
  } else {
    toast(`Paid ${money(Math.round(Number(data.amount.value) * 100))}!`);
  }
  await refresh().catch(() => {});
  render();
}

// ---------- Start ----------

async function init() {
  try {
    config = await (await fetch("/api/config")).json();
  } catch {
    app.innerHTML = `<p class="error-text">Couldn't reach the server.</p>`;
    return;
  }
  if (!BILL_ID) return render();

  const fromHash = new URLSearchParams(location.hash.slice(1)).get("admin");
  if (fromHash) {
    storage.set(`admin:${BILL_ID}`, fromHash);
    history.replaceState(null, "", `/?b=${BILL_ID}`); // so copying the URL bar never shares the admin token
  }
  adminToken = storage.get(`admin:${BILL_ID}`);
  me = storage.get(`person:${BILL_ID}`);
  zeroed = storage.get(`zero:${BILL_ID}`) ?? {};

  try {
    await refresh();
  } catch (err) {
    bill = null;
    if (err.status !== 404) app.innerHTML = `<p class="error-text">${esc(err.message)}</p>`;
    else render();
    return;
  }
  if (me) myClaims = { ...(bill.claims[me.personId] ?? {}) };
  render();
  schedulePoll();
}

init();
