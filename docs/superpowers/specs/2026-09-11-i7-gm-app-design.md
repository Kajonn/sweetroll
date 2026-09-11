# I7 GM App Design

Date: 2026-09-11. Status: approved spec, pre-implementation.
Authority: `design_v2.md` §17.9 (tasks 1–10), §13 cursor/idempotency/revision
rules; GUI plan `docs/superpowers/plans/2026-09-08-gui-integration.md` G7 GM
boxes. Backend contract source: `src/transport/http/campaigns.ts:503-936`.
Prior slice: G7 player campaign UI (`docs/acceptance/gui-2026-09-11-g7-player.md`).

## Goal

A GM can create and run a secure campaign from the shared responsive PWA —
on a phone, installed PWA, or desktop — reusing the I4a components and the
I6 owning-Module authorization contracts. No separate native client, no
second character renderer, no second design system.

## Constraints

- One deployable artifact; no package-format change.
- All campaign reads/writes go through `ApiClient` (`credentials:include`,
  `x-request-id`, JSON bodies even for DELETEs); invitation tokens travel in
  POST bodies only, never URLs.
- Every mutation sends a caller-minted `idempotencyKey` (UUID); after any
  `409`, re-read then mint a fresh key — never reuse.
- `409 conflict` carries `latestRevision`; surface explicit retry/reload,
  never "Merge".
- Query keys always include actor + generation
  (`["campaigns", ..., actorId, generation, ...]`); `enabled` requires
  `actorId !== null && online`; sign-out/account-switch relies on AppShell
  `cancelQueries/removeQueries` + lifetime remount `key=`.
- Shared controls (`Button, Panel, PageHeader, EmptyState, FormField`,
  `Select, Dialog, Tabs, Menu`) for all new surfaces; controls never decide
  authorization — server 404/409s render as unavailable/conflict states.
- `web/src/player/` stays campaign-free; all GM code lives in
  `web/src/campaigns/` plus `router.tsx` wiring and `AppShell` nav.
- TDD red-green per slice; `npm run contracts:check` stays green.

## Architecture and placement

All GM UI lives in `web/src/campaigns/` beside the player modules, wired
through `router.tsx` `*RouteView`s (identity guard → API seam → lifetime
`key=` → presentational view) plus `routeTree`, with `AppShell` nav entries
added together with their routes, never alone. Sheets reuse the existing
`CharacterDetail` session via `onOpenCharacter`. All frontend types derive
from `operations` in `web/src/api/schema.js`. `CampaignsApi` grows thin
wrappers only: `createCampaign`, `updateCampaign`, `archiveCampaign`,
`recoverCampaign`, `exportCampaign`, `listMembers`, `changeMemberRole`,
`removeMember`, `listInvitations`, `issueInvitation`, `rotateInvitation`,
`revokeInvitation`, `createContent`, `updateContent`, `replaceContentGrants`,
`deleteContent`, `recoverContent`.

The backend adds exactly one contract: a deep Campaigns Module upgrade
command with preview and commit operations. Preview is read-only and
side-effect-free (field mappings/defaults, warnings, affected characters,
before/after pin). Commit is a single revision-guarded call coordinating
migrations, the pin move, before/after audit, and rollback proof; the GM
caller never loops through characters, and publishing a new system version
never upgrades any campaign by itself. Until it lands, attached-character
migration stays denied as today.

The session board composes existing reads client-side (`GET content`,
`GET activity`, `GET characters`, plus character sheets) with
revision/ETag poll-on-view refresh; no session-board endpoint, no
websocket/SSE.

## Phase 1 — Setup and members (first)

- `CampaignCreate`: create from an accessible published system version (a
  shipped open-license template once launch-template licensing is settled,
  per §18.2) reusing the
  `metadataApi` creation-options loader pattern from the player
  character-creation flow; pinned-version display from first render.
- `CampaignSettings`: title/description edit, archive/recover, export;
  settings stay within what the backend exposes (title/description).
- `MemberList`: bounded roster, role/co-GM changes with explicit
  confirmation for security-sensitive changes (demotion, removal);
  owner protections mirror the backend matrix.
- `InvitationManager`: issue/rotate/revoke with metadata-only listing;
  lost-issue responses replay under the same key (metadata +
  `tokenUnavailable`), then explicit rotate with a new key.
- Exit e2e: create a campaign from the UI with no direct HTTP tools,
  invite and accept as a second actor, change a role, revoke an
  invitation.

## Phase 2 — Content and session

- `ContentEditor`: text authoring, audience grants, reveal/hide via
  soft-delete/recover, persistent audience markings on rows and reader.
- `SessionBoard`: pinned content, recent rolls/activity, quick character
  access, one-tap authorized resource bumps with optimistic status,
  idempotent retry, and immediate revision-conflict recovery.
- NPC/monster list pages `GET /campaigns/:id/characters` with
  client-side filtering and leads to the full-width sheet; no backend
  search endpoint.
- Disclosed GM character visibility (controller indicators), roll-audience
  controls executing through the existing sheet action-audience contract,
  and audit via the activity feed plus bounded export.
- Exit e2e: author and narrow content, drive the session board at phone
  viewport, bump a resource through a conflict.

## Phase 3 — Upgrade

- Backend deep upgrade command (preview + commit) per the Architecture
  section, with generated-contract updates and migration/audit tests.
- `UpgradeDialog`: preview warnings and before/after pin, explicit
  commit confirmation, isolation proof that another pinned campaign is
  unchanged.
- Exit e2e: preview then commit an upgrade without changing another
  pinned campaign.

## Phase 4 — Hardening

- Two-device/​co-GM operation through polling/revision refresh with
  clear conflict handling; no single-session lock.
- WCAG 2.2 AA review, responsive checks at phone/tablet/desktop,
  cross-campaign authorization tests, four-player session-burst load
  tests, SLO dashboards, alerting, backup-restoration drill, incident
  runbook exercise.

## Errors, conflicts, revocation

409 → re-read + explicit retry with a fresh key. 404 on
previously-readable data → purge campaign-scoped query keys, invalidate
the list, show an access-changed notice; revoked ids never mount.
Security-sensitive changes (role demotion, member removal, invitation
revoke, audience narrowing, upgrade commit) require confirmation dialogs.
Controls never decide authorization.

## Testing and acceptance

Per-phase exit e2e on real HTTP (Playwright, real database/server);
unit coverage for new API wrappers, hooks, and components; full web
suite + typecheck + contracts check green per phase.

Full acceptance demonstration: a GM creates a campaign from an accessible
published system (a shipped open-license template once launch-template
licensing is settled) without direct HTTP tools, invites four players,
manages visibility with persistent audience marks, runs the session
board from a phone while a second device shows content, resolves a
concurrent edit, and explicitly upgrades the campaign without changing
another pinned campaign. No mock-only screens count as completion.

## Explicitly out of this spec

- Preview-as-player: deferred to a later slice; this spec ships
  persistent audience marks only and designs no impersonation or
  `onBehalfOf` parameter.
- No new session-board, character-search, or policy-settings endpoints;
  no launch-template catalog (OD-08 stays deferred).
- Images, manual fog, tokens, and the restricted player display belong
  to I7b (GUI plan G8), not this spec.
- Production OIDC validation remains subject to the existing owner
  decision (dev/test auth only unless revisited).
