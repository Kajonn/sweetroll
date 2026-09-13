# Remediation acceptance record (2026-09-12)

Living record for the [pre-upgrade remediation index](../superpowers/plans/2026-09-12-remediation-index.md)
(R1–R18). Sections are appended per executed task with the tested commit,
commands, actual outcomes, and limitations. Reconciled milestone status lives
in Task 2; this file does not close I7, G7/G9 gates, or deferred gates.

## Task 1 — visibility with actual player accounts (R8)

Branch `fix/campaign-visibility-acceptance` over `c8b4fa5` (stabilization
Tasks 1–4). No new authorization contracts: all assertions exercise the
existing policy (`src/campaigns/policy.ts`) through real HTTP and the real UI
with two deterministic identities (code-test-a as owner-GM, code-test-b as an
ordinary `player`; no second player was needed — the plan's grant/ungrant
reuse and cross-campaign denial both work with one player).

### Product changes (each red-first)

- `web/src/campaigns/CampaignContent.tsx`
  - Detail item query uses `staleTime: 0`: reopening, focus, and reconnect
    always re-read the note instead of serving the shared 30s stale budget.
  - Detail 404 handling now also removes that item's cached body.
  - New list-membership guard: a list reload that drops the open note routes
    the mounted reader through the same revoked path (unavailable + row
    hidden + item cache dropped).
- `web/src/campaigns/CampaignDetail.tsx`: leave purges the session, member,
  and invitation query families, mirroring the revocation purge.

### Evidence

- `npm --prefix web test -- src/campaigns/CampaignContent.test.tsx` — 10/10
  (3 consecutive full-file runs). Five new regression tests; four failed
  before the fix for the intended reasons (cached body retained after 404,
  mounted reader surviving list exclusion, stale reopen skipping its fetch,
  late pre-revocation response rendering); the account-switch guard passed
  pre-fix (actor-scoped keys already isolate) and is retained as a guard.
- `npm --prefix web test -- src/campaigns/CampaignDetail.session.test.tsx`
  — 6/6, including the new leave-purges-session/members/invitations case
  (red before the purge extension).
- `npm --prefix web run typecheck` — clean.
- `web/tests/e2e/campaignVisibility.spec.ts` — 3/3 green in disposable
  databases (plus accumulation re-runs in a shared database). Covers: player
  list hiding gm_only/owner_only rows with persistent audience marks;
  generic-404 HTTP matrix (gm_only, owner_only both directions, cross-campaign)
  with secret bodies absent from response text; player reads all_players and
  the granted note; player-created owner-only note unreadable by the GM;
  unjoined campaign absent from list with unavailable detail; grant removal
  through the real GM edit UI followed by offline→online reconnect evicting
  the live reader (body/title gone, Back leads to a list without the row);
  leave with an open reader landing on the access-changed notice.
- Full canonical run `npm run test:e2e` (exit 0: 22 journeys including the
  new spec + 10 visuals) and the production-offline suite
  (`npm run web:test:offline`, exit 0: 22 passed) at the committed tree;
  root unit 306/306 with contracts check clean. This file is docs-only and
  cannot change those outcomes.

### Limitations

- Session-board leave coverage is component-level; the owner role can never
  leave by policy, so no GM-leaves-with-session-open browser path exists.
- Two-GM/co-GM conflict operation, physical devices, production auth,
  deployment artifact, and playtests remain gated per the index (R11–R16).
- The `Back to content` step once failed in development because the spec
  navigated away (unmounting the reader) before narrowing; fixed by opening
  the granted note immediately before the GM edit, not a product issue.

## Task 2 — full-matrix reconciliation at `40c6142` (R9)

Tested commit: `40c6142` on `main` (docs recording R6/R7 port `a5561d7`
over stabilization `c8b4fa5`/`7d92b71` plus visibility `b8d9a9b`).
Local run 2026-09-13, PostgreSQL 17 via compose (`sweetroll` service DB),
Node v24.11.1. Working tree clean except the pre-existing untracked
`web/test-results-verify-*/` artifacts; no screenshot baselines were touched
(`git status` clean apart from those directories; `git diff --check` clean).

### Results

- Root unit `npm test`: 307/307 (29 files).
- Integration `npm run test:integration`
  (`TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll`):
  300/300 (27 files, sequential per `6cd1c3a`).
- Root `npm run typecheck`, `npm run contracts:check`, `npm run build`: clean.
- Web unit `npm test` (from `web/`): first run 942/943 with 1 failure whose
  name was not captured (only the tail was kept — a verification-process gap,
  not evidence of a specific defect); three consecutive full reruns after it:
  943/943 (94 files) each. No code changed between runs.
- Web `npm run typecheck`: clean. Web `npm run build`: succeeds; the Vite
  >500 kB chunk-size warning remains (known R17 hygiene, unchanged).
- Canonical browser `npm run test:e2e` (from `web/`, with
  `E2E_DATABASE_ADMIN_URL`, `AUTHORITATIVE_ROLL_SECRET=development-only-roll-secret-32-bytes`,
  `CI=1`): 22/22 journeys + 10/10 visuals (32/32). A first attempt without the
  roll secret failed to start the webServer (`AUTHORITATIVE_ROLL_SECRET is
  required outside tests`) — a setup error, not a test result; rerun with the
  CI-documented env was green.
- Production offline `npm --prefix web run test:offline` (fresh `npm run
  web:build` first; `DATABASE_URL=.../sweetroll_offline`, `CI=1`,
  `SWEETROLL_TEST_AUTH=1` per CI): 22/22. This uses Vite preview, not the
  final frontend/API deployment artifact, so the deployment gate stays open.
- `docker build -t sweetroll:verify .`: succeeds. A successful build alone
  does not close the deployment gate.
- Audit triage (R18, warnings only, no upgrades run): root `--omit=dev` 0
  vulnerabilities, root dev-inclusive 4 (2 moderate, 2 high); web `--omit=dev`
  0, web dev-inclusive 6 (2 moderate, 3 high, 1 critical: vitest
  GHSA-82fw-gwwq-j7x9 path traversal, esbuild GHSA-67mh-4wv8-2f99 dev-server
  request forgery, playwright GHSA-7mvr-c777-76hp cert verification, plus
  vite/playwright transitive entries). All findings are dev/test-tooling
  exposure; no production-dependency advisory. `npm audit fix --force` was
  not run (it would break dependency ranges). React `act(...)` warnings in
  `DocumentEditor` tests persist (R17 hygiene, non-blocking).

### Status consequences

- R1–R5 (stabilization): closed by this matrix — revision-readiness gating,
  audience locators, fixture isolation, and full-suite CI entry point are on
  `main` and green here, including the previously failing campaign/GM
  journeys.
- R6/R7 (claim discovery, deleted-summary recovery): implemented in `a5561d7`
  and green in this matrix (integration claim/content suites, player-role
  claim journey, Hidden recover journey). Contract approval is recorded in
  the I6 backend spec reconciliation note (2026-09-12: user approved the
  narrow claim-discovery GET and management-only deleted-summary recovery)
  and in `design_v2.md` §§5.3/4.1; no new permissions beyond those approved
  contracts were exercised.
- R8 (visibility with player accounts): closed by Task 1 above; retained in
  this matrix via `campaignVisibility.spec.ts` inside the 22-journey run.
- R9 (this record): done to the extent automation allows — see limitations.
- Still open and untouched by this run: R10 manual/responsive/accessibility
  sign-off beyond the automated widths in the journeys, R11 co-GM conflict
  operation, R12 physical devices/installed-PWA/contrast/text-enlargement,
  R13 production OIDC, R14 deployment artifact, R15 mockup reference (still
  401-blocked), R16 playtests, R17 warning cleanup, R18 upgrade planning.

### Limitations

- The single first-run web unit failure is unattributed; if it recurs, capture
  the failing suite name before any further green-rerun claim.
- No remote CI execution was performed; CI parity is by using the documented
  CI env/commands locally.
- `web/test-results-verify-*/` traces from earlier verification runs are still
  untracked in the working tree and are not committed inputs to this record.
