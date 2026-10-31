# Player proposals for campaign templates — D1 contract

**Status:** implemented in draft PR #26; final CI/hosted acceptance in progress. Inherited-actions PR #25 is merged as `455f967`. [Execution plan](../plans/2026-10-31-player-template-proposals.md). These decisions define a separate follow-up; they do not change the accepted C implementation.

## Outcome and boundary

An active player submits bounded text describing an adventure item, spell, ability (`talent`) or effect. A GM/co-GM reviews it and either publishes one data-only campaign template or rejects it. Submission is not publication. Approval never changes a personal entry, character revision, published system or placed copy.

First-slice decisions: immutable submitted content; approve exactly that content; optional rejection reason; no pending edit/withdraw/resubmit-in-place. A fresh submission after rejection has a new identity. Existing catalog editing remains available after publication. GM/co-GM users create catalog templates through the existing flow; proposal submission is for the `player` role.

Excluded: system-derived proposals, base/default-value/action/formula authoring, automatic personal-entry replacement, D2 restricted catalog audiences, notifications, bulk decisions, proposal retention workers, offline proposal authoring/queues and application-version migration.

## Resource and visibility

The server owns `proposalId`, `campaignId`, `submitterId`, submitter membership generation, timestamps, `revision`, `status`, decision actor/reason and approved template identity. Content and kind are fixed at submission. Initial state is `pending`, revision 1. One decision produces revision 2 and terminal `approved` or `rejected` state.

| Reader/operation | Rule |
| --- | --- |
| Submit | Active player in an active campaign; no system-authorship or character-control shortcut |
| Read/list | Active GM/co-GM sees campaign proposals; active player sees only proposals submitted by that actor in the current membership generation |
| Approve | Active GM/co-GM, active campaign, pending/current proposal, and submitter still active in the original membership generation |
| Reject | Active GM/co-GM, active campaign and pending/current proposal; may reject an ineligible former member's proposal |
| Archived campaign | Authorized reads remain available; all proposal writes are blocked until recovery |
| Removed member, outsider or wrong campaign ID | Generic 404 before disclosing proposal existence, content, counts or receipt results |

Removal and rejoining must not resurrect old submission rights. A GM may still read those records but cannot approve them; the current member submits a fresh proposal. Demoted GMs lose other submitters' proposal data, including cached panels and decision receipts. Current authorization is checked before idempotency replay.

A submission receipt is bound to its original membership generation: removal/rejoin makes its replay inaccessible (404), not a new submission. A committed GM decision remains readable/replayable by its currently authorized GM even if the submitter later leaves; eligibility is a first-commit check, not a reason to recreate or erase the recorded decision.

Pending/rejected proposals, rejection reasons and submitter identities never enter slot discovery, character projections, public catalog DTOs or shared campaign activity. On approval, the new ordinary all-player template is public under existing B/C rules; publication does not expose a proposal ID, review discussion or private rejection reason. Submit UI explains that approval publishes the submitted text to all campaign members.

## Content and HTTP surface

`kind` is exactly `item | spell | talent | effect`. Strict `content` is `{name, description?, notes?, defaultQuantity?}`: nonblank name 1–200 characters; description/notes at most 2,000 each; quantity only for items, positive safe integer. Use the same string/quantity semantics as blank templates. Reject unknown keys and executable or server-owned inputs, including `base`, `baseTemplateId`, `defaultValues`, fields, actions, source references and snapshots. `validateTemplateContent` currently admits typed defaults before the blank-template check; it cannot be the sole proposal validator.

| Method/path under `/api/campaigns/:id` | Strict request | Result |
| --- | --- | --- |
| `POST /item-proposals` | `kind`, `content`, `expectedProposalRevision: 0`, `idempotencyKey` | 201 `{proposal, requestId}` |
| `GET /item-proposals` | Optional `status`, `limit`, `cursor`; no arbitrary submitter selector | 200 `{proposals, nextCursor, requestId}` with server-filtered scope |
| `GET /item-proposals/:proposalId` | No body | 200 `{proposal, requestId}` |
| `POST /item-proposals/:proposalId/approve` | `expectedProposalRevision`, `idempotencyKey` | 200 `{proposal, template, requestId}` |
| `POST /item-proposals/:proposalId/reject` | `expectedProposalRevision`, `idempotencyKey`, optional `reason` up to 2,000 characters | 200 `{proposal, requestId}` |

IDs in paths are UUIDs. Decision revisions are positive integers. Keys are nonempty strings up to 200 characters, matching catalog commands. No approval content override, template ID or submitter ID is accepted. A proposal view includes bounded original content, status/revision and timestamps; terminal views include the decision metadata and, for approval, the linked template ID. GM review additionally receives a bounded current eligibility summary; it is informational and must be rechecked at commit.

Use explicit current DTOs: common view `{proposalId, campaignId, submitterId, kind, content, status, revision, createdAt, updatedAt, decision, approvedTemplateId}`. Pending `decision`/template link are null; a terminal decision is `{actorId, decidedAt, reason}` with reason null for approval or an optional rejection message represented as null when absent. Only approval has a non-null template link. Membership generation stays server-owned/internal. GM review adds `eligibility: {canApprove, reason}`, where reason is null or `already_decided | campaign_archived | submitter_inactive | catalog_full`; player views omit this field. ISO timestamps and opaque IDs are rendered as ordinary labels/status through existing UI components.

Pagination defaults to 50, accepts 1–100, filters authority before paging and counts, and binds cursors to campaign, actor, role/read scope, current membership generation, status and ordering. Do not reuse a cursor after scope changes. Order by stable ID, consistently with catalog paging.

Proposed storage limits: 500 proposal records per campaign, including decided records, and 20 pending proposals per player membership generation. Submission checks both under the campaign lock. These are first-slice bounds, not a cleanup worker. Catalog publication retains its existing 500-template limit.

## Atomic decision and exact requests

Campaigns owns the transaction and campaign-first lock order. Under the same `PoolClient`, authorize current membership/lifecycle, check the actor/operation/key receipt, read the proposal, enforce its expected revision/state and current submitter eligibility, validate its strict blank content, and check catalog capacity.

Approval allocates one new template with catalog resource/content revision 1 and `audience: all_players`, using the deciding GM as catalog creator. Write the terminal proposal/link, catalog rows, audits, permitted public publication event and success receipt in one transaction. A failure anywhere rolls everything back and leaves the proposal pending. Extract a narrow transaction-aware publication helper from the existing catalog path; do not call `createTemplate` as a nested independent transaction while holding the campaign lock. The helper must enforce the same blank validation and capacity rules as direct creation.

The proposal's single terminal decision and campaign serialization prevent two keys or two GMs from publishing twice. Exact same-key replay returns the recorded decision and original linked template identity after current authorization; a different key against a terminal proposal conflicts. Replay does not create a replacement if the approved template was subsequently edited/archived. Use the existing receipt expiry and mismatch semantics; expired results require a fresh authorized read, not silent republishing.

Reject changes only the proposal and its private audit/receipt. Generic audit summaries contain no submitted text/reason. No pending/rejected proposal event is appended to activity visible to unrelated players. Approval emits only the existing permitted template-publication event, without private proposal metadata.

## Current-app storage, exports and UI recovery

Add a current-baseline proposal table with campaign/user references, membership generation, bounded content, status/revision, decision fields and approved-template link. Enforce terminal-state/link consistency. No schema upgrade chain or old-client conversion precedes the first application release tag. Use a fresh isolated database for schema tests; preview recreation, if needed, must be scoped and explicit.

Campaign export is already GM-only (`canExportCampaign`). Preserve that boundary and extend its current snapshot with bounded campaign `proposals`, counted in the existing export budget. Players read their own proposals through list/detail; D1 does not grant them campaign export access. Do not add proposal content to public activity or character exports. Export receipt replay rechecks current GM authority, including after demotion/removal; do not return a formerly privileged snapshot to a player.

Proposal screens are online-only. Keep queries in account/role/campaign-scoped memory, with cancellation and lifetime guards; do not persist private proposals in shared character caches or service-worker API caches. Clear review data on role change, removal, sign-out and account switch. Keys must distinguish GM review scope from player self scope even when the account is unchanged.

For an uncertain response, retain the exact request/key in the open component and retry it unchanged. Reload performs an authorized read/list and displays committed state; it never recreates a POST automatically. Approval/rejection recovery follows the proposal's terminal state and original template link. An unsubmitted/uncommitted local form is not promised durable after reload; no offline/durable proposal-intent queue is introduced in D1. Keep entered data on in-place validation, network and capacity errors; a 409 requires refresh and explicit review.

The sheet's optional **Suggest to GM** shortcut copies only displayed personal-entry text/quantity into the proposal form. It creates no server-side link to the entry. If slot kind is ambiguous, require a labeled kind choice; never forward a derived/system snapshot or hidden fields. Character removal/editing after submission does not alter the proposal. All-personal-entry write rules stay unchanged.

## Error contract

Invalid/unknown content or malformed cursors: 400. Unauthenticated: 401. Active player attempting a GM decision, or a GM using player-only submit: 403. Inaccessible campaign/proposal or another player's private ID: 404. Stale revision, terminal state, archived campaign or changed submitter eligibility: 409. Storage/catalog limits: 413 using existing Campaigns error mapping. Unexpected failure: 500 with rollback and no private details. Preserve the existing distinct idempotency mismatch and expired-result errors.
