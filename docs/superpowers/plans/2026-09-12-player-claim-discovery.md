# Player Claim Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an ordinary player discover and claim a character designated to them without granting pre-claim sheet access.

**Architecture:** Proposed: add a narrow, paginated claim-discovery read to the existing Campaigns Module rather than broaden the full character-summary endpoint. The existing placement command remains authoritative; discovery metadata is not permission to open, export, edit, or roll a sheet.

**Tech Stack:** PostgreSQL, Campaigns/Characters Modules, Fastify/OpenAPI, generated TypeScript, TanStack Query, React, Vitest, Playwright.

**Spec:** `design_v2.md` Sections 5.3, 9, 13, 17.8-17.9; `docs/superpowers/specs/2026-09-09-i6-campaign-backend-design.md`; [remediation index](2026-09-12-remediation-index.md), R6.

## Global Constraints

- **Approval required before implementation:** the endpoint and metadata-disclosure policy below are proposed, not approved design. Record approval and update `design_v2.md` plus the I6 spec before adding contracts.
- Full sheets remain restricted to GMs/controllers. Leave `Characters.loadAttachedSnapshot` authorization intact.
- Do not expose controller IDs, other designees, state, projection, rolls, audit, inventory, placement metadata, or system/version details in discovery rows.
- Active membership and current actor designation are required on every page; recheck them on claim. No client actor/role parameter is authoritative.
- Preserve campaign custody disclosure, revision/idempotency rules, ordinary 404 collapse, and multi-controller behavior.
- Do not change archived-character claim authorization in this repair. Current command and UI differ: the command does not check character lifecycle, while the UI only offers active claims. Retain that UI behavior and record the discrepancy rather than silently adding a new restriction.

---

## Decision and Alternatives

Recommended proposal: `GET /campaigns/{id}/claimable-characters` returns only the caller's outstanding designations using a small summary. This adds one endpoint but avoids granting every designee the existing roster's controller and placement metadata.

Alternative: extend the existing list with discriminated minimal claim-only rows. This avoids another endpoint but changes every roster consumer and needs an explicit union contract. Broadening the existing full summary unchanged is not recommended because it grants unnecessary metadata access. A manually entered GM-provided ID preserves current backend behavior but does not deliver the requested discoverable player workflow.

- [ ] Obtain approval for the recommended endpoint/fields or revise this plan around the selected alternative. Do not implement two competing paths.

## Task 1: Add the Policy-Filtered Discovery Contract

**Files:** Modify `src/campaigns/index.ts`, `src/campaigns/persistence.ts`, `src/transport/http/campaigns.ts`, `src/transport/http/campaigns.test.ts`, `tests/integration/campaign-http-acceptance.test.ts`, `tests/integration/campaign-placement.test.ts`, `tests/integration/campaign-character-authorization.test.ts`. Regenerate `docs/contracts/openapi-v1.json` and `web/src/api/schema.d.ts`.

**Interfaces:** Proposed Module method `listClaimableCharacters(ctx, input)` returns the existing `Result` envelope around the types below. HTTP operation ID: `get_campaigns_id_claimable_characters`. HTTP response adds the usual `requestId`; the Module result does not.

```ts
type ListClaimableCharactersInput = {
  campaignId: string;
  limit?: number;
  cursor?: string | null;
};
type ClaimableCharacterSummary = {
  characterId: string;
  name: string;
  revision: number;
  lifecycle: "active" | "archived";
};
type ListClaimableCharactersResult = {
  characters: ClaimableCharacterSummary[];
  nextCursor: string | null;
};
```

- [ ] Extend the existing I6 HTTP acceptance fixture: invite `h.users.player` as `player`, create a campaign character as GM, and designate that player through the real assignment command. Before designation, discovery is empty; after designation, the player learns the ID/revision only through the new read. Reuse `buildI6Harness`, `ctxFor`, and existing fixture setup; close each isolated-schema harness.

```ts
const response = await h.app.inject({
  method: "GET",
  url: `/campaigns/${campaignId}/claimable-characters?limit=1`,
  headers: { cookie: h.users.player.cookie },
});
expect(response.statusCode).toBe(200);
const row = response.json().characters[0];
expect(Object.keys(row).sort()).toEqual(["characterId", "lifecycle", "name", "revision"]);
expect((await h.characters.open(ctxFor(h.users.player), row.characterId)).ok).toBe(false);
```

- [ ] Run the targeted integration files with `TEST_DATABASE_URL` set and `--no-file-parallelism`; confirm the new endpoint/behavior is absent, not that the suite skipped.
- [ ] Implement one Campaigns-owned authorized read. Use SQL `EXISTS` on current-actor designations and `NOT EXISTS` for current controllers, with character/campaign IDs matched on every predicate. Apply authorization before `LIMIT`; order by an existing stable timestamp plus character ID, returning only the four public fields. Bind cursors to actor, campaign, and this query family. Reuse established default/max page limits and reject invalid/cross-scope cursors.
- [ ] Test unauthorized IDs, another designee, inactive/removed membership, leave/rejoin, designation consumed by claim, overlap without duplicate rows, archived lifecycle display, and interleaved unauthorized rows across pages. Keep the existing multi-controller command behavior: consuming one actor's designation does not erase other actors' designations. Deny pre-claim sheet read/export/activity/mutation through real existing routes.
- [ ] Add transport validation/mapping tests for 401, 404, page bounds and exact response fields. Run `npm run contracts:generate`, `npm run contracts:check`, root typecheck, and targeted HTTP/integration suites. Verify existing `GET /campaigns/{id}/characters` output and authorization are unchanged.

## Task 2: Deliver the Ordinary-Player Claim Journey

**Files:** Modify `web/src/campaigns/api.ts`, `types.ts`, `api.test.ts`, `campaignQueries.ts`, `campaignQueries.test.tsx`, `CampaignCharacters.tsx`, `CampaignCharacters.test.tsx`, `CampaignDetail.tsx`, `CampaignDetail.session.test.tsx`, `SessionBoard.tsx`, `SessionBoard.test.tsx`, `web/src/i18n/messages.ts`, and `web/tests/e2e/campaignJourney.spec.ts`.

**Interfaces:** Add `CampaignsApi.listClaimableCharacters(campaignId, input?)` returning the generated operation response. Add a distinct query prefix `['campaigns', 'claimable-characters', campaignId, actorId, generation]`; use infinite-query paging with limit 25. Reuse `claimCharacter` without changing its body.

- [ ] Add API serialization and component regressions: designated-only row has a Claim action and custody confirmation, but no Open button, controller count, or sheet preload. Use real generated response types rather than `claimable` properties hidden by `as never`. Archived entries carry a clear unavailable explanation and no claim action, preserving current UI behavior.

```tsx
expect(await screen.findByRole("button", { name: /claim bram/i })).toBeVisible();
expect(screen.queryByRole("button", { name: /open bram/i })).toBeNull();
expect(charactersApi.open).not.toHaveBeenCalled();
```

- [ ] Implement a separate claim-discovery section inside the existing character tab, not a second sheet renderer. Paginate it; show loading, empty, offline, failure/retry states. Resolve the confirmation target from a claim-summary row, not the old full-roster-only array. Remove guessed claimability based solely on `!controlled` from roster rows; if a GM roster row is also designated, use membership in the new server-returned discovery set to offer Claim.
- [ ] After successful claim, refresh both discovery and ordinary roster plus campaign revision before enabling next commands/Open. After 409, await fresh campaign and claim-summary revisions before explicit retry. On 404, remove the discovery row without relabeling it view-only. Scope new keys by actor/generation, purge on leave/revocation/sign-out, cancel or reject late responses, and test account A to B on one QueryClient.
- [ ] Thread `generation` and `online` from `CampaignDetail` into the character tab for query gating. Scope the existing roster key consistently in both `CampaignCharactersTab` and `SessionBoard`, since refreshed control status is actor-dependent. Use `campaignCharactersKey(campaignId, actorId, generation)` for reads and the explicit `['campaigns', 'characters', campaignId]` prefix for campaign-wide purge; update all callers/tests rather than retaining an unscoped default cache. Do not change roster HTTP authorization while changing cache keys.
- [ ] Change the browser invitation role to actual `player`, remove the co-GM workaround/comment, and claim using the discovered row. Keep a GM context only for authoritative designation setup; do not feed its character ID into the player UI or grant the player a GM session. Assert no pre-claim sheet request and generic 404 for direct access, then successful sheet open after claim. Exercise a second player without a designation and membership removal.
- [ ] Run targeted component/API tests, full web typecheck, the complete campaign journey twice, and the existing backend authorization matrix. Integrate sequentially with the recovery plan's shared API/schema edits. Record acceptance only after the player-role journey passes.
