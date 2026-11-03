// Reads a receipt photo with Gemini. Shared by the server and scripts/receipt.mjs.
// Only ever call this from the server: it uses GEMINI_API_KEY.
import { GoogleGenAI } from "@google/genai";

export const MODEL = "gemini-3.5-flash";
export const MIME_TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

// The shape we want back. Gemini is forced to answer with JSON matching this.
export const RECEIPT_SCHEMA = {
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

export const PROMPT = `Read this receipt and extract it as JSON. All amounts are in dollars.

Rules:
- items: every purchased item. "price" is the line total as printed (for items sold by weight, the final price, not the per-lb price). Use quantity 1 if no quantity is shown.
- Expand store abbreviations into readable names where you're confident (e.g. "GV 1 LF MLK" -> "Great Value 1% Lowfat Milk"); otherwise keep the printed text.
- A $0.00 modifier line (like a tea flavor) is part of the item above it: add it to that item's name, not as a separate item.
- discount: the sum of discount lines that are subtracted from the bill (e.g. "(10.40)" or "-10.40"), as a positive number. "You saved" notes about a price that's already reduced are NOT discounts. Use 0 if none.
- subtotal: the final subtotal before tax (ignore any partial subtotals printed partway down the receipt).
- tip: only a tip that was actually paid (printed as paid, or handwritten). Suggested-tip tables are NOT a tip. Use 0 if none.
- total: the final amount paid, including any handwritten tip/total.`;

let ai;

// image: { mimeType, data } with data as base64. Returns the raw Gemini JSON (amounts in dollars).
export async function readReceiptImage({ mimeType, data }) {
  ai ??= new GoogleGenAI({}); // reads GEMINI_API_KEY from the environment
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [{ inlineData: { mimeType, data } }, { text: PROMPT }],
    config: { responseMimeType: "application/json", responseJsonSchema: RECEIPT_SCHEMA },
  });
  return JSON.parse(response.text);
}

// Work in whole cents so floating point can't cause false mismatches (0.1 + 0.2 !== 0.3).
export const cents = (dollars) => Math.round(dollars * 100);

export function checkTotals(r) {
  const itemsSum = r.items.reduce((sum, item) => sum + cents(item.price), 0);
  const checks = [
    ["items - discount = subtotal", itemsSum - cents(r.discount), cents(r.subtotal)],
    ["subtotal + tax + tip = total", cents(r.subtotal) + cents(r.tax) + cents(r.tip), cents(r.total)],
  ];
  return checks.map(([label, got, expected]) => ({ label, got, expected, ok: got === expected }));
}
