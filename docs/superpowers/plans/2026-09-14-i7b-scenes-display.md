# I7b Scenes & Restricted Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A GM uploads images, composes fog/token scenes, and pairs a restricted display that shows only revealed pixels and visible tokens.

**Architecture:** Campaigns owns two new submodules (`media.ts`, `scenes.ts`) following the existing `content.ts`/`invitations.ts` command pattern, with rows in two new migrations. Originals stay private on local disk; per-revision redacted derivatives are composited server-side with `sharp`. The display polls a credential-scoped projection; pairing is a single-use short code redeemed on `/display`, which purges GM state on entry.

**Tech Stack:** PostgreSQL, Campaigns Module, Fastify/OpenAPI + TypeBox, generated TypeScript (`docs/contracts/openapi-v1.json`, `web/src/api/schema.d.ts`), React + TanStack Query, shared `web/src/ui/` controls, `sharp` for image decode/composite, Vitest, Playwright Chromium.

**Spec:** `docs/superpowers/specs/2026-09-14-i7b-scenes-display-design.md`; `design_v2.md` §§7.6–7.7, 17.9a; GUI plan G8.

## Global Constraints

- One deployable artifact; no package-format change; scenes are campaign data, never package data.
- All GM reads/writes go through `ApiClient` (`credentials:include`, `x-request-id`, JSON bodies even for DELETEs). Image bytes travel as bounded base64 in JSON (no multipart); decoded cap 5 MiB, dimension cap 4096 px, allow-list `image/png`, `image/jpeg`, `image/webp`.
- Every fog/token mutation sends a caller-minted `idempotencyKey` (UUID); after any `409`, re-read then mint a fresh key — never reuse.
- `409 conflict` carries `latestRevision`; surface explicit retry/reload, never "Merge".
- Query keys always include actor + generation (`["campaigns", ..., actorId, generation, ...]`); `enabled` requires `actorId !== null && online`; sign-out/account-switch relies on AppShell `cancelQueries/removeQueries` + lifetime remount `key=`.
- Shared controls for all new surfaces; controls never decide authorization — server 404/409s render as unavailable/conflict states.
- No `campaign`/`scene` string in `web/src/player/` — GM code in `web/src/campaigns/`, display shell in `web/src/display/`.
- TDD red-green per task; `npm run contracts:check` stays green (contracts regenerated in Task 4).
- New i18n keys ship in the same task as the component that uses them.
- Migrations are immutable, lexical-order files each running in its own transaction; never edit an applied file.

---

## File map

| File | Responsibility |
| --- | --- |
| `migrations/0018_campaign_media.sql` (create) | `media_files` table (owner, campaign, media_type, size, dims, checksum, storage_key) |
| `migrations/0019_campaign_scenes.sql` (create) | `scenes` table (background ref, revision, fog mask, token records as JSONB + revision) |
| `migrations/0020_display_credentials.sql` (create) | `display_codes` (single-use, TTL) + `display_credentials` (campaign-scoped, revocable) |
| `src/campaigns/media.ts` (create) | `uploadImage`, `deleteImage`, storage helpers (disk layout, sharp validation) |
| `src/campaigns/scenes.ts` (create) | `createScene`, `updateScene`, `applyFogEdit`, `placeToken`, `moveToken`, `removeToken` |
| `src/campaigns/display.ts` (create) | `pairDisplay`, `redeemDisplayCode`, `revokeDisplay`, `getDisplayProjection` (+ redaction) |
| `src/campaigns/index.ts` (modify) | Wire the three submodules into the `Campaigns` interface |
| `src/campaigns/persistence.ts` (modify) | Repos used inside the caller's transaction |
| `src/transport/http/campaigns.ts` (modify) | Media/scene/display routes + validation/mapping |
| `src/transport/http/campaigns.test.ts` (modify) | Transport tests for the new routes |
| `src/transport/http/openapi.test.ts` (modify) | New paths in the conformance list |
| `tests/integration/campaign-scenes.test.ts` (create) | Module matrix: auth, revisions, fog races, token visibility, pairing |
| `docs/contracts/openapi-v1.json`, `web/src/api/schema.d.ts` (regenerate) | New operations (Task 4 runs `contracts:generate`) |
| `web/src/campaigns/types.ts` (modify) | Derived scene/display types from `operations` |
| `web/src/campaigns/api.ts`, `api.test.ts` (modify) | Thin wrappers + serialization tests |
| `web/src/campaigns/campaignQueries.ts`, `campaignQueries.test.tsx` (modify) | Actor/generation-scoped scene/projection queries |
| `web/src/campaigns/SceneViewport.tsx`, `FogToolbar.tsx`, `TokenTray.tsx` (create) | GM scene UI |
| `web/src/campaigns/CampaignSettings.tsx` (modify) | GM Display pairing section |
| `web/src/display/DisplayView.tsx` (create) | Restricted display shell on `/display` |
| `web/src/router.tsx` (modify) | Scene + display routes |
| `web/src/i18n/messages.ts` (modify) | `campaign.detail.scenes.*` + `display.*` keys with their tasks |
| `web/tests/e2e/sceneDisplayJourney.spec.ts` (create) | Exit e2e: GM phone flow + display proof + revoke |
| `docs/acceptance/gui-2026-09-14-i7b-scenes.md` (create) | Acceptance record |

---

### Task 1: Media storage foundation + upload/delete commands

**Files:**
- Modify: `package.json` (add `sharp`), `Dockerfile` + `compose.yaml` (persisted `data/media` volume), `.dockerignore`/`.gitignore` (exclude `data/media/*` bytes)
- Create: `migrations/0018_campaign_media.sql`
- Create: `src/campaigns/media.ts`
- Modify: `src/campaigns/index.ts` (wire `uploadImage`/`deleteImage`)
- Modify: `src/campaigns/persistence.ts` (media file repo)
- Create: `tests/integration/campaign-scenes.test.ts` (media block only)

**Interfaces:**
- Consumes: `canManageCampaign` (`src/campaigns/policy.ts`); `RequestContext` (`src/systems/authoring.ts`); existing `Result` envelope.
- Produces (used by Tasks 2–4):

```ts
// src/campaigns/media.ts (added)
export type UploadImageInput = {
  campaignId: string;
  name: string;
  contentType: "image/png" | "image/jpeg" | "image/webp";
  dataBase64: string; // decoded cap 5 MiB enforced server-side
  idempotencyKey: string;
};
export type MediaFileView = {
  fileId: string;
  campaignId: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
  width: number;
  height: number;
  checksum: string;
  revision: number;
};
```

`Campaigns.uploadImage(ctx, input)` validates membership + GM role (`canManageCampaign`, else generic `not_found`), decodes base64 (reject over 5 MiB with `too_large`), verifies magic bytes + `sharp` metadata (reject mismatch/over 4096 px/undecodable with `unprocessable`), writes bytes to `data/media/<storage_key>` (random UUID filename), inserts the metadata row, and returns `MediaFileView`. `deleteImage` removes bytes + row (revision-guarded, idempotent replay on key reuse). Originals are never served by any static route in this task.

- [ ] **Step 1: Write the failing media tests.** In `tests/integration/campaign-scenes.test.ts`, reuse `buildI6Harness`, `ctxFor` (mirror `campaign-placement.test.ts`): GM uploads a 1×1 PNG fixture (inline base64), asserts dimensions echoed; player upload denied (generic 404); oversized/over-dimension/bad-magic rejected; delete removes the row (second delete → 404).

```ts
const uploaded = await h.campaigns.uploadImage(ctxFor(h.users.gm), {
  campaignId, name: "cave", contentType: "image/png",
  dataBase64: ONE_BY_ONE_PNG_BASE64, idempotencyKey: crypto.randomUUID(),
});
expect(uploaded.ok).toBe(true);
if (!uploaded.ok) throw new Error("expected upload");
expect(uploaded.value).toMatchObject({ width: 1, height: 1, mediaType: "image/png" });
```

- [ ] **Step 2: Run to verify it fails.** Run: `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npx vitest run tests/integration/campaign-scenes.test.ts --no-file-parallelism`. Expected: FAIL with `uploadImage is not a function`.
- [ ] **Step 3: Implement migration + module.** Write `0018` (`media_files` with `id, campaign_id REFERENCES campaigns ON DELETE CASCADE, owner_id, name, media_type, size_bytes, width, height, checksum, storage_key UNIQUE, revision, created_at`); implement `uploadImage`/`deleteImage` in `src/campaigns/media.ts` with the `sharp` metadata check; wire into `index.ts`; add the repo functions in `persistence.ts`. Disk root resolves from `SWEETROLL_MEDIA_DIR ?? <repo>/data/media`.
- [ ] **Step 4: Run to verify it passes.** Same command as Step 2. Expected: PASS. Then `npm run typecheck`. Expected: clean.
- [ ] **Step 5: Commit.** `git add package.json package-lock.json Dockerfile compose.yaml migrations/0018_campaign_media.sql src/campaigns/media.ts src/campaigns/index.ts src/campaigns/persistence.ts tests/integration/campaign-scenes.test.ts`; `git commit -m "feat(i7b): add campaign image upload with validated private storage"`.

---

### Task 2: Scene / fog / token commands

**Files:**
- Create: `migrations/0019_campaign_scenes.sql`
- Create: `src/campaigns/scenes.ts`
- Modify: `src/campaigns/index.ts`, `src/campaigns/persistence.ts`
- Modify: `tests/integration/campaign-scenes.test.ts` (scene block)

**Interfaces:**
- Consumes: Task 1 `MediaFileView`; `checkRevision`-style guards (same pattern `updateCampaign` uses); same `Result` envelope.
- Produces (used by Tasks 4–6):

```ts
// src/campaigns/scenes.ts (added)
export type FogOp = { mode: "reveal" | "conceal"; runs: Array<{ x: number; y: number; r: number }> };
export type TokenRecord = {
  tokenId: string; label: string; x: number; y: number; size: number;
  visible: boolean; imageFileId: string | null;
};
export type SceneView = {
  sceneId: string; campaignId: string; revision: number;
  backgroundFileId: string; fog: FogOp[]; tokens: TokenRecord[];
};
export type CreateSceneInput = { campaignId: string; backgroundFileId: string; idempotencyKey: string };
export type ApplyFogEditInput = {
  sceneId: string; expectedSceneRevision: number; op: FogOp; idempotencyKey: string;
};
export type PlaceTokenInput = {
  sceneId: string; expectedSceneRevision: number; label: string;
  x: number; y: number; size: number; visible: boolean;
  imageFileId: string | null; idempotencyKey: string;
};
```

`createScene` (GM only) pins the background file (must belong to the same campaign, else `not_found`); scenes start fully fogged with zero tokens. `applyFogEdit` appends one op under the revision guard (stale → `conflict` with `latestRevision`, zero writes). `placeToken`/`moveToken`/`removeToken` are revision-guarded the same way; coordinates are normalized 0–1 (reject outside with `bad_request`). Hidden tokens are stored but never returned by the Task 3 projection.

- [ ] **Step 1: Write the failing scene tests.** Extend the Task 1 spec file: create scene from the uploaded file (fully fogged, no tokens); fog edit bumps revision; stale `expectedSceneRevision` → `conflict` with no write (re-read revision to prove it); cross-campaign background rejected; out-of-range coordinates rejected; player mutation denied; idempotent replay returns the stored envelope.

```ts
const stale = await h.campaigns.applyFogEdit(ctxFor(h.users.gm), {
  sceneId, expectedSceneRevision: rev - 1,
  op: { mode: "reveal", runs: [{ x: 0.5, y: 0.5, r: 0.1 }] },
  idempotencyKey: crypto.randomUUID(),
});
expect(stale.ok).toBe(false);
```

- [ ] **Step 2: Run to verify it fails.** Same vitest command as Task 1 Step 2. Expected: FAIL with `createScene is not a function`.
- [ ] **Step 3: Implement migration + module.** Write `0019` (`scenes` with `id, campaign_id REFERENCES campaigns ON DELETE CASCADE, background_file_id, revision, fog_jsonb JSONB NOT NULL DEFAULT '[]', tokens_jsonb JSONB NOT NULL DEFAULT '[]'`); implement the five commands in `src/campaigns/scenes.ts`; wire into `index.ts`; repo reads/writes in `persistence.ts` run inside the caller's transaction.
- [ ] **Step 4: Run to verify it passes.** Same command. Expected: PASS. Then `npm run typecheck`. Expected: clean.
- [ ] **Step 5: Commit.** `git add migrations/0019_campaign_scenes.sql src/campaigns/scenes.ts src/campaigns/index.ts src/campaigns/persistence.ts tests/integration/campaign-scenes.test.ts`; `git commit -m "feat(i7b): add revision-guarded scene, fog and token commands"`.

---

### Task 3: Display pairing + redacted projection

**Files:**
- Create: `migrations/0020_display_credentials.sql`
- Create: `src/campaigns/display.ts`
- Modify: `src/campaigns/index.ts`, `src/campaigns/persistence.ts`
- Modify: `tests/integration/campaign-scenes.test.ts` (display block)

**Interfaces:**
- Consumes: Tasks 1–2 (`SceneView`, media bytes on disk); `hashToken`-style code hashing (`src/identity/util.ts`); same `Result` envelope.
- Produces (used by Tasks 4–5, 7):

```ts
// src/campaigns/display.ts (added)
export type DisplayProjection = {
  sceneId: string; sceneRevision: number;
  imageUrl: string; // redacted derivative for this revision, e.g. `/displays/:id/scenes/:sceneId/image?rev=N`
  tokens: Array<{ tokenId: string; label: string; x: number; y: number; size: number; imageUrl: string | null }>;
};
```

`pairDisplay(ctx, { campaignId })` (GM only) mints a 6-char code, stores its hash with 5-minute expiry, and returns `{ code }` once (never persisted in plaintext). `redeemDisplayCode({ code })` validates hash + expiry (single-use: delete on redeem; unknown/expired/used → generic `not_found`), issues a revocable credential `{ displayId, secret }`, and returns it once. `getDisplayProjection({ displayId, secret, sceneId })` revalidates the credential (revoked/unknown → `not_found`), composites the redacted derivative for the scene revision with `sharp` (fog-concealed pixels removed, not overlaid; hidden/fog-covered tokens omitted), caches the derivative file keyed by `(sceneId, revision)`, and returns only visible-and-revealed tokens. `revokeDisplay` deletes the credential (GM only).

- [ ] **Step 1: Write the failing display tests.** Extend the spec file: pair → code matches `/^[A-Z0-9]{6}$/`; redeem → credential works for the projection; second redeem of the same code → `not_found`; expired code → `not_found`; projection image bytes differ from the original (assert byte length/content differ and hidden token absent from `tokens`); revoke → projection `not_found`; cross-campaign scene via a second campaign's credential → `not_found`.

```ts
const projection = await h.campaigns.getDisplayProjection({
  displayId, secret, sceneId,
});
expect(projection.ok).toBe(true);
if (!projection.ok) throw new Error("expected projection");
expect(projection.value.tokens.find((t) => t.tokenId === hiddenId)).toBeUndefined();
```

- [ ] **Step 2: Run to verify it fails.** Same vitest command. Expected: FAIL with `pairDisplay is not a function`.
- [ ] **Step 3: Implement migration + module.** Write `0020` (`display_codes` with `code_hash UNIQUE, campaign_id, expires_at`; `display_credentials` with `id, campaign_id, secret_hash, revoked_at NULL, created_at`); implement `src/campaigns/display.ts` with the `sharp` redaction composite (background minus fog mask; token positions are data, not burned pixels); wire into `index.ts`.
- [ ] **Step 4: Run to verify it passes.** Same command. Expected: PASS. Then `npm run typecheck`. Expected: clean.
- [ ] **Step 5: Commit.** `git add migrations/0020_display_credentials.sql src/campaigns/display.ts src/campaigns/index.ts src/campaigns/persistence.ts tests/integration/campaign-scenes.test.ts`; `git commit -m "feat(i7b): add display pairing with redacted scene projection"`.

---

### Task 4: HTTP transport + generated contracts

**Files:**
- Modify: `src/transport/http/campaigns.ts`
- Modify: `src/transport/http/campaigns.test.ts`
- Modify: `src/transport/http/openapi.test.ts` (add new paths to the conformance list)
- Regenerate: `docs/contracts/openapi-v1.json`, `web/src/api/schema.d.ts` via `npm run contracts:generate`

**Interfaces:**
- Consumes: Tasks 1–3 command envelopes.
- Produces (used by Task 5): operation IDs `post_campaigns_id_images` (`POST /campaigns/:id/images`, body `{ name, contentType, dataBase64, idempotencyKey }`), `delete_campaigns_id_images_fileId`, `post_campaigns_id_scenes`, `post_scenes_id_fog_edits`, `post_scenes_id_tokens`, `post_campaigns_id_display_codes`, `post_displays_redeem`, `get_displays_id_scenes_sceneId_projection`, plus the binary `get_displays_id_scenes_sceneId_image` (redacted derivative) and GM-only `get_campaigns_id_images_fileId_original`. All JSON responses add the usual HTTP `requestId`; Module results do not.

- [ ] **Step 1: Write the failing transport tests.** Mirror the upgrade transport test pattern (stub the Campaigns module on the injected app): assert exact request field mapping, 401 unauthenticated → 401, unknown campaign/scene → 404, invalid body (bad `contentType`, non-UUID `idempotencyKey`, out-of-range coords) → 400, oversized base64 → 413, and that projection responses contain no `storage_key`, original bytes, or hidden tokens.

```ts
const res = await app.inject({
  method: "POST", url: `/campaigns/${id}/images`,
  payload: { name: "cave", contentType: "image/png", dataBase64: ONE_BY_ONE_PNG_BASE64, idempotencyKey: crypto.randomUUID() },
});
expect(res.statusCode).toBe(200);
expect(JSON.stringify(res.json())).not.toContain("storage_key");
```

- [ ] **Step 2: Run to verify it fails.** Run: `npx vitest run src/transport/http/campaigns.test.ts` from root. Expected: FAIL with `404` on the new paths (routes absent).
- [ ] **Step 3: Implement the routes.** Follow the existing `get_campaigns_id_claimable_characters` handler shape (`src/transport/http/campaigns.ts:1422`): TypeBox body schemas with the same bounds style, `ctxOf(request)` Module calls, shared `sendError` mapping. Binary image routes set `Content-Type` + `Cache-Control` (`no-store` for originals; `private, max-age=3600` keyed by revision for derivatives) and stream from disk. Display routes authenticate via the display credential (body/header, never URL query).
- [ ] **Step 4: Regenerate + verify.** Run: `npm run contracts:generate && npm run contracts:check && npm run typecheck` from root, then `npx vitest run src/transport/http/campaigns.test.ts src/transport/http/openapi.test.ts`. Expected: PASS across all four.
- [ ] **Step 5: Commit.** `git add src/transport/http/campaigns.ts src/transport/http/campaigns.test.ts src/transport/http/openapi.test.ts docs/contracts/openapi-v1.json web/src/api/schema.d.ts`; `git commit -m "feat(i7b): expose media, scenes and display projection over HTTP with contracts"`.

---

### Task 5: Web API seam + scoped queries

**Files:**
- Modify: `web/src/campaigns/types.ts`
- Modify: `web/src/campaigns/api.ts`
- Modify: `web/src/campaigns/api.test.ts`
- Modify: `web/src/campaigns/campaignQueries.ts`
- Modify: `web/src/campaigns/campaignQueries.test.tsx`

**Interfaces:**
- Consumes: Task 4 `operations[...]` entries (derive types, never hand-write).
- Produces (used by Tasks 6–7): `CampaignsApi.uploadImage/commitFogEdit/…`, `pairDisplay/redeemDisplay/revokeDisplay/getDisplayProjection`; `sceneDetailKey(campaignId, sceneId, actorId, generation)` + `useScene(...)`; `displayProjectionKey(displayId, sceneId, revision)` + `useDisplayProjection(...)` (display-credential keyed, GM-purgeable).

- [ ] **Step 1: Write the failing seam tests.** In `api.test.ts`, assert `uploadImage` POSTs to `/campaigns/c1/images` with exactly `{ name, contentType, dataBase64, idempotencyKey }` and `applyFogEdit` POSTs to `/scenes/s1/fog-edits` with exactly `{ expectedSceneRevision, op, idempotencyKey }` (mirror the claimable serialization test at `api.test.ts:81`). In `campaignQueries.test.tsx`, assert the scene key contains actor+generation, is disabled when `actorId` is null or offline, and that scene commit success invalidates the projection key.
- [ ] **Step 2: Run to verify they fail.** Run: `npm --prefix web test -- src/campaigns/api.test.ts src/campaigns/campaignQueries.test.tsx`. Expected: FAIL with `uploadImage is not a function`.
- [ ] **Step 3: Implement the seam.** Thin wrappers through the injected `CampaignsApi` exactly like `previewUpgrade`/`commitUpgrade`; key helpers beside `campaignUpgradePreviewKey`; no new purge prefix — reuse the campaign-wide `["campaigns", ..., campaignId]` removal pattern plus the display-scoped projection key.
- [ ] **Step 4: Run to verify they pass.** Same command as Step 2. Expected: PASS. Then `npm --prefix web run typecheck`. Expected: clean.
- [ ] **Step 5: Commit.** `git add web/src/campaigns/types.ts web/src/campaigns/api.ts web/src/campaigns/api.test.ts web/src/campaigns/campaignQueries.ts web/src/campaigns/campaignQueries.test.tsx`; `git commit -m "feat(i7b): add scene and display web API seam with scoped queries"`.

---

### Task 6: GM scene UI + Display pairing section

**Files:**
- Create: `web/src/campaigns/SceneViewport.tsx`, `SceneViewport.test.tsx`
- Create: `web/src/campaigns/FogToolbar.tsx`, `FogToolbar.test.tsx`
- Create: `web/src/campaigns/TokenTray.tsx`, `TokenTray.test.tsx`
- Modify: `web/src/campaigns/CampaignSettings.tsx`, `CampaignSettings.test.tsx`
- Modify: `web/src/i18n/messages.ts` (only `campaign.detail.scenes.*` keys)
- Modify: `web/src/router.tsx` (GM scene route `/campaigns/$campaignId/scenes`)

**Interfaces:**
- Consumes: Task 5 seam + `useScene`; shared `Dialog`, `Button`, `Panel`, `EmptyState`, `FormField`.
- Produces (used by Task 8): scene route rendering viewport + toolbar + tray; Settings Display section (pair code display, credential list + revoke).

- [ ] **Step 1: Write the failing component tests.** Render with the injected API seam + QueryClient wrapper (mirror `CampaignCharacters.test.tsx` fakes): viewport shows the scene image with token markers at normalized positions; toolbar reveal commits one op and undo drops the uncommitted stroke; tray place/move calls with fresh `crypto.randomUUID()` keys; 409 shows explicit retry text and refetches (never revision guessing); player sees no scene route content (server-driven 404 → unavailable); Settings shows the pair code once with credential list + revoke. All copy through new `campaign.detail.scenes.*` keys.
- [ ] **Step 2: Run to verify they fail.** Run: `npm --prefix web test -- src/campaigns/SceneViewport.test.tsx src/campaigns/FogToolbar.test.tsx src/campaigns/TokenTray.test.tsx`. Expected: FAIL with `Cannot find module`.
- [ ] **Step 3: Implement the components.** Viewport in normalized scene-space with fit/pan/zoom + keyboard alternatives (arrows nudge, +/- zoom); toolbar owns the uncommitted stroke + undo + commit dispatch; tray owns place/move forms; Settings mounts the pairing section for GMs only (existing role prop, no new authz logic). Offline mutations disabled with explanatory text; fog/token commits use fresh keys and explicit 409/404 paths.
- [ ] **Step 4: Run to verify they pass.** Same command. Expected: PASS. Then `npm --prefix web run typecheck`. Expected: clean.
- [ ] **Step 5: Commit.** `git add web/src/campaigns/SceneViewport.tsx web/src/campaigns/SceneViewport.test.tsx web/src/campaigns/FogToolbar.tsx web/src/campaigns/FogToolbar.test.tsx web/src/campaigns/TokenTray.tsx web/src/campaigns/TokenTray.test.tsx web/src/campaigns/CampaignSettings.tsx web/src/campaigns/CampaignSettings.test.tsx web/src/router.tsx web/src/i18n/messages.ts`; `git commit -m "feat(i7b): add GM scene viewport, fog toolbar and token tray"`.

---

### Task 7: Restricted display shell

**Files:**
- Create: `web/src/display/DisplayView.tsx`, `DisplayView.test.tsx`
- Modify: `web/src/router.tsx` (`/display` route, no GM chrome)
- Modify: `web/src/i18n/messages.ts` (only `display.*` keys)

**Interfaces:**
- Consumes: Task 5 `redeemDisplay` + `useDisplayProjection`.
- Produces (used by Task 8): `/display` code-entry → projection shell; GM purge on entry.

- [ ] **Step 1: Write the failing tests.** Code entry redeems and renders the scene image + visible tokens; entry purges `["campaigns", ...]` queries and cancels in-flight campaign results (assert via the injected QueryClient, mirror the revocation-purge assertions); revoked/unknown credential renders the blank/reconnecting state with no GM chrome or GM endpoint calls (assert no `openCampaign` fetch); reload path revalidates before render.
- [ ] **Step 2: Run to verify they fail.** Run: `npm --prefix web test -- src/display/DisplayView.test.tsx`. Expected: FAIL with `Cannot find module`.
- [ ] **Step 3: Implement the shell.** Minimal route component: code form → redeem → poll projection by `(displayId, sceneId, revision)`; image + absolutely positioned token markers; `Cache-Control`-friendly revision-keyed `imageUrl`; blank state on 404/poll failure; entry effect removes campaign query keys before the first projection fetch.
- [ ] **Step 4: Run to verify they pass.** Same command. Expected: PASS. Then full web unit + typecheck: `npm --prefix web test` and `npm --prefix web run typecheck`. Expected: PASS/clean.
- [ ] **Step 5: Commit.** `git add web/src/display/DisplayView.tsx web/src/display/DisplayView.test.tsx web/src/router.tsx web/src/i18n/messages.ts`; `git commit -m "feat(i7b): add restricted display shell with entry purge"`.

---

### Task 8: Exit e2e + acceptance record

**Files:**
- Create: `web/tests/e2e/sceneDisplayJourney.spec.ts`
- Create: `docs/acceptance/gui-2026-09-14-i7b-scenes.md`

**Interfaces:**
- Consumes: all previous tasks; canonical runner (`npm run test:e2e`) picks the new spec up automatically.
- Produces: exit evidence for the G8 box.

- [ ] **Step 1: Write the exit journey (e2e first).** GM `code-test-a` via the dev sign-in panel: upload a fixture PNG through the scene UI, create a scene, conceal-then-reveal a region, place one visible + one hidden token, pair a display code, open `/display` in a second context and redeem, assert the display shows the revealed region + visible token only. Inspect display network responses (no original bytes, no hidden token, no GM endpoints), `localStorage`/caches (no GM data), and deep links (direct original URL → 404 as display). Move a token + change scene, assert the display follows on poll; revoke the credential, assert the display blanks. Keep `workers: 1`, `retries: 0`.
- [ ] **Step 2: Run to verify it fails.** Run the spec against the current tree with caller-managed resources (README §Browser E2E: dedicated DB/ports + `DATABASE_URL` + `CI=1`) before Tasks 1–7 land (or in a detached worktree at the pre-I7b parent). Expected: FAIL (no scene routes; display path absent).
- [ ] **Step 3: Make it pass with only test fixes.** No product change expected in this task; fix selectors/timing only.
- [ ] **Step 4: Run full verification.** Root `npm test`, `npm run test:integration` (`TEST_DATABASE_URL` set, `--no-file-parallelism`), `npm run typecheck`, `npm run contracts:check`, `npm run build`; web `npm test`, `npm run typecheck`, `npm run build`; canonical `npm run test:e2e` (now including the new spec); fresh `npm run web:build` then `npm run web:test:offline`; `docker build`; `git diff --check`. Record tested commit, commands, outcomes, and limitations in `docs/acceptance/gui-2026-09-14-i7b-scenes.md` (same shape as the Phase 3 record; production-auth and real-device gates stay open).
- [ ] **Step 5: Commit.** `git add web/tests/e2e/sceneDisplayJourney.spec.ts docs/acceptance/gui-2026-09-14-i7b-scenes.md`; `git commit -m "feat(i7b): prove restricted scene display isolation in exit e2e with acceptance"`.
