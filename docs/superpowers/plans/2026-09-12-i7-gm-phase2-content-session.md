# I7 GM Phase 2 (Content + Session) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A GM authors campaign text content with audience grants and reveal/hide controls, and runs a live session from a mobile Session view with latest content, recent activity, quick character access, one-tap resource bumps, and audience-scoped rolls.

**Architecture:** Extend the `web/src/campaigns/` seam with content CRUD/grant wrappers plus two thin online-only `CharactersApi` wrappers (resource bump, action execute) that use the existing HTTP audience/revision contracts without touching the I4 character session queue; add `ContentEditor` (create/edit/audience/grants/delete/recover) mounted in the Content tab for GMs, and a composed `SessionBoard` (latest content + recent activity + searchable character directory with expandable bump/roll rows) mounted as a GM-gated Session tab, polling existing reads on a fixed interval with a manual refresh.

**Tech Stack:** React + TypeScript, TanStack Router/Query, CSS modules, `web/src/ui/` shared controls, generated `web/src/api/schema.d.ts` (`operations`) — consuming only, no schema edit expected.

**Spec:** `docs/superpowers/specs/2026-09-11-i7-gm-app-design.md` (Phase 2 section; approach A).

## Global Constraints

- One deployable artifact; no new backend routes, no package-format change, no second character renderer (sheets keep opening via the existing `onOpenCharacter` seam; the I4 session queue is untouched — the two new thin wrappers are online-only and documented as GM session-board use).
- All campaign/character reads/writes go through `ApiClient` (`credentials:include`, `x-request-id`, JSON bodies even for DELETEs).
- Every mutation sends a caller-minted `idempotencyKey` (UUID); after any `409`, re-read then mint a fresh key — never reuse.
- `409 conflict` carries `latestRevision`; surface explicit retry/reload, never "Merge".
- Query keys always include actor + generation: `["campaigns", ..., actorId, generation, ...]`; `enabled` requires `actorId !== null && online`; sign-out/account-switch relies on AppShell `cancelQueries/removeQueries` + lifetime remount `key=`.
- Shared controls (`Button, Panel, PageHeader, EmptyState, FormField, Select, Checkbox, Dialog, Tabs`) for all new surfaces; controls never decide authorization — server 404/409s render as unavailable/conflict states.
- No `campaign` string in `web/src/player/` — all new code lives in `web/src/campaigns/` + `router.tsx` (no router change expected; tab wiring only in `CampaignDetail.tsx`) + `web/src/i18n/messages.ts` keys only.
- TDD red-green per task; `npm run contracts:check` stays green (no schema edit expected — consuming only).
- New i18n keys ship in the same task as the component that uses them.
- Ruling (no content-pinning contract): the backend has no pinned flag on content (verified in `get_campaigns_id_content`/`get_content_id` schemas and all UI — no `pinned` field exists), so the spec's "pinned content" ships as a "Latest content" section (first page of the audience-filtered list). True pinning is deferred, not faked with a tag convention.

---

## File map

| File | Responsibility |
| --- | --- |
| `web/src/campaigns/types.ts` (modify) | Derived types for content create/update/delete/recover/grants + bump/execute bodies |
| `web/src/campaigns/api.ts` (modify) | Thin `createContent`, `updateContent`, `deleteContent`, `recoverContent`, `replaceContentGrants` wrappers; export `ContentListQuery`/`ActivityListQuery` |
| `web/src/characters/api.ts` (modify) | Thin online-only `bumpCharacterResource`, `executeCharacterAction` wrappers |
| `web/src/characters/api.test.ts` (modify) | Wrapper contract tests for the two new methods |
| `web/src/campaigns/api.test.ts` (modify) | Wrapper contract tests for the five content methods |
| `web/src/campaigns/ContentEditor.tsx` (create) | Create/edit form: title/body/tags/audience/grants + delete/recover with confirmations |
| `web/src/campaigns/ContentEditor.test.tsx` (create) | Bodies, revision + fresh-key, grant replacement, delete/recover tests |
| `web/src/campaigns/CampaignContent.tsx` (modify) | GM authoring mount: `ContentEditor` + per-item edit/grant/delete actions for GMs |
| `web/src/campaigns/SessionBoard.tsx` (create) | Latest content + recent activity + searchable directory + expandable bump/roll rows |
| `web/src/campaigns/SessionBoard.test.tsx` (create) | Composition, search filter, bump bodies, audience roll bodies, polling tests |
| `web/src/campaigns/CampaignDetail.tsx` (modify) | GM-gated Session tab; revocation purge of session keys |
| `web/src/i18n/messages.ts` (modify) | New `campaign.detail.content.edit.*`, `campaign.detail.session.*` keys |
| `web/tests/e2e/gmSessionJourney.spec.ts` (create) | Phase 2 exit e2e at phone + desktop viewports |
| `docs/acceptance/gui-2026-09-12-g7-gm-phase2.md` (create) | Acceptance record for this phase |

---

### Task 1: Content + character-action API seam extensions

**Files:**
- Modify: `web/src/campaigns/types.ts`
- Modify: `web/src/campaigns/api.ts`
- Modify: `web/src/campaigns/api.test.ts`
- Modify: `web/src/characters/api.ts`
- Modify: `web/src/characters/api.test.ts`

**Interfaces:**
- Consumes: `ApiClient.fetch`; `operations` from `web/src/api/schema.js`.
- Produces (used by Tasks 2–3): `CreateContentBody`, `CreateContentResponse`, `UpdateContentBody`, `DeleteContentBody`, `RecoverContentBody`, `ReplaceGrantsBody` types; `CampaignsApi.createContent/updateContent/deleteContent/recoverContent/replaceContentGrants`; exported `ContentListQuery`/`ActivityListQuery` types; `CharactersApi.bumpCharacterResource/executeCharacterAction` + `BumpCharacterResourceBody`, `ExecuteCharacterActionBody`, `BumpCharacterResourceResponse`, `ExecuteCharacterActionResponse` types.

Verified operation IDs and shapes (`web/src/api/schema.d.ts`): `post_campaigns_id_content` (body `{title?, body?, tags?, audience?: "gm_only"|"all_players"|"selected_players"|"owner_only", grantedUserIds?, idempotencyKey}`); `patch_content_id` (body `{title?, body?, tags?, audience?, expectedContentRevision, idempotencyKey}`); `delete_content_id` (body `{expectedContentRevision, idempotencyKey}` — JSON DELETE body); `post_content_id_recover` (body `{expectedContentRevision, idempotencyKey}`); `post_content_id_grants` (body `{grantedUserIds, expectedContentRevision, idempotencyKey}`); `post_characters_characterId_resources_resourceId_bump` (body `{direction: "up"|"down", expectedRevision, idempotencyKey}`); `post_characters_characterId_actions_actionId` (body `{inputs?, audience?: "owner_only"|"gm_only"|"campaign", expectedRevision, idempotencyKey}`).

- [ ] **Step 1: Write the failing api tests**

```tsx
// Append to web/src/campaigns/api.test.ts
describe("createCampaignsApi GM content", () => {
  it("creates content with audience and idempotency key", async () => {
    const fetch = vi.fn().mockResolvedValue({ content: { contentId: "n1" }, requestId: "r1" });
    const api = createCampaignsApi({ fetch } as never);
    await api.createContent("c1", { title: "Briefing", body: "Meet at dusk.", audience: "all_players", idempotencyKey: "k1" });
    expect(fetch).toHaveBeenCalledWith("POST", "/campaigns/c1/content", {
      body: { title: "Briefing", body: "Meet at dusk.", audience: "all_players", idempotencyKey: "k1" },
    });
  });

  it("replaces grants atomically with revision + fresh key", async () => {
    const fetch = vi.fn().mockResolvedValue({ content: { contentId: "n1" }, requestId: "r2" });
    const api = createCampaignsApi({ fetch } as never);
    await api.replaceContentGrants("n1", { grantedUserIds: ["u2"], expectedContentRevision: 3, idempotencyKey: "k2" });
    expect(fetch).toHaveBeenCalledWith("POST", "/content/n1/grants", {
      body: { grantedUserIds: ["u2"], expectedContentRevision: 3, idempotencyKey: "k2" },
    });
  });

  it("deletes content with the revision body on the DELETE", async () => {
    const fetch = vi.fn().mockResolvedValue({ content: { contentId: "n1" }, requestId: "r3" });
    const api = createCampaignsApi({ fetch } as never);
    await api.deleteContent("n1", { expectedContentRevision: 3, idempotencyKey: "k3" });
    expect(fetch).toHaveBeenCalledWith("DELETE", "/content/n1", {
      body: { expectedContentRevision: 3, idempotencyKey: "k3" },
    });
  });
});
```

```ts
// Append to web/src/characters/api.test.ts (check its existing import/describe shape first and match it)
describe("CharactersApi GM session-board wrappers", () => {
  it("bumps a resource with direction, revision, and key", async () => {
    const fetch = vi.fn().mockResolvedValue({ result: {}, requestId: "r1" });
    const api = createCharactersApi({ fetch } as never);
    await api.bumpCharacterResource("s1", "hp", { direction: "down", expectedRevision: 4, idempotencyKey: "k1" });
    expect(fetch).toHaveBeenCalledWith("POST", "/characters/s1/resources/hp/bump", {
      body: { direction: "down", expectedRevision: 4, idempotencyKey: "k1" },
    });
  });

  it("executes an action with audience, revision, and key", async () => {
    const fetch = vi.fn().mockResolvedValue({ result: {}, requestId: "r2" });
    const api = createCharactersApi({ fetch } as never);
    await api.executeCharacterAction("s1", "a1", { audience: "campaign", expectedRevision: 4, idempotencyKey: "k2" });
    expect(fetch).toHaveBeenCalledWith("POST", "/characters/s1/actions/a1", {
      body: { audience: "campaign", expectedRevision: 4, idempotencyKey: "k2" },
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix web run test -- src/campaigns/api.test.ts src/characters/api.test.ts`
Expected: FAIL with `api.createContent is not a function` (and the other methods missing).

- [ ] **Step 3: Write minimal types + implementation**

```ts
// Append to web/src/campaigns/types.ts
export type CreateContentBody = NonNullable<
  operations["post_campaigns_id_content"]["requestBody"]
>["content"]["application/json"];
export type CreateContentResponse =
  operations["post_campaigns_id_content"]["responses"]["201"]["content"]["application/json"];

export type UpdateContentBody = NonNullable<
  operations["patch_content_id"]["requestBody"]
>["content"]["application/json"];

export type DeleteContentBody = NonNullable<
  operations["delete_content_id"]["requestBody"]
>["content"]["application/json"];

export type RecoverContentBody = NonNullable<
  operations["post_content_id_recover"]["requestBody"]
>["content"]["application/json"];

export type ReplaceGrantsBody = NonNullable<
  operations["post_content_id_grants"]["requestBody"]
>["content"]["application/json"];
```

```ts
// In web/src/campaigns/api.ts: change `type ContentListQuery` → `export type ContentListQuery`
// and `type ActivityListQuery` → `export type ActivityListQuery` (same shapes).
// Append to the CampaignsApi type:
  createContent(campaignId: string, body: CreateContentBody): Promise<CreateContentResponse>;
  updateContent(contentId: string, body: UpdateContentBody): Promise<CampaignContentResponse>;
  deleteContent(contentId: string, body: DeleteContentBody): Promise<unknown>;
  recoverContent(contentId: string, body: RecoverContentBody): Promise<unknown>;
  replaceContentGrants(contentId: string, body: ReplaceGrantsBody): Promise<unknown>;
// Append to the object returned by createCampaignsApi:
    createContent: (campaignId, body) =>
      client.fetch<CreateContentResponse>("POST", `/campaigns/${campaignId}/content`, { body }),
    updateContent: (contentId, body) =>
      client.fetch<CampaignContentResponse>("PATCH", `/content/${contentId}`, { body }),
    deleteContent: (contentId, body) =>
      client.fetch("DELETE", `/content/${contentId}`, { body }),
    recoverContent: (contentId, body) =>
      client.fetch("POST", `/content/${contentId}/recover`, { body }),
    replaceContentGrants: (contentId, body) =>
      client.fetch("POST", `/content/${contentId}/grants`, { body }),
```

```ts
// In web/src/characters/api.ts, add to the CharactersApi type (beside listCharacters):
  bumpCharacterResource(
    characterId: string,
    resourceId: string,
    body: BumpCharacterResourceBody,
  ): Promise<BumpCharacterResourceResponse>;
  executeCharacterAction(
    characterId: string,
    actionId: string,
    body: ExecuteCharacterActionBody,
  ): Promise<ExecuteCharacterActionResponse>;
// Types (add near DuplicateCharacterBody in web/src/characters/types.ts,
// derived from operations — never hand-written shapes):
export type BumpCharacterResourceBody = NonNullable<
  operations["post_characters_characterId_resources_resourceId_bump"]["requestBody"]
>["content"]["application/json"];
export type BumpCharacterResourceResponse =
  operations["post_characters_characterId_resources_resourceId_bump"]["responses"]["200"]["content"]["application/json"];
export type ExecuteCharacterActionBody = NonNullable<
  operations["post_characters_characterId_actions_actionId"]["requestBody"]
>["content"]["application/json"];
export type ExecuteCharacterActionResponse =
  operations["post_characters_characterId_actions_actionId"]["responses"]["200"]["content"]["application/json"];
// Implementation (beside duplicateCharacter in createCharactersApi):
// ONLINE-ONLY GM session-board wrappers: they call the same HTTP contracts
// as the character session queue but bypass the offline durable queue.
// The player sheet keeps using the session; these must never be used
// while offline (callers gate on `online`).
    bumpCharacterResource: (characterId, resourceId, body) =>
      client.fetch<BumpCharacterResourceResponse>("POST", `/characters/${characterId}/resources/${resourceId}/bump`, { body }),
    executeCharacterAction: (characterId, actionId, body) =>
      client.fetch<ExecuteCharacterActionResponse>("POST", `/characters/${characterId}/actions/${actionId}`, { body }),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix web run test -- src/campaigns/api.test.ts src/characters/api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/campaigns/types.ts web/src/campaigns/api.ts web/src/campaigns/api.test.ts web/src/characters/types.ts web/src/characters/api.ts web/src/characters/api.test.ts
git commit -m "feat(g7): extend API seams with GM content and session-board ops"
```

---

### Task 2: ContentEditor + Content tab GM authoring

**Files:**
- Create: `web/src/campaigns/ContentEditor.tsx`
- Create: `web/src/campaigns/ContentEditor.test.tsx`
- Modify: `web/src/campaigns/CampaignContent.tsx`
- Modify: `web/src/i18n/messages.ts` (add `campaign.detail.content.edit.*` keys)

**Interfaces:**
- Consumes: `CampaignsApi.createContent/updateContent/deleteContent/recoverContent/replaceContentGrants` (Task 1); `CampaignMember` (roster for grant selection); `ContentSummary`/`ContentView`; `audienceLabel` (existing).
- Produces: `ContentEditor({api, campaignId, members, initial?, onSaved, onDeleted})`, `ContentAuthoringSection` mount inside `CampaignContentTab` for `isGm` (used by Task 4 wiring — the tab gains optional GM props; Task 4 passes them).

Behavior: create form (title, body textarea, tags comma input, audience `Select` of the four levels, granted-user `Checkbox` list from active roster members shown only when audience is `selected_players`); edit loads `initial: ContentView` (title/body/tags/audience) and sends only changed fields + `expectedContentRevision: initial.revision` + fresh key; grants save sends the full replacement `{grantedUserIds, expectedContentRevision, idempotencyKey}` (atomic replacement — the UI always sends the complete checked set, never deltas); delete/recover behind confirm `Dialog`s (delete description states the note is hidden and recoverable; recover only offered for deleted items the GM can still read). Every 409 → parent `onChanged` (list refetch) + conflict notice + fresh-key retry. Error paths render generic text only, never server payloads (mirror the file header discipline at `CampaignContent.tsx:1-5`).

`CampaignContentTab` gains optional props `{ campaignRevision?: number; actorId?: string | null; generation?: number; online?: boolean; isGm?: boolean; members?: CampaignMember[]; onChanged?: () => void }` defaulting to player behavior (no authoring) when `isGm` is falsy — existing callers keep compiling. When `isGm`, render `ContentEditor` (create) above the list and per-item Edit/Delete controls opening the editor prefilled / confirm dialogs. After any mutation, invalidate `campaignContentKey(campaignId)` and call `onChanged`.

i18n keys: `campaign.detail.content.edit.createTitle: "New note"`, `campaign.detail.content.edit.titleLabel: "Title"`, `campaign.detail.content.edit.bodyLabel: "Body"`, `campaign.detail.content.edit.tagsLabel: "Tags (comma-separated, optional)"`, `campaign.detail.content.edit.audienceLabel: "Audience"`, `campaign.detail.content.edit.grantsLabel: "Share with (selected players)"`, `campaign.detail.content.edit.save: "Save note"`, `campaign.detail.content.edit.saving: "Saving…"`, `campaign.detail.content.edit.saved: "Note saved."`, `campaign.detail.content.edit.editItem: "Edit {title}"`, `campaign.detail.content.edit.delete: "Hide {title}"`, `campaign.detail.content.edit.delete.confirm.title: "Hide this note?"`, `campaign.detail.content.edit.delete.confirm.description: "The note is hidden from its audience and can be recovered later."`, `campaign.detail.content.edit.delete.confirm.confirm: "Confirm hiding"`, `campaign.detail.content.edit.recover: "Recover {title}"`, `campaign.detail.content.edit.recover.confirm.title: "Recover this note?"`, `campaign.detail.content.edit.recover.confirm.confirm: "Confirm recovery"`, `campaign.detail.content.edit.conflict: "This note changed. The list was reloaded — review and retry."`, `campaign.detail.content.edit.error: "Saving failed. Try again."`.

- [ ] **Step 1: Write the failing component test**

```tsx
// web/src/campaigns/ContentEditor.test.tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ContentEditor } from "./ContentEditor.js";

const members = [
  { campaignId: "c1", userId: "u2", role: "player", status: "active", generation: 1, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" },
];

describe("ContentEditor", () => {
  it("creates a note with audience and fresh idempotency key", async () => {
    const api = { createContent: vi.fn().mockResolvedValue({ content: { contentId: "n1" }, requestId: "r" }) };
    const onSaved = vi.fn();
    render(<ContentEditor api={api as never} campaignId="c1" members={members as never} onSaved={onSaved} onDeleted={() => {}} />);
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "Briefing" } });
    fireEvent.change(screen.getByLabelText(/body/i), { target: { value: "Meet at dusk." } });
    fireEvent.click(screen.getByRole("button", { name: /save note/i }));
    await vi.waitFor(() => expect(api.createContent).toHaveBeenCalled());
    expect(api.createContent).toHaveBeenCalledWith("c1", expect.objectContaining({
      title: "Briefing",
      body: "Meet at dusk.",
      audience: "gm_only",
    }));
    const body = (api.createContent as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(typeof body.idempotencyKey).toBe("string");
    expect(onSaved).toHaveBeenCalled();
  });

  it("replaces grants with the complete checked set", async () => {
    const api = { replaceContentGrants: vi.fn().mockResolvedValue({ content: {}, requestId: "r" }) };
    const initial = { contentId: "n1", campaignId: "c1", audience: "selected_players", title: "Plan", body: "Shh.", tags: [], revision: 3, grantedUserIds: [] };
    render(<ContentEditor api={api as never} campaignId="c1" members={members as never} initial={initial as never} onSaved={() => {}} onDeleted={() => {}} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /u2/i }));
    fireEvent.click(screen.getByRole("button", { name: /save note/i }));
    await vi.waitFor(() => expect(api.replaceContentGrants).toHaveBeenCalledWith("n1", expect.objectContaining({
      grantedUserIds: ["u2"],
      expectedContentRevision: 3,
    })));
  });

  it("hides a note behind a confirmation dialog", async () => {
    const api = { deleteContent: vi.fn().mockResolvedValue({ content: {}, requestId: "r" }) };
    const initial = { contentId: "n1", campaignId: "c1", audience: "all_players", title: "Plan", body: "Shh.", tags: [], revision: 3, grantedUserIds: [] };
    const onDeleted = vi.fn();
    render(<ContentEditor api={api as never} campaignId="c1" members={members as never} initial={initial as never} onSaved={() => {}} onDeleted={onDeleted} />);
    fireEvent.click(screen.getByRole("button", { name: /hide /i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm hiding/i }));
    await vi.waitFor(() => expect(api.deleteContent).toHaveBeenCalledWith("n1", expect.objectContaining({
      expectedContentRevision: 3,
    })));
    expect(onDeleted).toHaveBeenCalled();
  });
});
```

Default audience for creates is `gm_only` (the GM default per backend spec §4.1 — the UI preselects it; the server remains authoritative).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix web run test -- src/campaigns/ContentEditor.test.tsx`
Expected: FAIL with "Cannot find module './ContentEditor.js'".

- [ ] **Step 3: Write minimal component + tab mount**

`ContentEditor` mirrors `CampaignSettingsView`'s mutation shape (per-action pending/conflict/error, fresh `crypto.randomUUID()`, 409 → `onChanged` + conflict notice). Audience `Select` options reuse `audienceLabel` for the four `ContentAudience` values. Grant checkboxes keyed by `member.userId` with visible label — the roster carries no display names in `CampaignMember`, so label checkboxes by userId short id (`userId.slice(0, 8)`) with full id as accessible description; do not invent names. Tags input parses comma-separated text into `string[]`, omitting the field when empty on create.

Tab mount: extend `CampaignContentTab` props as specified; the GM branch renders `<ContentEditor api campaignId members onSaved={reload} onDeleted={reload} />` where `reload` invalidates `campaignContentKey(campaignId)` + calls `props.onChanged?.()`. Per-item Edit opens the editor with `initial` (fetch the full view via `openContent` first — the list summary has no body/grants); per-item Hide opens the delete confirm (needs the item revision → fetch view first as well). Check `Checkbox`'s label contract in `web/src/ui/` before wiring (avoid double-labeling per the Phase 1 rule).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix web run test -- src/campaigns/ContentEditor.test.tsx src/campaigns/CampaignContent.test.tsx`
Expected: PASS (existing content tests unbroken — the tab defaults to player behavior).

- [ ] **Step 5: Commit**

```bash
git add web/src/campaigns/ContentEditor.tsx web/src/campaigns/ContentEditor.test.tsx web/src/campaigns/CampaignContent.tsx web/src/i18n/messages.ts
git commit -m "feat(g7): add GM content authoring with audience grants"
```

---

### Task 3: SessionBoard (latest content, activity, directory, bumps, rolls)

**Files:**
- Create: `web/src/campaigns/SessionBoard.tsx`
- Create: `web/src/campaigns/SessionBoard.test.tsx`
- Modify: `web/src/i18n/messages.ts` (add `campaign.detail.session.*` keys)

**Interfaces:**
- Consumes: `CampaignsApi.listContent/listActivity/listCampaignCharacters/openCampaign` + `CharactersApi.open/bumpCharacterResource/executeCharacterAction` (Task 1); `CampaignMember` roster (for controller names? roster gives userIds only — display controller counts, not names); `onOpenCharacter` navigation seam.
- Produces: `SessionBoard({campaignsApi, charactersApi, campaignId, actorId, generation, online, onOpenCharacter, onAccessRevoked})` (mounted by Task 4 in a GM-gated Session tab).

Sections (all read-only except where noted; 404 on any feed → `onAccessRevoked`):
1. **Latest content**: `listContent(campaignId, { limit: 10 })` under key `["campaigns", "session", campaignId, actorId, generation, "content"]`, rows with persistent `audienceLabel` marks (reuse the function, not a copy).
2. **Recent activity**: `listActivity(campaignId, { limit: 20 })` under the matching `"activity"` key, rendering kind + actor + timestamp only (reuse `activityKindLabel` from `CampaignActivity.tsx` — import it; do not duplicate the mapping).
3. **Character directory**: `listCampaignCharacters` full list (existing `campaignCharactersKey` + same query shape as `CampaignCharactersTab` to share cache), client-side name filter input, rows with name + controller count + Open button; expanding a row loads `charactersApi.open(characterId)` once and derives bump/roll targets from `character.projection.sheets[].sections[].elements[]`.
4. **Bump rows**: resource elements `{kind: "resource", resourceId, label, value: {current, max}, min, max}` render label + `current/max` + down/up buttons (disabled at min/max, mirroring `CharacterSheet.tsx:186`); each bump calls `bumpCharacterResource(characterId, resourceId, { direction, expectedRevision: character.revision, idempotencyKey: crypto.randomUUID() })` with per-row pending/conflict/error; success refetches the sheet; 409 refetches + conflict notice + fresh-key retry.
5. **Roll rows**: action elements `{kind: "action", actionId, label, inputs}` with an audience `Select` (owner_only/gm_only/campaign, default `campaign`) + Execute button. Actions WITH required inputs (`inputs.some((i) => i.required)`) render "open the sheet to roll" linking via `onOpenCharacter` instead of an Execute button — the board never fabricates required inputs. Execute calls `executeCharacterAction(characterId, actionId, { audience, expectedRevision, idempotencyKey })`; the returned roll result renders kind-agnostically (result text via `String(result.roll ?? result)` — never assume payload shape; on unparseable success, show the generic uncertain-outcome text and keep the attempt, mirroring the `malformed_response` discipline).
6. **Refresh**: manual Refresh button refetching all feeds + `refetchInterval: 15_000` while `online` (pass `refetchInterval: props.online ? 15_000 : false`); polling refetches queries only and never resets local bump/roll row state (row state lives in per-row child components keyed by characterId).

i18n keys: `campaign.detail.session.title: "Session"`, `campaign.detail.session.refresh: "Refresh"`, `campaign.detail.session.contentHeading: "Latest content"`, `campaign.detail.session.activityHeading: "Recent activity"`, `campaign.detail.session.charactersHeading: "Characters"`, `campaign.detail.session.search.label: "Filter characters"`, `campaign.detail.session.search.placeholder: "Name contains…"`, `campaign.detail.session.open: "Open {name}"`, `campaign.detail.session.controllers: "{count} controllers"`, `campaign.detail.session.bump.down: "Decrease {label}"`, `campaign.detail.session.bump.up: "Increase {label}"`, `campaign.detail.session.bump.conflict: "{label} changed. Reloaded — retry the bump."`, `campaign.detail.session.roll.audience: "Roll audience"`, `campaign.detail.session.roll.execute: "Roll {label}"`, `campaign.detail.session.roll.openSheet: "Open the sheet to roll {label}"`, `campaign.detail.session.roll.uncertain: "The roll may have applied. Reload the character before retrying."`, `campaign.detail.session.roll.error: "The roll failed. Try again."`, `campaign.detail.session.loading: "Loading session…"`, `campaign.detail.session.loadFailed: "Session data could not be loaded."`, `campaign.detail.session.offline: "You are offline. Session data may be stale."`.

- [ ] **Step 1: Write the failing component test**

```tsx
// web/src/campaigns/SessionBoard.test.tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { SessionBoard } from "./SessionBoard.js";

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const sheet = (overrides = {}) => ({
  characterId: "s1", ownerId: null, campaignId: "c1", controllers: [], placementGeneration: 1,
  returnOwnerId: null, name: "Bram", systemVersionId: "v1", entityDefinitionId: "hero",
  revision: 7, lifecycle: "active", archivedAt: null,
  createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
  state: { schemaVersion: "1.0", values: {} }, derivedValues: {},
  validations: [],
  projection: {
    projectionVersion: "1.0", systemId: "s", versionId: "v1", packageChecksum: "p",
    entityId: "hero", entityLabel: "Hero",
    sheets: [{ id: "sh", label: "Sheet", sections: [{ id: "sec", label: "Sec", elements: [
      { kind: "resource", id: "e1", resourceId: "hp", label: "Health", value: { current: 3, max: 5 }, min: 0, max: 5, step: 1, resetTo: "max", validations: [] },
      { kind: "action", id: "e2", actionId: "a1", label: "Strike", actionKind: "roll", inputs: [], validations: [] },
    ] }] }],
    derivedValues: {}, validations: [],
  },
  reconciliation: { characterId: "s1", baseRevision: null, revision: 7 },
  ...overrides,
});

describe("SessionBoard", () => {
  it("bumps a resource with revision + fresh key and reloads the sheet", async () => {
    const campaignsApi = {
      listContent: vi.fn().mockResolvedValue({ content: [], nextCursor: null, requestId: "r0" }),
      listActivity: vi.fn().mockResolvedValue({ events: [], nextCursor: null, requestId: "r1" }),
      listCampaignCharacters: vi.fn().mockResolvedValue({ characters: [
        { characterId: "s1", campaignId: "c1", name: "Bram", entityDefinitionId: "hero", systemVersionId: "v1", revision: 7, lifecycle: "active", placementGeneration: 1, controllers: [], updatedAt: "2026-09-01T00:00:00Z" },
      ], nextCursor: null, requestId: "r2" }),
    };
    const charactersApi = {
      open: vi.fn().mockResolvedValue({ character: sheet(), requestId: "r3" }),
      bumpCharacterResource: vi.fn().mockResolvedValue({ result: {}, requestId: "r4" }),
    };
    render(<SessionBoard campaignsApi={campaignsApi as never} charactersApi={charactersApi as never}
      campaignId="c1" actorId="u1" generation={0} online onOpenCharacter={() => {}} onAccessRevoked={() => {}} />,
      { wrapper: wrapper() });
    fireEvent.click(await screen.findByRole("button", { name: /bram/i }));
    fireEvent.click(await screen.findByRole("button", { name: /increase health/i }));
    await vi.waitFor(() => expect(charactersApi.bumpCharacterResource).toHaveBeenCalledWith("s1", "hp", expect.objectContaining({
      direction: "up",
      expectedRevision: 7,
    })));
    const body = (charactersApi.bumpCharacterResource as ReturnType<typeof vi.fn>).mock.calls[0]![2];
    expect(typeof body.idempotencyKey).toBe("string");
  });

  it("filters the directory by name without new requests", async () => {
    const campaignsApi = {
      listContent: vi.fn().mockResolvedValue({ content: [], nextCursor: null, requestId: "r0" }),
      listActivity: vi.fn().mockResolvedValue({ events: [], nextCursor: null, requestId: "r1" }),
      listCampaignCharacters: vi.fn().mockResolvedValue({ characters: [
        { characterId: "s1", campaignId: "c1", name: "Bram", entityDefinitionId: "hero", systemVersionId: "v1", revision: 7, lifecycle: "active", placementGeneration: 1, controllers: [], updatedAt: "2026-09-01T00:00:00Z" },
        { characterId: "s2", campaignId: "c1", name: "Mira", entityDefinitionId: "hero", systemVersionId: "v1", revision: 2, lifecycle: "active", placementGeneration: 1, controllers: [], updatedAt: "2026-09-01T00:00:00Z" },
      ], nextCursor: null, requestId: "r2" }),
    };
    const charactersApi = { open: vi.fn() };
    render(<SessionBoard campaignsApi={campaignsApi as never} charactersApi={charactersApi as never}
      campaignId="c1" actorId="u1" generation={0} online onOpenCharacter={() => {}} onAccessRevoked={() => {}} />,
      { wrapper: wrapper() });
    await screen.findByRole("button", { name: /mira/i });
    fireEvent.change(screen.getByLabelText(/filter characters/i), { target: { value: "bram" } });
    expect(screen.queryByRole("button", { name: /mira/i })).toBeNull();
    expect(screen.getByRole("button", { name: /bram/i })).toBeVisible();
    expect(campaignsApi.listCampaignCharacters).toHaveBeenCalledTimes(1);
  });

  it("rolls with the selected audience and fresh key", async () => {
    const campaignsApi = {
      listContent: vi.fn().mockResolvedValue({ content: [], nextCursor: null, requestId: "r0" }),
      listActivity: vi.fn().mockResolvedValue({ events: [], nextCursor: null, requestId: "r1" }),
      listCampaignCharacters: vi.fn().mockResolvedValue({ characters: [
        { characterId: "s1", campaignId: "c1", name: "Bram", entityDefinitionId: "hero", systemVersionId: "v1", revision: 7, lifecycle: "active", placementGeneration: 1, controllers: [], updatedAt: "2026-09-01T00:00:00Z" },
      ], nextCursor: null, requestId: "r2" }),
    };
    const charactersApi = {
      open: vi.fn().mockResolvedValue({ character: sheet(), requestId: "r3" }),
      executeCharacterAction: vi.fn().mockResolvedValue({ result: { roll: "13" }, requestId: "r4" }),
    };
    render(<SessionBoard campaignsApi={campaignsApi as never} charactersApi={charactersApi as never}
      campaignId="c1" actorId="u1" generation={0} online onOpenCharacter={() => {}} onAccessRevoked={() => {}} />,
      { wrapper: wrapper() });
    fireEvent.click(await screen.findByRole("button", { name: /bram/i }));
    fireEvent.click(await screen.findByRole("button", { name: /roll strike/i }));
    await vi.waitFor(() => expect(charactersApi.executeCharacterAction).toHaveBeenCalledWith("s1", "a1", expect.objectContaining({
      audience: "campaign",
      expectedRevision: 7,
    })));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix web run test -- src/campaigns/SessionBoard.test.tsx`
Expected: FAIL with "Cannot find module './SessionBoard.js'".

- [ ] **Step 3: Write minimal component**

Structure (three presentational sections + per-character expandable row component in the same file; row state isolated per characterId so polling never resets it):
- `SessionBoard` owns the three feed queries (content limit 10, activity limit 20, characters full list via `campaignCharactersKey` shape for cache sharing) with `refetchInterval: props.online ? 15_000 : false`, offline notice when `!props.online`, manual Refresh button calling all three `refetch()`s.
- Character rows: expand-on-click loads `open()` once (cache per characterId in the same query client under `["campaigns", "session", campaignId, actorId, generation, "sheet", characterId]`); derive resource/action elements by filtering `element.kind`.
- Bump/roll mutations mirror `attemptClaim` (fresh key, 409 → sheet refetch + conflict notice, other errors → generic text). Bump buttons disabled at min/max and while offline (online-only wrappers). Roll audience `Select` defaults to `campaign`.
- Reuse, don't duplicate: import `audienceLabel` from `./CampaignContent.js` and `activityKindLabel` from `./CampaignActivity.js` (check its export name — `activityKindLabel content_created/...` per the G7 survey; verify before use).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix web run test -- src/campaigns/SessionBoard.test.tsx`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add web/src/campaigns/SessionBoard.tsx web/src/campaigns/SessionBoard.test.tsx web/src/i18n/messages.ts
git commit -m "feat(g7): add GM session board with bumps and audience rolls"
```

---

### Task 4: Session tab wiring, Phase 2 exit e2e, acceptance record

**Files:**
- Modify: `web/src/campaigns/CampaignDetail.tsx`
- Modify: `web/src/i18n/messages.ts` (add `campaign.detail.tabs.session: "Session"`)
- Create: `web/tests/e2e/gmSessionJourney.spec.ts`
- Create: `docs/acceptance/gui-2026-09-12-g7-gm-phase2.md`

**Interfaces:**
- Consumes: `SessionBoard` (Task 3); `CampaignContentTab` GM props (Task 2); `ownRole` + `useCampaignMembers` gating pattern from Phase 1 Task 7 (`MembersManageSection` in `CampaignDetail.tsx`).
- Produces: GM-gated Session tab; Phase 2 exit evidence; acceptance record.

Wiring: add a `tabs` entry `{ id: "session", label: t("campaign.detail.tabs.session"), content: <SessionBoard ... /> }` rendered only for GMs — reuse the `MembersManageSection` roster read: extend that section (or a sibling) to compute `isGm` once and render both the Members content and the Session tab entry. Simplest honest shape: compute `isGm` in `CampaignDetail` body via the shared `useCampaignMembers` call (same params → deduped single request) and conditionally include both the members-tab GM blocks and the session tab. Refactor the Phase 1 inline section minimally: hoist the `useCampaignMembers` call to `CampaignDetail` and pass `isGm` down. Extend `handleAccessRevoked` to purge the session keys (`["campaigns", "session", campaignId]` prefix).

- [ ] **Step 1: Write the failing tab test**

Add `web/src/campaigns/CampaignDetail.session.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { CampaignDetail } from "./CampaignDetail.js";

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const campaign = {
  campaignId: "c1", ownerId: "u1", systemVersionId: "v1",
  title: "North Watch", description: "A border fort.",
  status: "active", revision: 4, accessRevision: 1, archivedAt: null,
  createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
};

describe("CampaignDetail session tab", () => {
  it("shows the session tab to the campaign owner and hides it from players", async () => {
    const api = {
      openCampaign: vi.fn().mockResolvedValue({ campaign, requestId: "r" }),
      listMembers: vi.fn().mockResolvedValue({
        members: [
          { campaignId: "c1", userId: "u1", role: "owner", status: "active", generation: 1, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" },
          { campaignId: "c1", userId: "u2", role: "player", status: "active", generation: 1, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" },
        ],
        nextCursor: null, requestId: "r2",
      }),
      listContent: vi.fn().mockResolvedValue({ content: [], nextCursor: null, requestId: "r3" }),
      listActivity: vi.fn().mockResolvedValue({ events: [], nextCursor: null, requestId: "r4" }),
      listCampaignCharacters: vi.fn().mockResolvedValue({ characters: [], nextCursor: null, requestId: "r5" }),
    };
    const { unmount } = render(<CampaignDetail api={api as never} campaignId="c1" actorId="u1" onLeft={() => {}} />, { wrapper: wrapper() });
    expect(await screen.findByRole("tab", { name: /session/i })).toBeVisible();
    unmount();
    render(<CampaignDetail api={api as never} campaignId="c1" actorId="u2" onLeft={() => {}} />, { wrapper: wrapper() });
    await screen.findByRole("tab", { name: /members/i });
    expect(screen.queryByRole("tab", { name: /session/i })).toBeNull();
  });
});
```

Check the `Tabs` tablist roles in `web/src/ui/` before finalizing selectors (per the Phase 1 Task 7 note).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix web run test -- src/campaigns/CampaignDetail.session.test.tsx`
Expected: FAIL (no Session tab).

- [ ] **Step 3: Wire the Session tab + Content tab GM props**

Hoist the roster read, compute `isGm`, include the session tab entry only when `isGm`; pass `campaignRevision={campaign.revision} actorId generation online isGm members onChanged={detail.refetch}` into `CampaignContentTab` (members from the hoisted roster pages). `CampaignDetail` already receives `generation`/`online` as optional props from Phase 1 (defaults apply). Purge session keys in `handleAccessRevoked`.

- [ ] **Step 4: Run tests + typecheck + full web suite + contracts**

Run: `npm --prefix web run test -- src/campaigns/CampaignDetail.session.test.tsx`
Expected: PASS.
Run: `npm --prefix web run test`
Expected: full suite green.
Run: `npm --prefix web run typecheck`
Expected: clean.
Run from repo root: `npm run contracts:check`
Expected: pass.

- [ ] **Step 5: Write the Phase 2 exit e2e**

Create `web/tests/e2e/gmSessionJourney.spec.ts` mirroring `web/tests/e2e/gmSetupJourney.spec.ts` helpers (dev sign-in, `publishOwnedClone` + `uid`, `STEP_TIMEOUT`). Flow as the GM actor entirely through the UI (campaign creation now exists via `/campaigns/new` — no direct campaign HTTP provisioning; seed only the owned d20 clone via the System Builder API per the OD-01 rationale): create campaign → Content tab → author a note with `all_players` audience → narrow it to `selected_players` with a grant → hide it (soft-delete) → recover it → Session tab shows latest content + activity + character directory → expand a character → bump a resource through a conflict (two rapid bumps or a stale-revision retry) → roll with `campaign` audience. Run once at phone viewport (360px) and once at desktop (1280px): parameterize the single test over both viewports. Assert the campaign list shows the new campaign (Phase 1 Task 3 follow-up confirmation).

- [ ] **Step 6: Run the e2e**

Run from `web/` (env `CI=1 DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll_e2e AUTHORITATIVE_ROLL_SECRET=development-only-roll-secret-32-bytes`; Playwright starts its own backend + web per `playwright.config.ts`):
`npx playwright test tests/e2e/gmSessionJourney.spec.ts`
Expected: pass at both viewports. Record actual run metadata (time, viewports, theme) in the acceptance note — only checks actually run.

- [ ] **Step 7: Write the acceptance record + commit**

Create `docs/acceptance/gui-2026-09-12-g7-gm-phase2.md` mirroring `docs/acceptance/gui-2026-09-11-g7-gm-phase1.md`: date, tree, exit demonstration steps, gates actually run with exact commands and counts, fixture, findings, limitations (production OIDC unvalidated, no real-device runs, Chromium only unless run otherwise).

```bash
git add web/src/campaigns/CampaignDetail.tsx web/src/campaigns/CampaignDetail.session.test.tsx web/src/campaigns/CampaignContent.tsx web/src/i18n/messages.ts web/tests/e2e/gmSessionJourney.spec.ts docs/acceptance/gui-2026-09-12-g7-gm-phase2.md
git commit -m "feat(g7): wire GM session tab and Phase 2 exit demonstration"
```

---

## Deferred to later slices (not this plan)

- Content pinning (no backend contract; latest-content section ships instead).
- Preview-as-player (deferred per spec).
- Upgrade preview/commit backend command + UI (spec Phase 3).
- Two-device hardening, WCAG/load/SLO/runbook (spec Phase 4).
- Export payload download/display (readiness-only reporting stands).
- Rolls for actions with required inputs from the board (open-sheet path instead; never fabricate inputs).
- GM offline bumps/rolls (board is online-first; wrappers are online-only by contract).
