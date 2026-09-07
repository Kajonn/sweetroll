# Task 11 report — prove offline acceptance and close review gaps

Branch: `i4-character-sheet` (worktree `/home/jonas/dev/sweetroll/.worktrees/i4-character-sheet`).
Base for comparison: `2738344` (`fix: make offline readiness eviction-aware`).
No subagents. TDD throughout (RED observed for (a) integration audience and I4 seeder guard before fixes).

## Critical (a) — integration audience regression: FIXED, suite green

`tests/integration/character-http-acceptance.test.ts:308` used strict `toEqual` on the roll
envelope without `audience`, regressing against same-branch Task 7 (`34bde15`, which added
authoritative `owner_only` audience through runtime → persistence → HTTP/OpenAPI → web).
RED confirmed pre-fix:

```
FAIL  tests/integration/character-http-acceptance.test.ts > full d20 flow over HTTP …
AssertionError: expected { actionId: 'check', …(6) } to deeply equal { actionId: 'check', …(5) }
+   "audience": "owner_only",
❯ tests/integration/character-http-acceptance.test.ts:308:21
```

Fix: added `audience: "owner_only"` to the `toEqual` (strict equality retained, contract pinned).
Full evidence post-fix:

```
TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npm run test:integration
 Test Files  12 passed (12)
      Tests  120 passed (120)
```

## Critical (b) — visual 4× fails: PROVEN pre-existing at base, re-baselined

Claim under test: the 4 visual fails are "identical at base on fresh DB" (i.e. NOT caused by
Task 7–11 UI changes). Proof procedure (main untouched; isolated worktree
`/tmp/opencode/sweetroll-base` at detached `2738344`, `node_modules` symlinked — package
manifests identical between base and HEAD):

1. Fresh DB per run: `DROP DATABASE sweetroll / CREATE DATABASE sweetroll` + `npm run migrate`
   (per-worktree migrate; the HEAD DB could not be reused for base because the Task 11 seeder
   rows trip the base seeder's checksum-unique path — further proof the seeders differ, handled
   by starting each run from an empty database).
2. `CI=1 DATABASE_URL=… AUTHORITATIVE_ROLL_SECRET=… npx playwright test tests/e2e/visual.spec.ts --reporter=list`
   in each worktree (CI=1 forces fresh webServers so the base run serves base code).

HEAD at `651d67c` on fresh DB (`/tmp/opencode/visual-head.log`):

```
✘  1  visual: library › at 360px
✘  2  visual: library › at 1280px
✘  3  visual: document editor (d20) › at 360px
✘  4  visual: document editor (d20) › at 1280px
✓  5–10  sheet preview ×2, publish dialog ×2, conflict banner ×2
4 failed / 6 passed
library-360:          979 pixels (ratio 0.01 of all image pixels) are different
library-1280:         958 pixels (ratio 0.01 of all image pixels) are different
document-editor-360:  979 pixels (ratio 0.01 of all image pixels) are different
document-editor-1280: 958 pixels (ratio 0.01 of all image pixels) are different
```

Base `2738344` on fresh DB (`/tmp/opencode/visual-base.log`): **identical set, identical ratios**
(4 failed / 6 passed; 979 / 958 / 979 / 958 px at ratio 0.01 for the same four tests).
The base diff image (`library-360-diff.png`, inspected) shows header-only drift (logo /
"New character" / "Sign out" anti-aliasing), with zero content-area diff — same pixel counts
for library and document-editor at equal widths confirm a shared chrome element, not page
content. No Task 7–11 code path renders those pages' headers differently (Tasks 7–11 touch
character sheets, offline store/session, and character routes only).

Disposition: accepted as stale-baseline header drift, pre-existing at base. Re-baselined via
`web:test:e2e:update` ONLY for `tests/e2e/visual.spec.ts` (4 PNGs regenerated:
`library-360/1280.png`, `document-editor-360/1280.png`; the 6 passing baselines untouched).
Verify on fresh DB post-rebaseline (`/tmp/opencode/visual-head-rebaseline.log`): **10 passed**.
Final full dev-server E2E (`/tmp/opencode/e2e-full2.log`): **19 passed** (acceptance 2, sheets 6,
smoke 1, visual 10) — CSS fix below did not move any visual pixel.

## I1 — lost-response proof hardened (identical frozen key + idempotent replay)

`web/tests/offline/character.spec.ts` (`runAcceptance`, all 3 REFERENCE_SYSTEMS) and
`web/tests/offline/coordination.spec.ts` (post-takeover sync) previously only asserted the
abort happened. Now: both bump attempts' bodies are captured via
`route.request().postDataJSON()`; the test asserts `≥2` attempts, a defined
`idempotencyKey`, **identical keys and identical full bodies** (same frozen request replayed,
not a re-minted one). Because a client-side `route.abort("failed")` lands pre-apply, each
test additionally replays the captured frozen body server-side and asserts
`reconciliation.replayed === true` with revision still `before + 1` and still exactly one
`character_resource_bumped` row — proving the frozen key is idempotent (no double effect even
if the abort had landed post-apply).

## I2 — bump activity tightened to exactly one

Both specs above now assert
`activity.events.filter(e => e.kind === "character_resource_bumped").length` **`.toBe(1)`**
(revision `+1` proves single effect; exactly one row proves no double-apply across the
abort+retry window), including after the frozen-key replay POST.

## I3 — prior-owner revoke purge (was cross-owner probe only)

New test `privacy.spec.ts`: "prior owner cache is purged after server-side ownership transfer".
As owner A: open sheet to offline-ready (durable snapshot + worker), queue one offline bump,
reconnect with bump sync held (route abort) so the queue cannot drain, then transfer ownership
to B server-side (`POST /api/characters/:id/ownership-transfer`). Reload as prior owner A:
asserts `This character is unavailable.`, heading count 0, `Changes pending` count 0, response
body contains no character name, API `GET` → 404 with `cacheDisposition: "purge"`. Queue
deletion (not send): B still sees pre-transfer revision `+1` (transfer only, no bump leak).
Snapshot deletion: a fresh page in A's context still shows unavailable, never the cached name.

## I4 — seeder repair-by-delete RESTRICT guard

`seedReferenceTemplates` (`src/systems/implementation/persistence/repository.ts`) repaired
drifted template rows via `DELETE + INSERT`. `characters.system_version_id` (and migration
source/target ids) reference `system_versions` with `ON DELETE RESTRICT`, so a future
drift+usage coincidence would crash boot (23503) or remove a live row. Fix: before the
`DELETE`, `SELECT 1 FROM characters WHERE system_version_id = $1`; on a hit, skip the repair
(`console.warn` + keep old row). Isolated seeder schemas without a `characters` table
(`42P01`) keep the old repair path — existing DB repair test still passes. TDD: new
no-DB fake-runner test asserts no `DELETE` is issued, the characters probe runs, a warning is
logged, and `versionsReplaced` is 0.

## I5 — sheet E2E parameterized over all reference systems (no scope reduction)

`web/tests/e2e/character-sheet.spec.ts` was d20-only (2 tests). It now runs
`REFERENCE_SHEETS` (d20 / PbtA 2d6 / d6 pool) × 360/1280 = **6 tests**, each with keyboard
Enter bump, no-overflow assert, screenshot (`e2e-character-<key>-<width>.png`), and axe
(serious/critical). This exposed a REAL UI bug (fix, not scope reduction): the PbtA sheet
failed axe with `color-contrast` serious — 12px `--color-warning` (`#d97706`, 3.05:1 on
`#fafafa`) in `#character-action-unavailable`. Fix follows the codebase's existing convention
(editor modules already use `--color-warning-fg` fallback `#92400e`): added
`--color-warning-fg: #92400e` to `web/src/styles/global.css` and switched the character
sheet's small warning text (`.actionUnavailable`, `.stale`, `.completionUnavailable`,
`.imageUnavailable > span:last-child`) to it. No design-doc change (no token spec in
`design_v2.md`; matches established editor-module pattern). Borders/large-graphics keep
`--color-warning`; publish/preview modules untouched (out of scope, no axe coverage, would
invalidate fresh baselines). Post-fix: 6/6 green.

## Minors (noted, no code change required)

- Dev-signin test users: `/dev/signin` test identities (`code-test-a/b`, `code-dev`) persist
  `users`/`sessions` rows; offline/e2e tests do not clean them up. Accepted: isolated per-run
  subjects, no cross-test interference (each test uses unique character names + fresh
  contexts); DB resets (`DROP/CREATE + migrate`) clear them when determinism matters.
- `SWEETROLL_TEST_AUTH=1`: test-only escape hatch registering `/dev/signin` under
  `NODE_ENV=production` for the offline fixture. It defaults OFF (`http.ts:48,107`) and must
  stay out of real deployments — no production UI affordance exists (dev panel mounts only in
  dev mode; fixture posts to the endpoint directly). Deployment check: never set the env var
  outside local/CI acceptance runs.
- Router first-render: route views render `<p role="status">loading</p>` (never a null flash)
  while identity/store/coordination resolve (`router.tsx:118,145-154`); coordination handles
  are never reused across StrictMode remounts. Session settle: `whenIdle`/drain quiescence is
  awaited on lock release (`setQuiesce`). Both reviewed as acceptable, unchanged.
- Migration comment assertion (`0010` RESTRICT note): acceptable as-is; I4's runtime guard
  above is the enforcement.

## Final verification (all unpiped, final code)

- `TEST_DATABASE_URL=… npm run test:integration` → 12 files, **120 passed**
- `npm test` (root unit) → 28 files, **269 passed**
- `npm --prefix web run test` → 59 files, **484 passed**
- `npm run web:test:e2e` (dev server, fresh DB) → **19 passed** (`/tmp/opencode/e2e-full2.log`)
- `npm run web:build` then `npm run web:test:offline` (production build) → **13 passed**
  (`/tmp/opencode/offline2.log`; 13 = 12 prior + 1 new I3 revoke-purge test)
- `npm run typecheck` + `npm --prefix web run typecheck` → pass; `npm run build` → pass
- `git worktree remove --force /tmp/opencode/sweetroll-base` after evidence capture (main never touched)
