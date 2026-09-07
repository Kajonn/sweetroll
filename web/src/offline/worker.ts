/**
 * Asset-only offline service worker logic.
 *
 * This module has no DOM, React, IndexedDB, or API-client dependencies so the
 * production worker can be built as an isolated script. It exports pure
 * routing helpers (used by unit tests and the generated `sw.js`) plus
 * `renderServiceWorker`, which serializes those same functions into the
 * worker source emitted by `web/build/offline-assets.ts`.
 *
 * Privacy invariant: the worker caches same-origin build assets and the
 * navigation shell only. It never intercepts `/api` or `/dev`, never caches
 * private API response bodies, and never stores identity material.
 */

export const OFFLINE_CACHE_PREFIX = "sweetroll-offline-assets";
export const OFFLINE_STATUS_MESSAGE = "sweetroll:offline-status";

export type OfflineManifest = {
  buildId: string;
  assets: string[];
};

/** Versioned CacheStorage name for one production build. */
export function cacheNameForBuild(buildId: string): string {
  return `${OFFLINE_CACHE_PREFIX}:${buildId}`;
}

/**
 * Shell navigations the worker may answer from cache. Only the routes needed
 * to reopen a cached character sheet: the library entry, the creation route,
 * and one character deep link segment. Every other document path (including
 * `/api`, `/dev`, and unknown paths) must fall through to the network so an
 * API failure is never disguised as HTML.
 */
export function isKnownShellRoute(pathname: string): boolean {
  const path = pathname.endsWith("/") && pathname !== "/" ? pathname.slice(0, -1) : pathname;
  if (path === "/") return true;
  if (path === "/characters/new") return true;
  if (path.startsWith("/characters/")) {
    const rest = path.slice("/characters/".length);
    return rest.length > 0 && !rest.includes("/");
  }
  return false;
}

/**
 * Whether the worker handles this same-origin request. `mode` is `"navigate"`
 * for document navigations and any other string for subresource requests.
 */
export function shouldHandle(url: URL, mode: string): boolean {
  const path = url.pathname;
  if (path === "/api" || path.startsWith("/api/")) return false;
  if (path === "/dev" || path.startsWith("/dev/")) return false;
  if (mode === "navigate") return isKnownShellRoute(path);
  return true;
}

/**
 * Render the standalone `sw.js` source for a versioned asset manifest. The
 * routing helpers above are serialized verbatim so the worker and the unit
 * tests share one implementation. The lifecycle is deliberately non-forced:
 * no `skipWaiting`, so open clients stay on a coherent build until they
 * close; obsolete caches are removed on activate, when old clients are gone.
 */
export function renderServiceWorker(manifest: OfflineManifest): string {
  const embedded = JSON.stringify(manifest);
  return `"use strict";
const OFFLINE_MANIFEST = ${embedded};
const OFFLINE_CACHE_NAME = ${JSON.stringify(cacheNameForBuild(manifest.buildId))};
const OFFLINE_STATUS_MESSAGE = ${JSON.stringify(OFFLINE_STATUS_MESSAGE)};
${isKnownShellRoute.toString()}
${shouldHandle.toString()}
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      // Transactional install: addAll rejects if any asset fails, so a
      // partial cache never reports readiness.
      const cache = await caches.open(OFFLINE_CACHE_NAME);
      await cache.addAll(OFFLINE_MANIFEST.assets);
    })(),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(${JSON.stringify(`${OFFLINE_CACHE_PREFIX}:`)}) && name !== OFFLINE_CACHE_NAME)
          .map((name) => caches.delete(name)),
      );
      if (self.clients && typeof self.clients.claim === "function") await self.clients.claim();
    })(),
  );
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  const mode = request.mode === "navigate" ? "navigate" : "asset";
  if (!shouldHandle(url, mode)) return;
  if (mode === "navigate") {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request).catch(() => undefined);
        if (cached) return cached;
        const shell = await caches.match("/index.html").catch(() => undefined);
        if (shell) return shell;
        return fetch(request);
      })(),
    );
    return;
  }
  event.respondWith(
    (async () => {
      const cached = await caches.match(request).catch(() => undefined);
      return cached || fetch(request);
    })(),
  );
});
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== OFFLINE_STATUS_MESSAGE) return;
  const port = event.ports && event.ports[0];
  const target = port ? port : event.source;
  if (!target) return;
  event.waitUntil(
    (async () => {
      // Eviction-aware readiness: liveness alone is not enough. A
      // post-activation eviction can leave the worker alive while the
      // versioned cache or shell is gone, so confirm both before reporting
      // ready.
      let ready = false;
      try {
        const hasCache = await caches.has(OFFLINE_CACHE_NAME);
        const shell = hasCache ? await caches.match("/index.html") : undefined;
        ready = hasCache && !!shell;
      } catch {
        ready = false;
      }
      const reply = { type: OFFLINE_STATUS_MESSAGE, ready, buildId: OFFLINE_MANIFEST.buildId, cache: OFFLINE_CACHE_NAME };
      target.postMessage(reply);
    })(),
  );
});
`;
}
