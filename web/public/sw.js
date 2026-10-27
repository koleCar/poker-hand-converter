/*
 * Rail's service worker (#55): the converter keeps working with no network.
 *
 * The converter is the one screen that needs nothing from a server — parsing
 * runs in a Web Worker in the tab — so it is the one screen this caches:
 *
 *   * `/_next/static/*`, `/fonts/*`, `/icons/*`: cache-first. Content-hashed or
 *     versioned in the filename, so a cached copy is never stale.
 *   * page navigations: network-first, always. A fresh deploy and the reader's
 *     own session win whenever there is a network; the cache is only what is
 *     shown when there is not. `/convert` is precached and is the fallback for
 *     any page that was never visited, so going offline lands on something that
 *     works rather than the browser's dinosaur.
 *   * everything else — `/api/*`, `/auth/*`, RSC payloads, Supabase (another
 *     origin): untouched. A stale API answer is worse than an error.
 *
 * Bump VERSION to drop every cache on the next activation.
 */
const VERSION = "rail-sw-1";
const STATIC = `${VERSION}-static`;
const PAGES = `${VERSION}-pages`;
const OFFLINE_URL = "/convert";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(PAGES)
      .then((cache) => cache.addAll([OFFLINE_URL, "/favicon.svg", "/manifest.webmanifest"]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

function isImmutable(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/fonts/") ||
    url.pathname.startsWith("/icons/")
  );
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (isImmutable(url)) {
    event.respondWith(
      caches.open(STATIC).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      }),
    );
    return;
  }

  // Only full page loads. Client-side navigations fetch RSC payloads (`RSC: 1`),
  // which are per-route and per-session; they go to the network untouched.
  if (request.mode !== "navigate" || request.headers.get("RSC")) return;

  event.respondWith(
    (async () => {
      try {
        const response = await fetch(request);
        if (response.ok && url.pathname === OFFLINE_URL) {
          const cache = await caches.open(PAGES);
          cache.put(OFFLINE_URL, response.clone());
        }
        return response;
      } catch {
        const cache = await caches.open(PAGES);
        return (
          (await cache.match(request)) ||
          (await cache.match(OFFLINE_URL)) ||
          new Response("Offline", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } })
        );
      }
    })(),
  );
});
