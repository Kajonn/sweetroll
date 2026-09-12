# G7 GM campaign setup/members Phase 1 acceptance (I7 exit demonstration)

Date: 2026-09-12. Branch `feat/i7-gm-phase1-setup-members`. Tree: Task 7 closeout
(`web/src/campaigns/CampaignDetail.tsx` Members wiring + revocation purge,
`campaign.detail.tabs.members` i18n key, `CampaignDetailRouteView`
generation/online props, `web/src/campaigns/CampaignDetail.members.test.tsx`,
`web/tests/e2e/gmSetupJourney.spec.ts`, and this note, committed together
as the Task 7 closeout change). Only checks actually run are listed;
anything not listed was not run.

## Exit demonstration (new, Task 7)

`web/tests/e2e/gmSetupJourney.spec.ts` — "I7 exit: GM setup through UI,
invitations, accept, promote, remove, unavailable". Chromium headless,
default desktop viewport:

1. GM seeding as `code-test-a` (isolated context, real HTTP): actor-owned
   d20 clone published through the real System Builder API (clone → save
   draft unchanged → publish 1.0.0), because the seeded reference templates
   are link-access/unlisted (OD-01) and versionless enumeration never offers
   them. Nothing else is provisioned over HTTP.
2. GM `code-test-a` via the dev sign-in panel (code field filled) creates
   the campaign entirely through the UI: `/campaigns/new` → select the
   seeded clone version → title `G7 GM Setup <uid>` → Create campaign →
   detail opens at `/campaigns/:id` with the campaign heading.
3. `/campaigns` lists the newly created campaign (fire-and-forget
   list-invalidation from Task 3) → open it back up.
4. Members tab as the owner: roster plus the GM-gated management sections
   (`Campaign settings`, `Invitations` heading); the pinned version line
   shows the seeded clone version id.
5. Issue a player invitation: the display-once token panel
   (`Share this invitation link token now`) shows the token; Done dismisses
   it and the token value lingers nowhere on the screen.
6. Rotate: a new, different token is shown and dismissed; revoke the
   rotated invitation behind the confirm dialog — the row stays listed with
   status `revoked`.
7. Fresh player invitation issued for the invitee flow (token read off the
   GM screen, then dismissed).
8. Invitee `code-test-b` via the dev sign-in panel (separate context):
   `/invitations?token=` review shows the campaign title, the token string
   appears nowhere on the page, Accept → `Welcome to {title}.`
9. Invitee opens the campaign from `/campaigns`; as a player the Members
   tab shows the roster (own row) without management sections (no
   `Campaign settings`, no `Invitations` heading).
10. GM (fresh detail load — the accept bumped the campaign revision)
    promotes the member to co-GM: `Change role` select → `co_gm` →
    `Change role` → confirm dialog (`Confirm role change`) → roster row
    shows `Co-GM`.
11. GM (fresh load again — the promotion bumped the revision) removes the
    member: `Remove {userId}` → confirm dialog (`Confirm removal`) → the
    roster no longer lists the user id.
12. Removed invitee: direct `GET /campaigns/:id` shows
    `This campaign is unavailable.` plus the access-changed notice
    (`Access to this campaign changed. Cached data for this campaign was
    removed.` — revocation purge path); `/campaigns` stays clean.

## Gates actually run (2026-09-12, this tree)

From `web/` (env
`CI=1 DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll_e2e
AUTHORITATIVE_ROLL_SECRET=development-only-roll-secret-32-bytes`; Playwright
started its own backend `npm run migrate && npm run dev:http` + `npm run web:dev`
per `playwright.config.ts`):

- `npx playwright test tests/e2e/gmSetupJourney.spec.ts` — **1/1 pass**
  (11.7s).
- `npm run test` — **90 files / 895 tests pass** (includes the new
  `CampaignDetail.members.test.tsx`: owner sees the Members tab with the
  settings/invitations sections; TDD RED verified first — no Members tab
  before wiring).
- `npm run typecheck` — clean.

From repo root:

- `npm run contracts:check` — pass.

Browser/device/theme matrix actually run: Playwright Chromium headless only,
default desktop viewport (Playwright default 1280×720). Theme: default
(light in headless) — no dark-mode or phone-viewport e2e in this task. No
real-device runs (see limitations).

## Fixture

Per-run owned d20 clone (name kept "D20 System", 1.0.0) via API; unique
`G7 GM Setup <uid>` title (no campaign DELETE endpoint; shared
`sweetroll_e2e` DB). Invitee `code-test-b`, GM `code-test-a`; invitee user
id resolved through a throwaway probe context so the GM session cookie
stays intact. The seeded version is located through the same
`creation-versions` catalog (limit 25) the UI reads, and the nth same-label
button is clicked (prior runs leave same-named clones in the shared DB).
Dev sign-in panel used for both actors (dev server), so no
`SWEETROLL_TEST_AUTH` escape hatch was needed. Tokens travel in POST bodies
only; the test reads each token off the GM's display-once panel (the
sanctioned UI surface, never a URL transport).

## Screenshots

None taken (the spec captures no screenshots; all assertions are DOM/text
based).

## Findings

- During development the e2e failed expecting `No invitations yet.` after
  revoke: the list endpoint carries no status filter, so revoked rows stay
  listed with status `revoked`. The spec asserts the `revoked` marker
  instead. No implementation change (unit Task 6 tests pin the same shape).
- During development the promote assertion matched the hidden
  `Change role` select option (`Co-GM` text also lives in the options): the
  assertion scopes to row spans. No implementation change.
- Membership mutations (accept, role change, removal) bump the campaign
  revision, so the GM re-loads the detail before each revision-guarded
  roster mutation in the spec; without the reload the UI's 409-conflict
  retry path would trigger. No implementation change (conflict path is
  covered by unit tests).
- One full-suite unit run showed a single transient test failure under
  load; the suite re-ran green repeatedly (90 files / 895 tests) with no
  implementation change. The failing file identity was not captured from
  that run's output (only the tail was kept); same pattern as the
  unrelated `AppShell.test.tsx` timeout noted in the G7 player record.
- `design_v2.md` §17.8 untouched: Members wiring matches the plan
  (TanStack dedupe via identical `useCampaignMembers` parameters, GM gate
  on owner/co_gm, optional generation/online props).

## Limitations (open)

- Production OIDC: no real-provider validation (owner decision); GM and
  invitee sign-in proven on seeded dev codes only.
- No physical phone/tablet runs, no standalone install proof, no dark-mode
  or phone-viewport campaign e2e in this task.
- Full e2e suite (other specs) not re-run in this task; change surface is
  additive (one new tab on the campaign detail route, additive i18n key,
  two new optional props).
- E2E ran against a shared `sweetroll_e2e` Postgres (unique names per run;
  prior runs' campaigns/clones remain but are selected by exact id, so
  they do not interfere).
