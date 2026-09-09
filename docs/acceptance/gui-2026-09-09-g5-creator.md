# G5 acceptance (2026-09-09) — simple creator + publish-to-character handoff

Branch `feat/g5-simple-creator`, Task 6 of 6 (Tasks 1–5: `e5487d3..402e71c`).
Commit: `feat(g5): publish-to-character handoff with exit demonstration` on
branch `feat/g5-simple-creator` (parent `402e71c`, Tasks 1–5: `e5487d3..402e71c`).
No design change (`design_v2.md` untouched — the §17.6a acceptance demo already
mandates "create and publish a simple system … create and use a character").

## What changed (Task 6)

- `web/src/publish/PublishDialog.tsx` (success view only): `Create test character`
  plain `<a href=/characters/new?systemVersionId={versionId}>` (same Router-less
  pattern as `VersionHistory.tsx:171-177`) beside the kept `Close`; versionId +
  checksum display unchanged; submit gate untouched. New i18n key
  `publish.success.createCharacter`. CTA styled primary via a `.createLink` class
  (semantic tokens only).
- `web/src/editor/sheet/{SectionEditor,SheetEditor}.tsx` + `DocumentEditor.tsx`
  `SheetsTab`: document-wide section/element-id allocators. The e2e exposed that
  adding a field element to two sections minted `element_1` twice, and
  `duplicate_definition_id` blocks saves → the 4th draft PUT 422'd ("Save
  failed" with no recovery). Allocation now scans all sheets; per-section
  fallback kept for standalone use.
- `web/src/shell/AppShell.tsx`: query hygiene on the null→actor settle is now
  `invalidateQueries()` instead of `cancelQueries()+removeQueries()`. The e2e
  exposed that reload/direct-link on `/systems/:id` stuck on "Loading system…"
  forever: the initial settle cancelled the editor's open fetch (proven with a
  temporary console probe: two `null/0 → actor/1` cancels racing the open
  GETs). Away-from-account transitions (switch/sign-out/generation bump) still
  cancel+purge. Probe removed.
- Tests: new `web/tests/e2e/creatorToCharacter.spec.ts` (exit demo + reference
  preservation); `PublishDialog.test.tsx` success-CTA anchor assertion;
  `SheetEditor.test.tsx` allocator tests. `acceptance.spec.ts` untouched.

## Evidence (all actually run; isolated DB `sweetroll_g5`, backend 3112 / web 5176)

- `CI=1 DATABASE_URL=…/sweetroll_g5 AUTHORITATIVE_ROLL_SECRET=development-only-roll-secret-32-bytes BACKEND_PORT=3112 WEB_PORT=5176 SWEETROLL_BACKEND_TARGET=http://localhost:3112 npx playwright test tests/e2e/creatorToCharacter.spec.ts --reporter=list` from `web/` → **2/2 pass** (exit 7.4s, preservation 1.8s on the final run).
- Same env `npx playwright test tests/e2e/creatorToCharacter.spec.ts tests/e2e/acceptance.spec.ts` → 3 pass, **1 pre-existing failure**: `acceptance: clone template…` fails at `document-editor-tab-entities` (legacy tab id removed by the Task 2 tab rename; fails identically on clean `402e71c` with my changes stashed — verified, not a Task 6 regression; file left untouched per constraint). The `a11y: library passes axe` test passes.
- `npx vitest run` from `web/` → **72 files / 791 passed**. `npm run typecheck` → clean. `npm run build` → ok.
- `node --import tsx scripts/generate-system-contracts.ts --check` from root → exit 0. `TEST_DATABASE_URL=…/sweetroll_g5_int npm run test:integration` → **13 files / 126 passed** (serial, load limits preserved).
- Reference fixture: blank draft via library UI + seeded d20 template (`a0000000-0000-5000-8000-000000000001/…0002`).
- Device/browser: headless Chromium (Playwright, Linux), viewports 1280×800 and 360×800. Theme: default light ("Follow device", never switched).

## Screenshots

- `/tmp/g5-publish-success.png` (run artifact, not committed): publish-success
  card showing "Published / Version 1.0.0 is live.", version ID + checksum rows,
  primary `Create test character` CTA beside `Close`. Inspected: layout correct,
  no clipped actions. No "before" shot (new element; before = no CTA).
- No full-page journey PNGs kept (matches G4 artifact policy).
- Visual baselines regenerated with owner approval (see below): the 8 stale
  `visual.spec.ts` PNGs (library, document-editor, sheet-preview,
  publish-dialog × 360/1280) now match the creator UI; both
  `conflict-banner-*` PNGs passed unchanged against the existing baselines.

## Visual baseline regeneration (human-approved, 2026-09-09)

The owner HUMAN-APPROVED regenerating the 8 stale visual baselines
(approval recorded in the controller session). The actuals were inspected
before approval: new basics-first tabs, readiness row, taller publish
dialog with readiness summary; doubled preview headings verified
pre-existing from the old expected PNG. No source changes were made to get
green (locator migration only, already landed in `8705a56`).

Commands actually run (branch `feat/g5-simple-creator`, commit `617eb03`):

- Prerequisites per `web/playwright.config.ts:17-47`: `npm run migrate` from
  root (DB `postgres://sweetroll:sweetroll@localhost:5432/sweetroll`,
  default ports BACKEND_PORT=3000/WEB_PORT=5173); backend (`npm run
  dev:http`) + web (`npm run web:dev`) auto-started by Playwright
  `webServer`, same pattern as the CI `web-e2e` job.
- From `web/`: `npx playwright test tests/e2e/visual.spec.ts
  --update-snapshots --reporter=list` → 8 PNGs re-generated
  (`conflict-banner-360/1280` passed against existing baselines, untouched),
  10 passed.
- Re-run from `web/`: `npx playwright test tests/e2e/visual.spec.ts
  --reporter=list` → **10/10 pass**.
- `git status --short` confirmed ONLY the 8 expected PNGs under
  `web/tests/visual/__screenshots__/` changed; committed alone as
  `617eb03 test(gui): regenerate visual baselines for G5 creator`.
- Spot-check: regenerated `publish-dialog-1280.png` shows the readiness
  summary (Draft rev / Unsaved changes / No blocking issues / Not published
  yet), semver input + Patch/Minor/Major, release notes, and
  Cancel/Confirm publish.

## Manual findings

- `MetadataEditor` buffers keystrokes and flushes on form blur: e2e fills must
  Tab out before the PUT waiter, and the waiter matches PUT *request bodies*
  (`document.metadata.description` / ids) because a mount autosave PUT can win
  the race with unrelated content.
- Template seed versions are link-only (owner NULL): `GET
  /system-versions/{seed}/export` is 404 by design (`exportVersion` requires
  ownership). The preservation test publishes the clone and exports the owned
  version instead — existing HTTP surface only, no new endpoints, no seed
  changes.
- Post-publish version-history row verified by returning to `/systems/:id`
  after character creation (success dialog is modal, so the row check happens
  after the CTA navigation).

## Remaining limitations (not run / not fixed)

- `acceptance.spec.ts` clone-flow was red on stale Task-2 tab locators (see
  above); fixed by the locator-only migration in `8705a56`
  (`creatorToCharacter + acceptance` 4/4 green there), and `visual.spec.ts`
  is now 10/10 green on the regenerated baselines above. `smoke.spec.ts` /
  `character-sheet.spec.ts` were not re-run here; any red there is
  pre-existing and out of Task 6 scope.
- No dark-mode, 200% text, long-label, touch, or real-device (Android/iPad)
  runs — remains G9 work. No axe run inside the new spec (library axe still
  passes in `acceptance.spec.ts`).
- Characters created by the e2e (`G5 Test Hero`) have no DELETE endpoint and
  remain as residue in the isolated `sweetroll_g5` DB (precedent:
  `character-sheet.spec.ts`); systems are deleted in `afterEach`.
