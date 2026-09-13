# G7 GM campaign-upgrade Phase 3 acceptance (I7 exit demonstration)

Date: 2026-09-13. Branch `feat/phase3-campaign-upgrade`. Tree: Task 7
closeout (this note plus `web/tests/e2e/campaignUpgradeJourney.spec.ts`,
committed together as the Task 7 closeout change). Tasks 1–6 shipped the
full upgrade path on this branch: backend preview/commit, HTTP routes,
web seam, UpgradeDialog, and GM Settings wiring with the production chain
(route → CampaignDetail → Settings → dialog) live. Only checks actually
run are listed; anything not listed was not run.

## Product changes

None. This task is test-only by binding: no product file was modified
(`git status` shows only the new spec plus this note). The dialog stays
open on success by product design; the journey closes it explicitly in
test-only handling. `workers: 1`, `retries: 0` preserved (untouched
`web/playwright.config.ts`). The ordinary-player claim and
Hidden-recovery journeys are untouched in their own specs.

## Exit demonstration (new, Task 7)

`web/tests/e2e/campaignUpgradeJourney.spec.ts` — "G7 exit: publish newer
version via creator UI, upgrade campaign A with stale retry, campaign B
untouched". Chromium headless, default desktop viewport:

1. GM `code-test-a` via the dev sign-in panel (code field filled) builds a
   fixture system through the real creator UI — the G5 blank → simple
   system flow, no publish bypass: blank draft, description + default
   dice, one `Hero` entity with integer `Might` (`field`) + text `Name`
   (`field_1`), one guided d6 roll, one sheet binding both fields, then
   publish 1.0.0. The new system id is deleted in `afterEach`
   (campaigns/characters have no DELETE endpoint, so campaign/hero names
   carry a per-run stamp).
2. Two GM-owned campaigns A/B are created on the 1.0.0 pin through real
   HTTP as the GM actor, with one campaign character each on the `Hero`
   entity.
3. A newer version is published through the same creator UI: the Might
   max is tightened 20 → 10 on the Attributes tab (the carried default 0
   stays valid) and 2.0.0 is published. The constraint change is
   acknowledgement-free and surfaces as a per-character preview warning
   without requiring explicit mappings (every valued field is
   sheet-bound, so nothing is ever dropped).
4. Immediately after publishing, both campaigns still read the 1.0.0 pin
   (publishing alone upgrades nothing).
5. Campaign B's view + roster are snapshotted as the byte-identical
   baseline (envelope `requestId` excluded).
6. `code-test-b` is invited to campaign A as co-GM through the real
   invitations endpoint and accepts through the real invitation UI in a
   second browser context, so the stale-commit bump comes from a
   different GM actor.
7. Campaign A: detail → Members tab → Campaign settings → Upgrade
   campaign → the 2.0.0 target is discovered in the catalog-filtered
   list (same system, strictly greater semver) and selected.
8. Preview shows the before/after pin (`1.0.0 → 2.0.0`), the attached
   hero, and the `Constraints for field` warning, with no `Requires
   explicit mapping` marker.
9. The second GM bumps campaign A (title PATCH through real HTTP), so
   the dialog's preview revision goes stale; confirm + Commit answers
   409 and the dialog reports `Campaign changed — review fresh preview.`
   The fresh preview refetch is observed on the wire
   (`POST upgrade-previews`) before the retry, and the confirmation gate
   is renewed (checkbox unchecked again).
10. Explicit retry with a fresh confirmation commits: `Upgraded to
    2.0.0.` The dialog stays open on success and is closed explicitly
    via Close (test-only handling, no product change).
11. Real reads: campaign A serves the 2.0.0 pin at a newer revision with
    its hero migrated to 2.0.0; campaign B's view + roster stringify
    byte-identical to the pre-upgrade baseline.

## Gates actually run (2026-09-13, this tree)

Tested commit `96787cf` plus the Task 7 closeout (spec + this note).

Targeted red/green iteration used direct Playwright with
caller-managed resources (dedicated DB/ports + `DATABASE_URL` + `CI=1`
per README §Browser E2E; never the dev database):

- RED: the new spec run from a detached worktree at `67fc5ed`
  (pre-Phase-3 parent; spec file copied in, `node_modules` symlinked,
  DB `sweetroll_t7_red`, ports 3221/5221) — **1 failed as expected**:
  creator publish 1.0.0/2.0.0, both campaigns, pins-unchanged asserts,
  B baseline, co-GM invite/accept, Members tab and Campaign settings
  all pass; the run times out waiting for the `Upgrade campaign`
  button (no Upgrade section; upgrade routes absent before Tasks 1–6).
- GREEN: same spec on this tree (DB `sweetroll_t7_iter`, ports
  3211/5211) — **1 passed (14.6s)** with no test-only selector/timing
  fixes needed beyond the fixture redesign below.

Full matrix (all on this tree):

- Root `npm test` — **29 files / 309 tests pass**.
- Root `npm run test:integration` (`TEST_DATABASE_URL` set) —
  **28 files / 319 tests pass**.
- Root `npm run typecheck`, `npm run contracts:check`, `npm run build`
  — clean.
- Web `npm test` — **95 files / 964 tests pass** (see findings for one
  transient full-suite timeout; file-alone rerun 17/17).
- Web `npm run typecheck`, `npm run build` — clean.
- Canonical `npm run test:e2e` from `web/` (`E2E_DATABASE_ADMIN_URL`
  + `AUTHORITATIVE_ROLL_SECRET` + `CI=1`) — **23/23 journeys pass
  (includes the new spec, listed 4th) + 10/10 visuals pass**.
- Canonical without the secret — setup error, not a result: the
  webServer fails at start (`AUTHORITATIVE_ROLL_SECRET is required
  outside tests`, exit 1).
- Fresh `npm run web:build`, then `npm run web:test:offline`
  (DB `sweetroll_offline` + `CI=1` + `SWEETROLL_TEST_AUTH=1` per CI) —
  **22/22 pass**.
- `docker build -t sweetroll:ci .` — pass. `git diff --check` — clean.

## Findings

- First journey draft used an owned d20 clone as the fixture. Its
  `proficient` field is required-but-sheet-unbound, so every hero
  carries an unknown-kind value the migration can never same-ID carry:
  the preview reports `Source field(s) "proficient" have no target`
  plus the package-default warning with `requiresMapping: true`, and
  the commit fails closed with 422 `requires explicit mappings`. The
  dialog (by design) displays the mapping demand but offers no mapping
  entry, so a dialog-driven commit on d20-based campaigns cannot
  succeed. No product change: the journey builds a scratch system via
  the creator UI with every valued field sheet-bound instead, and the
  v2 constraint edit keeps `requiresMapping` false. Backend fail-closed
  behavior is unchanged and unasserted here beyond the 409 path.
- `web npm test` flaked once under full-suite load:
  `AppShell.test.tsx > null→actor settle refetches …` timed out in
  5000ms (run 1: 1 failed / 963 passed; immediate rerun: 964/964 with
  no code changes; file-alone rerun: 17/17). Pre-existing timing
  sensitivity in an untouched shell test, unrelated to this task — no
  product file changed. Not fixed here.
- Browser/device/theme matrix actually run: Playwright Chromium
  headless only, default desktop viewport for the new journey (other
  specs cover 360×640 / 1280×800). Theme: default (light in headless)
  — no dark-mode e2e in this task. No real-device runs.

## Fixture

Per-run scratch system via the creator UI (unique
`G7 Upgrade System <uid>` name, 1.0.0 → 2.0.0; system row deleted in
`afterEach`); unique `G7 Upgrade A/B <uid>` campaigns and heroes per
run on the isolated e2e database (no campaign/character DELETE
endpoint). GM `code-test-a` owns everything; `code-test-b` joins
campaign A as co-GM through a real invitation accept. Idempotency keys
caller-minted fresh per attempt, including the dialog's per-attempt
keys and the renewed confirmation after the 409.

## Limitations (open)

- Production OIDC: no real-provider validation (owner decision); GM
  sign-in proven on seeded dev codes only (dev panel for journeys,
  `SWEETROLL_TEST_AUTH` for the offline suite).
- No physical phone/tablet runs, no standalone install proof beyond
  the existing PWA checks, no dark-mode runs for the new journey.
- The exit journey covers the constraint-warning upgrade path only;
  explicit-mapping upgrades (dropped sources) stay backend-covered —
  the dialog has no mapping entry by design.
- Scratch databases (`sweetroll_t7_iter`, `sweetroll_t7_red`,
  `sweetroll_offline`) were dropped after their runs; the dev database
  was never reset; the canonical runner created/isolated/dropped its
  own run-scoped databases.

## Open follow-ups

- I7 Phase 4 hardening (per design §17 sequence: Phase 3 upgrades,
  then Phase 4 hardening, then I7b scenes/display).
- G8 (I7b media/scenes/restricted display) and G9 release acceptance
  (built-artifact review, real-device checks, deployment, playtests)
  stay open, as do production authentication and the pre-existing G7/G9
  gates recorded earlier.
