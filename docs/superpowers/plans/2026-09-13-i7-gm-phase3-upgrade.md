# I7 GM Phase 3 (Campaign Upgrade) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A GM previews a campaign system-version upgrade (per-character warnings, before/after pin) and commits it atomically without changing any other pinned campaign.

**Architecture:** Add one deep `Campaigns` Module command pair — read-only `previewUpgrade` plus single-transaction `commitUpgrade` — that drives attached-character migrations through a new Characters-internal seam (existing HTTP migration routes keep denying attached scope). The GM picks the target from the existing creation-versions catalog filtered to the campaign's system (exact version-ID fallback, no new discovery endpoint), confirms in an `UpgradeDialog`, and the exit e2e proves a second pinned campaign is untouched.

**Tech Stack:** PostgreSQL, Campaigns/Characters Modules, Fastify/OpenAPI, generated TypeScript (`docs/contracts/openapi-v1.json`, `web/src/api/schema.d.ts`), React + TanStack Query, shared `web/src/ui/` controls, Vitest, Playwright Chromium.

**Spec:** `docs/superpowers/specs/2026-09-11-i7-gm-app-design.md` (Architecture upgrade paragraph; Phase 3 section); `design_v2.md` §6.7 (upgrades/migration), §17 task 9 (deep upgrade command), §13 (cursor/idempotency/revision rules).

## Global Constraints

- One deployable artifact; no package-format change; publishing a new system version never upgrades any campaign by itself.
- All campaign reads/writes go through `ApiClient` (`credentials:include`, `x-request-id`, JSON bodies even for DELETEs).
- Every upgrade commit sends a caller-minted `idempotencyKey` (UUID); after any `409`, re-read then mint a fresh key — never reuse.
- `409 conflict` carries `latestRevision`; surface explicit retry/reload, never "Merge".
- Query keys always include actor + generation: `["campaigns", ..., actorId, generation, ...]`; `enabled` requires `actorId !== null && online`; sign-out/account-switch relies on AppShell `cancelQueries/removeQueries` + lifetime remount `key=`.
- Shared controls (`Button, Panel, PageHeader, EmptyState, FormField, Select, Dialog`) for all new surfaces; controls never decide authorization — server 404/409s render as unavailable/conflict states.
- No `campaign` string in `web/src/player/` — all new code lives in `web/src/campaigns/` + `router.tsx` (no router change expected) + `web/src/i18n/messages.ts` keys only.
- Upgrade mutations are online-only and disabled offline, while refreshing, and when the campaign lifecycle forbids them.
- TDD red-green per task; `npm run contracts:check` stays green (contracts regenerated in Task 3).
- New i18n keys ship in the same task as the component that uses them.
- No campaign-level rollback command in this phase (see Decision D4). No creator-authored migration scripts (§6.7 exclusion). No preview-as-player, no pinning changes beyond the campaign `system_version_id` move.

---

## Decisions (locked before tasks)

**D1 — Attached-migration seam (internal, not HTTP).** `Characters.previewMigration/commitMigration/rollbackMigration` keep denying attached scope at HTTP (`denyAttachedMigrationScope` in `src/characters/migration.ts:23` stays). `Campaigns.commitUpgrade` / `previewUpgrade` drive attached characters through two new Characters-internal functions (same transaction via a passed `PoolClient`):

```ts
// src/characters/migration.ts (added; NOT wired to any HTTP route)
export async function previewAttachedMigration(
  client: PoolClient,
  ctx: RequestContext,
  input: PreviewCharacterMigration,
): Promise<CharacterResult<CharacterMigrationPreview>>;
export async function commitAttachedMigration(
  client: PoolClient,
  ctx: RequestContext,
  input: CommitCharacterMigration,
): Promise<CharacterResult<CharacterCommandResult>>;
```

They run the exact existing preview/commit logic minus the attached-scope denial (ownership/authorization already established by the Campaigns caller: active membership, GM role, campaign custody of the character). Alternative (per-character HTTP `commitMigration` calls from the GM client, then a pin move) is rejected: it cannot be atomic and lets a GM migrate single attached sheets around the campaign.

**D2 — Target discovery reuses the creation-versions catalog.** No new discovery endpoint. The dialog lists `GET /characters/creation-versions` entries filtered client-side to the campaign's `systemId` with `semanticVersion` greater than the pin (bounded existing pagination applies), plus a manual exact-version-ID entry as fallback (G4 picker pattern). Server preview/commit re-authorize the exact target with the existing known-version use predicate (owner or `public`/`link` access, published lifecycle, same system, different from pin) — permission to use a known version never implies broader discovery (OD-01 option A, unchanged).

**D3 — Commit recomputes previews server-side in one transaction.** The client passes `mappings`/`defaults` (optional), `expectedCampaignRevision`, and `idempotencyKey` — never `previewId`s (they expire and would race). Commit order inside one transaction: lock campaign row first (existing campaign-first discipline), recheck GM/active/revision, load attached characters in deterministic character-ID order with row locks, run attached-migration preview per character in-transaction, fail closed with explicit per-character 409/422 on any concurrent edit or missing required mapping (whole transaction rolls back, no partial application), then commit each migration, move the pin, bump campaign revision, write campaign audit (before/after pin + per-character migration IDs). Idempotency replays the stored commit envelope on key reuse.

**D4 — No campaign rollback command.** Commit persists before/after snapshots and per-character `migrationId`s in campaign audit (the Architecture "rollback proof": reversal stays possible in principle with full evidence). Attached per-character rollback remains denied by the existing scope gate and a campaign-level downgrade command is explicitly deferred, not half-built; per-character rollback retention is unchanged.

---

## File map

| File | Responsibility |
| --- | --- |
| `src/characters/migration.ts` (modify) | `previewAttachedMigration` + `commitAttachedMigration` internals (D1) |
| `src/campaigns/index.ts` (modify) | `previewUpgrade` + `commitUpgrade` deep commands (D3) |
| `src/campaigns/persistence.ts` (modify) | Upgrade repo reads/writes used inside the caller's transaction |
| `src/transport/http/campaigns.ts` (modify) | `POST /campaigns/:id/upgrade-previews`, `POST /campaigns/:id/upgrade-commits` + validation/mapping |
| `src/transport/http/campaigns.test.ts` (modify) | Transport tests for both routes (auth, validation, field-exactness) |
| `src/transport/http/openapi.test.ts` (modify) | New paths in the conformance list (1 line, mirrors R6/R7) |
| `tests/integration/campaign-upgrade.test.ts` (create) | Preview/commit matrix: auth, isolation, conflicts, idempotency, archived denial |
| `docs/contracts/openapi-v1.json`, `web/src/api/schema.d.ts` (regenerate) | New operations (Task 3 runs `contracts:generate`) |
| `web/src/campaigns/types.ts` (modify) | Derived upgrade types from `operations` |
| `web/src/campaigns/api.ts`, `api.test.ts` (modify) | `CampaignsApi.previewUpgrade/commitUpgrade` + serialization tests |
| `web/src/campaigns/campaignQueries.ts`, `campaignQueries.test.tsx` (modify) | Actor/generation-scoped upgrade-preview query; purge-prefix retention |
| `web/src/campaigns/UpgradeDialog.tsx`, `UpgradeDialog.test.tsx` (create) | Preview warnings, before/after pin, explicit commit confirmation |
| `web/src/campaigns/CampaignSettings.tsx`, `CampaignSettings.test.tsx` (modify) | GM-only Upgrade section mounting the dialog (existing pinned-version row stays) |
| `web/src/i18n/messages.ts` (modify) | `campaign.detail.upgrade.*` keys with the dialog task |
| `web/tests/e2e/campaignUpgradeJourney.spec.ts` (create) | Exit e2e: preview → commit; second pinned campaign unchanged |
| `docs/acceptance/gui-2026-09-13-g7-gm-phase3.md` (create) | Acceptance record for this phase |

---

### Task 1: Attached-migration internals + upgrade preview command

**Files:**
- Modify: `src/characters/migration.ts`
- Modify: `src/campaigns/index.ts` (preview only; commit is Task 2)
- Modify: `src/campaigns/persistence.ts`
- Create: `tests/integration/campaign-upgrade.test.ts` (preview block only; commit block in Task 2)

**Interfaces:**
- Consumes: `PreviewCharacterMigration` / `CharacterMigrationPreview` (`src/characters/index.ts:346-365`); `CampaignView.systemVersionId/revision` (`src/campaigns/index.ts:494-504`); `canManageCampaign` (`src/campaigns/policy.ts:37`); `VersionSummary.semanticVersion/lifecycle` (`src/systems/authoring.ts:70-78`); `authorizeVersionUse`-equivalent known-version use predicate (same predicate character creation uses: owner or `public`/`link` access, published version).
- Produces (used by Tasks 2–3):

```ts
// src/campaigns/index.ts (added)
export type PreviewCampaignUpgrade = {
  campaignId: string;
  targetVersionId: string;
  mappings?: Record<string, string>;
  defaults?: Record<string, unknown>;
};
export type UpgradeCharacterPreview = {
  characterId: string;
  name: string;
  sourceVersionId: string;
  warnings: string[];
  requiresMapping: boolean;
};
export type CampaignUpgradePreview = {
  campaignId: string;
  campaignRevision: number;
  sourceVersionId: string;
  targetVersionId: string;
  targetSemanticVersion: string;
  characters: UpgradeCharacterPreview[];
};
```

`Campaigns.previewUpgrade(ctx, input)` returns the existing `Result` envelope around `CampaignUpgradePreview`. It is read-only: no row writes, no audit rows, no idempotency keys.

- [ ] **Step 1: Write the failing preview tests.** In `tests/integration/campaign-upgrade.test.ts`, reuse `buildI6Harness`, `ctxFor`, and existing fixture setup (mirror `campaign-placement.test.ts` harness usage); close each isolated-schema harness. GM creates a campaign from a published fixture version, adds a campaign character, then previews against a newer published version of the same system:

```ts
const preview = await h.campaigns.previewUpgrade(ctxFor(h.users.gm), {
  campaignId, targetVersionId: v2,
});
expect(preview.ok).toBe(true);
if (!preview.ok) throw new Error("expected upgrade preview");
expect(preview.value).toMatchObject({ campaignId, sourceVersionId: v1, targetVersionId: v2 });
expect(preview.value.characters[0]).toMatchObject({ characterId, sourceVersionId: v1 });
expect(preview.value.characters[0].warnings).toEqual(expect.any(Array));
```

Cover: player/outside/unauthenticated denied (generic 404 collapse for cross-campaign IDs); target equal to pin rejected; target from another system rejected; unpublished target rejected; link-only target usable by exact ID but undiscoverable (no new endpoint lists it); archived-campaign preview still readable; campaign with zero attached characters previews with `characters: []`.

- [ ] **Step 2: Run to verify it fails.** Run: `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npx vitest run tests/integration/campaign-upgrade.test.ts --no-file-parallelism`. Expected: FAIL with `previewUpgrade is not a function` (and `previewAttachedMigration is not a function` where used).

- [ ] **Step 3: Implement `previewAttachedMigration` + `commitAttachedMigration` in `src/characters/migration.ts`.** Factor the existing preview/commit bodies so the HTTP path keeps the `denyAttachedMigrationScope` gate and the new exports run identical logic without it. Both accept the caller's `PoolClient` and run no `COMMIT` themselves. No HTTP wiring, no signature changes to existing exports.

- [ ] **Step 4: Implement `Campaigns.previewUpgrade`.** Authorize: campaign exists, caller is an active GM (`canManageCampaign`), else generic `not_found`. Load target version metadata; reject when the target is the pin, another system, or unpublished/inaccessible under the known-version use predicate. For every attached character (bounded by the existing 200 cap; no pagination — state the cap in a comment), call `previewAttachedMigration` with the caller's `mappings`/`defaults` and set `requiresMapping` when the character preview carries breaking-change warnings that need explicit mapping (mirror the exact warning-kind check the standalone commit path uses — do not invent a second taxonomy). Never return `candidateState`, projections, rolls, inventory, or grants — only the six `UpgradeCharacterPreview` fields above.

- [ ] **Step 5: Run the preview tests to verify they pass.** Same command as Step 2. Expected: PASS. Then run the existing attached-denial suites to prove the HTTP gate is intact: `tests/integration/campaign-character-authorization.test.ts` and `tests/integration/campaign-placement.test.ts` with the same env/flags. Expected: PASS (no behavior change).

- [ ] **Step 6: Commit.** `git add src/characters/migration.ts src/campaigns/index.ts src/campaigns/persistence.ts tests/integration/campaign-upgrade.test.ts`; `git commit -m "feat(g7): add campaign upgrade preview with attached-migration internals"`.

### Task 2: Atomic upgrade commit command

**Files:**
- Modify: `src/campaigns/index.ts` (commit only)
- Modify: `src/campaigns/persistence.ts`
- Modify: `tests/integration/campaign-upgrade.test.ts` (commit block)

**Interfaces:**
- Consumes: `CommitCharacterMigration` (`src/characters/index.ts:366-371`); Task 1 `previewUpgrade` + `previewAttachedMigration`/`commitAttachedMigration`; existing campaign revision-guard + idempotency-replay helpers used by `updateCampaign` (`src/campaigns/index.ts:956-1033` pattern: `checkRevision`, revision mismatch → `conflict` with `latestRevision`, idempotency envelope replay).
- Produces (used by Tasks 3–4):

```ts
// src/campaigns/index.ts (added)
export type CommitCampaignUpgrade = {
  campaignId: string;
  targetVersionId: string;
  expectedCampaignRevision: number;
  idempotencyKey: string;
  mappings?: Record<string, string>;
  defaults?: Record<string, unknown>;
};
export type CampaignUpgradeResult = {
  campaignId: string;
  campaignRevision: number;
  sourceVersionId: string;
  targetVersionId: string;
  migratedCharacterIds: string[];
};
```

`Campaigns.commitUpgrade(ctx, input)` returns the existing `Result` envelope around `CampaignUpgradeResult` (D3 ordering; single transaction; idempotent replay).

- [ ] **Step 1: Write the failing commit tests.** Extend `tests/integration/campaign-upgrade.test.ts`: commit moves the pin and every attached character's `system_version_id`, bumps campaign revision, and records per-character migration IDs in campaign audit; second campaign on the same pin is byte-identical after (pin, revision, characters). Cover: player commit denied; stale `expectedCampaignRevision` → `conflict` with `latestRevision` and zero writes (re-read pin to prove it); same `idempotencyKey` replayed returns the stored envelope with no second migration lineage; concurrent character edit between preview and commit (bump character revision via a real command) fails the whole commit with no partial migration; missing required mapping → explicit 422 naming character + definition, pin unchanged; archived campaign commit denied even when preview was readable; zero-character campaign commits pin-only.

```ts
const first = await h.campaigns.commitUpgrade(ctxFor(h.users.gm), {
  campaignId, targetVersionId: v2, expectedCampaignRevision: rev, idempotencyKey: crypto.randomUUID(),
});
expect(first.ok).toBe(true);
const replay = await h.campaigns.commitUpgrade(ctxFor(h.users.gm), {
  campaignId, targetVersionId: v2, expectedCampaignRevision: first.value.campaignRevision, idempotencyKey: sameKey,
});
expect(replay).toEqual(first);
const other = await h.campaigns.open(ctxFor(h.users.gm2), otherCampaignId);
expect(other.value?.systemVersionId).toBe(v1);
```

- [ ] **Step 2: Run to verify it fails.** Same vitest command as Task 1 Step 2. Expected: FAIL with `commitUpgrade is not a function`.

- [ ] **Step 3: Implement `Campaigns.commitUpgrade` per D3.** One transaction, campaign row locked first, deterministic character-ID lock order. Reuse the `updateCampaign` revision/idempotency pattern verbatim (same helper functions, same error codes). Character 409/422 inside the transaction aborts everything; map to explicit campaign-level errors carrying the character ID (never a partial `migratedCharacterIds`). Campaign audit row records before/after pin + migration IDs (D4).

- [ ] **Step 4: Run the full upgrade suite green plus neighbors.** Same command. Expected: PASS. Then `tests/integration/campaigns.test.ts` (lifecycle/revision neighbors) with same env/flags. Expected: PASS.

- [ ] **Step 5: Commit.** `git add src/campaigns/index.ts src/campaigns/persistence.ts tests/integration/campaign-upgrade.test.ts`; `git commit -m "feat(g7): commit campaign upgrades atomically with pin move and audit"`.

### Task 3: HTTP transport + generated contracts

**Files:**
- Modify: `src/transport/http/campaigns.ts`
- Modify: `src/transport/http/campaigns.test.ts`
- Modify: `src/transport/http/openapi.test.ts` (1 line: add both paths to the conformance list)
- Regenerate: `docs/contracts/openapi-v1.json`, `web/src/api/schema.d.ts` via `npm run contracts:generate`

**Interfaces:**
- Consumes: Task 1–2 `PreviewCampaignUpgrade`/`CommitCampaignUpgrade` result envelopes.
- Produces (used by Task 4): operation IDs `post_campaigns_id_upgrade_previews` (`POST /campaigns/:id/upgrade-previews`, body `{ targetVersionId, mappings?, defaults? }`) and `post_campaigns_id_upgrade_commits` (`POST /campaigns/:id/upgrade-commits`, body `{ targetVersionId, expectedCampaignRevision, idempotencyKey, mappings?, defaults? }`); both responses add the usual HTTP `requestId`, Module results do not.

- [ ] **Step 1: Write the failing transport tests.** Mirror the R6 transport test (`src/transport/http/campaigns.test.ts:913` pattern): stub `previewUpgrade`/`commitUpgrade` on the injected Campaigns module; assert exact request field mapping, 401 unauthenticated → 401, unknown campaign → 404, invalid body (missing `targetVersionId`, non-UUID `idempotencyKey`, non-integer `expectedCampaignRevision`) → 400, and that preview responses contain no `candidateState`/projection keys.

```ts
const preview = await app.inject({
  method: "POST", url: `/campaigns/${id}/upgrade-previews`,
  payload: { targetVersionId: "v2" },
});
expect(preview.statusCode).toBe(200);
expect(Object.keys(preview.json())).toContain("characters");
expect(JSON.stringify(preview.json())).not.toContain("candidateState");
```

- [ ] **Step 2: Run to verify it fails.** Run: `npx vitest run src/transport/http/campaigns.test.ts` from root. Expected: FAIL with `404` / `previewUpgrade is not a function` on the stubbed app (routes absent).

- [ ] **Step 3: Implement both routes.** Follow the existing `get_campaigns_id_claimable_characters` handler shape (`src/transport/http/campaigns.ts:1422`): validate body with TypeBox schemas (same bounds style as neighboring routes), call the Module with `ctxOf(request)`, map Module errors via the shared `sendError` table. No new shared pagination schema; preview takes no cursor (200-cap note in comment).

- [ ] **Step 4: Regenerate + verify.** Run: `npm run contracts:generate && npm run contracts:check && npm run typecheck` from root, then `npx vitest run src/transport/http/campaigns.test.ts src/transport/http/openapi.test.ts`. Expected: PASS across all four.

- [ ] **Step 5: Commit.** `git add src/transport/http/campaigns.ts src/transport/http/campaigns.test.ts src/transport/http/openapi.test.ts docs/contracts/openapi-v1.json web/src/api/schema.d.ts`; `git commit -m "feat(g7): expose campaign upgrade preview/commit over HTTP with contracts"`.

### Task 4: Web API seam + scoped queries

**Files:**
- Modify: `web/src/campaigns/types.ts`
- Modify: `web/src/campaigns/api.ts`
- Modify: `web/src/campaigns/api.test.ts`
- Modify: `web/src/campaigns/campaignQueries.ts`
- Modify: `web/src/campaigns/campaignQueries.test.tsx`

**Interfaces:**
- Consumes: `operations["post_campaigns_id_upgrade_previews"]` and `operations["post_campaigns_id_upgrade_commits"]` from `web/src/api/schema.d.ts` (Task 3 output — derive types, never hand-write).
- Produces (used by Tasks 5–6): `CampaignsApi.previewUpgrade(campaignId, body)` / `CampaignsApi.commitUpgrade(campaignId, body)`; `useUpgradePreview(campaignId, actorId, generation, targetVersionId)` query keyed `["campaigns", "upgrade-preview", campaignId, actorId, generation, targetVersionId]`; existing `["campaigns", "content", campaignId]`-style purge prefixes retained — after commit, invalidate `["campaigns", "characters", campaignId]`, content/activity/session reads, and the campaign view.

- [ ] **Step 1: Write the failing seam tests.** In `api.test.ts`, assert `previewUpgrade` POSTs to `/campaigns/c1/upgrade-previews` with exactly `{ targetVersionId, mappings, defaults }` and `commitUpgrade` POSTs to `/campaigns/c1/upgrade-commits` with exactly `{ targetVersionId, expectedCampaignRevision, idempotencyKey, mappings, defaults }` (mirror the claimable serialization test at `api.test.ts:81`). In `campaignQueries.test.tsx`, assert the preview key contains actor+generation+target, is disabled when `actorId` is null or offline, and that commit success invalidates the roster/content/campaign keys.

- [ ] **Step 2: Run to verify they fail.** Run: `npm --prefix web test -- src/campaigns/api.test.ts src/campaigns/campaignQueries.test.tsx`. Expected: FAIL with `previewUpgrade is not a function`.

- [ ] **Step 3: Implement the seam.** Thin wrappers through the injected `CampaignsApi` exactly like `listClaimableCharacters` (`web/src/campaigns/api.ts:129-132` pattern). No new purge prefix — reuse the campaign-wide `["campaigns", ..., campaignId]` removal pattern `CampaignDetail.tsx` already uses for leave/revocation.

- [ ] **Step 4: Run to verify they pass.** Same command as Step 2. Expected: PASS. Then `npm --prefix web run typecheck`. Expected: clean.

- [ ] **Step 5: Commit.** `git add web/src/campaigns/types.ts web/src/campaigns/api.ts web/src/campaigns/api.test.ts web/src/campaigns/campaignQueries.ts web/src/campaigns/campaignQueries.test.tsx`; `git commit -m "feat(g7): add campaign upgrade web API seam with scoped queries"`.

### Task 5: UpgradeDialog component

**Files:**
- Create: `web/src/campaigns/UpgradeDialog.tsx`
- Create: `web/src/campaigns/UpgradeDialog.test.tsx`
- Modify: `web/src/i18n/messages.ts` (only `campaign.detail.upgrade.*` keys)

**Interfaces:**
- Consumes: Task 4 `useUpgradePreview` + `CampaignsApi.commitUpgrade`; shared `Dialog`, `Button`, `Panel`, `EmptyState`.
- Produces (used by Task 6): `<UpgradeDialog campaignId actorId generation target onClose onCommitted />` — owns target selection, preview display, confirmation, commit dispatch, and 409/404 handling.

- [ ] **Step 1: Write the failing component tests.** Render with the injected API seam + QueryClient wrapper (mirror `CampaignCharacters.test.tsx` fakes): target picker lists creation-versions entries filtered to the campaign system with greater `semanticVersion` plus an exact-ID entry; preview shows before/after pin (`v1… → 2.0.0`) and per-character warnings with `requiresMapping` flagged; commit button stays disabled until explicit confirmation checkbox; successful commit calls `onCommitted` and shows the new pin; 409 shows "campaign changed — review fresh preview" with a fresh key on retry (never `revision + 1` guessing); 404 removes the dialog content with generic unavailability; archived/expired characters render explanatory text with no commit action.

```tsx
expect(await screen.findByText(/1\.0\.0 → 2\.0\.0/)).toBeVisible();
expect(screen.getByRole("button", { name: /commit upgrade/i })).toBeDisabled();
await userEvent.click(screen.getByRole("checkbox", { name: /i understand/i }));
expect(screen.getByRole("button", { name: /commit upgrade/i })).toBeEnabled();
```

- [ ] **Step 2: Run to verify they fail.** Run: `npm --prefix web test -- src/campaigns/UpgradeDialog.test.tsx`. Expected: FAIL with `Cannot find module './UpgradeDialog.js'`.

- [ ] **Step 3: Implement `UpgradeDialog`.** Target list from the existing creation-versions query hook filtered by `systemId` (reuse, do not duplicate the catalog endpoint); exact-ID fallback field with definite-input-error mapping (G1 pattern). Preview pane, confirmation gate, commit with fresh `crypto.randomUUID()` key, explicit 409/404 paths per the test contract. All copy through new `campaign.detail.upgrade.*` message keys. Never decide authorization — 404/409 render server-driven states.

- [ ] **Step 4: Run to verify they pass.** Same command. Expected: PASS.

- [ ] **Step 5: Commit.** `git add web/src/campaigns/UpgradeDialog.tsx web/src/campaigns/UpgradeDialog.test.tsx web/src/i18n/messages.ts`; `git commit -m "feat(g7): add campaign UpgradeDialog with preview and guarded commit"`.

### Task 6: Settings wiring + authorization surfacing

**Files:**
- Modify: `web/src/campaigns/CampaignSettings.tsx`
- Modify: `web/src/campaigns/CampaignSettings.test.tsx`

**Interfaces:**
- Consumes: Task 5 `UpgradeDialog`; existing pinned-version row (`campaign.manage.settings.version.label`).
- Produces (used by Task 7): GM-only Upgrade section in Settings: pinned-version display, "Check for upgrades" entry opening the dialog, post-commit invalidation of campaign/roster/content/session reads.

- [ ] **Step 1: Write the failing tests.** GM sees the Upgrade section with current pin and entry button; player sees the pin row but no Upgrade section; Upgrade entry disabled offline with explanatory text; after `onCommitted`, roster/content/campaign queries are invalidated (assert via the injected QueryClient, mirror the claim-refresh assertions).

- [ ] **Step 2: Run to verify they fail.** Run: `npm --prefix web test -- src/campaigns/CampaignSettings.test.tsx`. Expected: FAIL (no Upgrade section rendered).

- [ ] **Step 3: Implement the section.** Gate on the existing GM role prop the Settings tab already receives (no new authorization logic — server remains authoritative). Mount `UpgradeDialog` on entry; on commit, invalidate the Task 4 key set and show the new pin from the refreshed campaign view.

- [ ] **Step 4: Run to verify they pass.** Same command. Expected: PASS. Then full web unit + typecheck: `npm --prefix web test` and `npm --prefix web run typecheck`. Expected: PASS/clean.

- [ ] **Step 5: Commit.** `git add web/src/campaigns/CampaignSettings.tsx web/src/campaigns/CampaignSettings.test.tsx`; `git commit -m "feat(g7): wire campaign upgrade section into GM settings"`.

### Task 7: Exit e2e + acceptance record

**Files:**
- Create: `web/tests/e2e/campaignUpgradeJourney.spec.ts`
- Create: `docs/acceptance/gui-2026-09-13-g7-gm-phase3.md`

**Interfaces:**
- Consumes: all previous tasks; canonical runner (`npm run test:e2e`) picks the new spec up automatically (journeys glob).
- Produces: exit evidence for the I7 Phase 3 box.

- [ ] **Step 1: Write the exit journey (e2e first).** Two campaigns on the same published fixture version (GM-owned). Publish a newer version through the real creator UI (the same publish flow the G5 `creatorToCharacter.spec.ts` exit journey exercises — no product publish bypass). Immediately after publishing, assert both campaigns still read the old pin (publishing alone upgrades nothing). In campaign A: Settings → Upgrade → pick the new version from the discovered list → preview shows before/after pin + per-character warnings → confirm → commit → pin and character versions read new. Assert campaign B (pin, revision, character versions) is byte-identical via real reads. Cover stale commit via a second GM context (bump campaign → 409 → fresh preview → explicit retry succeeds). Keep the ordinary-player claim and Hidden-recovery journeys untouched in their specs.

- [ ] **Step 2: Run to verify it fails.** Run the spec against the current tree with caller-managed resources (README §Browser E2E) or the canonical runner. Expected: FAIL (no Upgrade section; routes absent if backend tasks are unmerged — run after Tasks 1–6 land).

- [ ] **Step 3: Make it pass with only test fixes.** No product change expected in this task; fix selectors/timing only. Preserve `workers: 1`, `retries: 0`.

- [ ] **Step 4: Run full verification.** Root `npm test`, `npm run test:integration` (`TEST_DATABASE_URL` set, `--no-file-parallelism`), `npm run typecheck`, `npm run contracts:check`, `npm run build`; web `npm test`, `npm run typecheck`, `npm run build`; canonical `npm run test:e2e` (now including the new spec); `npm run web:test:offline` (fresh `web:build` first, offline DB + `CI=1` + `SWEETROLL_TEST_AUTH=1` per CI); `docker build`; `git diff --check`. Record tested commit, commands, outcomes, and limitations in `docs/acceptance/gui-2026-09-13-g7-gm-phase3.md` (same shape as the Phase 2 record: product changes, evidence, limitations, open follow-ups — Phase 4 and G8/G9 stay open).

- [ ] **Step 5: Commit.** `git add web/tests/e2e/campaignUpgradeJourney.spec.ts docs/acceptance/gui-2026-09-13-g7-gm-phase3.md`; `git commit -m "feat(g7): prove campaign upgrade isolation in exit e2e with acceptance"`.
