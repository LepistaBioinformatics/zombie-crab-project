// Minimal, dependency-free service worker (no workbox). It keeps the app shell
// installable and fast; chat itself needs the network so it is never cached.
// Bump CACHE_VERSION to invalidate old caches on the next activate.
const CACHE_VERSION = "zc-shell-v1";
const OFFLINE_URL = "/offline";

// Core shell precached at install so a cold, offline start still renders.
const PRECACHE_URLS = [OFFLINE_URL, "/logo-light.jpg", "/logo-dark.jpg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // API calls (branding, auth, chat) must always hit the network -- never serve
  // a cached response that could be stale or break the session.
  if (url.pathname.startsWith("/api/")) return;

  // Navigations: network-first, falling back to the cached offline page.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match(OFFLINE_URL).then((cached) => cached ?? Response.error()),
      ),
    );
    return;
  }

  // Static assets (Next build output, bundled images): cache-first, then fill
  // the cache on a miss so the next load is instant.
  if (url.pathname.startsWith("/_next/static/") || /\.(?:js|css|woff2?|png|jpe?g|svg|ico)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
            return response;
          }),
      ),
    );
  }
});
