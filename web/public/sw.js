// Keeps the app shell available offline, so a screen that reloads while its
// connection is down still opens — and carries on showing its last message,
// which the page keeps in localStorage.
//
// Pages are network-first (a deploy shows up on the next load); hashed assets
// are cache-first, since a hash never changes content. /api is never cached.

const CACHE = "noticebrd-shell-v1";

self.addEventListener("install", (event) => {
  // The first visit loads its assets before this worker controls the page, so
  // cache the ones the current page references now.
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const html = await (await fetch("/", { cache: "no-cache" })).text();
      const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
      await cache.addAll(["/", "/icon.svg", "/manifest.webmanifest", "/awake.mp4", "/awake.webm", ...assets]);
    })(),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  // Range requests (video) and the build stamp go straight to the network.
  if (request.headers.has("range") || url.pathname === "/version.txt") return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put("/", copy));
          }
          return response;
        })
        .catch(() => caches.match("/")),
    );
    return;
  }

  if (url.pathname === "/") return;

  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          if (response.ok && (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icon"))) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
