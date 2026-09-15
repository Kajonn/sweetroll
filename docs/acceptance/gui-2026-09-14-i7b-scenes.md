# I7b scenes + restricted display acceptance (Task 8 exit demonstration)

Date: 2026-09-15. Branch `feat/i7b-scenes-display`. Tree: Task 8
closeout (this note plus `web/tests/e2e/sceneDisplayJourney.spec.ts`,
the Task 7 review fix in `web/src/display/DisplayView.tsx` with its
unit tests, and the `/display` route test, committed together as the
Task 8 closeout change). Tasks 1–7 shipped the full slice on this
branch: scene/fog/token commands, media upload, display pairing with
redacted projection, HTTP routes + contracts, the web seam, the GM
scene viewport, and the display shell. Only checks actually run are
listed; anything not listed was not run.

## Product changes

One controller-allowed product fix beyond the brief's test-only
binding (Task 7 review finding, design §7.7 letter): a post-frame 404
(revocation landing after a good frame) kept the frozen frame behind a
reconnecting notice. `web/src/display/DisplayView.tsx` now blanks on a
post-frame 404 with the same blank state + disconnect affordance as the
no-frame case. Transient non-404 failures still keep the last good
frame with a reconnecting notice — that complies and is untouched.

`isNotFound` was verified against the actual Task 5/backend
revocation contract and needed no extension: `resolveDisplayScene`
(`src/campaigns/display.ts`) collapses every credential failure
(unknown/revoked credential, secret mismatch, cross-campaign scene) to
null, which the caller maps to generic `not_found`, served as HTTP 404
(`STATUS_BY_CODE` in `src/transport/http/campaigns.ts`); the
`/displays/` routes skip session auth, so no 401/403 revocation shape
exists. The web `ApiError` carries both `code` and `status` (and even
the `http_404` fallback still matches via `status`), so matching
`status === 404 || code === "not_found"` covers the whole contract.
Covered by a code-only (`{ code: "not_found" }`, no status) unit test.

`workers: 1`, `retries: 0` preserved (untouched
`web/playwright.config.ts`).

## Exit demonstration (new, Task 8)

`web/tests/e2e/sceneDisplayJourney.spec.ts` — "I7b exit: restricted
scene display shows only revealed areas and visible tokens, follows,
then blanks". Chromium headless, default desktop viewport:

1. GM seeding through real HTTP as `code-test-a` (isolated context):
   owned-d20 clone via the real System Builder API, one campaign, one
   1x1 PNG background upload (`dataBase64`), one scene. No
   scene-create/upload UI exists in this slice, so these rows go
   through HTTP; everything composable in the UI runs through the UI.
2. GM scene UI as `code-test-a` via the dev sign-in panel:
   `/campaigns/<id>/scenes?sceneId=<id>` shows the scene background;
   conceal dab (0.7,0.7,r=0.15) committed, then reveal dab
   (0.3,0.5,r=0.35) committed — scenes start fully fogged, so the
   reveal is drawn to cover the visible token's home and move target.
   Visible token `Alpha` (0.25,0.5) + hidden token `Ghost`
   (0.75,0.25, "Visible to the display" unchecked) placed through the
   token tray. Fresh page loads between mutations keep the revision
   guard fed without guessing; each commit retries once on 409.
3. GM pairs a display through Campaign settings (Members tab → "Pair
   display"); the once-shown 6-char code is read from the dialog and
   dismissed with Done.
4. Display side in a second, never-signed-in context navigated with an
   explicit `?sceneId=` (no picker UI exists in this slice — empty
   state otherwise): code entry shows with no app-header, redeem
   renders the display image + `Alpha` at 25% left; `Ghost` absent.
5. Isolation: the display context issues no request to any GM path
   (`/api/campaigns`, `/api/scenes/`, `/api/content`,
   `/api/characters`, `/api/invitations`, `/api/systems`); every
   projection body is free of `Ghost`, `storage_key`, and original
   bytes; a direct GET of the GM original as display answers 401 with
   no image bytes (anonymous: the credential exemption covers
   `/displays/` routes only); `localStorage` is empty,
   `sessionStorage` holds only `sweetroll:display-credential`
   (displayId + secret, no campaign data), and `caches.keys()` is
   empty.
6. Token move via real HTTP (Alpha → 0.55,0.5, inside the revealed
   region): the display follows on poll (55% left).
7. Scene change: a second scene created via HTTP renders token-free at
   its own `?sceneId=` (image src carries the new scene id); back on
   scene A the moved token is where the poll left it.
8. GM revokes the credential through the settings UI ("Display
   revoked."); the display blanks on poll ("This display is
   unavailable.", no image, "Enter a different code" affordance).

## Gates actually run (2026-09-15, this tree)

Tested commit `a37776d` plus the Task 8 closeout (fix + route test +
spec + this note). Targeted iteration used direct Playwright with
caller-managed resources (dedicated DB/ports + `DATABASE_URL` + `CI=1`
+ `AUTHORITATIVE_ROLL_SECRET=development-only-roll-secret-32-bytes` +
`SWEETROLL_BACKEND_TARGET`, per README §Browser E2E; never the dev
database):

- RED (structural, per controller ruling): the new spec was not
  executed on the pre-I7b tree; at the pre-I7b parent `a3b65fe` the
  whole surface the spec needs is absent (`web/src/router.tsx`: 0
  display matches; `src/transport/http/campaigns.ts`: 0 scene/display
  matches; no `DisplayView`), so the seed upload already fails there.
- GREEN: the new spec alone (DB `sweetroll_t8_iter`, ports 3231/5231)
  — **1 passed (~22s)** after test-only fixes (UUID idempotency keys,
  `scene` response wrap, Playwright `getByLabel`, reveal geometry that
  actually covers the token per the fully-fogged-start rule, inline
  `style` attribute instead of computed-px CSS).

Full matrix (all on this tree):

- Root `npm test` — **29 files / 318 tests pass**.
- Root `npm run test:integration` (`TEST_DATABASE_URL` set, DB
  `sweetroll_t8_int`, `--no-file-parallelism` per package script) —
  **29 files / 347 tests pass**.
- Root `npm run typecheck`, `npm run contracts:check`, `npm run build`
  — clean.
- Web `npm test` — **102 files / 1030 tests pass** (includes the 3 new
  DisplayView tests + the `/display` route test).
- Web `npm run typecheck`, `npm run build` — clean.
- Canonical `npm run test:e2e` from `web/`
  (`E2E_DATABASE_ADMIN_URL` + `AUTHORITATIVE_ROLL_SECRET` + `CI=1`,
  ports 3231/5231) — ran journeys then visuals to completion; visuals
  **9/10 pass** (`visual: document editor (d20) at 360px` fails, see
  findings).
- Direct `SWEETROLL_E2E_SUITE=journeys` rerun (fresh DB, same env
  shape) for exact counts — **23 passed / 2 failed** (includes the new
  spec passing; the 2 failures are pre-existing, see findings).
- Fresh `npm run web:build`, then `npm run web:test:offline` (DB
  `sweetroll_offline_t8` + `CI=1` + `SWEETROLL_TEST_AUTH=1`) —
  **21 passed / 1 failed** (pre-existing, see findings).
- `docker build -t sweetroll:t8 .` — pass. `git diff --check` — clean.

## Findings (all pre-existing failures reproduced WITHOUT Task-8 changes)

Each failure below was reproduced identically from a detached worktree
at `a37776d` (Tasks 1–7 only, symlinked `node_modules`, dedicated
DB/ports), so none is introduced by this task and all stay open:

- `visual: document editor (d20) at 360px` — screenshot mismatch; the
  diff pixels concentrate on the bottom nav ("Characters Campaigns
  Activity Account" + "Language") with faint differences elsewhere:
  baseline/environment rendering drift in an untouched surface.
- `campaignJourney` (G7 exit) — after Leave, the campaign title still
  matches on `/campaigns` (`toHaveCount(0)` times out).
- `clientNavigation` — heading "Campaigns" not visible after a header
  nav hop.
- Offline `privacy.spec.ts › no private data in CacheStorage or after
  purge` — the CacheStorage scan flags the precached app bundle
  itself: its text contains the long-standing `library.sharing.private
  = "Private"` i18n string, so the `includes("Private")` hit is the
  bundle URL, not private data (`/api/` and `/dev/` URL asserts still
  hold).

## Fixture

Per-run campaign (`I7b Scene Campaign <uid>`) on the isolated e2e
database; inline 1x1 transparent PNG base64 (same bytes as the backend
integration tests); conceal (0.7,0.7,0.15) + reveal (0.3,0.5,0.35)
chosen so `Alpha` (0.25,0.5 → 0.55,0.5) stays revealed per the
fully-fogged-start rule; hidden `Ghost` (0.75,0.25). GM `code-test-a`
owns everything; the display context never signs in. No scene/image
DELETE endpoints exist; scratch databases (`sweetroll_t8_iter`,
`sweetroll_t8_int`, `sweetroll_t8_j*`, `sweetroll_t8_vis*`,
`sweetroll_offline_t8`, `sweetroll_offclean`, canonical run-scoped DBs)
were dropped after their runs; the dev database was never touched;
run-artifact `data/` (media/derivatives under the worktree) removed.

## Limitations (open)

- Production OIDC: no real-provider validation (owner decision); GM
  sign-in proven on seeded dev codes only (dev panel for journeys,
  `SWEETROLL_TEST_AUTH` for the offline suite).
- No physical phone/tablet runs, no standalone install proof beyond
  the existing PWA checks, no dark-mode runs for the new journey.
- Browser/device/theme matrix actually run: Playwright Chromium
  headless only, default desktop viewport for the new journey.
- The four failures above (2 journeys, 1 visual, 1 offline) stay open;
  Task 8 scope allowed exactly one product fix (the DisplayView blank),
  so they were evidenced, not fixed.
- Production-auth and real-device gates stay open.

## Open follow-ups

- Triage the four pre-existing failures (journey leave-list staleness,
  header-hop heading, 360px editor baseline, offline bundle self-hit).
- G9 release acceptance (built-artifact review, real-device checks,
  deployment, playtests) stays open, as do production authentication
  and the pre-existing G7/G9 gates recorded earlier.
