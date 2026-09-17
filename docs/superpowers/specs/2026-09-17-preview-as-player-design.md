# Preview-as-player design (content slice, 2026-09-17)

Owner-approved scope (2026-09-17): content list + reader only; specific
member target; dedicated GM-only read-only endpoint. Full campaign,
generic least-privilege view, audit logging, and offline preview are out.

## Authority

- `design_v2.md` §4.1: every visibility control offers a preview-as-player check.
- `design_v2.md` §9.1: preview uses the same policy engine as real
  requests, never a UI-only approximation.
- `design_v2.md` §17 I7 task 4: preview-as-player using the production
  Campaigns Module policy implementation.

## Endpoint

`POST /campaigns/:id/content-preview`, body `{ targetUserId: <uuid>,
contentId?: <uuid> }`, operation id `post_campaigns_id_content_preview`.

- Caller must be an active GM (`owner`/`co_gm`) of the campaign, else 403
  (signed-out 401 via the existing auth hook — no new auth machinery).
- Target must be an active member of the same campaign, else 404. The
  target's membership record feeds the existing `canReadContent`
  (`src/campaigns/policy.ts`) evaluation — no parallel policy logic.
- Without `contentId`: projected content list rows in the existing list
  shape (same fields the member's real list returns). With `contentId`:
  the single projected reader item, or the same 404 the real reader
  returns when the target cannot read it. A GM caller learns nothing new:
  they can already read everything.
- Read-only by construction: no idempotency key, no mutation path accepts
  a preview identity, ever.
- Precedent: `post_campaigns_id_upgrade_previews` (read-only preview kept
  out of existing routes). Contracts regenerated via
  `npm run contracts:generate` + `npm run contracts:check`
  (`docs/contracts/openapi-v1.json`, `web/src/api/schema.d.ts`).

## UI (Content tab, GM-only)

- A "Preview as" member select (active members only) in the Content tab.
  Selecting a member enters preview mode: a persistent banner
  ("Previewing as {displayName} — read-only"), list + reader rendered from
  preview queries, all mutating controls (author/edit/hide/reveal/grants)
  hidden.
- Exit restores the GM view. Preview is ephemeral UI state, not a route
  (no deep links). Preview queries live under
  `["campaigns", "preview", campaignId, targetUserId]` and are purged on
  exit/unmount — preview data never enters GM content cache keys.
- Mid-preview removal of the target (or any preview fetch failure)
  surfaces an error state and purges preview data.

## Acceptance bar

- Contract/matrix: GM 200 / member 403 / signed-out 401 / unknown
  campaign 404 / non-member target 404 / removed target 404.
- Parity: preview rows equal the target member's real rows (same test
  fixtures, volatile fields excluded and named).
- UI unit: banner visible, exit restores, no mutation affordance present in
  preview, preview cache purged on exit.
- Two-user e2e: GM preview matches the member's own view; exit restores;
  removed-target error path.
- GUI plan G7 box checked only with the acceptance record linked.
