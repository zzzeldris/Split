// Reads receipt photos with Gemini and checks that the numbers add up.
//
// Usage (run from the project root so .env is found):
//   node scripts/receipt.mjs                                  -> every image in test-receipts/
//   node scripts/receipt.mjs test-receipts/grocery_test.jpg   -> just one image
import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const MODEL = "gemini-3.5-flash";
const RECEIPT_DIR = "test-receipts";
const MIME_TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

// The shape we want back. Gemini is forced to answer with JSON matching this.
const RECEIPT_SCHEMA = {
  type: "object",
  properties: {
    merchant: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          quantity: { type: "number" },
          price: { type: "number", description: "Total price for this line (not per unit)" },
        },
        required: ["name", "quantity", "price"],
      },
    },
    discount: { type: "number" },
    subtotal: { type: "number" },
    tax: { type: "number" },
    tip: { type: "number" },
    total: { type: "number" },
  },
  required: ["merchant", "items", "discount", "subtotal", "tax", "tip", "total"],
};

const PROMPT = `Read this receipt and extract it as JSON. All amounts are in dollars.

Rules:
- items: every purchased item. "price" is the line total as printed (for items sold by weight, the final price, not the per-lb price). Use quantity 1 if no quantity is shown.
- Expand store abbreviations into readable names where you're confident (e.g. "GV 1 LF MLK" -> "Great Value 1% Lowfat Milk"); otherwise keep the printed text.
- A $0.00 modifier line (like a tea flavor) is part of the item above it: add it to that item's name, not as a separate item.
- discount: the sum of discount lines that are subtracted from the bill (e.g. "(10.40)" or "-10.40"), as a positive number. "You saved" notes about a price that's already reduced are NOT discounts. Use 0 if none.
- subtotal: the final subtotal before tax (ignore any partial subtotals printed partway down the receipt).
- tip: only a tip that was actually paid (printed as paid, or handwritten). Suggested-tip tables are NOT a tip. Use 0 if none.
- total: the final amount paid, including any handwritten tip/total.`;

const ai = new GoogleGenAI({}); // reads GEMINI_API_KEY from the environment

async function readReceipt(filePath) {
  const mimeType = MIME_TYPES[path.extname(filePath).toLowerCase()];
  if (!mimeType) throw new Error(`Unsupported image type: ${filePath}`);
  const data = (await readFile(filePath)).toString("base64");

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [{ inlineData: { mimeType, data } }, { text: PROMPT }],
    config: { responseMimeType: "application/json", responseJsonSchema: RECEIPT_SCHEMA },
  });
  return JSON.parse(response.text);
}

// Work in whole cents so floating point can't cause false mismatches (0.1 + 0.2 !== 0.3).
const cents = (dollars) => Math.round(dollars * 100);
const money = (c) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toFixed(2)}`;

function checkTotals(r) {
  const itemsSum = r.items.reduce((sum, item) => sum + cents(item.price), 0);
  const checks = [
    ["items - discount = subtotal", itemsSum - cents(r.discount), cents(r.subtotal)],
    ["subtotal + tax + tip = total", cents(r.subtotal) + cents(r.tax) + cents(r.tip), cents(r.total)],
  ];
  return checks.map(([label, got, expected]) => ({ label, got, expected, ok: got === expected }));
}

function printReceipt(file, r) {
  console.log(`\n=== ${path.basename(file)}: ${r.merchant} ===`);
  for (const item of r.items) {
    console.log(`  ${String(item.quantity).padStart(4)} x ${item.name.padEnd(36)} ${money(cents(item.price)).padStart(9)}`);
  }
  for (const [label, value] of [["Discount", -r.discount], ["Subtotal", r.subtotal], ["Tax", r.tax], ["Tip", r.tip], ["Total", r.total]]) {
    if (label === "Discount" && !r.discount) continue;
    console.log(`  ${label.padStart(42)} ${money(cents(value)).padStart(9)}`);
  }
  for (const c of checkTotals(r)) {
    const detail = c.ok ? "" : ` (got ${money(c.got)}, receipt says ${money(c.expected)})`;
    console.log(`  ${c.ok ? "OK  " : "FAIL"} ${c.label}${detail}`);
  }
}

const files = process.argv.length > 2
  ? process.argv.slice(2)
  : (await readdir(RECEIPT_DIR))
      .filter((f) => MIME_TYPES[path.extname(f).toLowerCase()])
      .map((f) => path.join(RECEIPT_DIR, f));

if (files.length === 0) console.log(`No images found. Put receipt photos in ${RECEIPT_DIR}/.`);

for (const file of files) {
  try {
    printReceipt(file, await readReceipt(file));
  } catch (err) {
    console.error(`\n=== ${path.basename(file)}: ERROR ===\n  ${err.message}`);
  }
}
