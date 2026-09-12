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
