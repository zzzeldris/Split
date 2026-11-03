// A tiny Redis client with only the commands the app uses.
//
// With UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN set, it talks to Upstash over its
// REST API with plain fetch. Without them it falls back to an in-memory store, so local
// development and tests work with no account. The in-memory store loses everything on restart.
//
// Every method returns what Redis returns: strings, integers, null, or a flat [field, value, ...]
// array for HGETALL (converted to an object here for convenience).

export function createStore(env = process.env) {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? upstashStore(url, token) : memoryStore();
}

const toObject = (flat) => {
  const obj = {};
  for (let i = 0; i < (flat?.length ?? 0); i += 2) obj[flat[i]] = flat[i + 1];
  return obj;
};

function commands(run) {
  return {
    get: (key) => run(["GET", key]),
    set: (key, value) => run(["SET", key, value]),
    del: (...keys) => run(["DEL", ...keys]),
    pexpireat: (key, ms) => run(["PEXPIREAT", key, ms]),
    hget: (key, field) => run(["HGET", key, field]),
    hset: (key, obj) => run(["HSET", key, ...Object.entries(obj).flat()]),
    hsetnx: (key, field, value) => run(["HSETNX", key, field, value]),
    hdel: (key, field) => run(["HDEL", key, field]),
    hincrby: (key, field, by) => run(["HINCRBY", key, field, by]),
    hgetall: async (key) => toObject(await run(["HGETALL", key])),
  };
}

function upstashStore(url, token) {
  async function call(path, body) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(`${url}${path}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(`Upstash ${res.status}: ${data.error ?? "request failed"}`);
        return data;
      } catch (err) {
        if (attempt >= 1 || err.message.startsWith("Upstash 4")) throw err;
      }
    }
  }
  async function run(cmd) {
    const data = await call("", cmd.map(String));
    if (data.error) throw new Error(`Redis ${cmd[0]}: ${data.error}`);
    return data.result;
  }
  return {
    kind: "upstash",
    ...commands(run),
    // Runs the commands as one MULTI/EXEC transaction: all of them or none.
    async multi(cmds) {
      const results = await call("/multi-exec", cmds.map((c) => c.map(String)));
      const failed = results.find((r) => r.error);
      if (failed) throw new Error(`Redis transaction: ${failed.error}`);
      return results.map((r) => r.result);
    },
  };
}

function memoryStore() {
  const data = new Map(); // key -> { value: string | Map, expiresAt: ms | null }

  const live = (key) => {
    const entry = data.get(key);
    if (entry?.expiresAt != null && entry.expiresAt <= Date.now()) data.delete(key);
    return data.get(key);
  };
  const hash = (key, create) => {
    let entry = live(key);
    if (!entry && create) data.set(key, (entry = { value: new Map(), expiresAt: null }));
    return entry?.value;
  };

  // Synchronous, so a batch of commands can't interleave with another request (like MULTI/EXEC).
  function exec([name, key, ...args]) {
    switch (name) {
      case "GET": return live(key)?.value ?? null;
      case "SET": data.set(key, { value: String(args[0]), expiresAt: null }); return "OK";
      case "DEL": return [key, ...args].filter((k) => live(k) && data.delete(k)).length;
      case "PEXPIREAT": { const e = live(key); if (!e) return 0; e.expiresAt = Number(args[0]); return 1; }
      case "HGET": return hash(key)?.get(args[0]) ?? null;
      case "HSET": {
        const h = hash(key, true);
        let added = 0;
        for (let i = 0; i < args.length; i += 2) { if (!h.has(args[i])) added++; h.set(args[i], String(args[i + 1])); }
        return added;
      }
      case "HSETNX": { const h = hash(key, true); if (h.has(args[0])) return 0; h.set(args[0], String(args[1])); return 1; }
      case "HDEL": { const h = hash(key); const n = h?.delete(args[0]) ? 1 : 0; if (h?.size === 0) data.delete(key); return n; }
      case "HINCRBY": { const h = hash(key, true); const v = Number(h.get(args[0]) ?? 0) + Number(args[1]); h.set(args[0], String(v)); return v; }
      case "HGETALL": return [...(hash(key) ?? new Map())].flat();
      default: throw new Error(`memoryStore: unsupported command ${name}`);
    }
  }

  return {
    kind: "memory",
    ...commands(async (cmd) => exec(cmd)),
    async multi(cmds) { return cmds.map(exec); },
  };
}
