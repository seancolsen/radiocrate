/*
 * RadioCrate's service worker: an app-shell cache, nothing more.
 *
 * Its whole job is to make the app *launch* like a native one — instantly, and
 * without a network round trip — by holding the ~19 MB wasm bundle and its
 * loader in the Cache API. Your library and your audio live on the server, so
 * everything under /api is deliberately left alone (see `fetch` below): this
 * worker never makes the app appear to work offline when it can't.
 *
 * `cargo xtask build-release` rewrites the two `const` lines below with a hash
 * of the built `dist/` and the actual list of files in it. The build output
 * uses stable (unhashed) file names, so that hash is the only thing telling a
 * new deployment apart from the one already cached — it changing is what makes
 * every asset re-download.
 *
 * Unstamped, the build id stays `dev` and the worker caches nothing at all: it
 * registers (so the install and standalone-launch behavior can still be tried
 * out under `trunk serve`) but passes every request straight through. A caching
 * worker in front of a rebuild-on-save dev server would just serve you the
 * bundle you last built.
 */

const BUILD_ID = "dev";
const PRECACHE = [];

const CACHE = `radiocrate-shell-${BUILD_ID}`;
const PASSTHROUGH = BUILD_ID === "dev";

/** The shell entry point every in-scope navigation resolves to. */
const SHELL = "/index.html";

self.addEventListener("install", (event) => {
  if (PASSTHROUGH) return;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // `reload` bypasses the HTTP cache, so a fresh build is never precached
      // from a stale copy the browser happens to be holding.
      await cache.addAll(PRECACHE.map((url) => new Request(url, { cache: "reload" })));
    })(),
  );
  // Deliberately no `skipWaiting()`. Swapping the worker out from under a
  // running app would mean serving a new wasm bundle to a page built against
  // the old one, and for a music player, a surprise reload mid-track is worse
  // than being one version behind until the next cold start.
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith("radiocrate-shell-") && name !== CACHE)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (PASSTHROUGH || request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // The API is network-only, on purpose:
  //  - query results would go stale in ways the UI can't reason about;
  //  - audio streams are served with `Range` requests, and a worker that
  //    answered those from a whole-file cache entry would break seeking.
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return;

  // Navigations resolve to the shell. The server already rewrites unknown
  // paths to index.html, so matching that behavior here keeps a cold, offline
  // launch identical to an online one.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cached = await caches.match(SHELL);
        if (cached) return cached;
        return fetch(request);
      })(),
    );
    return;
  }

  // Static assets: serve from cache when we have them, otherwise fetch and
  // keep a copy so a same-session miss doesn't repeat.
  event.respondWith(
    (async () => {
      const cached = await caches.match(request, { ignoreSearch: true });
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && response.type === "basic") {
        const cache = await caches.open(CACHE);
        cache.put(request, response.clone());
      }
      return response;
    })(),
  );
});

self.addEventListener("message", (event) => {
  // An escape hatch for taking an update immediately rather than at the next
  // cold start; `index.html` exposes it as `radiocrate.applyUpdate()`.
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});
