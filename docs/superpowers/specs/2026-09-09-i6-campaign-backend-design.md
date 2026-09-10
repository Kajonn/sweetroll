# Campaign Backend - Design (I6 backend only)

**Status:** Revised draft for review; not an implementation or I6 acceptance record.
**Date:** 2026-09-09.
**Authority:** `design_v2.md` Sections 12, 13, 17.8 and GUI plan G7.
**Scope:** Campaign backend and existing Characters integration. No Player campaign UI, GM app, outbox, or email delivery.
**Implementation plan:** [Task-level backend plan](../plans/2026-09-09-i6-campaign-backend.md). Prerequisite dispositions approved below; implementation has not started.

## 1. Decisions and boundaries

- OD-02: active GMs/co-GMs see full attached character sheet state, disclosed before joining, claiming, and adopting. I6 ships this fixed policy, not a visibility toggle. It does not implicitly grant access to owner-only notes or actor-private rolls.
- Invitations are single-use bearer tokens distributed out of band. Only token hashes persist. Lost issue responses are recovered by explicit token rotation, not by storing plaintext in receipts.
- Owner decision: when an adopted character's original owner leaves or is removed, the same character returns to that owner with its current sheet values. Campaign history does not become personal history. This return right is immutable while attached.
- Adoption requires an exact campaign-version match. No implicit migration, heterogeneous-system campaign, or attached-character independent migration/rollback is introduced.
- Campaign-created characters remain campaign-owned when a player leaves. Multiple active player controllers may share a sheet; controller rights are not a right to take the character out of the campaign.
- SystemRuntime continues to own rules evaluation; Characters owns sheet mutations and authoritative rolls. No second renderer, mutation protocol, or rules engine.
- Token-only delivery is an approved deviation from the original I6 email/outbox task. Email/outbox is deferred to a separately planned I6 follow-up. Media/display and campaign version upgrades remain I7b and I7 respectively.

**Owner-approved prerequisite dispositions (2026-09-09):** This backend-only slice may proceed before full I5 acceptance, using the existing deterministic authentication adapter and license-neutral reference fixtures. This permits backend development and HTTP verification, not production deployment, closure of I5, or full I6 acceptance. Real production sign-in and its return journey remain required for production readiness and full I6 acceptance.

- OD-03: defer named collaborators and multi-creator editing; preserve current creator ownership and revision-safe saves. Campaign membership and co-GM roles grant no system-authoring permissions. Collaborative authoring is not part of this slice.
- OD-08: defer launch-template selection and license review. Tests use existing license-neutral fixtures; campaigns may use accessible published versions without a shipped template catalog. Licensed-template claims and demonstrations requiring those templates remain blocked until licensing is verified.
- Player integration and all other applicable acceptance gates remain open. These narrow dispositions supersede the earlier instruction to resolve these prerequisites before starting this backend slice; they do not waive authorization, concurrency, offline-regression, or contract verification.

## 2. Module boundaries and existing-route integration

Campaigns exposes deep commands for campaign metadata/lifecycle, membership, invitations, campaign character placement, content/grants, activity, and export. Its internal policy implementation owns campaign membership, role, content audience, and campaign character capabilities. HTTP adapters authenticate, decode, invoke one owning Module operation, and map its result.

Characters retains existing open/list/create/edit/bump/action/lifecycle/transfer/duplicate/export/activity/migration endpoints. Every path must distinguish standalone from attached characters using an authorization context supplied by the campaign policy implementation. This includes command execution claims, completed receipts, recovery reads, migration previews/rollback, and library/search queries; ownership alone cannot authorize an attached character. The policy seam returns capabilities and authorization generation, not caller-controlled roles or a permanent authorization grant.

Characters' internal campaign-placement operation participates in the same PostgreSQL transaction as Campaigns membership/placement commands. Campaigns coordinates placement and membership changes through this narrow internal operation; it does not call public owner-only HTTP operations or reimplement character state writes. Runtime evaluation stays outside long transactions. A final short transaction locks/rechecks campaign authorization, character revision and placement generation before storing state, roll, activity, and receipt together. Avoid circular public Module calls; bootstrap injects the policy/placement dependencies.

Before implementation, enumerate every existing Characters operation in a contract test matrix. Preserve the standalone one-owner API and data without introducing campaign terms into the current Player UI. Campaign DTO additions and ownership unions must be regenerated from OpenAPI; owner-only SQL helpers must not remain reachable for attached data.

## 3. Ownership, departure, and authorization

### 3.1 Character representation

Standalone characters have one non-null `owner_id`, no `campaign_id`, and no campaign controllers. Attached characters have a non-null `campaign_id` and no standalone `owner_id`. `character_controllers` contains zero or more active campaign memberships; controllers may retain their record after promotion to co-GM. GM authority does not require a controller record. Zero controllers is a valid GM-controlled/unclaimed character; no dummy user owns it.

An adoption additionally records immutable `return_owner_id`, source campaign, and a placement generation. The original owner must be an active member and controller throughout the attachment, regardless of their campaign role. Assignment cannot remove that controller or change the return owner. A campaign-created character has no return owner. Historical placement records persist after detachment for audit and history scoping.

### 3.2 Capability matrix

| Operation | Campaign owner / active co-GM | Active player | Removed member / outsider |
| --- | --- | --- | --- |
| Read campaign identity, roster | Yes | Yes; public member display data only | No |
| Read/edit/bump/roll sheet | All attached sheets | Controlled sheets only | No attached access |
| Create campaign character | Unclaimed or assigned to active players | Self-controlled character | No |
| Replace controllers / designate claimant | Yes, with adoption return-owner invariant | No | No |
| Claim | Not needed for GM access | Only if explicitly designated by GM; adds that member once and consumes designation | No |
| Adopt standalone | Cannot take another user's character | Own active, exact-version character; explicit disclosure acknowledgement | No |
| Transfer / duplicate to personal library | Denied while attached | Denied while attached | No |
| Export sheet | Authorized current sheet projection only | Controlled current sheet projection only | Returned standalone sheet only |
| Archive/recover character | Yes | No while attached | No |
| Rename attached sheet | Yes | Controllers only | No |
| Migrate/rollback attached character | Denied until I7 campaign upgrade command | Denied | No |

Standalone owners retain existing behavior. An active GM who wants to adopt their own standalone character uses the same own-character adoption checks; the return owner remains a controller regardless of their current campaign role. A player can leave via self-removal; they cannot change another member or their own role. Only the campaign owner may promote/demote co-GMs. Co-GMs may manage player memberships and player invitations, but cannot remove/demote the owner, modify peer co-GMs, or issue elevated-role invitations. The owner is always an active GM, cannot leave/demote/remove themselves, and may archive instead; ownership transfer is not added in this slice.

### 3.3 Departure transaction

Leaving/removal atomically marks membership removed, clears that membership's controllers, claim designations, and content grants, and increments authorization generation. Campaign-created characters retain their current state in the campaign; remaining controllers and GMs retain their access.

Each character adopted by the departing member is detached in the same transaction: restore `owner_id = return_owner_id`, clear `campaign_id` and all controllers/designations, increment character revision and placement generation, and preserve current sheet state and exact version. Other controllers and campaign GMs lose live access to that character. A minimal campaign audit event records departure/return, not a new copy of sheet values. Archiving a campaign does not remove membership or automatically detach characters; leave/removal remains available while archived.

Disclosure acknowledged during adoption: all sheet fields, descriptions, inventory and current values can return to the original owner, including GM edits. GMs must not put secrets in that sheet. No field-level provenance filtering is claimed. This is an explicit exception to blanket character-access denial after membership removal, not an exception for campaign content.

Rolls, activity, migration history and receipts carry their original standalone/campaign placement scope. Returning the character does not relabel campaign history or expose other actors' data. Pre-adoption personal history is hidden from campaign callers and becomes available again to the original owner after return. Campaign history remains accessible only through current campaign/audience policy; the departed actor cannot retrieve even their own campaign-scoped receipts or rolls. Returned character reads, exports and recovery paths must not embed that history. Existing character export/duplicate implementations must be checked for hidden historical payloads.

### 3.4 Pin and lifecycle rules

Adoption requires an active standalone character, current owner consent, active campaign membership, matching entity validity and exact `system_version_id`. Reject a mismatch with a definite validation error; the owner may separately migrate before adoption. Attachment advances revision/generation and invalidates outstanding migration previews. Attached migration preview, commit and rollback are denied, including previews made before attachment. Return advances revision again; old queued commands cannot execute against the returned sheet as if attachment never occurred.

Archived campaigns allow authorized reads/exports and departure, but no new joins, content/character edits, rolls, adoption or assignment. Archive/recover are revisioned owner/co-GM commands. Recovery does not restore removed memberships, grants, claims or invitations consumed/revoked earlier.

## 4. Content, rolls, activity and exports

### 4.1 Content policy

All campaign content access requires active membership, including creator access. Default GM-created content is `gm_only`; default player-created notes are `owner_only`.

| Audience | Read access |
| --- | --- |
| `gm_only` | Active owner/co-GMs |
| `all_players` | All active members |
| `selected_players` | Active granted players and active owner/co-GMs |
| `owner_only` | Active creating member only; no implicit GM override |

Players create owner-only notes and edit/delete their own notes; sharing/audience/grant administration is GM-only and cannot operate on another actor's inaccessible owner-only note. GMs edit/delete content they can read. Grant replacement validates active memberships in the same campaign, is atomic with audience changes, and increments content revision and authorization generation. Removing a member destroys grants rather than reactivating them on rejoin. Soft deletion hides content from ordinary reads; authorized recovery uses the same visibility policy and expected revision. Text has bounded title/body/tag lengths and list sizes; no HTML execution, uploads, external ingestion, or custom rendering.

### 4.2 Roll contract changes

Extend existing Characters action input with optional audience, using one wire/storage vocabulary: `owner_only`, `gm_only`, `campaign`. Standalone actions accept only `owner_only` and retain existing behavior. For attached characters, `owner_only` means the rolling actor only, subject to active campaign membership; it does not mean every controller. `gm_only` means rolling actor plus current owner/co-GMs; `campaign` means all active members. Full-sheet GM visibility does not override a private roll.

Campaign `roll_audience_default` defaults to `campaign`. An explicit permitted per-roll audience overrides it. The effective audience is fixed when the execution is first claimed, included with placement scope in execution metadata and input-hash semantics, and reused on retry even if the campaign default changes. Audience cannot be widened on an existing roll. Unknown values fail validation, never fall back to a wider audience.

Characters applies audience authorization after Runtime resolution; Runtime remains a rules evaluator, not a campaign policy engine. Remove the assumption that runtime `owner_only` is authoritative for attached rolls. Update normalized roll DTO composition, HTTP schemas, generated client contracts, `character_rolls` audience constraint and persistence together. Store original campaign/placement scope and actor with every roll. Commit character result, roll, campaign activity reference and idempotency outcome atomically.

Activity rows reference the source content/roll/placement with relational selectors. Do not copy private action inputs, roll bindings, note bodies or sheet state into a broadly visible event. On every activity/session/export read, apply current membership and source visibility, including grant removal and content deletion. A roll's detailed bindings/inputs are returned only under its own audience policy, not merely because the caller can read the sheet. A returned character must not break authorization of its historical campaign rolls: use the stored original campaign scope, not its current attachment.

### 4.3 Polling and export

Reads return campaign `revision` plus monotonic `accessRevision` for policy invalidation. Poll-on-view is sufficient; no websocket/SSE service is added. Authorize before evaluating cache validators: never return `304` to a revoked actor. Protected campaign responses use `Cache-Control: no-store`; no shared HTTP cache or service-worker campaign payload caching is introduced here. Responses identify policy scope so the future Player integration can purge on revocation/reconnect. This is backend invalidation metadata, not a claim that existing browsers can erase information while offline.

Campaign export is a bounded synchronous, versioned JSON projection for owner/co-GMs, using the same visibility policy as reads. Owner-only notes and actor-private rolls of other members are omitted, not exposed through an administrative export bypass. Exclude credentials, token hashes, account secrets and private receipts. Use a consistent authorized snapshot and deterministic ordering; reject above configured export limits without partial output. Audit metadata has stable event IDs, not a copy of every secret payload. Sheet exports while attached contain only permitted current sheet data and no pre-adoption personal history.

## 5. Invitation protocol

- Issue uses 256-bit server randomness, stores only SHA-256 token hash, explicit intended role, expiry, revision and issuer. Plaintext token exists only in memory and the initial successful response. Redact token-bearing bodies/URLs and hashes from logs; review/accept/decline take tokens in POST bodies, not query strings.
- The issue receipt stores invitation ID and non-secret metadata, never token bytes or the full initial response. Same-key replay returns that metadata with `tokenUnavailable: true`; no new token is generated. This is the documented exception to byte-identical response replay, while still guaranteeing no duplicate creation.
- If the initial response is lost, retrieve the invitation ID via same-key replay or authorized listing and explicitly rotate with a new idempotency key and expected invitation/campaign revisions. Rotation replaces the hash atomically, invalidates the old link, and returns a new token once. Retrying rotation gives non-secret metadata; another lost response requires another explicit rotation. No deterministic token recovery or encrypted token storage is introduced.
- Review requires sign-in and a valid token. It returns only campaign identity, pinned version, inviter display name, intended role, expiry, invitation revision, disclosed policies and their access revision. No roster, content or sheet data leaks. Accept/decline includes token, campaign ID, expected invitation revision and reviewed access revision; changed invitation or access revision requires re-review before consuming the token. Consumption does not require the administrative campaign revision unavailable to a prospective member.
- Tokens are single-use globally, not once per actor. Lock campaign then invitation; compare against the current hash and check state/expiry. Exactly one actor can accept or decline. Record consumed state, actor and accepted membership generation. Decline consumes the token and creates no membership. An already-active member cannot use a token to elevate their role; return a definite error without consuming it.
- Replaying acceptance may confirm the original outcome only while the same membership generation remains active. It never recreates membership after removal, rejoin, or expiry of the command receipt. Another actor, revoked/rotated/expired token or removed acceptance recipient receives a generic unavailable response without campaign data. An expired invitation does not revoke a membership already validly accepted; current membership gates replay.
- Owner/co-GM revoke is idempotent and prevents future consumption. Revoking an already-consumed invite does not remove membership; that requires the explicit member-removal command. Rate-limit issue, review and consumption; validate configured expiry and request-size limits.

## 6. Persistence and transactional rules

Use relational selectors for all authorization, ownership, audience and lifecycle decisions. Do not hide these in `settings_json` or arbitrary permissions JSON.

| Record | Required additions / invariants |
| --- | --- |
| `campaigns` | Owner, name/description, immutable version FK, active/archived state, revision, access revision, disclosed fixed GM-sheet policy, roll audience default, timestamps |
| `campaign_members` | Composite campaign/user key, owner/co-GM/player role, active/removed state, membership generation; owner invariant |
| `invitations` | Hash unique, campaign FK, intended role, expiry, pending/accepted/declined/revoked state, revision, consuming actor/generation; no token in receipt |
| `characters` | Nullable standalone owner, nullable campaign FK, exactly one ownership scope, character revision and placement generation; preserve all existing standalone rows |
| `character_placements` | Character, generation, original campaign and optional immutable return owner, start/end; retains historical scope |
| `character_controllers` / claim designations | Character and same-campaign active membership FK; unique controller pairs; return-owner invariant |
| `content_items` / grants | Campaign, creator, audience, revision, soft-delete timestamps, bounded text/tags; grants target membership in same campaign |
| Existing rolls/activity/executions/migration history | Original standalone/campaign placement scope and actor; audience constraints widened only for campaign records |
| Campaign activity/audit | Stable event ID, campaign, actor, source references, audience selectors, timestamp, request ID; request ID is correlation, not a uniqueness rule for all events in one command |

Migrations backfill existing characters/history as standalone scope without changing IDs or package bytes. Validate CHECK/FK constraints on the ownership union. Index membership-scoped character/content queries and `(campaign_id, occurred_at, id)` activity pagination. No outbox table is added.

All mutations require an idempotency key under existing retention/uncertain-outcome conventions. Resource mutations require expected revision. Member/role/placement mutations use `expectedCampaignRevision`; content uses `expectedContentRevision`; administrative invitation rotation/revoke uses invitation and campaign revisions; invitation issue uses campaign revision; character placement additionally uses `expectedCharacterRevision`. Invitation accept/decline instead uses the invitation revision and reviewed access revision returned by review, never an arbitrary client role. Review is read-only and needs no mutation precondition. Campaign create has no target revision. Missing preconditions fail decoding rather than becoming blind writes.

Consistent lock order: campaign, invitations/content as needed, characters ordered by ID. Membership and controller/grant changes take the campaign lock and advance campaign/access revision. Sheet commands take that same campaign lock before their final character lock and authorization recheck, but do not advance campaign revision for ordinary sheet edits. Standalone commands recheck placement after locking; if adoption changed it, abort/retry through the correct lock order rather than acquiring a campaign lock after a character lock. Departure locks all affected characters in ID order. Policy reads and protected payload selection share a consistent database snapshot. Reads overlapping revocation may linearize before it; reads begun after committed revocation must deny.

Content/grant changes lock campaign then content, check expected revision, and advance content/access revisions atomically. Return, membership removal, controller cleanup, audit and receipt are all-or-nothing. Bound campaign/member/character counts and request sizes through configuration so a departure cannot require an unbounded transaction; load-test at those supported limits. Conflicts return non-sensitive summaries only after current authorization succeeds. No success is returned for a partially completed departure.

## 7. Idempotency, replay and recovery

Scope keys by actor, operation and target; hash normalized input including preconditions, requested audience and acknowledgement. Same input does not execute twice; changed input is `idempotency_mismatch`. Keep execution identity and dice deterministic across retry using the current Characters execution mechanism.

Before returning any saved result, reauthorize its original resource, audience and placement scope. This applies to existing Characters replay/recovery, exports, migration results and new Campaigns commands. A current right to the returned standalone character is not permission to read campaign-era receipts. Removed users get generic denial for campaign payloads. When an otherwise-authorized result no longer has the same policy/placement generation, return a documented non-sensitive `result_unavailable` outcome rather than replaying stale state or re-executing the command. A mutation already committed stays committed even when its original result can no longer be disclosed.

Failure memoization differs by path: placement transactions roll back pending idempotency rows on failure (a changed-input retry claims fresh, never `idempotency_mismatch`), while Characters commands finalize errors into receipts (a changed-input retry is `idempotency_mismatch`).

Invitation issue/rotation uses the non-secret replay exception in Section 5. Successful leave/removal can replay a minimal own-command acknowledgement without fetching campaign data or recreating side effects. Acceptance replay additionally checks consumed-token actor and original membership generation. Cache validators, conflicts, command-status endpoints and download responses cannot bypass these checks. Tests must exercise the existing early-replay paths before any owner-only lookup.

## 8. Complete HTTP surface

Every row maps to owning Module methods with typed input/output, preconditions from Section 6, idempotency on mutations, stable error codes and generated OpenAPI/client contracts. Avoid an illustrative interface with missing inputs; the following is the required operation inventory.

| Area | Operations under `/api` |
| --- | --- |
| Campaigns | `POST/GET /campaigns`; `GET/PATCH /campaigns/{id}`; `POST /campaigns/{id}/archive`; `POST /campaigns/{id}/recover` |
| Members | `GET /campaigns/{id}/members`; `PATCH /campaigns/{id}/members/{userId}` for role; `DELETE /campaigns/{id}/members/{userId}` for removal/self-leave |
| Invitations | `POST/GET /campaigns/{id}/invitations`; `POST /campaigns/{id}/invitations/{inviteId}/rotate`; `POST /campaigns/{id}/invitations/{inviteId}/revoke`; `POST /invitations/review`, `/invitations/accept`, `/invitations/decline` |
| Placement | `GET/POST /campaigns/{id}/characters`; `POST /campaigns/{id}/characters/{characterId}/assign` (controllers and claimant designation); `/claim`; `/adopt` |
| Content | `GET/POST /campaigns/{id}/content`; `GET/PATCH/DELETE /content/{id}`; `POST /content/{id}/grants`; `POST /content/{id}/recover` |
| Activity/export | `GET /campaigns/{id}/activity`; `POST /campaigns/{id}/exports` |
| Existing Characters | Preserve routes, extend action audience and DTOs, enforce Sections 2-4 and 7 on every existing route |

The GM session-board endpoint/UI belongs to I7, not this backend acceptance slice. I6 supplies authorized bounded activity/content/character reads that it will compose through a deep Module operation later.

All lists use bounded cursor pagination with deterministic tie-breaking: activity `(occurred_at,id)`, other lists `(created_at,id)` or the documented composite membership key. Apply authorization before pagination; limits/cursors never expose unauthorized counts. Scope and validate cursors to actor/query/campaign, reauthorize every page and prevent cross-scope cursor use. Reads return current revisions without embedding unbounded rosters or content in campaign metadata. Invalid inaccessible IDs collapse to `not_found`; invitation failures do not distinguish unknown/revoked/expired tokens. No token-bearing GET endpoints or debug-only provisioning API.

## 9. Implementation sequence and evidence gates

1. Write the authorization and ownership contract matrix, including all existing Characters routes and receipt/recovery paths. Reproduce standalone replay ordering risks with regression tests before modifying implementation.
2. Add relational ownership/history migrations and the internal policy/placement seam. Verify existing standalone integration/offline tests still pass and attached access cannot use owner-only shortcuts.
3. Implement campaign membership, owner protections, revision/lock ordering, archive/recovery and bounded lists. Verify concurrent removal versus edit/adopt/claim and rollback on injected failures.
4. Implement token review/issue/rotation/accept/decline/revoke and documented secret-free replay. Test two-actor consumption races, lost responses, policy-change re-review, rejoin generations and receipt/log secret scans.
5. Implement campaign character create/controllers/claim/adopt/return and exact-version rules. Test current-state return, multiple controllers, archived departure, pre-attachment migration previews and stale queued commands after detach.
6. Implement content/grants, campaign roll audience integration, source-filtered activity, export and invalidation metadata. Regenerate contracts together with database/DTO changes, not as a later patch.
7. Run PostgreSQL DOR/policy/concurrency/idempotency suites, thin HTTP contracts, existing frontend type/tests and production offline regressions affected by Characters changes. Run four-player bursts and departure-at-supported-limit load checks under existing latency budgets. Record actual commands/results; unrun gates remain open.

Required security scenarios include removed member/outsider versus every endpoint; ordinary character URL/transfer/duplicate/export/recovery bypass attempts; own returned sheet versus inaccessible campaign history; owner-only note and private roll exclusion from GM exports; visibility narrowing after cursor issuance; replay after removal and rejoin; `304` after revocation; last-owner protection; conflicting grants; cross-campaign assignments and guesses; second actor accepting a consumed invite; lost issue/rotation responses containing no durable plaintext; campaign pin mismatch and attached migration denial.

## 10. HTTP acceptance demonstration

Provision a campaign, review and accept an invitation as another actor, create/claim a campaign character and adopt an exact-version personal character with the return disclosure. Exercise shared controllers and all content/roll audiences through ordinary HTTP. Remove the player while a write races: either the authorized write commits before departure and its current state returns, or it is denied/conflicted afterward; never partial return or silent overwrite.

Verify campaign-created sheets stay in the campaign and become inaccessible to the removed player. Verify the adopted character returns with its current sheet and version to its original owner, while former controllers/GMs lose live access and campaign-private history stays inaccessible through every personal read/export/replay path. Confirm expired/replayed invitations cannot restore membership, every audience-filtered list/export is safe, and no public API bypasses the owning policy.

## 11. Review-gap closure and authority reconciliation

| Review finding | Required resolution |
| --- | --- |
| Existing character authorization and missing ownership | Sections 2-3, 6; full endpoint matrix and return exception |
| Replay after revocation | Sections 5, 7; current policy and original placement checks |
| Campaign-visible roll contract mismatch | Section 4.2; storage/runtime composition/HTTP/generated types together |
| Token retry contradiction | Section 5; metadata-only replay and explicit rotation |
| Missing security concurrency model | Section 6; aggregate revisions, shared locks and owner protection |
| Adoption compatibility/migration ambiguity | Section 3.4; exact pin, no attached independent migration |
| Missing workflow endpoints | Section 8; review/decline/lists/read/delete/recovery inventory |
| Design authority drift | `design_v2.md` Sections 12, 17.8, 18; token-only deferral and disclosed ownership policy |

No acceptance checkbox is closed by this document. UI cache purge, offline campaign policy integration, production-provider validation, real devices and G9 release evidence remain with their owning increments. The standalone offline contract remains intact; future campaign caching must explicitly handle membership/placement boundaries rather than treating this backend spec as permission to persist campaign secrets indefinitely.
