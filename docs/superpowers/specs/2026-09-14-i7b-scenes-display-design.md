# I7b Scenes & Restricted Display Design

Date: 2026-09-14. Status: approved spec (sections 1–4 reviewed in chat); implementation plan not yet written.
Authority: `design_v2.md` §§7.6–7.7, 17.9a; GUI plan `docs/superpowers/plans/2026-09-08-gui-integration.md` G8.
Prior slice: I7 GM app (`docs/superpowers/specs/2026-09-11-i7-gm-app-design.md`, Phases 1–3 landed).
Reconciliation: full I7b is specified here as one spec; the implementation plan may split it into
contracts-first / UI / display-shell tasks.

## Goal

A GM runs simple visual scenes from a phone while a separate tablet (or remote player) shows a
restricted display projection: background image, manually edited fog, and GM-positioned tokens —
with no GM secrets reachable on the display. No tactical grids, movement rules, initiative, vision,
dynamic lighting, or combat automation.

## Constraints

- One deployable artifact; no package-format change (scenes are campaign data, not system packages).
- All GM reads/writes go through `ApiClient` (`credentials:include`, `x-request-id`, JSON bodies);
  display reads use the display credential only.
- Every fog/token mutation sends a caller-minted `idempotencyKey`; after any `409`, re-read then
  mint a fresh key — never reuse, never guess `revision + 1`.
- `409 conflict` carries `latestRevision`; surface explicit retry/reload, never "Merge".
- Campaign web query keys always include actor + generation; `enabled` requires
  `actorId !== null && online`; display queries are keyed by display credential + scene revision.
- Shared controls for all new surfaces; controls never decide authorization.
- `web/src/player/` stays campaign-free and scene-free; GM scene code lives in
  `web/src/campaigns/`, the display shell in its own route module.
- Image bytes live on local disk (`data/media/<storage_key>`); Postgres holds metadata and scene
  rows. Compose gains a persisted media volume; no object-store service in this slice.
- Safe derivatives require real image decode/resize: this spec approves adding one image
  dependency (`sharp` recommended) with Dockerfile consequences.
- TDD red-green per slice; `npm run contracts:check` stays green.

## Architecture and placement

Campaigns owns the Module surface; no new top-level Module. Backend adds scene/media/display
commands plus two read projections. The session board composes existing reads; the display polls
`getDisplayProjection` on view (no websocket/SSE, no new session-board endpoint).

 GM UI lives in `web/src/campaigns/` beside the existing GM modules, wired through `router.tsx`
`*RouteView`s plus `routeTree`, with `AppShell` nav entries added together with their routes.
Sheets reuse the existing `CharacterDetail` session where monster sheets are opened. All frontend
types derive from `operations` in `web/src/api/schema.js`.

## Section 1 — Contracts & persistence

New Campaigns commands (GM/co-GM only unless noted):

- `uploadImage`: bounded bytes + magic-byte + dimension checks; stores original private on disk,
  metadata row (owner, campaign, media_type, size, dims, checksum). 413 over size, 422
  undecodable/over-dimension. Deletion removes bytes + derivatives.
- `createScene` / `updateScene`: background image ref, revision-guarded metadata edit.
- `applyFogEdit`: one mask op per call (reveal/conceal stroke), expected revision; stale → 409
  with `latestRevision`; concurrent strokes are never merged.
- `placeToken` / `moveToken` / `removeToken`: normalized 0–1 scene coordinates, size, visibility
  flag; revision-guarded.
- `pairDisplay`: mint single-use code (5-min TTL, campaign-scoped, hash stored).
- `redeemDisplayCode` / `revokeDisplay` / `listDisplayCredentials` (GM).
- `getDisplayProjection` (display credential): `{ sceneRevision, imageUrl, tokens[] }` —
  visible-and-revealed tokens only; fog-covered pixels absent from the derivative bytes.

Originals are served only on an authorized GM route with `Cache-Control: no-store` (never public
static URLs). Display derivatives are served on the display-credential route, cached by
auth+revision, purged on revocation. No service-worker persistence of campaign/display payloads.

## Section 2 — Pairing, display auth & projection

GM Campaign Settings → Display → `pairDisplay` shows a 6-character single-use code (5-min TTL).
The display route `/display` holds no GM session: entering the code calls `redeemDisplayCode`,
which first wipes campaign/GM query caches and in-flight results in that browser context, then
issues a revocable bearer display credential scoped to one campaign. The credential grants
`getDisplayProjection` only — no GM notes, sheets, members, settings, originals, or mutations.

GM Settings lists active display credentials with Revoke. Revocation kills the credential; the
display blanks on next poll and cached display bytes are purged. Back-nav/reload/error/reconnect
on `/display` revalidates before rendering; uncertain permission renders blank, never stale
privileged content. Cross-campaign credential use collapses to generic 404. Remote players use
the same code path.

As built, the display credential is a bearer secret held in `sessionStorage` and sent on display
reads via the `x-display-secret` header (never in URLs, except the `rev` cache key). Rationale:
header auth is CSRF-immune, tab-scoped storage clears with the session, and script access to the
secret is XSS-equivalent to the existing GM session cookie — no new exposure class. An
HttpOnly-cookie credential was considered and rejected: ambient cookie auth would reintroduce
CSRF-able requests on the shared display context the entry purge is designed to isolate.

## Section 3 — GM scene UI

- `SceneViewport`: fit/pan/zoom in normalized scene-space (phone/tablet agree); keyboard
  alternatives for every drag op (arrow-key nudge, +/- zoom, toolbar buttons).
- `FogToolbar`: reveal/conceal brush + size, local undo of the latest uncommitted stroke, commit
  per stroke with expected revision; 409 → re-read + explicit retry.
- `TokenTray`: scene token library (label + optional uploaded token image); tap-to-place /
  drag-to-move; per-token visibility toggle (hidden tokens never leave the server).
- Display status: pending/applied/offline per mutation via existing sync text; paired-display
  list + revoke. Offline GM edits queue with idempotent replay; the display itself is
  online-only (blank/reconnecting when stale).

Excluded: grids, measurement, initiative, vision, lighting automation, arbitrary drawing.

## Section 4 — Display shell, testing & acceptance

`/display` renders full-viewport scene image + visible tokens with no nav/GM chrome and calls no
GM endpoints. Poll failure or 404 → "Reconnecting…"/blank state.

- Module tests: authz matrix (incl. cross-campaign display rejection), 409 fog races,
  hidden-token omission byte-checked in projection responses, pairing TTL/single-use.
- HTTP tests: 401/404 collapse, 413/422, revocation behavior.
- Web unit: viewport/keyboard ops, fog undo, revocation blanking, cache purge on entry.
- Exit e2e on real HTTP: GM phone flow (upload → scene → reveal/conceal → place/move token →
  pair → revoke) with a second context as the display; network/storage/deep-link inspection
  proving no originals, hidden tokens, or GM data leak; remote-player repeat.
- Acceptance: the G8 exit demo (`design_v2.md` §17.9a), recorded in `docs/acceptance/`;
  real-device and production-auth gates stay explicitly open.

## Explicitly out of this spec

- Preview-as-player, launch-template catalog, policy-settings endpoints.
- Video/voice, tactical movement, dynamic lighting, marketplace, arbitrary scripting.
- Production OIDC validation (existing owner decision; dev/test auth unless revisited).
- Phase 4 hardening (two-device conflict proof, WCAG review, load tests, SLO/alerting,
  backup drill, runbook) — separate slice.
