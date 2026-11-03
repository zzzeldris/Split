// Checks that the Upstash Redis credentials in .env work, using every command the app uses.
// It writes a few keys under check:<random>, reads them back, and deletes them.
//
// Usage (from the project root): node scripts/check-store.mjs
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { createStore } from "../lib/store.js";

const store = createStore();
if (store.kind !== "upstash") {
  console.error("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN aren't both set in .env.");
  process.exit(1);
}

const prefix = `check:${randomBytes(4).toString("hex")}`;
const results = [];
const check = (label, ok, detail = "") => results.push({ label, ok, detail });

try {
  await store.set(`${prefix}:s`, "hello");
  check("SET / GET", (await store.get(`${prefix}:s`)) === "hello");

  await store.hset(`${prefix}:h`, { a: "1", b: JSON.stringify({ x: 2 }) });
  check("HSET / HGET", (await store.hget(`${prefix}:h`, "a")) === "1");
  check("HSETNX refuses an existing field", (await store.hsetnx(`${prefix}:h`, "a", "9")) === 0);
  check("HINCRBY", (await store.hincrby(`${prefix}:h`, "a", 1)) === 2);
  const all = await store.hgetall(`${prefix}:h`);
  check("HGETALL", all.a === "2" && JSON.parse(all.b).x === 2, JSON.stringify(all));

  const results2 = await store.multi([
    ["HSET", `${prefix}:h`, "c", "3"],
    ["HINCRBY", `${prefix}:h`, "a", 1],
  ]);
  check("MULTI/EXEC transaction", results2[1] === 3, JSON.stringify(results2));

  check("PEXPIREAT", (await store.pexpireat(`${prefix}:s`, Date.now() + 60_000)) === 1);

  // A value the size of a resized receipt photo (~500 KB of base64).
  const photo = randomBytes(375_000).toString("base64");
  await store.set(`${prefix}:photo`, photo);
  check("Large value (~500 KB, like a photo)", (await store.get(`${prefix}:photo`))?.length === photo.length);
} catch (err) {
  check("Request", false, err.message);
} finally {
  await store.del(`${prefix}:s`, `${prefix}:h`, `${prefix}:photo`).catch(() => {});
}

for (const r of results) console.log(`${r.ok ? "OK  " : "FAIL"} ${r.label}${r.ok || !r.detail ? "" : `: ${r.detail}`}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
