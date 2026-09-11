# G7 Player campaign content/activity acceptance (I6 exit demonstration)

Date: 2026-09-11. Branch `feat/g7-player-campaign-ui`. Tree: Task 5 closeout
(`web/src/campaigns/CampaignContent.tsx`, `CampaignActivity.tsx`,
`CampaignContent.test.tsx`, `CampaignDetail.tsx` wiring + revocation purge,
`web/tests/e2e/campaignJourney.spec.ts`, and this note, committed together
as the Task 5 closeout change). Only checks actually run are listed;
anything not listed was not run.

## Exit demonstration (new, Task 5)

`web/tests/e2e/campaignJourney.spec.ts` — "G7 exit: invitation accept,
campaign list, claim, permitted content, activity, leave purges".
Chromium headless, default desktop viewport:

1. GM seeding as `code-test-a` (isolated context, real HTTP): actor-owned
   d20 clone published through the real System Builder API (clone → save
   draft unchanged → publish 1.0.0), because the seeded reference templates
   are link-access/unlisted (OD-01) and versionless enumeration never offers
   them; then `POST /api/campaigns`, one `all_players` note via
   `POST /api/campaigns/:id/content`, one character via
   `POST /api/campaigns/:id/characters`, and a `co_gm` invitation via
   `POST /api/campaigns/:id/invitations` (re-reading the campaign revision
   before each revision-guarded call). The invitee joins as `co_gm`: the
   backend lists campaign characters to GMs in full but to players only when
   controlled, so a player-role invitee cannot discover a GM-designated sheet
   in the list UI (see Findings).
2. Invitee `code-test-b` via the dev sign-in panel (code field filled):
   `/invitations?token=` review shows the campaign title, the token string
   appears nowhere on the page, Accept → `Welcome to {title}.`
3. GM designates the invitee through the real assign endpoint
   (`controllerUserIds: []`, `designateClaimants: [invitee]`), mirroring
   `tests/integration/campaign-http-acceptance.test.ts`.
4. `/campaigns` lists the joined campaign → open → Characters tab (default)
   shows `Available to claim.` → `Claim {name}` → confirm dialog
   (`Confirm claim`) → `You now control {name}.`
5. Content tab: persistent `All players` audience marking → `Open {note}`
   → permitted body text renders with its audience mark → `Back to content`.
6. Activity tab: `Content created` event renders (kind + actor + timestamp,
   no secret payloads).
7. Leave campaign (confirm dialog accepted): back at `/campaigns` without
   the campaign; direct `GET /campaigns/:id` shows
   `This campaign is unavailable.` plus the access-changed notice
   (`Access to this campaign changed. Cached data for this campaign was
   removed.` — revocation purge path); `/campaigns` stays clean.

## Gates actually run (2026-09-11, this tree)

From `web/` (env
`CI=1 DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll_e2e
AUTHORITATIVE_ROLL_SECRET=development-only-roll-secret-32-bytes`; Playwright
started its own backend `npm run migrate && npm run dev:http` + `npm run web:dev`
per `playwright.config.ts`):

- `npx playwright test tests/e2e/campaignJourney.spec.ts` — **1/1 pass**
  (8.2s).
- `npm run test` — **85 files / 877 tests pass** (includes the new
  `CampaignContent.test.tsx`: audience labels for all four levels, revoked
  notes never mounted).
- `npm run typecheck` — clean.

From repo root:

- `npm run contracts:check` — pass.

Browser/device/theme matrix actually run: Playwright Chromium headless only,
default desktop viewport. Theme: default (light in headless) — no dark-mode
or phone-viewport e2e in this task. No real-device runs (see limitations).

## Fixture

Per-run owned d20 clone (name kept "D20 System", 1.0.0) via API; unique
`G7 Campaign/Briefing/Hero <uid>` names (no campaign/character DELETE
endpoint; shared `sweetroll_e2e` DB). Invitee `code-test-b`, GM
`code-test-a`; invitee user id resolved through a throwaway probe context so
the GM session cookie stays intact. Dev sign-in panel used for the invitee
(dev server), so no `SWEETROLL_TEST_AUTH` escape hatch was needed.

## Screenshots

None taken (the spec captures no screenshots; all assertions are DOM/text
based).

## Findings

- During development the e2e first failed seeding with `409` on
  `POST .../invitations` (content/character creation had bumped the campaign
  revision after the create response): fixed by re-reading the campaign
  revision before every revision-guarded seed call.
- During development the e2e hung on the player-role `Claim` click: the
  button never renders because the list endpoint returns only controlled
  sheets to players. Backend acceptance
  (`tests/integration/campaign-http-acceptance.test.ts:113`) confirms the
  intended flow is GM-designate → claimant claims with a GM-disclosed id.
  The spec therefore invites as `co_gm` (identical player-app UI, no role
  branching in these tabs) and designates after accept. Player-role claim
  discovery in the list UI is a cross-slice gap: either the backend should
  list designated sheets to designees, or UI claiming stays GM/co-GM-only in
  practice. No backend change made (out of scope for this plan); flagged for
  I7 GM work or a backend visibility follow-up.
- One full-suite unit run showed a single unrelated `AppShell.test.tsx`
  timeout under load (null→actor settle); it passes in isolation and the
  full suite re-ran green (85 files / 877 tests). No implementation change
  was needed.
- `design_v2.md` §17.8 untouched: content/activity/audience (player task 3),
  revocation purge (player task 4), and e2e (player task 5) match the plan;
  per-roll audience selection stays deferred to I7 as ruled.

## Limitations (open)

- Production OIDC: no real-provider validation (owner decision); invitee
  sign-in proven on seeded dev codes only.
- No physical phone/tablet runs, no standalone install proof, no dark-mode
  or phone-viewport campaign e2e in this task.
- Full e2e suite (other specs) not re-run in this task; change surface is
  additive (new tabs/purge on campaign routes, additive i18n keys).
- E2E ran against a shared `sweetroll_e2e` Postgres (unique names per run;
  prior runs' campaigns/characters/clones remain but are selected by exact
  id, so they do not interfere).
