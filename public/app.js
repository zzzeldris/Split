// The pay link looks like /?bill=<id>&person=<name>.
const params = new URLSearchParams(location.search);
const BILL_ID = params.get("bill");
const PERSON = params.get("person");

const messageEl = document.getElementById("message");
const button = document.querySelector("paypal-button");

let config;
let bill;

function showMessage(text, kind = "info") {
  messageEl.textContent = text;
  messageEl.className = kind;
}

function formatMoney(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: config.currency }).format(value);
}

const shareValue = () => (bill.shares[PERSON].cents / 100).toFixed(2);

function renderShare() {
  document.getElementById("title").textContent = `${PERSON}, you owe ${bill.payer.name}`;
  document.getElementById("description").textContent = bill.description;
  document.getElementById("total").textContent = formatMoney(shareValue());
}

// The server looks up the amount and who gets paid; the browser only says which share.
async function createOrder() {
  const res = await fetch("/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ billId: BILL_ID, person: PERSON }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Could not create order");
  return { orderId: data.id };
}

async function onApprove({ orderId }) {
  showMessage("Finishing your payment…");
  const res = await fetch(`/api/orders/${orderId}/capture`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  const data = await res.json();

  if (data.error === "INSTRUMENT_DECLINED") {
    showMessage("Your payment method was declined. Click the button to try a different one.", "error");
  } else if (res.ok && data.status === "PENDING") {
    // Money is on its way but not settled (e.g. under review) — don't say "paid" or "not charged".
    button.hidden = true;
    showMessage(`Payment received and pending review. Reference: ${data.captureId}`, "info");
  } else if (!res.ok || data.status !== "COMPLETED") {
    showMessage("Something went wrong capturing the payment. You have not been charged.", "error");
  } else {
    button.hidden = true;
    showMessage(`Paid ${formatMoney(data.amount.value)}! Transaction ID: ${data.captureId}`, "success");
  }
}

// The SDK URL comes from the server so it always matches PAYPAL_ENVIRONMENT.
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

async function init() {
  try {
    config = await (await fetch("/api/config")).json();
    const billRes = await fetch(`/api/bills/${encodeURIComponent(BILL_ID)}`);
    bill = await billRes.json();
    if (!billRes.ok || !bill.shares[PERSON]) {
      showMessage("This payment link isn't valid.", "error");
      return;
    }
    renderShare();
    if (bill.shares[PERSON].status !== "unpaid") {
      showMessage(`Your share is already ${bill.shares[PERSON].status}. Thanks!`, "success");
      return;
    }
    await loadScript(config.sdkUrl);

    const sdk = await window.paypal.createInstance({
      clientId: config.clientId,
      components: ["paypal-payments"],
      pageType: "checkout",
    });

    const methods = await sdk.findEligibleMethods({
      currencyCode: config.currency,
      amount: shareValue(),
    });
    if (!methods.isEligible("paypal")) {
      showMessage("PayPal isn't available for this browser or region.", "error");
      return;
    }

    const session = sdk.createPayPalOneTimePaymentSession({
      onApprove,
      onCancel: () => showMessage("Payment cancelled."),
      onError: (err) => {
        console.error(err);
        showMessage("PayPal ran into a problem. Please try again.", "error");
      },
    });

    button.hidden = false;
    button.addEventListener("click", async () => {
      showMessage("");
      try {
        // start() needs the Promise itself, i.e. createOrder(), not createOrder.
        await session.start({ presentationMode: "auto" }, createOrder());
      } catch (err) {
        console.error(err);
        showMessage("Couldn't start checkout. Please try again.", "error");
      }
    });
  } catch (err) {
    console.error(err);
    showMessage("Checkout failed to load. Is the server running?", "error");
  }
}

init();
