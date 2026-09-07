# Task 10 report — eviction-aware offline readiness (I1 + M1-M4)

## Fixes
- I1 `web/src/offline/worker.ts`: status `message` listener now checks `caches.has(OFFLINE_CACHE_NAME)` + `caches.match("/index.html")`, replies `ready` only if both (eviction-aware, async via `event.waitUntil`).
- M1 `web/src/offline/register.ts`: `offlineReady` now `state.snapshotCompatible ?? false` (missing compatibility defaults to not-ready). Hook still passes explicit compatibility.
- M2 `web/build/offline-assets.ts`: added `avif` to `CACHEABLE_EXTENSIONS`; removed dead `manifest.webmanifest` from `GENERATED_FILES` (commented). No new exports/APIs.
- M3 `web/src/offline/useOfflineAvailability.ts`: threads explicit `stored?: boolean` (`snapshotStored = stored ?? view !== null`) with documented implication (confirmed view only set after durable-store load).
- M4 `web/src/offline/register.ts`: `hasControllingWorker` single-eval (`const c = ...controller; return c !== null && c !== undefined`).

## Regression tests (TDD)
- RED confirmed pre-fix: `grep caches.has web/src/offline/worker.ts` → none.
- Added `worker.test.ts`: source contains `caches.has` + `caches.match`, no literal `ready: true` (evicted cache → ready false semantics).
- Updated `register.test.ts`: missing compatibility → `false`; explicit `true` still required.
- Added `offline-assets.test.ts`: avif cached.

## Evidence
- focused: `npm --prefix web run test -- src/offline/worker.test.ts src/offline/register.test.ts src/offline/offline-assets.test.ts src/offline/availability.test.tsx` → 4 files, 31 tests passed.
- `npm --prefix web run test` → 59 files, 481 tests passed (1 flake in `session.test.ts` on first run, passed on rerun + isolated).
- `npm --prefix web run build` → pass; `dist/sw.js` contains `caches.has` (1x).
- `npm --prefix web run test:offline` → 1 passed (chromium offline deep-link reload).
- `npm run typecheck` → pass; `npm --prefix web run typecheck` → pass (unpiped, separate runs).
