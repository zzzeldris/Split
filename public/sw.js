// Service worker: makes the app installable and opens it instantly from the home screen.
// It caches only the app's own files (the "shell"). It never caches /api/ responses, so bills,
// claims and payments always come fresh from the server.
const CACHE = "split-shell-v1";
const SHELL = ["/", "/app.js", "/style.css", "/lib/shares.js", "/lib/split.js", "/icon.svg", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first, so a new deploy shows up at once; the cache is only used when offline.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;

  // Every page URL (/?b=...) is the same app shell.
  const key = event.request.mode === "navigate" ? "/" : url.pathname;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok && SHELL.includes(key)) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(key, copy));
        }
        return res;
      })
      .catch(() => caches.match(key).then((hit) => hit ?? Response.error())),
  );
});
