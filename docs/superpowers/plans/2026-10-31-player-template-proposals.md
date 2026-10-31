# Player proposals for campaign templates — adventure slice D1

**Status:** code-grounded execution draft; no D1 implementation or acceptance claim. [Companion contract](../specs/2026-10-31-player-template-proposals.md).
**Dependency:** review/merge inherited-actions PR #25. Planning baseline is its head `9f11c741f7ce3cc6722c07af21fa3d1857ccae29`; application `58c71a1` passed CI #158 and hosted acceptance, and the documentation-only head passed CI #159. Retarget this planning change to main after C merges, accounting for the actual merge SHA.
**Authority:** [design §§5.4, 17.0, 17.9b and 18.2](../../../design_v2.md), [adventure-items roadmap](2026-10-07-adventure-custom-items.md), [GUI delivery gates](2026-09-08-gui-integration.md).
**Goal:** a player suggests bounded adventure content; a GM/co-GM approves exactly one reusable data-only catalog template or rejects the suggestion. The player's original entry stays unchanged.

This follows accepted slice C and precedes D2 restricted catalog audiences. It does not add inherited-action proposals, restricted catalog publication, trading, bulk placement, new mechanics, notifications or a proposal offline queue. Read the companion contract's proposed limits, actor/generation policy and recovery boundary before implementation.

Until the first application release tag (`v*.*.*`), update the current database baseline and test fresh isolated databases. No application/database or character/campaign migration, old-cache adapter or previous-client transition suite belongs here. Membership generations, immutable published rules and exact-request receipts remain current authorization requirements.

## User journey

1. An active player opens Campaign → Items & powers → **My suggestions** → **Suggest a template**. A shortcut from a personal sheet entry may prefill text; it does not link or rewrite that entry.
2. Choose Item, Spell, Ability or Effect, enter bounded text and item quantity. The form explains that approval publishes this content to all members; it exposes no system base, typed rule defaults or expression editor.
3. Submit online. The player sees only their current-membership proposals and decision status. Network uncertainty retains the same request/key in the open form; reload reads committed proposals without resubmitting.
4. GM/co-GM opens **Review suggestions**, reads the exact content and chooses **Approve and publish to all members** or **Reject** with an optional reason. Ineligible submissions explain why approval is blocked.
5. Approval creates one ordinary blank campaign template and links it from the proposal. It can be placed and independently edited under existing B/C rules. Subsequent catalog edits/archival do not change the original suggestion or personal entry. Rejection publishes nothing.

## Code seams and required changes

| Existing seam | Work and constraint |
| --- | --- |
| `src/campaigns/templates.ts` | Current `createTemplate` owns its transaction and permits optional C bases/defaults. Extract a narrow client-aware blank publication capability; approval cannot nest that public command while holding the campaign lock. Share strict blank validation and capacity rules. |
| `src/campaigns/templatePersistence.ts` | Reuse catalog row/revision creation with the caller client; preserve immutable content and lifecycle behavior. |
| Campaigns `index.ts`, `persistence.ts`, `policy.ts` | Add proposal Module methods/repository and explicit player-self versus GM-review policy. Use `campaign_members.generation` to bind submissions; current role and membership precede receipt replay. |
| `database/schema.sql` | Add the current proposal baseline, status/link checks, campaign/status and submitter/generation paging indexes. Add no migration runner or historical repair. |
| `src/campaigns/content.ts` | Campaign export is GM-only and already uses one read snapshot and a record budget. Add bounded campaign proposals to that snapshot/budget; preserve GM-only authorization on initial export and replay. |
| `src/transport/http/campaignTemplates.ts`, `campaigns.ts` | Register distinct strict proposal routes/DTOs, error mapping and current export shape. Regenerate OpenAPI/client types canonically. |
| `web/src/campaigns/CampaignTemplates.tsx` and route wiring | Reuse dialog, fields, role/lifetime guards and frozen retry patterns. Add separate self/review query scopes; do not reuse a GM result as a player cache. |
| Sheet personal-entry controls | Optional text-only prefill into the campaign proposal form; no character command, snapshot upload or new source authority. |

The proposal contains submitted text, not an executable or placeable template. No entry runtime, dice grammar, push policy, character schema or system-package format change should be needed.

## TDD and delivery order

Keep this work in its own implementation PR after C review/merge. Each new behavior starts with an observed meaningful red test, then the smallest implementation, green and refactoring. Generated output or retained passing suites are not substitutes for tests of proposal behavior.

### D1.0 — Confirm the contract and baseline

- [ ] Reconcile the companion contract with the merged C head and inspect public Module/DTO boundaries before changing code.
- [ ] Confirm proposed first-slice decisions: player-only immutable submissions, exact-content approval, private GM/self visibility, generation-bound eligibility, 500 campaign records / 20 pending per membership, and online-only recovery without a durable proposal queue.
- [ ] Record a fixture using all four kinds and a personal item that remains unchanged throughout suggestion/approval.

**Gate:** ownership, DTOs, bounds, visibility and retry semantics are unambiguous. D2 and migration work remain excluded.

### D1.1 — Private submission and discovery

- [ ] Red: an active player cannot yet submit a proposal or list only their own suggestions. Add immutable content, server-owned actor/generation and pending revision 1.
- [ ] Red: reject executable/default/base/snapshot inputs, unknown keys, invalid text/quantity/kind and oversized bodies; prove a malicious player cannot select a submitter or campaign scope.
- [ ] Red → green with real PostgreSQL/HTTP: outsider, removed member, rejoined generation, another player's direct ID, GM demotion and archive/recover. Filter before pagination/counts and bind cursors to actual read scope.
- [ ] Enforce both proposal quotas under the campaign lock; same-key replay/mismatch/expiry retain existing semantics after current authorization. Denied writes leave no proposal/audit/receipt.
- [ ] Prove pending/rejected content, identities and reasons do not appear in shared activity, catalog choices, projections or unrelated exports.

**Gate:** a submission grants no publication, placement or mechanical authority and cannot disclose another submitter's content.

### D1.2 — One atomic approval or rejection

- [ ] Red: GM approval cannot yet create a blank template and terminal proposal atomically. Extract the transaction-aware blank publication helper with no behavior change for direct catalog create.
- [ ] Approve exact content under campaign → proposal locking, active submitter-generation check, catalog capacity and expected proposal revision. Allocate a fresh template at resource/content revision 1 and store its link.
- [ ] Red → green: same-key exact replay, changed payload/key, approve/approve and approve/reject races, concurrent co-GMs, revocation/archive races and catalog-full rollback. Exactly one terminal decision/template must survive.
- [ ] Inject failures after catalog insert, terminal update, audit/activity and receipt writes. Verify full rollback and a still-pending proposal; do not consume a success receipt on failure.
- [ ] Reject without a catalog row or shared activity. Approval's public event contains only ordinary publication data; private audit summaries contain no submitted text/reason.
- [ ] Later template edit/archive and receipt expiry never republish or change the linked identity. Member removal/rejoin cannot reactivate the old submission; rejection remains available to GMs.

**Gate:** one decision publishes at most one template, and a failed decision publishes nothing.

### D1.3 — Export and client authority

- [ ] Extend the existing GM-only campaign export in its consistent read transaction with bounded campaign proposals. Count them in export limits and recheck GM authority on replay after demotion/removal. Keep player campaign exports denied and character exports unchanged.
- [ ] Red: a delayed GM review response must not render after demotion/account switch/removal. Scope query keys and lifetime guards to account, campaign and current GM/self context; clear inaccessible data before another role can render it.
- [ ] Keep private proposal data out of durable character stores/service-worker API caches. Verify purge/abort behavior, direct links and stale page cursors without adding old-client transition tests.

**Gate:** discovery, direct read, export and client cache all enforce the same private visibility policy.

### D1.4 — Player/GM GUI and exact requests

- [ ] Red: build the player suggestion form and self list, GM review list and exact-content decision dialog using existing controls/i18n. Show eligibility and linked catalog outcome without technical IDs.
- [ ] Keep fields on validation/network/capacity errors; retry the exact frozen body/key. A 409 requires explicit refresh/review and never changes to a fresh key automatically.
- [ ] Lose committed submit/approve/reject responses, reload and re-list. Read authoritative status/link; never synthesize another POST or duplicate publication. Retain the original request for retries while its form is open.
- [ ] Optional personal-entry prefill copies only public form text/quantity; ambiguous kind needs a labeled choice. Verify no character revision, personal value, source or history changes on submission/decision.
- [ ] Verify keyboard/focus/Escape, confirmations, escaped content and 320/360/768/1280 light/dark layouts. Preserve GM direct-create and player ordinary catalog placement.
- [ ] Offline controls explain that submission/decisions require connectivity. Existing personal editing/placement offline behavior is unchanged; no proposal queue is added.

**Gate:** the player understands suggestion versus publication, and retries cannot silently make a second decision.

### D1.5 — Final CI and isolated hosted acceptance

- [ ] Run Node 24 root and real PostgreSQL suites, typechecks, generated-contract identity, frontend tests/build, canonical browser/offline/visual suites and Docker. Preserve workload/latency limits, retries and baselines.
- [ ] Deploy the exact tested application to the existing isolated preview. Verify source pin, terminal success, readiness and served asset identity. Preserve the real production project and unrelated test data.
- [ ] Use GM, co-GM and two players: one player suggests from a personal item, the other cannot discover/read it, GM approves, a normal member places the public blank template, and the personal item remains unchanged. Reject a second proposal with no publication.
- [ ] Cover direct-ID/export/cache isolation, two competing decisions, removed/rejoined submitter, catalog-full failure, stale revisions and committed-response loss/reload recovery. Confirm no new writes while offline.
- [ ] Archive only run-created characters/templates/campaigns/systems and independently read back cleanup; proposal records follow the archived campaign's read policy. Do not invent a deletion/retention feature for test cleanup.
- [ ] Record exact commit/deployment/resources, observed red/green findings and final hosted results under `docs/acceptance/`; update design/roadmap from evidence only. Keep unperformed physical-device/provider-auth/playtest G9 gates open.

**Gate:** D1 is complete only when private submission, one atomic publication, scope-safe recovery and the unchanged original entry pass CI and hosted acceptance. This document closes none of those gates by itself.

## Follow-up

After D1 acceptance/review, plan D2's restricted catalog audience, explicit reveal/placement and preview-as-player contract separately. Real-device and release-readiness work can progress in parallel; it does not authorize D2, migration, trading or custom action authoring.
