# Campaign Backend — Design (I6 backend only)

**Status:** Draft — pending user review of this file before implementation planning.
**Date:** 2026-09-09.
**Design authority:** `design_v2.md` §§12, 13, 17.8; GUI plan G7 backend portion.
**Slice:** I6 backend only (Approach A). No Player campaign UI, no GM app, no outbox/email worker.

## 1. Purpose

Implement the I6 campaign collaboration HTTP interface so campaigns can be provisioned, joined, played, and revoked through documented endpoints with server-enforced authorization. An invited player can later (I6 player integration) join and participate through the Player app; this slice proves every workflow over HTTP without UI.

Decisions locked for this slice:

- **OD-02 resolved as default-yes, disclosed:** GMs see full character state by default in campaigns they manage. The campaign `settings_json` records `gmSeesFullState: true`, and join/claim responses disclose it. A per-campaign toggle is supported but defaults to yes; deny-by-default applies to everything else.
- **Invitations are token-only, no outbox:** invite creation generates a high-entropy token, stores only its hash, and returns the plaintext once in the command response. No `outbox_events` table and no email delivery exist in this slice. This defers `design_v2.md` §17.8 backend task 2 (outbox + email) and requires the design delta in §11 below.

## 2. Scope

### In scope

- `src/campaigns/` Module: one deep `Campaigns` interface owning authorization, transactions, revision checks, idempotency, and audit/activity writes.
- Relational persistence: `campaigns`, `campaign_members`, `invitations`, `content_items`, `content_grants`, `activity_events`, campaign export; `characters` extension with nullable `campaign_id` plus claim/adopt flow that never implicitly re-pins the character version.
- Documented HTTP endpoints for campaign create/read/update/archive, member and co-GM management, invitation issue/accept/decline/revoke, campaign policy configuration, character campaign create/assign/claim/adopt, text content CRUD with audiences and grants, session-board read, campaign activity reads, and campaign export.
- Campaign and character policy decisions for read, edit, roll audience, and GM visibility, implemented once in `src/campaigns/policy.ts` for reuse by all future callers including preview-as-player.
- Revision concurrency, idempotency keys, DOR/matrix/concurrency/revocation/export/load tests against real PostgreSQL.

### Out of scope

- Transactional outbox and invitation email delivery (deferred to an I6 follow-up; see §11).
- All Player campaign UI (invitation review screens, campaign list/navigation, claim UX, content rendering, activity feeds) and all GM app UI (creation wizard, session board UI, reveal controls, upgrade preview UI). Those consume this interface in later slices.
- Images, scenes, fog, tokens, restricted display pairing (I7b/G8).
- System-version upgrade preview/commit command (I7 task 9); publishing alone never upgrades a campaign or character.
- Public campaign discovery, search, marketplace, moderation, payments, video/voice, tactical rules.

## 3. Core decisions

### 3.1 One owning Module

A single `Campaigns` Module owns campaign workflows the way `Characters` owns character workflows. The HTTP adapter decodes one request, calls one `Campaigns` method, and maps the result. It never coordinates repositories, evaluates policy, or orders transactions itself. `policy.ts` is the only place that decides membership, role, audience, and GM-visibility questions.

### 3.2 Explicit relational authorization columns

Identifiers, ownership, membership, roles, visibility/audience selectors, versions, and timestamps live in relational columns and indexes. Creator-defined shapes stay in JSONB (`settings_json`, character `state_json`). Authorization queries are scoped joins with deny-by-default; no policy is enforced only in the client.

### 3.3 Token-only invitations

`POST .../invitations` generates 256-bit entropy with `crypto.randomBytes`, stores `SHA-256(token)` plus `intended_role`, `expires_at`, and `revoked_at`, and returns the plaintext token exactly once. `accept` compares hashes in constant time, checks expiry/revocation/membership, and inserts membership atomically. Plaintext tokens never persist; logs store only truncated hashes. Email delivery is a later consumer of an explicit accept-token handoff, not part of this slice.

### 3.4 Characters keep their pin

Campaign assignment, claiming, and standalone-to-campaign adoption set `campaign_id` and ownership without changing `system_version_id`. Migration remains an explicit separate command owned by Characters. A campaign pins one immutable system version at creation; characters created inside it inherit that pin.

### 3.5 Poll-on-view reads

Session-board and activity reads are revision-stamped snapshots (`revision`, `occurred_at` cursors). Clients refresh on view activation. No websocket, SSE, or broadcast channel exists in this slice, and activity payloads never carry secret content to mixed audiences.

## 4. Module interface

```ts
export interface Campaigns {
  createCampaign(ctx: RequestContext, input: CreateCampaignInput): Promise<Result<CampaignView>>;
  getCampaign(ctx: RequestContext, campaignId: CampaignId): Promise<Result<CampaignView>>;
  patchCampaign(ctx: RequestContext, campaignId: CampaignId, input: PatchCampaignInput): Promise<Result<CampaignView>>;
  archiveCampaign(ctx: RequestContext, campaignId: CampaignId, input: RevisionInput): Promise<Result<CampaignView>>;

  updateMember(ctx: RequestContext, campaignId: CampaignId, memberId: UserId, input: MemberUpdate): Promise<Result<MemberView>>;
  removeMember(ctx: RequestContext, campaignId: CampaignId, memberId: UserId): Promise<Result<void>>;

  issueInvitation(ctx: RequestContext, campaignId: CampaignId, input: IssueInviteInput): Promise<Result<IssuedInvite>>;
  acceptInvitation(ctx: RequestContext, input: AcceptInviteInput): Promise<Result<MembershipView>>;
  revokeInvitation(ctx: RequestContext, campaignId: CampaignId, invitationId: InvitationId): Promise<Result<void>>;

  createCampaignCharacter(ctx: RequestContext, campaignId: CampaignId, input: CampaignCharacterInput): Promise<Result<CharacterView>>;
  assignCharacter(ctx: RequestContext, campaignId: CampaignId, characterId: CharacterId, input: AssignInput): Promise<Result<CharacterView>>;
  claimCharacter(ctx: RequestContext, campaignId: CampaignId, characterId: CharacterId): Promise<Result<CharacterView>>;
  adoptStandalone(ctx: RequestContext, campaignId: CampaignId, characterId: CharacterId): Promise<Result<CharacterView>>;

  postContent(ctx: RequestContext, campaignId: CampaignId, input: ContentInput): Promise<Result<ContentView>>;
  patchContent(ctx: RequestContext, contentId: ContentId, input: ContentPatch): Promise<Result<ContentView>>;
  grantContent(ctx: RequestContext, contentId: ContentId, input: GrantInput): Promise<Result<ContentView>>;

  getSession(ctx: RequestContext, campaignId: CampaignId): Promise<Result<SessionSnapshot>>;
  getActivity(ctx: RequestContext, campaignId: CampaignId, input: ActivityQuery): Promise<Result<ActivityPage>>;
  exportCampaign(ctx: RequestContext, campaignId: CampaignId): Promise<Result<CampaignExport>>;
}
```

All mutating inputs carry `expectedRevision` where the target is revisioned and `idempotencyKey` where retry risk exists (create, invite, content, assign/claim/adopt, export). Results include the new revision and request ID.

## 5. Persistence

New migrations under the existing migration chain:

- `campaigns(id PK, system_version_id FK → immutable versions, owner_id FK, settings_json JSONB, status, revision INT, created_at, archived_at NULL)`. Index on `(owner_id, status)`.
- `campaign_members(campaign_id, user_id, role: gm/co-gm/player, status: active/removed, joined_at, permissions_override JSONB NULL, PRIMARY KEY (campaign_id, user_id))`. Index on `(user_id, status)`.
- `invitations(id PK, campaign_id FK, token_hash BYTEA UNIQUE, intended_role, expires_at, revoked_at NULL, accepted_by NULL, created_by, created_at)`. Index on `(campaign_id, revoked_at, expires_at)`.
- `content_items(id PK, campaign_id FK, creator_id, kind: note/handout/recap, title, body TEXT, audience: gm-only/all/selected/owner-only, revision INT, created_at, updated_at)`. Index on `(campaign_id, audience)`.
- `content_grants(content_id FK, member_id FK → users, PRIMARY KEY (content_id, member_id))`.
- `activity_events(id PK, campaign_id FK, actor_id, type, audience, payload JSONB minimal, occurred_at, request_id UNIQUE)`. Index on `(campaign_id, occurred_at DESC)`.
- `characters` alteration: `campaign_id FK NULL`, with a partial index on `(campaign_id) WHERE campaign_id IS NOT NULL`. Existing `owner_id`, `visibility`, `revision` semantics unchanged.

`settings_json` shape v1: `{ gmSeesFullState: true, rollAudienceDefault: "campaign" | "gm-only" | "private", contentDefault: "all" | "gm-only" }`. Unknown keys are rejected.

## 6. HTTP interface

All under `/api`, versioned with the existing OpenAPI document:

| Area | Endpoints |
|---|---|
| Campaigns | `POST /campaigns`; `GET /campaigns/{id}`; `PATCH /campaigns/{id}`; `POST /campaigns/{id}/archive` |
| Members | `PATCH /campaigns/{id}/members/{memberId}` (role/status, GM-only); `DELETE /campaigns/{id}/members/{memberId}` (remove/leave) |
| Invitations | `POST /campaigns/{id}/invitations`; `POST /invitations/accept` (`{token}`); `POST /invitations/{id}/revoke` |
| Characters | `POST /campaigns/{id}/characters`; `POST /campaigns/{id}/characters/{cid}/assign`; `POST /campaigns/{id}/characters/{cid}/claim`; `POST /campaigns/{id}/characters/{cid}/adopt` |
| Content | `POST /campaigns/{id}/content`; `PATCH /content/{id}`; `POST /content/{id}/grants` (`{memberIds}`) |
| Session/activity | `GET /campaigns/{id}/session`; `GET /campaigns/{id}/activity?cursor&limit` |
| Exports | `POST /campaigns/{id}/exports` |

Cursor pagination is required on activity and member/content lists. Every error carries a stable code, human message, request ID, and optional field paths. Inaccessible resources collapse to `not_found` unless existence disclosure is intentional (invitation accept uses a generic invalid/expired response that does not distinguish unknown from revoked).

## 7. Authorization policy

- Every operation resolves the resource first, then evaluates the actor in `policy.ts`. Client-provided roles are never trusted.
- Campaign create requires access to a published system version (owner or `public`/`link` for a known version ID, mirroring character creation).
- Member management, invitation issue/revoke, content audience changes, settings, archive, and export require GM or co-GM with active membership. Joining requires a valid unexpired unrevoked token plus campaign confirmation semantics (accept is explicit, never automatic on link open).
- Content reads scope by audience: `gm-only` to active GMs; `all` to active members; `selected` to grant holders plus GMs; `owner-only` to the creator plus GMs only when `gmSeesFullState` is true (it defaults true and the response discloses it).
- Character reads inside a campaign follow campaign policy plus character ownership; GM full-state visibility is disclosed, audited, and never extends to system creators outside the campaign.
- Revocation (member removal, grant removal, invitation revoke, content audience narrowing) takes effect on the next authorized read and its tests assert both HTTP denial and absence from subsequent list/activity payloads.

## 8. Concurrency, idempotency, errors

- Mutable rows (`campaigns`, `content_items`) require `expectedRevision`; mismatch returns `409 conflict` with the latest revision and a non-sensitive summary.
- Idempotency keys are scoped to actor + endpoint + key with bounded retention; identical replay returns the stored result, differing input returns `idempotency_mismatch`.
- Invitation accept is idempotent per `(token_hash, accepted_by)`; concurrent accepts resolve to one membership.
- Character assign/claim/adopt lock the character row, recheck revision and campaign membership, then write; failures leave no partial membership or grant rows.
- Programmer/infrastructure failures log with request ID and map to sanitized `internal` / `temporarily_unavailable`.

## 9. Testing

Against real PostgreSQL plus thin HTTP-adapter tests (authn, wire decoding, status mapping, OpenAPI conformance):

- DOR tests for every campaign, character-in-campaign, content, invitation, and export endpoint (guessed IDs disclose nothing).
- Role/membership/audience matrix: gm/co-gm/player/removed/outsider × gm-only/all/selected/owner-only × GM-visibility default-yes disclosed.
- Invitation expiry, replay, revoke, concurrent-accept (one membership), and generic accept-failure responses.
- Concurrent member update, content patch, and grant races (revision conflict, no silent merge).
- Standalone adopt plus claim flows preserving the character pin; publishing a new system version changes nothing pinned.
- Campaign export determinism (byte-stable ordering, no account secrets) and four-player session-burst load within existing latency budgets.

## 10. Acceptance demonstration (HTTP-only, no UI)

Provision a campaign and invitation through the documented HTTP interface; accept as a second actor; create and claim campaign characters; post gm-only, all-player, and selected content; make a campaign-visible roll through the existing Characters action path; verify unauthorized, revoked, and guessed-ID callers are denied; verify member removal cuts HTTP access and subsequent list/activity payloads contain no revoked data.

## 11. Design delta to record in `design_v2.md`

- §17.8 backend task 2: mark outbox + email delivery as deferred to an I6 follow-up; this slice ships token-only invitations with no `outbox_events` writes.
- §12 tables: mark `outbox_events` as not yet introduced (first consumer deferred with email).
- §18 OD-02: record resolved as disclosed default-yes for I6 (`gmSeesFullState: true` default, disclosed at join/claim).
- No change to I7/I7b scope, offline contract, grammar v0.1, or published-package immutability.

## 12. Risks and limits

- Token distribution is out-of-band in this slice (returned once in the command response); phishing/abuse controls beyond entropy/hash/expiry live with the future delivery channel.
- Activity reads are polling snapshots; simultaneous-GM conflict UX and cache-invalidation signals for installed clients arrive with the Player/GM UI slices.
- Four-player burst load validates the backend path only; installed-PWA and real-device behavior remain G9 gates.
