# Multi-user journey remediation — accepted on isolated preview

**Status (2026-11-02):** F1-F3 fixed and accepted in PR #28; E1 resolved for the
isolated test target. The complete MU-00–MU-12 rerun passed on deployed application
`a1fc299` in 144.743 seconds with 24 verified rolls and no GUI bypasses. See the
[post-fix acceptance record](../../acceptance/multi-user-journey-2026-11-02.md) and
[structured evidence](../../acceptance/multi-user-journey-2026-11-02.json).
**Owner priority (2026-11-01):** fix the problems discovered in the one-GM/three-player
journey, then repeat the same sequence. This precedes new features, including the
previously suggested production-authentication feature.
**Baseline:** main `af2b076dfd44460501fed8002990f92f4b373efb`.
**Evidence:** [historical report](../../acceptance/multi-user-journey-2026-11-01.md),
[sanitized execution data](../../acceptance/multi-user-journey-2026-11-01.json).
**Mandatory acceptance:** [MU-00–MU-12 protocol](../../acceptance/multi-user-journey-protocol.md).

Read AGENTS.md, design §§5/17.0/18.2 and the GUI integration gates. Preserve the
existing Module/HTTP/client boundaries, policy, revisions, idempotency, immutable
rules pins and current-format offline behavior. Use meaningful observed red →
smallest green → refactor tests. No pre-release migration/upgrade code or tests.

## Problem register — historical findings and verified closure

| ID | Priority/status | Observed problem | Required outcome |
| --- | --- | --- | --- |
| F1 | High / CLOSED 2026-11-02 | Manual token review shows the correct invitation, but Accept sends an empty token and returns 400; reproduced for all three players. Link-based acceptance works. | Manual review → accept succeeds without a URL-token fallback; decline and existing link flows remain correct. |
| F2 | Medium / CLOSED 2026-11-02 | No GUI route for attaching an existing personal character; one direct API adoption was necessary. Creating directly in a campaign works. | Authorized player selects its own compatible personal character and confirms adoption in GUI; existing direct creation remains usable. |
| F3 | Medium / CLOSED 2026-11-02 | Selected recipients and template preview use raw UUID labels. Policies work, but a GM cannot identify players naturally. | Display recognizable player names with safe disambiguation while requests/grants stay keyed by stable user ID and membership generation. |
| E1 | Test-environment blocker / CLOSED for isolated acceptance | Intended main acceptance deployment is healthy but test-auth is locked; an application-identical existing D2 preview was used. | Verify a suitable isolated fixed-commit test target and four fixture identities before rerunning; record exact configuration/state. No production-auth feature or production weakening is required to unblock this test. |

F1 is a reproduced functional bug. F2 is a GUI workflow gap, F3 a usability defect,
and E1 an environment blocker; do not merge these into an unsupported “all tests
passed” claim. Prior C/D1/D2 evidence remains historical. Closure is based on the new record above, focused regressions and the complete deployed rerun.

## Execution order

### 1. Repair manual invitation state (F1)

- [x] Observe red component/browser tests for manual token entry → successful review
  → Accept; assert the request retains the entered token without logging its value.
- [x] Cover manual decline, invalid token correction, intentional new URL token,
  navigation/unmount, and the existing invitation-link path.
- [x] Fix `web/src/campaigns/InvitationReview.tsx` with the smallest state/effect change.
  Code inspection points to `activeToken` → `describeError` → `runReview` changing
  the initialization effect dependency and restoring the empty URL token. Verify
  this cause through the red test rather than relying on inspection alone.
- [x] Keep tokens out of rendered output/errors, retain server invitation revisions,
  current membership checks and fresh-key/review behavior; prove red → green.

### 2. Complete existing-character adoption in GUI (F2)

- [x] Historical GUI red: player 1 had no adoption route on 2026-11-01. The
  repaired campaign dialog now passes four focused tests and MU-04 through GUI.
  This records historical browser evidence, not an automated pre-fix unit test
  of the newly introduced dialog.
- [x] Reuse `src/characters/campaignPlacement.ts` / Campaigns' existing adoption
  operation and transport contract; extend `web/src/campaigns/api.ts` and the owning
  view only as needed. Use the existing authorized personal-character discovery
  seam, with bounded paging; no guessed IDs or new ownership bypass.
- [x] Label choices by character name, show campaign/system compatibility and
  explain GM access before sending `acknowledgedDisclosure`. Cancel sends no command.
- [x] Exercise another owner's character, different pinned version, already-attached
  character, stale campaign/character revisions, membership loss and offline state.
  Preserve values/equipment and current placement/controller policy on success.
- [x] Prove uncertain-result recovery uses the same frozen request/key, conflict
  requires review, and direct campaign character creation is unchanged.
- [ ] Broader G9 follow-up: complete the physical-device and full keyboard/focus/
  theme matrix across routes. This acceptance inspected the phone adoption dialog,
  mixed 360/768/1280 player views, GM light/dark widths and Axe on the catalog;
  the real PostgreSQL/HTTP suites passed in CI. The wider matrix is unclaimed.

### 3. Make member choices recognizable (F3)

- [x] Observe red tests for display names in selected-recipient controls and
  Preview as player, including duplicate names, long names and missing names.
- [x] Inspect current member projection (`src/transport/http/campaigns.ts`) and
  Identity Module's display-name capability. Provide only bounded authorized
  identity labels for visible current members; do not expose emails or add a
  second identity model/direct cross-module database shortcut.
- [x] Reuse shared controls in `TemplateSharing.tsx` and `CampaignTemplates.tsx`.
  Labels must remain recognizable for duplicate names; missing names may use an
  explicit fallback. Names are presentation only, never principal/grant keys.
- [x] Keep incomplete-roster paging, generation revocation, actual-player preview,
  role changes, stale responses and cache purges intact. Regenerate contracts/types
  through the canonical command if the DTO changes; prove red → green.

### 4. Verify the fixed build and repeat the journey (E1 + F1–F3)

- [x] Turn the ordered protocol into a maintainable regression journey using the
  existing `web/tests/fixtures/`, E2E/offline suites and isolated hosted config
  conventions. Include all GUI steps, not an API-seeded substitute. Keep fixture
  authentication and verification/cleanup separate from user-operation setup.
- [x] Run required root/frontend/real-PostgreSQL tests, typechecks, generated
  contract checks, browser/offline/visual suites, builds and Docker as applicable
  to the implementation and required CI. Do not inflate timeouts/retries or remove
  assertions/workload to hide failures.
- [x] Establish an isolated intended test target with four synthetic identities.
  Verify source commit, terminal SUCCESS, readiness and served artifact identity.
  Leave production's source/authentication and unrelated preview data unchanged.
- [x] Execute MU-00–MU-12 in the recorded order: blank system → adventure/notes →
  three manual invitation joins → personal/campaign character creation → campaign
  catalog → six entries and six actions per player → access/reopen checks → six
  concurrent actions → restricted sharing/preview/reveal → offline → independent
  quantity edit → scoped archive/readback. Preserve 24 successful rolls.
- [x] For F1, all three manual accepts must pass; a link fallback is a failed gate.
  For F2, player 1's adoption must use GUI; an API adoption is a failed gate.
  For F3, select/preview actual players by recognizable labels and verify exact
  recipient IDs/generations on the server.
- [x] Publish a new dated acceptance record with actual red/green results, commands,
  CI and deployment SHAs, each protocol step, screenshots, limitations and cleanup.
  Record deviations as FAIL/BLOCKED, never silently skip them.

## Exit and handoff

F1-F3 and E1 are CLOSED for this scoped journey. Historical failure observations,
31 focused green regressions, seven green CI #187 jobs on the deployed application,
and the fresh complete hosted run are linked above. The final runner also fixes
hosted-proxy observation overhead without increasing the six-minute budget,
retries or reducing any GUI/roll/privacy/offline workload. Both failed preliminary
runs and independent cleanup verification remain in the evidence.

AGENTS.md and design Section 18.2 now reflect this closure. The unchecked wider
GUI/device matrix remains G9 work. Real provider login, licensed launch templates,
physical Android/iPad and physical/remote playtests are still open; no public
release or new feature is authorized by this record. No migration/upgrade work
precedes the first application release tag.
