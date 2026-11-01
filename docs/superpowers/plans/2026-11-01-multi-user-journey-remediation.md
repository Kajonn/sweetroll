# Multi-user journey remediation — required next work

**Status:** planned; no fixes implemented or post-fix acceptance claimed by this PR.
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

## Open problem register

| ID | Priority/status | Observed problem | Required outcome |
| --- | --- | --- | --- |
| F1 | High / OPEN | Manual token review shows the correct invitation, but Accept sends an empty token and returns 400; reproduced for all three players. Link-based acceptance works. | Manual review → accept succeeds without a URL-token fallback; decline and existing link flows remain correct. |
| F2 | Medium / OPEN | No GUI route for attaching an existing personal character; one direct API adoption was necessary. Creating directly in a campaign works. | Authorized player selects its own compatible personal character and confirms adoption in GUI; existing direct creation remains usable. |
| F3 | Medium / OPEN | Selected recipients and template preview use raw UUID labels. Policies work, but a GM cannot identify players naturally. | Display recognizable player names with safe disambiguation while requests/grants stay keyed by stable user ID and membership generation. |
| E1 | Test-environment blocker / OPEN at historical run | Intended main acceptance deployment is healthy but test-auth is locked; an application-identical existing D2 preview was used. | Verify a suitable isolated fixed-commit test target and four fixture identities before rerunning; record exact configuration/state. No production-auth feature or production weakening is required to unblock this test. |

F1 is a reproduced functional bug. F2 is a GUI workflow gap, F3 a usability defect,
and E1 an environment blocker; do not merge these into an unsupported “all tests
passed” claim. Prior C/D1/D2 evidence remains historical and does not close this gate.

## Execution order

### 1. Repair manual invitation state (F1)

- [ ] Observe red component/browser tests for manual token entry → successful review
  → Accept; assert the request retains the entered token without logging its value.
- [ ] Cover manual decline, invalid token correction, intentional new URL token,
  navigation/unmount, and the existing invitation-link path.
- [ ] Fix `web/src/campaigns/InvitationReview.tsx` with the smallest state/effect change.
  Code inspection points to `activeToken` → `describeError` → `runReview` changing
  the initialization effect dependency and restoring the empty URL token. Verify
  this cause through the red test rather than relying on inspection alone.
- [ ] Keep tokens out of rendered output/errors, retain server invitation revisions,
  current membership checks and fresh-key/review behavior; prove red → green.

### 2. Complete existing-character adoption in GUI (F2)

- [ ] Observe red tests for player 1 selecting a compatible owned personal character
  and adopting it through the campaign or sheet UI. Pin one clear discoverable path.
- [ ] Reuse `src/characters/campaignPlacement.ts` / Campaigns' existing adoption
  operation and transport contract; extend `web/src/campaigns/api.ts` and the owning
  view only as needed. Use the existing authorized personal-character discovery
  seam, with bounded paging; no guessed IDs or new ownership bypass.
- [ ] Label choices by character name, show campaign/system compatibility and
  explain GM access before sending `acknowledgedDisclosure`. Cancel sends no command.
- [ ] Exercise another owner's character, different pinned version, already-attached
  character, stale campaign/character revisions, membership loss and offline state.
  Preserve values/equipment and current placement/controller policy on success.
- [ ] Prove uncertain-result recovery uses the same frozen request/key, conflict
  requires review, and direct campaign character creation is unchanged.
- [ ] Inspect phone/tablet/desktop, keyboard/focus and light/dark behavior; run the
  relevant real PostgreSQL/HTTP tests if server discovery/projection changes.

### 3. Make member choices recognizable (F3)

- [ ] Observe red tests for display names in selected-recipient controls and
  Preview as player, including duplicate names, long names and missing names.
- [ ] Inspect current member projection (`src/transport/http/campaigns.ts`) and
  Identity Module's display-name capability. Provide only bounded authorized
  identity labels for visible current members; do not expose emails or add a
  second identity model/direct cross-module database shortcut.
- [ ] Reuse shared controls in `TemplateSharing.tsx` and `CampaignTemplates.tsx`.
  Labels must remain recognizable for duplicate names; missing names may use an
  explicit fallback. Names are presentation only, never principal/grant keys.
- [ ] Keep incomplete-roster paging, generation revocation, actual-player preview,
  role changes, stale responses and cache purges intact. Regenerate contracts/types
  through the canonical command if the DTO changes; prove red → green.

### 4. Verify the fixed build and repeat the journey (E1 + F1–F3)

- [ ] Turn the ordered protocol into a maintainable regression journey using the
  existing `web/tests/fixtures/`, E2E/offline suites and isolated hosted config
  conventions. Include all GUI steps, not an API-seeded substitute. Keep fixture
  authentication and verification/cleanup separate from user-operation setup.
- [ ] Run required root/frontend/real-PostgreSQL tests, typechecks, generated
  contract checks, browser/offline/visual suites, builds and Docker as applicable
  to the implementation and required CI. Do not inflate timeouts/retries or remove
  assertions/workload to hide failures.
- [ ] Establish an isolated intended test target with four synthetic identities.
  Verify source commit, terminal SUCCESS, readiness and served artifact identity.
  Leave production's source/authentication and unrelated preview data unchanged.
- [ ] Execute MU-00–MU-12 in the recorded order: blank system → adventure/notes →
  three manual invitation joins → personal/campaign character creation → campaign
  catalog → six entries and six actions per player → access/reopen checks → six
  concurrent actions → restricted sharing/preview/reveal → offline → independent
  quantity edit → scoped archive/readback. Preserve 24 successful rolls.
- [ ] For F1, all three manual accepts must pass; a link fallback is a failed gate.
  For F2, player 1's adoption must use GUI; an API adoption is a failed gate.
  For F3, select/preview actual players by recognizable labels and verify exact
  recipient IDs/generations on the server.
- [ ] Publish a new dated acceptance record with actual red/green results, commands,
  CI and deployment SHAs, each protocol step, screenshots, limitations and cleanup.
  Record deviations as FAIL/BLOCKED, never silently skip them.

## Exit and handoff

All problem rows remain OPEN until their implementation and fresh evidence exist.
Check off tasks only from observed results. Close E1 from target/identity preflight;
close F1–F3 only after focused regressions and the complete deployed rerun pass.
Update this plan, design §18.2 and AGENTS.md's priority together when the gate closes.
**Do not start a new feature before that closure.** Real devices, provider login,
licensed launch templates and physical/remote playtests remain separate G9 work;
this plan neither implements migration support nor claims public-release readiness.
