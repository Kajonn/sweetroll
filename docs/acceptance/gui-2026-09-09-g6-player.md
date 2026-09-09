# G6 Player app acceptance (I5 exit demonstration)

Date: 2026-09-09. Branch `feat/g6-player-app`. Tree: `ddc0929` (Tasks 1–6)
plus the new `web/tests/e2e/playerJourney.spec.ts` and this note, committed
together as the Task 7 closeout change. Only checks actually run are listed;
anything not listed was not run.

## Exit demonstration (new, Task 7)

`web/tests/e2e/playerJourney.spec.ts` — "I5 exit: sign in on phone, select
system, create+play two characters, find recent, survive offline, export,
sign out clears data". One test, phone viewport 390x844, Chromium headless:

1. `/welcome` onboarding (anonymous, flag cleared first): welcome heading,
   create-first-character link `href="/characters/new"`, library link
   `href="/characters"`; Continue persists `sweetroll:onboarding:anonymous`.
2. Dev sign-in, then an actor-owned d20 clone is published through the real
   System Builder API (clone → save draft unchanged → publish 1.0.0),
   because the seeded reference templates are link-access/unlisted (OD-01)
   and versionless enumeration never offers them.
3. Versionless `/characters/new` picker select with no ID typed (owned clone
   chosen from the list) → hero A created → `Proficient` completion →
   Decrease Health bump (Saved) → Check roll (Roll result + Total).
4. Same picker flow creates hero B → Decrease Health bump (Saved).
5. `/characters`: each hero opened once from the list, then the Recently
   opened rail shows both; hero A reopened from the rail.
6. `context.setOffline(true)` → Increase Health → Changes pending →
   reconnect → Saved; server activity holds exactly 2
   `character_resource_bumped` events (one online, one replayed — no dupes)
   and the library shows exactly one row for hero A.
7. Export on hero A: `download` event captured, parsed file byte-equals the
   authoritative `POST /api/characters/:id/exports` document.
8. Sign-out (confirm dialog accepted): dev panel returns; `/characters`
   shows no hero name and no Recently opened rail; no `localStorage` value
   contains either name; reload stays clean.

## Gates actually run (2026-09-09, this tree)

From `web/` (env `DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll`
`AUTHORITATIVE_ROLL_SECRET=development-only-roll-secret-32-bytes`; Playwright
started its own backend `npm run migrate && npm run dev:http` + `npm run web:dev`
per `playwright.config.ts`):

- `npx playwright test tests/e2e/playerJourney.spec.ts
  tests/e2e/playerLibrary.spec.ts tests/e2e/playerShell.spec.ts` — **6/6 pass**.
- `npm test` — **78 files / 860 tests pass** (includes the prior-contract
  suites: paginated catalog, library + duplicate, shell routes + mounts,
  theme precedence incl. account-default matrix, G4 restyle DOM contracts,
  auth concurrency/return/expired flows).
- `npm run typecheck` — clean. `npm run build` — clean (chunk-size warning only).

From repo root (env `TEST_DATABASE_URL=...same Postgres...`):

- `npm run test:integration` — **16 files / 135 tests pass**.
- `npm run contracts:check` — pass.
- `npm test` — **28 files / 273 tests pass**.

Browser/device/theme matrix actually run: Playwright Chromium headless only;
journey at 390x844, shell specs at 360/1280 phone + desktop. Theme: default
(Follow-device → light in headless) — no dark-mode e2e in this task; the
account-default/device-override matrix is covered by the unit suites
re-run green above. No real-device runs (see limitations).

## Fixture

Per-run owned d20 clone (name kept "D20 System", 1.0.0) via API; seeded
reference templates via `migrate`; dev sign-in default code; unique
`Exit Hero A/B <base36>` names (no character DELETE endpoint; shared dev DB).

## Screenshots

- `web/tests/e2e/evidence/exit-library-recent-390-<stamp>.png` (transient,
  gitignored): phone library with Recently opened rail + list rows showing
  both exit heroes. Viewed and confirmed 2026-09-09.

## Findings

- The exit journey passes with **zero implementation changes**: no wiring
  bugs, no missing empty-states, no sign-out purge holes on this path.
  Sign-out purge + per-account isolation were verified, not assumed:
  AppShell cancels + `removeQueries()` on away-from-account transitions
  (unit-tested), `store.clearAccount` purges queue/activity/attempts and
  nulls confirmed state per account with cross-account isolation
  (unit-tested), and the new e2e asserts no cached names in UI, storage, or
  after reload.
- `design_v2.md` §17.7 untouched: this task changes no design.
- Visual baselines: owner HUMAN-APPROVED regenerating the 7 stale G6
  player-chrome baselines (approval recorded in the controller session;
  actuals inspected beforehand — header nav entries, phone bottom nav,
  shared-button styles; no functional errors; conflict banner renders
  correctly). Regenerated 2026-09-09 via
  `npx playwright test tests/e2e/visual.spec.ts --update-snapshots`
  (from `web/`, same env as above), then re-ran
  `npx playwright test tests/e2e/visual.spec.ts` — **10/10 pass**.
  Regenerated PNGs: library 360 + 1280, document editor (d20) 360 + 1280,
  sheet preview 360, publish dialog 360, conflict banner 360. The 1280
  variants of sheet preview, publish dialog, and conflict banner were
  already green and are unchanged.

## Limitations (open)

- Production OIDC: no real-provider validation exists (owner decision);
  `/cb` return + first-sign-in concurrency are proven on the deterministic
  test adapter only (Task 6). G6 box 5 stays open on this item.
- G9 real-device remainder: no physical phone/tablet runs, no standalone
  install proof (synthetic `beforeinstallprompt` only), contrast sign-off
  outstanding, no physical-table/remote playtest sessions.
- Visual baselines regenerated with owner approval (see Findings) —
  `visual.spec.ts` **10/10 green** after regeneration.
- E2E ran against a shared dev Postgres (unique names per run; prior runs'
  owned clones remain listed for the dev user but are selected by exact
  version id, so they do not interfere).
