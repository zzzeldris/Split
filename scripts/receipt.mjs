// Reads receipt photos with Gemini and checks that the numbers add up.
//
// Usage (run from the project root so .env is found):
//   node scripts/receipt.mjs                                  -> every image in test-receipts/
//   node scripts/receipt.mjs test-receipts/grocery_test.jpg   -> just one image
import "dotenv/config";
import { MIME_TYPES, readReceiptImage, cents, checkTotals } from "../lib/receipt.js";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const RECEIPT_DIR = "test-receipts";

async function readReceipt(filePath) {
  const mimeType = MIME_TYPES[path.extname(filePath).toLowerCase()];
  if (!mimeType) throw new Error(`Unsupported image type: ${filePath}`);
  const data = (await readFile(filePath)).toString("base64");
  return readReceiptImage({ mimeType, data });
}

const money = (c) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toFixed(2)}`;

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
