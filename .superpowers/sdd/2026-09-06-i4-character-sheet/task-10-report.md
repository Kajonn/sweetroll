# Task 10 report — Production Offline Asset Loading

## Status

Complete. Fully offline reopening of cached character sheets behind a
production-only, asset-only service worker.

## What was built

- `web/src/offline/worker.ts` — pure routing (`shouldHandle`,
  `isKnownShellRoute`), versioned cache naming, and `renderServiceWorker`,
  which serializes those same functions into the emitted `sw.js`. No DOM,
  React, IndexedDB, or API imports, so the worker builds as an isolated
  script. Lifecycle: transactional `addAll` install (any failure fails the
  install, never ready), no `skipWaiting` (open clients stay on a coherent
  build), obsolete caches purged on activate, known-route shell fallback,
  `/api` + `/dev` + unknown document paths never intercepted, no
  `cache.put` of response bodies. Status-message handler
  (`sweetroll:offline-status`) confirms cache readiness per build.
- `web/src/offline/register.ts` — `offlineReady` (Available-offline =
  stored snapshot + compatible projection + controlling-worker cache
  readiness), `isSnapshotOfflineCompatible` (projection `1.0`),
  `readOfflineBuildId`, `describeOfflineUpdate`, production-only
  `registerOfflineWorker` (`/sw.js`, scope `/`), and
  `queryWorkerCacheReady` (no controller/reply/timeout reads as not ready).
- `web/src/offline/useOfflineAvailability.ts` — hook combining the durable
  snapshot with confirmed worker cache readiness; page/worker build mismatch
  surfaces as `update-available`.
- `web/build/offline-assets.ts` — Vite plugin emitting versioned `sw.js` +
  `offline-manifest.json` (entry HTML + lazy chunks/CSS/fonts; sourcemaps,
  API/export bodies excluded), stamping the shell with the build id, and
  adding preview SPA fallback (API/dev/files pass through).
- `web/playwright.offline.config.ts` + `web/tests/offline/offline.spec.ts`
  — production-browser smoke test (worker control + deep-link reload with
  cached assets). Excluded from Vitest discovery.
- Modified: `web/vite.config.ts` (plugin, `tests/offline/**` exclusion;
  dev E2E config untouched), `web/src/main.tsx` (production registration),
  `web/src/characters/CharacterRoute.tsx` + `CharacterSheet.tsx`
  (Available-offline badge via optional `offlineAvailable` prop; renderer
  stays transport/browser-free), `web/src/i18n/messages.ts` (two keys),
  root + web package scripts (`web:test:offline` delegation).
- No install manifest, no install prompts, no private data in CacheStorage.

## Verification (commit `a16530b` + working tree below)

- Red: `npm run web:test -- src/offline` → 4 files failed (missing modules).
- Green focused: 28/28 pass (`worker` 11, `register` 9, `offline-assets` 4,
  `availability` 4), including the brief's verbatim assertions.
- `npm run web:build` → `dist/sw.js` (no `skipWaiting`), manifest
  `{buildId, [/index.html, css, js]}`, no `.map` entries, shell stamped
  with matching build id.
- `npm run web:test:offline` → 1/1 passed (chromium; worker control,
  readiness reply with build id, `/characters/new` reload fully offline).
  Backend proxy errors in the log are expected — no backend runs; the shell
  renders anonymously.
- Full: `web:test` 478/478 (59 files), root `npm test` 269/269,
  `web:typecheck` and root `typecheck` clean.

## Limitations

- `vite preview` serves the last `web:build` output; the offline suite
  assumes a fresh build first (documented in the offline config header).
- Preview has no backend, so the smoke test asserts shell/asset caching,
  not authenticated character data (covered by unit/hook tests).
