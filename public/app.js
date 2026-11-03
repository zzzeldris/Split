const PRODUCT_ID = "hackathon-tee";

const quantityEl = document.getElementById("quantity");
const messageEl = document.getElementById("message");
const button = document.querySelector("paypal-button");

let config;

function showMessage(text, kind = "info") {
  messageEl.textContent = text;
  messageEl.className = kind;
}

function formatMoney(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: config.currency }).format(value);
}

function renderProduct() {
  const product = config.products[PRODUCT_ID];
  document.getElementById("product-name").textContent = product.name;
  document.getElementById("product-price").textContent = formatMoney(product.price);
  document.getElementById("total").textContent = formatMoney(product.price * quantityEl.value);
}

// The server works out the price; the browser only says what and how many.
async function createOrder() {
  const res = await fetch("/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productId: PRODUCT_ID, quantity: Number(quantityEl.value) }),
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
    quantityEl.disabled = true;
    showMessage(`Payment received and pending review. Reference: ${data.captureId}`, "info");
  } else if (!res.ok || data.status !== "COMPLETED") {
    showMessage("Something went wrong capturing the payment. You have not been charged.", "error");
  } else {
    button.hidden = true;
    quantityEl.disabled = true;
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
    renderProduct();
    quantityEl.addEventListener("change", renderProduct);
    await loadScript(config.sdkUrl);

    const sdk = await window.paypal.createInstance({
      clientId: config.clientId,
      components: ["paypal-payments"],
      pageType: "checkout",
    });

    const methods = await sdk.findEligibleMethods({
      currencyCode: config.currency,
      amount: config.products[PRODUCT_ID].price,
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
