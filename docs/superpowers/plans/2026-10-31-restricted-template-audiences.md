# Restricted campaign-template audiences — D2 execution plan

**Status:** implemented in PR #27; final CI #174 and both isolated hosted journeys pass. [Acceptance, screenshots, asset identity and cleanup](../../acceptance/restricted-template-audiences-2026-11-01.md). Wider G9 release gates remain open.
**Baseline:** merged D1 main `90b053d`; C PR #25 and D1 PR #26 are merged.
**Contract:** [D2 audiences, reveal and offline boundary](../specs/2026-10-31-restricted-template-audiences.md).
**Goal:** prepare GM-only/selected-player catalog drafts, preview the actual player's
view, and explicitly reveal to all players before ordinary sheet placement.

This is the separately planned D2 follow-up requested by the D1 execution plan.
Follow AGENTS.md, design and GUI G1/G7/G9 gates. Use observed red → smallest green
implementation → refactor for each behavior. No pre-release migration or historical
client-transition tests. Do not close gates from documents or retained old evidence.

## Code-grounded findings

- `src/campaigns/templates.ts` currently types every template as `all_players`.
  `authorize` checks campaign membership/GM role, but open/list have no audience policy.
  Mutation receipts return full content after only GM authorization. Add explicit
  current-scope authorization before replay and suppress secret public activity.
- `src/campaigns/templatePersistence.ts` pages all campaign rows and cursors bind only
  campaign/status/kind. Make read scope explicit and filter in SQL before pagination.
  Both `content.ts` GM export and Characters call this repository directly: audit
  every caller instead of fixing only public catalog endpoints.
- `src/characters/index.ts` reads raw templates during entry resolution, rechecks
  revisions in the command transaction, and constructs selectors through raw catalog
  pages. All three seams must exclude restricted templates, including GM requests.
  Inspect receipt replay before adding a live catalog requirement that would break
  independent copies or committed retries.
- `web/src/characters/CharacterRoute.tsx` and `store.ts` persist campaign selector
  choices for offline placement. Keep that payload all-player-only. Campaign restricted
  reads need transient scope handling like D1 `CampaignProposals.tsx`.
- `src/campaigns/policy.ts` already centralizes content visibility, but template grants
  need current membership generations as D1 uses. Reuse conventions, not content-note
  creator privileges or client-side authorization.
- `CampaignTemplates.tsx` owns catalog authoring and frozen online retries;
  `campaignTemplates.ts` owns strict HTTP schemas and generated API contracts. Extend
  these seams and shared/i18n controls rather than introducing a second catalog.

## Execution record (2026-11-01)

Final application `5f445aa` is pinned to successful deployment
`f23a7773-3492-4917-851e-25f92071bf20`. CI #174 (`34309f9`, application-identical
plus tests/docs) passes all seven jobs on its first attempt: 472 root, 350 real
PostgreSQL, 1,180 frontend, 62 browser, 30 offline and ten visual checks, types,
contracts, builds and Docker. Hosted Chromium normal/offline journeys pass in
33.298/37.252 seconds, zero retries; six served assets match byte for byte. Cleanup
readback verifies all seven run manifests. Campaign roll p95 is 143.6 ms against
500 ms, with unchanged workload and limits. The detailed checkboxes below retain
the implementation/verification recipe; this execution record and linked acceptance
are the delivered evidence. Physical-device/provider-auth/playtest gates stay open.


Implementation preserves the B/C/D1 Module seams, fresh schema baseline and independent
character copies. The grant budget is bounded by 100 and the configured membership
limit. Campaign catalog queries carry current actor/generation/role/read-mode scopes;
restricted reads stay outside durable character caches. Recipient/preview labels reuse
the existing roster user labels (user IDs); no recipient IDs are manually entered.

TDD CI #168 on `0176b37` observed four failing PostgreSQL/HTTP requirements before code.
CI #169/#170 identified archive/conflict and new-fixture/schema expectation issues;
those are repaired without relaxing existing assertions, timeouts, retry policies,
workloads or visual baselines. CI #170 independently passes 472 root tests and 346
PostgreSQL cases, with two new fixture/schema assertions still requiring correction.
The original assertion checks were retained and corrected to use current reconciliation
metadata and include the new grant primary-key index. A new cache-unmount regression
was observed red and repaired; nine targeted frontend tests pass locally.

A browser contrast finding during theme changes is repaired by synchronizing foreground
and background palette changes, preserving final colors. The new offline journey uses
the sheet's actual durable-offline badge and additionally verifies control of the
catalog page by the production worker; a campaign catalog has no sheet badge.
The worker deliberately excludes campaign navigation from the offline shell allowlist:
the new offline direct-reload check asserts an explicit network denial and no secret
content, while disclosed character copies must reopen successfully. API cache keys
are inspected independently. No offline campaign navigation is introduced.

Hosted resources are confined to new project `sweetroll-d2-acceptance`, environment
`preview`; existing preview and production projects remain unchanged. First deployment
failed private database connectivity across regions. The app is being colocated with
the database volume; no egress/endpoint security settings were changed. Final
CI/deployment, asset identity, hosted results and independent cleanup are recorded in
the linked acceptance report.

## D2.0 — Pin contract and fixtures

- [ ] Review the merged D1/C implementation and inventory all repository callers,
  character execution replay, public activity projections and client cache owners.
- [ ] Pin the existing campaign membership limit and selected-recipient body budget.
- [ ] Prepare GM/co-GM/two-player fixtures, a removed/rejoined generation and outsider;
  include item/spell/ability/effect plus inherited defaults/actions and existing copies.

**Gate:** restricted drafts are never placeable; explicit all-player reveal is the
only transition to ordinary placement. No new sheet secrecy or grant semantics.

## D2.1 — Audience persistence and policy (TDD)

- [ ] Red: current member policy reveals every catalog template. Add generation-bound
  grant relation and baseline constraints; one Campaigns template read policy.
- [ ] Red → green real PostgreSQL: GM, selected/unselected player, outsider, removal,
  rejoin, promotion/demotion and archived access matrix. No creator bypass.
- [ ] Add strict create/sharing inputs; validate recipients/budgets and serialize
  complete grant replacement under campaign lock. Revision/key mismatch and injected
  failures roll back grants, row revision, audit/activity and receipt together.
- [ ] Preserve omitted-audience all-player create and D1 atomic approval behavior.

## D2.2 — Read surfaces, receipts and preview (TDD)

- [ ] Red: direct ID/list/paging can disclose hidden drafts. Scope repository APIs;
  filter before LIMIT, bind cursors, check active membership on every page.
- [ ] Extend bounded GM export in its existing read snapshot and deny replay after
  demotion. Prove private IDs/text/grants absent from public activity and errors.
- [ ] Implement GM-only read-only paginated template preview for an active player
  using identical policy and query scoping as actual player reads. Target removal
  fails closed; preview cannot authorize writes, exports or account impersonation.
- [ ] Recheck current authority on exact mutation replay; retain normal idempotency
  mismatch/expiry semantics without exposing old secret responses.

## D2.3 — Reveal and safe placement (TDD)

- [ ] Red: raw character selectors and entry resolution admit restricted rows. Permit
  only active all-player templates for selectors and initial/locked placement checks.
- [ ] Red → green races: reveal/narrow/placement/archive/removal with campaign lock
  order retained; no hidden snapshot, partial write or revision/key substitution.
- [ ] Prove failed uncommitted queued references require current authority/review,
  while authorized committed retries preserve one independent historical copy.
- [ ] Existing copies, returned characters, actions/pushes, rolls, character export
  and offline field updates remain independent of later catalog sharing.

## D2.4 — Catalog GUI and cache boundary (TDD)

- [ ] Shared audience controls, labeled active-player recipients and persistent
  audience marks. Explain draft versus placeable template and unrecalled copies.
- [ ] Explicit reveal confirmation; freeze exact request/key during uncertain result;
  conflict requires review, reload only reads, and errors preserve form/focus.
- [ ] Preview picker/banner uses target-specific queries; exit restores real GM view.
- [ ] Red: delayed privileged responses after demotion/account switch/offline entry
  cannot render or repopulate cache. Purge transient restricted/preview data.
- [ ] Prove no restricted text/default/action appears in IndexedDB/service-worker
  caches or character selector payloads. Preserve ordinary offline placement behavior.
- [ ] Inspect routed 320/360/768/1280 light/dark, keyboard/Escape/return focus and long
  labels with actual screenshots; do not replace baselines to conceal failures.

## D2.5 — CI and hosted acceptance

- [ ] Run Node 24 unit/real-PostgreSQL suites, frontend tests, typechecks, generated
  contract identity/builds, canonical browser/offline/visual suites and Docker. Keep
  retries/timeouts, assertions, workload budgets and visual baselines intact.
- [ ] Deploy exact tested application to isolated preview; inspect source branch,
  terminal success/readiness and served asset identity. Leave production sources
  and unrelated preview data unchanged.
- [ ] Multi-identity GUI journey: secret preparation → selected draft → preview
  parity → blocked placement → explicit all-player reveal → independent sheet copy.
  Narrow again and prove existing copies persist while new placement is blocked.
- [ ] Exercise direct IDs/paging/exports/activity, generation revocation, competing
  GMs, lost responses, reload, stale references and offline reconnect. Inspect
  browser storage/network for hidden payloads; canonical offline journey still passes.
- [ ] Archive only run-created resources and independently verify cleanup. Record
  exact source/deployment, commands, observed red/green, screenshots and limitations
  in `docs/acceptance/`; update plan/design from actual evidence.

**Completion gate:** all D2 privacy, explicit reveal, placement, current-request
recovery and hosted checks pass. Real devices, provider authentication and physical/
remote playtests remain G9; no public-release claim follows from D2 alone.
