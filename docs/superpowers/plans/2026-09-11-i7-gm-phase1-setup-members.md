# I7 GM Phase 1 (Setup + Members) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A GM creates a campaign from the UI, edits its settings, manages members/roles, and issues/rotates/revokes invitations through the real I6 contracts.

**Architecture:** Extend the existing `web/src/campaigns/` domain seam (`types.ts` derived from `operations`, thin `ApiClient` wrappers in `api.ts`, lifetime-scoped hooks in `campaignQueries.ts`) with GM operations; add `CampaignCreate`, `CampaignSettings`, `CampaignMembersTab`, `InvitationManager` components reusing `web/src/ui/` shared controls and the claim-flow mutation pattern (`crypto.randomUUID()` idempotency key, `expectedRevision`, 409 re-read + fresh-key retry, never "Merge"); wire a `/campaigns/new` route and a Members tab through the `*RouteView` template in `web/src/router.tsx`.

**Tech Stack:** React + TypeScript, TanStack Router/Query, CSS modules, `web/src/ui/` shared controls, generated `web/src/api/schema.d.ts` (`operations`) — consuming only, no schema edit expected.

**Spec:** `docs/superpowers/specs/2026-09-11-i7-gm-app-design.md` (Phase 1 section; full I7 approach A).

## Global Constraints

- One deployable artifact; no new backend routes, no package-format change, no second character renderer (sheets keep opening via the existing `onOpenCharacter` seam).
- All campaign reads/writes go through `ApiClient` (`credentials:include`, `x-request-id`, JSON bodies even for DELETEs); tokens travel in POST bodies only, never URLs.
- Every mutation sends a caller-minted `idempotencyKey` (UUID); after any `409`, re-read then mint a fresh key — never reuse.
- `409 conflict` carries `latestRevision`; surface explicit retry/reload, never "Merge".
- Query keys always include actor + generation: `["campaigns", ..., actorId, generation, ...]`; `enabled` requires `actorId !== null && online`; sign-out/account-switch relies on AppShell `cancelQueries/removeQueries` + lifetime remount `key=`.
- Shared controls (`Button, Panel, PageHeader, EmptyState, FormField, Select, Dialog, Tabs`) for all new surfaces; controls never decide authorization — server 404/409s render as unavailable/conflict states.
- No `campaign` string in `web/src/player/` — all new code lives in `web/src/campaigns/` + `router.tsx` + `AppShell.tsx` + `web/src/i18n/messages.ts` keys only.
- TDD red-green per task; `npm run contracts:check` stays green (no schema edit expected — consuming only).
- New i18n keys ship in the same task as the component that uses them (component tests render against the real messages module).

---

## File map

| File | Responsibility |
| --- | --- |
| `web/src/campaigns/types.ts` (modify) | Derived response/body types for create/update/archive/recover/export, members, invitations mgmt |
| `web/src/campaigns/api.ts` (modify) | Thin `CampaignsApi` wrappers for the Task 1 endpoints |
| `web/src/campaigns/api.test.ts` (modify) | Wrapper contract tests (method, path, body/query shape) |
| `web/src/campaigns/campaignQueries.ts` (modify) | `campaignMembersKey`, `campaignInvitationsKey`, `useCampaignMembers`, `useCampaignInvitations` |
| `web/src/campaigns/campaignQueries.test.tsx` (create) | Lifetime scoping + `enabled` gating tests for the new hooks |
| `web/src/campaigns/CampaignCreate.tsx` (create) | Version-catalog picker + title/description + create; pinned-version display |
| `web/src/campaigns/CampaignCreate.test.tsx` (create) | Picker, validation, create body, conflict retry tests |
| `web/src/campaigns/CampaignSettings.tsx` (create) | Title/description edit, archive/recover, export (GM-gated by parent) |
| `web/src/campaigns/CampaignSettings.test.tsx` (create) | Edit/archive/export bodies, revision + fresh-key tests |
| `web/src/campaigns/CampaignMembers.tsx` (create) | Roster list, own-role derivation, role change + removal with confirmations |
| `web/src/campaigns/CampaignMembers.test.tsx` (create) | Role gating, change/remove bodies, confirm-dialog tests |
| `web/src/campaigns/InvitationManager.tsx` (create) | Issue/rotate/revoke, metadata-only list, token display-once |
| `web/src/campaigns/InvitationManager.test.tsx` (create) | Issue/rotate/revoke bodies, tokenUnavailable replay test |
| `web/src/campaigns/CampaignDetail.tsx` (modify) | Add Members tab (members + invitations + settings for GMs) |
| `web/src/router.tsx` (modify) | `/campaigns/new` route + `CampaignCreateRouteView`; library "New campaign" action |
| `web/src/shell/AppShell.tsx` (modify only if nav changes) | No new nav entry (creation lives under Campaigns); leave untouched |
| `web/src/i18n/messages.ts` (modify) | New `campaign.create.*`, `campaign.manage.settings.*`, `campaign.detail.members.*`, `campaign.detail.invitations.manage.*` keys |
| `web/tests/e2e/gmSetupJourney.spec.ts` (create) | Phase 1 exit e2e: create → invite → accept → role change → revoke |
| `docs/acceptance/gui-2026-09-11-g7-gm-phase1.md` (create) | Acceptance record for this phase |

---

### Task 1: GM CampaignsApi seam extension + derived types

**Files:**
- Modify: `web/src/campaigns/types.ts`
- Modify: `web/src/campaigns/api.ts`
- Modify: `web/src/campaigns/api.test.ts`

**Interfaces:**
- Consumes: `ApiClient.fetch` from `web/src/api/client.ts:50-60`; `operations` from `web/src/api/schema.js`.
- Produces: `CreateCampaignBody`, `CreateCampaignResponse`, `UpdateCampaignBody`, `CampaignLifecycleBody`, `ExportCampaignBody`, `CampaignMember`, `MemberListResponse`, `ChangeMemberRoleBody`, `RemoveMemberBody`, `InvitationSummary`, `InvitationListResponse`, `IssueInvitationBody`, `IssueInvitationResponse`, `RotateInvitationBody`, `RevokeInvitationBody` types (used by Tasks 2–6); extended `CampaignsApi` methods `createCampaign`, `updateCampaign`, `archiveCampaign`, `recoverCampaign`, `exportCampaign`, `listMembers`, `changeMemberRole`, `removeMember`, `listInvitations`, `issueInvitation`, `rotateInvitation`, `revokeInvitation` (used by Tasks 3–6).

Operation IDs (verified in `web/src/api/schema.d.ts`): `post_campaigns` (body `{systemVersionId, title, description?, idempotencyKey}`, 201); `patch_campaigns_id` (body `{title?, description?, expectedCampaignRevision, idempotencyKey}`, 200); `post_campaigns_id_archive` / `post_campaigns_id_recover` (body `{expectedCampaignRevision, idempotencyKey}`, 200); `post_campaigns_id_exports` (body `{idempotencyKey}`, 200); `get_campaigns_id_members` (query `{cursor?, limit?}`, member `{campaignId, userId, role: "owner"|"co_gm"|"player", status, generation, ...}`); `patch_campaigns_id_members_userId` (body `{role: "co_gm"|"player", expectedCampaignRevision, idempotencyKey}`); `delete_campaigns_id_members_userId` (body `{expectedCampaignRevision, idempotencyKey}` in the JSON DELETE body); `get_campaigns_id_invitations` (invitation metadata, no tokens); `post_campaigns_id_invitations` (body `{intendedRole: "player"|"co_gm", expiresAt?, expectedCampaignRevision, idempotencyKey}`, 201, union response with `token` XOR `tokenUnavailable: true`); `post_campaigns_id_invitations_inviteId_rotate` (body `{expectedInvitationRevision, expectedCampaignRevision, expiresAt?, idempotencyKey}`); `post_campaigns_id_invitations_inviteId_revoke` (body `{expectedInvitationRevision, expectedCampaignRevision, idempotencyKey}`).

- [ ] **Step 1: Write the failing types + api test additions**

```tsx
// Append to web/src/campaigns/api.test.ts
import { describe, expect, it, vi } from "vitest";
import { createCampaignsApi } from "./api.js";

describe("createCampaignsApi GM setup", () => {
  it("creates a campaign with system version, title, and idempotency key", async () => {
    const fetch = vi.fn().mockResolvedValue({ campaign: { campaignId: "c1" }, requestId: "r1" });
    const api = createCampaignsApi({ fetch } as never);
    await api.createCampaign({ systemVersionId: "v1", title: "North Watch", idempotencyKey: "k1" });
    expect(fetch).toHaveBeenCalledWith("POST", "/campaigns", {
      body: { systemVersionId: "v1", title: "North Watch", idempotencyKey: "k1" },
    });
  });

  it("removes a member with the revision body on the DELETE", async () => {
    const fetch = vi.fn().mockResolvedValue({ member: { userId: "u9" }, requestId: "r2" });
    const api = createCampaignsApi({ fetch } as never);
    await api.removeMember("c1", "u9", { expectedCampaignRevision: 3, idempotencyKey: "k2" });
    expect(fetch).toHaveBeenCalledWith("DELETE", "/campaigns/c1/members/u9", {
      body: { expectedCampaignRevision: 3, idempotencyKey: "k2" },
    });
  });

  it("issues an invitation with intended role in the POST body", async () => {
    const fetch = vi.fn().mockResolvedValue({ invitation: { invitationId: "i1" }, requestId: "r3" });
    const api = createCampaignsApi({ fetch } as never);
    await api.issueInvitation("c1", { intendedRole: "player", expectedCampaignRevision: 3, idempotencyKey: "k3" });
    expect(fetch).toHaveBeenCalledWith("POST", "/campaigns/c1/invitations", {
      body: { intendedRole: "player", expectedCampaignRevision: 3, idempotencyKey: "k3" },
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix web run test -- src/campaigns/api.test.ts`
Expected: FAIL with `api.createCampaign is not a function` (and the other two methods missing).

- [ ] **Step 3: Write minimal types + implementation**

```ts
// Append to web/src/campaigns/types.ts
export type CreateCampaignBody = NonNullable<
  operations["post_campaigns"]["requestBody"]
>["content"]["application/json"];
export type CreateCampaignResponse =
  operations["post_campaigns"]["responses"]["201"]["content"]["application/json"];

export type UpdateCampaignBody = NonNullable<
  operations["patch_campaigns_id"]["requestBody"]
>["content"]["application/json"];

export type CampaignLifecycleBody = NonNullable<
  operations["post_campaigns_id_archive"]["requestBody"]
>["content"]["application/json"];

export type ExportCampaignBody = NonNullable<
  operations["post_campaigns_id_exports"]["requestBody"]
>["content"]["application/json"];
export type ExportCampaignResponse =
  operations["post_campaigns_id_exports"]["responses"]["200"]["content"]["application/json"];

export type MemberListResponse =
  operations["get_campaigns_id_members"]["responses"]["200"]["content"]["application/json"];
export type CampaignMember = MemberListResponse["members"][number];

export type ChangeMemberRoleBody = NonNullable<
  operations["patch_campaigns_id_members_userId"]["requestBody"]
>["content"]["application/json"];
export type RemoveMemberBody = NonNullable<
  operations["delete_campaigns_id_members_userId"]["requestBody"]
>["content"]["application/json"];

export type InvitationListResponse =
  operations["get_campaigns_id_invitations"]["responses"]["200"]["content"]["application/json"];
export type InvitationSummary = InvitationListResponse["invitations"][number];

export type IssueInvitationBody = NonNullable<
  operations["post_campaigns_id_invitations"]["requestBody"]
>["content"]["application/json"];
export type IssueInvitationResponse =
  operations["post_campaigns_id_invitations"]["responses"]["201"]["content"]["application/json"];

export type RotateInvitationBody = NonNullable<
  operations["post_campaigns_id_invitations_inviteId_rotate"]["requestBody"]
>["content"]["application/json"];
export type RevokeInvitationBody = NonNullable<
  operations["post_campaigns_id_invitations_inviteId_revoke"]["requestBody"]
>["content"]["application/json"];
```

```ts
// Append to the CampaignsApi type in web/src/campaigns/api.ts (before the closing };)
  createCampaign(body: CreateCampaignBody): Promise<CreateCampaignResponse>;
  updateCampaign(campaignId: string, body: UpdateCampaignBody): Promise<CampaignViewResponse>;
  archiveCampaign(campaignId: string, body: CampaignLifecycleBody): Promise<CampaignViewResponse>;
  recoverCampaign(campaignId: string, body: CampaignLifecycleBody): Promise<CampaignViewResponse>;
  exportCampaign(campaignId: string, body: ExportCampaignBody): Promise<ExportCampaignResponse>;
  listMembers(campaignId: string, input?: CampaignListQuery): Promise<MemberListResponse>;
  changeMemberRole(campaignId: string, memberUserId: string, body: ChangeMemberRoleBody): Promise<unknown>;
  removeMember(campaignId: string, memberUserId: string, body: RemoveMemberBody): Promise<unknown>;
  listInvitations(campaignId: string, input?: CampaignListQuery): Promise<InvitationListResponse>;
  issueInvitation(campaignId: string, body: IssueInvitationBody): Promise<IssueInvitationResponse>;
  rotateInvitation(campaignId: string, inviteId: string, body: RotateInvitationBody): Promise<IssueInvitationResponse>;
  revokeInvitation(campaignId: string, inviteId: string, body: RevokeInvitationBody): Promise<unknown>;
```

```ts
// Append to the object returned by createCampaignsApi in web/src/campaigns/api.ts
// (mirror the existing listCampaigns/listContent input-undefined branching
// for the two cursor-paginated GETs).
    createCampaign: (body) =>
      client.fetch<CreateCampaignResponse>("POST", "/campaigns", { body }),
    updateCampaign: (campaignId, body) =>
      client.fetch<CampaignViewResponse>("PATCH", `/campaigns/${campaignId}`, { body }),
    archiveCampaign: (campaignId, body) =>
      client.fetch<CampaignViewResponse>("POST", `/campaigns/${campaignId}/archive`, { body }),
    recoverCampaign: (campaignId, body) =>
      client.fetch<CampaignViewResponse>("POST", `/campaigns/${campaignId}/recover`, { body }),
    exportCampaign: (campaignId, body) =>
      client.fetch<ExportCampaignResponse>("POST", `/campaigns/${campaignId}/exports`, { body }),
    listMembers: (campaignId, input) =>
      input === undefined
        ? client.fetch<MemberListResponse>("GET", `/campaigns/${campaignId}/members`)
        : client.fetch<MemberListResponse>("GET", `/campaigns/${campaignId}/members`, {
          query: { cursor: input.cursor ?? undefined, limit: input.limit ?? undefined },
        }),
    changeMemberRole: (campaignId, memberUserId, body) =>
      client.fetch("PATCH", `/campaigns/${campaignId}/members/${memberUserId}`, { body }),
    removeMember: (campaignId, memberUserId, body) =>
      client.fetch("DELETE", `/campaigns/${campaignId}/members/${memberUserId}`, { body }),
    listInvitations: (campaignId, input) =>
      input === undefined
        ? client.fetch<InvitationListResponse>("GET", `/campaigns/${campaignId}/invitations`)
        : client.fetch<InvitationListResponse>("GET", `/campaigns/${campaignId}/invitations`, {
          query: { cursor: input.cursor ?? undefined, limit: input.limit ?? undefined },
        }),
    issueInvitation: (campaignId, body) =>
      client.fetch<IssueInvitationResponse>("POST", `/campaigns/${campaignId}/invitations`, { body }),
    rotateInvitation: (campaignId, inviteId, body) =>
      client.fetch<IssueInvitationResponse>("POST", `/campaigns/${campaignId}/invitations/${inviteId}/rotate`, { body }),
    revokeInvitation: (campaignId, inviteId, body) =>
      client.fetch("POST", `/campaigns/${campaignId}/invitations/${inviteId}/revoke`, { body }),
```

Update the `CampaignListQuery` reuse: `listMembers`/`listInvitations` reuse the existing `CampaignListQuery` type (`{cursor?, limit?}`); no new query type is needed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix web run test -- src/campaigns/api.test.ts`
Expected: PASS (all pre-existing + 3 new tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/campaigns/types.ts web/src/campaigns/api.ts web/src/campaigns/api.test.ts
git commit -m "feat(g7): extend CampaignsApi seam with GM setup/member/invitation ops"
```

---

### Task 2: Member/invitation lifetime-scoped query hooks

**Files:**
- Modify: `web/src/campaigns/campaignQueries.ts`
- Create: `web/src/campaigns/campaignQueries.test.tsx`

**Interfaces:**
- Consumes: `CampaignsApi.listMembers`, `CampaignsApi.listInvitations` from Task 1; `useInfiniteQuery` from `@tanstack/react-query`.
- Produces: `campaignMembersKey(campaignId, actorId, generation)`, `campaignInvitationsKey(campaignId, actorId, generation)`, `useCampaignMembers(api, campaignId, actorId, generation, options)`, `useCampaignInvitations(api, campaignId, actorId, generation, options)` (used by Tasks 5–6); `CAMPAIGN_MEMBER_PAGE_LIMIT = 25`.

- [ ] **Step 1: Write the failing hook test**

```tsx
// web/src/campaigns/campaignQueries.test.tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { campaignInvitationsKey, campaignMembersKey, useCampaignMembers } from "./campaignQueries.js";

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("useCampaignMembers", () => {
  it("scopes the key to campaign, actor, and generation", () => {
    expect(campaignMembersKey("c1", "u1", 2)).toEqual(["campaigns", "members", "c1", "u1", 2]);
    expect(campaignInvitationsKey("c1", "u1", 2)).toEqual(["campaigns", "invitations", "c1", "u1", 2]);
  });

  it("stays disabled while signed out or offline", () => {
    const api = { listMembers: vi.fn() };
    const signedOut = renderHook(
      () => useCampaignMembers(api as never, "c1", null, 0, { enabled: true, online: true }),
      { wrapper: wrapper() },
    );
    const offline = renderHook(
      () => useCampaignMembers(api as never, "c1", "u1", 0, { enabled: true, online: false }),
      { wrapper: wrapper() },
    );
    expect(signedOut.result.current.status).toBe("pending");
    expect(offline.result.current.status).toBe("pending");
    expect(api.listMembers).not.toHaveBeenCalled();
  });

  it("pages members with cursor + limit when enabled", async () => {
    const api = {
      listMembers: vi.fn().mockResolvedValue({ members: [], nextCursor: null, requestId: "r" }),
    };
    const { result } = renderHook(
      () => useCampaignMembers(api as never, "c1", "u1", 0, { enabled: true, online: true }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(api.listMembers).toHaveBeenCalledWith("c1", { cursor: null, limit: 25 }));
    expect(result.current.status).toBe("success");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix web run test -- src/campaigns/campaignQueries.test.tsx`
Expected: FAIL with "Cannot find module './campaignQueries.js'" or missing exports.

- [ ] **Step 3: Write minimal hooks**

```ts
// Append to web/src/campaigns/campaignQueries.ts
import type { CampaignsApi, CampaignListQuery } from "./api.js";

export const CAMPAIGN_MEMBER_PAGE_LIMIT = 25;

export function campaignMembersKey(campaignId: string, actorId: string | null, generation: number) {
  return ["campaigns", "members", campaignId, actorId, generation];
}

export function campaignInvitationsKey(campaignId: string, actorId: string | null, generation: number) {
  return ["campaigns", "invitations", campaignId, actorId, generation];
}

function memberPageQuery(pageParam: string | null): CampaignListQuery {
  return { cursor: pageParam, limit: CAMPAIGN_MEMBER_PAGE_LIMIT };
}

export function useCampaignMembers(
  api: CampaignsApi,
  campaignId: string,
  actorId: string | null,
  generation: number,
  options: { enabled: boolean; online: boolean },
) {
  return useInfiniteQuery({
    queryKey: campaignMembersKey(campaignId, actorId, generation),
    queryFn: ({ pageParam }: { pageParam: string | null }) => api.listMembers(campaignId, memberPageQuery(pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: options.enabled && options.online && actorId !== null,
    staleTime: 30_000,
  });
}

export function useCampaignInvitations(
  api: CampaignsApi,
  campaignId: string,
  actorId: string | null,
  generation: number,
  options: { enabled: boolean; online: boolean },
) {
  return useInfiniteQuery({
    queryKey: campaignInvitationsKey(campaignId, actorId, generation),
    queryFn: ({ pageParam }: { pageParam: string | null }) => api.listInvitations(campaignId, memberPageQuery(pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: options.enabled && options.online && actorId !== null,
    staleTime: 30_000,
  });
}
```

Note: the existing `useCampaignList` already imports `useInfiniteQuery` and the `CampaignsApi, CampaignListQuery` types at `campaignQueries.ts:1-2`; extend those import lines rather than duplicating them.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix web run test -- src/campaigns/campaignQueries.test.tsx`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add web/src/campaigns/campaignQueries.ts web/src/campaigns/campaignQueries.test.tsx
git commit -m "feat(g7): add lifetime-scoped member/invitation list hooks"
```

---

### Task 3: CampaignCreate with version-catalog picker + `/campaigns/new` route

**Files:**
- Create: `web/src/campaigns/CampaignCreate.tsx`
- Create: `web/src/campaigns/CampaignCreate.test.tsx`
- Modify: `web/src/router.tsx`
- Modify: `web/src/campaigns/CampaignLibrary.tsx` (add "New campaign" action)
- Modify: `web/src/i18n/messages.ts` (add `campaign.create.*` keys)

**Interfaces:**
- Consumes: `CampaignsApi.createCampaign` (Task 1); `CharactersApi.listCreationVersions` with `VersionCatalogQuery` (`web/src/characters/api.ts:32,66`); `CreationVersionEntry` (`web/src/characters/types.ts:92`: `{versionId, systemId, systemName, semanticVersion, createdAt}`).
- Produces: `CampaignCreate(api, versionsApi, actorId, navigation: { onCreated(campaignId) })`, `campaignCreateViewKey(actor, generation)` (used by Task 7 router wiring).

Behavior: version catalog lists accessible versions (owned + public per OD-01) via `versionsApi.listCreationVersions({ limit: 25 })`; selecting a version shows its pinned identity (`systemName semanticVersion`, short id); title (required) + description (optional) fields; submit calls `createCampaign({ systemVersionId, title, description?, idempotencyKey: crypto.randomUUID() })`; 409 → reload catalog + conflict notice with fresh-key retry, never "Merge"; success → `navigation.onCreated(campaignId)`. Offline/signed-out keep dedicated guidance (mirror `CreateCharacter` guards: disable submit while offline).

i18n keys to add in `web/src/i18n/messages.ts` beside the `campaign.library.*` block:
`campaign.create.title: "New campaign"`, `campaign.create.description: "Pick a system version, name the campaign, and create it."`, `campaign.create.version.label: "System version"`, `campaign.create.version.loading: "Loading versions…"`, `campaign.create.version.loadFailed: "Versions could not be loaded."`, `campaign.create.version.retry: "Retry"`, `campaign.create.version.empty: "No usable system versions."`, `campaign.create.title.label: "Campaign title"`, `campaign.create.description.label: "Description (optional)"`, `campaign.create.submit: "Create campaign"`, `campaign.create.creating: "Creating…"`, `campaign.create.conflict: "Something changed. The list was reloaded — retry creating."`, `campaign.create.error: "Creation failed. Try again."`, `campaign.create.signIn: "Sign in to create a campaign."`, `campaign.create.offline: "You are offline. Reconnect to create a campaign."`, `campaign.library.new: "New campaign"`.

- [ ] **Step 1: Write the failing component test**

```tsx
// web/src/campaigns/CampaignCreate.test.tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { CampaignCreate } from "./CampaignCreate.js";

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const versions = [
  { versionId: "v1", systemId: "s1", systemName: "D20 System", semanticVersion: "1.0.0", createdAt: "2026-09-01T00:00:00Z" },
];

describe("CampaignCreate", () => {
  it("creates a campaign from the selected version with a fresh idempotency key", async () => {
    const api = { createCampaign: vi.fn().mockResolvedValue({ campaign: { campaignId: "c9" }, requestId: "r" }) };
    const versionsApi = { listCreationVersions: vi.fn().mockResolvedValue({ data: { versions, nextCursor: null }, requestId: "r" }) };
    const onCreated = vi.fn();
    render(<CampaignCreate api={api as never} versionsApi={versionsApi as never} actorId="u1" online navigation={{ onCreated }} />, { wrapper: wrapper() });
    fireEvent.click(await screen.findByRole("button", { name: /d20 system 1\.0\.0/i }));
    fireEvent.change(screen.getByLabelText(/campaign title/i), { target: { value: "North Watch" } });
    fireEvent.click(screen.getByRole("button", { name: /create campaign/i }));
    await vi.waitFor(() => expect(api.createCampaign).toHaveBeenCalled());
    const body = (api.createCampaign as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(body).toMatchObject({ systemVersionId: "v1", title: "North Watch" });
    expect(typeof body.idempotencyKey).toBe("string");
    expect(onCreated).toHaveBeenCalledWith("c9");
  });

  it("retries with a fresh key after a create conflict (409), never merging", async () => {
    const api = {
      createCampaign: vi.fn()
        .mockRejectedValueOnce({ code: "conflict", status: 409, message: "taken" })
        .mockResolvedValueOnce({ campaign: { campaignId: "c9" }, requestId: "r2" }),
    };
    const versionsApi = { listCreationVersions: vi.fn().mockResolvedValue({ data: { versions, nextCursor: null }, requestId: "r" }) };
    render(<CampaignCreate api={api as never} versionsApi={versionsApi as never} actorId="u1" online navigation={{ onCreated: () => {} }} />, { wrapper: wrapper() });
    fireEvent.click(await screen.findByRole("button", { name: /d20 system 1\.0\.0/i }));
    fireEvent.change(screen.getByLabelText(/campaign title/i), { target: { value: "North Watch" } });
    fireEvent.click(screen.getByRole("button", { name: /create campaign/i }));
    expect(await screen.findByText(/something changed/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /create campaign/i }));
    await vi.waitFor(() => expect(api.createCampaign).toHaveBeenCalledTimes(2));
    const [first, second] = (api.createCampaign as ReturnType<typeof vi.fn>).mock.calls;
    expect(first![0].idempotencyKey).not.toBe(second![0].idempotencyKey);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix web run test -- src/campaigns/CampaignCreate.test.tsx`
Expected: FAIL with "Cannot find module './CampaignCreate.js'".

- [ ] **Step 3: Write minimal component**

```tsx
// web/src/campaigns/CampaignCreate.tsx
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { CharactersApi } from "../characters/api.js";
import { t } from "../i18n/index.js";
import { Button, EmptyState, FormField, PageHeader, Panel } from "../ui/index.js";
import type { CampaignsApi } from "./api.js";

export function campaignCreateViewKey(actor: string | null, generation: number): string {
  return `${actor ?? "signed-out"}:${generation}`;
}

function isConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; status?: unknown };
  return record.status === 409 || record.code === "conflict";
}

function describeError(cause: unknown, fallback: string): string {
  if (typeof cause === "object" && cause !== null && "message" in cause
    && typeof cause.message === "string" && cause.message !== "") {
    return cause.message;
  }
  return fallback;
}

export function CampaignCreate(props: {
  api: Pick<CampaignsApi, "createCampaign">;
  versionsApi: Pick<CharactersApi, "listCreationVersions">;
  actorId: string | null;
  online: boolean;
  navigation: { onCreated: (campaignId: string) => void };
}) {
  const queryClient = useQueryClient();
  const catalog = useQuery({
    queryKey: ["campaigns", "create", "versions", props.actorId],
    queryFn: () => props.versionsApi.listCreationVersions({ limit: 25 }),
    enabled: props.actorId !== null && props.online,
    staleTime: 30_000,
  });
  const [versionId, setVersionId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (props.actorId === null) {
    return (
      <section aria-label={t("campaign.create.title")}>
        <PageHeader title={t("campaign.create.title")} />
        <p role="status">{t("campaign.create.signIn")}</p>
      </section>
    );
  }
  if (!props.online) {
    return (
      <section aria-label={t("campaign.create.title")}>
        <PageHeader title={t("campaign.create.title")} description={t("campaign.create.description")} />
        <p role="status">{t("campaign.create.offline")}</p>
      </section>
    );
  }

  const submit = async (): Promise<void> => {
    const trimmedTitle = title.trim();
    if (pending || versionId === null || trimmedTitle === "") return;
    setPending(true);
    setError(null);
    setConflict(false);
    // Caller-minted idempotency key, fresh on every attempt.
    const idempotencyKey = crypto.randomUUID();
    try {
      const response = await props.api.createCampaign({
        systemVersionId: versionId,
        title: trimmedTitle,
        ...(description.trim() === "" ? {} : { description: description.trim() }),
        idempotencyKey,
      });
      await queryClient.invalidateQueries({ queryKey: ["campaigns", "list"] });
      props.navigation.onCreated(response.campaign.campaignId);
    } catch (cause) {
      if (isConflict(cause)) {
        // 409 → reload the catalog, then offer a retry with a fresh key. Never "Merge".
        await catalog.refetch();
        setConflict(true);
      } else {
        setError(describeError(cause, t("campaign.create.error")));
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <section aria-label={t("campaign.create.title")}>
      <PageHeader title={t("campaign.create.title")} description={t("campaign.create.description")} />
      {conflict ? <p role="status">{t("campaign.create.conflict")}</p> : null}
      {error !== null ? <p role="alert">{error}</p> : null}
      {catalog.status === "pending" ? <p role="status">{t("campaign.create.version.loading")}</p> : null}
      {catalog.status === "error" ? (
        <EmptyState
          title={t("campaign.create.version.loadFailed")}
          action={
            <Button variant="primary" onClick={() => void catalog.refetch()}>
              {t("campaign.create.version.retry")}
            </Button>
          }
        />
      ) : null}
      {catalog.status === "success" ? (
        catalog.data.data.versions.length === 0 ? (
          <EmptyState title={t("campaign.create.version.empty")} />
        ) : (
          <Panel title={t("campaign.create.version.label")}>
            <ul>
              {catalog.data.data.versions.map((entry) => (
                <li key={entry.versionId}>
                  <Button
                    variant="secondary"
                    aria-pressed={versionId === entry.versionId}
                    onClick={() => setVersionId(entry.versionId)}
                  >
                    {`${entry.systemName} ${entry.semanticVersion}`}
                  </Button>
                </li>
              ))}
            </ul>
          </Panel>
        )
      ) : null}
      <FormField label={t("campaign.create.title.label")}>
        <input aria-label={t("campaign.create.title.label")} value={title} onChange={(event) => setTitle(event.target.value)} />
      </FormField>
      <FormField label={t("campaign.create.description.label")}>
        <input aria-label={t("campaign.create.description.label")} value={description} onChange={(event) => setDescription(event.target.value)} />
      </FormField>
      <Button variant="primary" pending={pending} pendingText={t("campaign.create.creating")} onClick={() => void submit()}>
        {t("campaign.create.submit")}
      </Button>
    </section>
  );
}
```

Adaptation notes for the executor (not placeholders — read before committing): check `FormField`'s actual children/label contract in `web/src/ui/` and the raw-input pattern used by `MetadataEditor.tsx`/`FieldControl.tsx`; if `FormField` already renders its own labeled control, drop the inner `aria-label` to avoid double-labeling (the G4 follow-up rule). Check `Button`'s `pending`/`pendingText`/`variant` props against the leave-dialog usage in `CampaignDetail.tsx:230-238`.

- [ ] **Step 4: Wire the `/campaigns/new` route + library action**

In `web/src/router.tsx`, beside `campaignsRoute` (`router.tsx:146-150`), add:

```tsx
const campaignCreateRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/campaigns/new",
  component: CampaignCreateRouteView,
});
```

Add `CampaignCreateRouteView` after `CampaignLibraryRouteView` (`router.tsx:406-439`), mirroring its identity guard exactly (loading → anon `storePostSigninPath("/campaigns/new")` + sign-in prompt → lifetime `key={campaignCreateViewKey(actorId, generation)}`), rendering `CampaignCreate` with `api={api} versionsApi={charactersApi} actorId={actorId} online={identity.isOnline()} navigation={{ onCreated: (campaignId) => navigate({ to: "/campaigns/$campaignId", params: { campaignId } }) }}` (mirror `CampaignDetailRouteView`'s `onOpenCharacter` navigation at `router.tsx:472-475`). Register the route in `routeTree` (`router.tsx:531`).

In `web/src/campaigns/CampaignLibrary.tsx`, extend `CampaignLibraryNavigation` with `onCreateCampaign: () => void` and add a `PageHeader` action link `href="/campaigns/new"` labeled `t("campaign.library.new")` that calls it (mirror the existing `onEnterToken` anchor at `CampaignLibrary.tsx:36-45`); pass `onCreateCampaign` from `CampaignLibraryRouteView`'s navigation object navigating to `/campaigns/new`. Update `CampaignLibrary.test.tsx` if it asserts the navigation object shape (check first).

- [ ] **Step 5: Run tests + typecheck**

Run: `npm --prefix web run test -- src/campaigns/CampaignCreate.test.tsx`
Expected: PASS (2/2).
Run: `npm --prefix web run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add web/src/campaigns/CampaignCreate.tsx web/src/campaigns/CampaignCreate.test.tsx web/src/router.tsx web/src/campaigns/CampaignLibrary.tsx web/src/i18n/messages.ts
git commit -m "feat(g7): add GM campaign creation from version catalog"
```

---

### Task 4: CampaignSettings (edit, archive/recover, export)

**Files:**
- Create: `web/src/campaigns/CampaignSettings.tsx`
- Create: `web/src/campaigns/CampaignSettings.test.tsx`
- Modify: `web/src/i18n/messages.ts` (add `campaign.manage.settings.*` keys)

**Interfaces:**
- Consumes: `CampaignsApi` (`updateCampaign`, `archiveCampaign`, `recoverCampaign`, `exportCampaign`) from Task 1; `CampaignView` from `web/src/campaigns/types.ts:7-9` (`{campaignId, ownerId, systemVersionId, title, description, status, revision, ...}`).
- Produces: `CampaignSettingsView({api, campaign, onChanged})` (mounted by the Members tab in Task 7 only when the actor's own role is `owner` or `co_gm`).

Behavior: title/description form prefilled from `campaign`; save sends `{title?, description?, expectedCampaignRevision: campaign.revision, idempotencyKey}`; archive (when `status === "active"`) and recover (when `archived`) send `{expectedCampaignRevision, idempotencyKey}` behind `Dialog` confirmations; export sends `{idempotencyKey}` and reports success/failure (no file download in this task — success notice only; the export payload display/download belongs to a later slice). Every 409 → `onChanged()` (parent refetches detail) + conflict notice + fresh-key retry. Pinned-version display: `systemVersionId` short id rendered as read-only text.

i18n keys: `campaign.manage.settings.title: "Campaign settings"`, `campaign.manage.settings.titleLabel: "Title"`, `campaign.manage.settings.descriptionLabel: "Description"`, `campaign.manage.settings.save: "Save settings"`, `campaign.manage.settings.saving: "Saving…"`, `campaign.manage.settings.saved: "Settings saved."`, `campaign.manage.settings.version.label: "Pinned system version"`, `campaign.manage.settings.archive: "Archive campaign"`, `campaign.manage.settings.archive.confirm.title: "Archive this campaign?"`, `campaign.manage.settings.archive.confirm.description: "Archived campaigns allow reads and departure but no new joins or edits. You can recover it later."`, `campaign.manage.settings.archive.confirm.confirm: "Confirm archive"`, `campaign.manage.settings.recover: "Recover campaign"`, `campaign.manage.settings.recover.confirm.title: "Recover this campaign?"`, `campaign.manage.settings.recover.confirm.confirm: "Confirm recovery"`, `campaign.manage.settings.export: "Export campaign"`, `campaign.manage.settings.export.exporting: "Exporting…"`, `campaign.manage.settings.export.done: "Export ready."`, `campaign.manage.settings.conflict: "This campaign changed. It was reloaded — review and retry."`, `campaign.manage.settings.error: "Saving failed. Try again."`.

- [ ] **Step 1: Write the failing component test**

```tsx
// web/src/campaigns/CampaignSettings.test.tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CampaignSettingsView } from "./CampaignSettings.js";

const campaign = {
  campaignId: "c1", ownerId: "u1", systemVersionId: "v1",
  title: "North Watch", description: "A border fort.",
  status: "active", revision: 5, accessRevision: 1, archivedAt: null,
  createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
};

describe("CampaignSettingsView", () => {
  it("saves title edits against the current revision with a fresh key", async () => {
    const api = { updateCampaign: vi.fn().mockResolvedValue({ campaign, requestId: "r" }) };
    const onChanged = vi.fn();
    render(<CampaignSettingsView api={api as never} campaign={campaign as never} onChanged={onChanged} />);
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "South Watch" } });
    fireEvent.click(screen.getByRole("button", { name: /save settings/i }));
    await vi.waitFor(() => expect(api.updateCampaign).toHaveBeenCalled());
    expect(api.updateCampaign).toHaveBeenCalledWith("c1", expect.objectContaining({
      title: "South Watch",
      expectedCampaignRevision: 5,
    }));
    const body = (api.updateCampaign as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(typeof body.idempotencyKey).toBe("string");
    expect(onChanged).toHaveBeenCalled();
  });

  it("archives behind a confirmation dialog", async () => {
    const api = { archiveCampaign: vi.fn().mockResolvedValue({ campaign, requestId: "r" }) };
    render(<CampaignSettingsView api={api as never} campaign={campaign as never} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^archive campaign/i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm archive/i }));
    await vi.waitFor(() => expect(api.archiveCampaign).toHaveBeenCalledWith("c1", expect.objectContaining({
      expectedCampaignRevision: 5,
    })));
  });

  it("shows the pinned system version as read-only text", () => {
    const api = {};
    render(<CampaignSettingsView api={api as never} campaign={campaign as never} onChanged={() => {}} />);
    expect(screen.getByText(/pinned system version/i)).toBeVisible();
    expect(screen.getByText(/v1/)).toBeVisible();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix web run test -- src/campaigns/CampaignSettings.test.tsx`
Expected: FAIL with "Cannot find module './CampaignSettings.js'".

- [ ] **Step 3: Write minimal component**

Mirror `CampaignCharactersView`'s mutation pattern (`CampaignCharacters.tsx:81-120`): per-action pending/conflict/error state, `crypto.randomUUID()` per attempt, `isConflict`/`isNotFound` helpers, `describeError` fallback, `Dialog` confirmation mirroring the claim dialog (`CampaignCharacters.tsx:225-252` — first click opens confirm, confirm executes). Structure:

```tsx
// web/src/campaigns/CampaignSettings.tsx
import { useState } from "react";
import { t } from "../i18n/index.js";
import { Button, Dialog, FormField, Panel } from "../ui/index.js";
import type { CampaignsApi } from "./api.js";
import type { CampaignView } from "./types.js";

// isConflict + describeError helpers identical to CampaignCharacters.tsx:27-44.

export function CampaignSettingsView(props: {
  api: Pick<CampaignsApi, "updateCampaign" | "archiveCampaign" | "recoverCampaign" | "exportCampaign">;
  campaign: CampaignView;
  onChanged?: () => void;
}) {
  // title/description state prefilled from props.campaign; savePending/saveConflict/saveError;
  // archivePhase: "idle" | "confirming" | "working"; recoverPhase likewise;
  // exportPending/exportDone/exportError.
  // attemptSave: updateCampaign(campaignId, { title, description, expectedCampaignRevision: props.campaign.revision, idempotencyKey: crypto.randomUUID() })
  //   → onChanged on success; 409 → onChanged + conflict notice (fresh-key retry via Save button).
  // attemptArchive / attemptRecover: same shape with archiveCampaign/recoverCampaign behind Dialog confirmations.
  // attemptExport: exportCampaign(campaignId, { idempotencyKey: crypto.randomUUID() }) → done notice.
  // Render: Panel "Campaign settings" with FormFields, Save button; pinned version read-only row;
  //   Archive or Recover button depending on props.campaign.status; Export button.

```tsx
const attemptSave = async (): Promise<void> => {
  const trimmedTitle = title.trim();
  if (savePending || trimmedTitle === "") return;
  setSavePending(true);
  setSaveError(null);
  setSaveConflict(false);
  // Caller-minted idempotency key, fresh on every attempt.
  const idempotencyKey = crypto.randomUUID();
  try {
    await props.api.updateCampaign(props.campaign.campaignId, {
      title: trimmedTitle,
      description: description.trim(),
      expectedCampaignRevision: props.campaign.revision,
      idempotencyKey,
    });
    setSaved(true);
    props.onChanged?.();
  } catch (cause) {
    if (isConflict(cause)) {
      // 409 → re-read first, then offer a retry with a fresh key. Never "Merge".
      setSaveConflict(true);
      props.onChanged?.();
    } else {
      setSaveError(describeError(cause, t("campaign.manage.settings.error")));
    }
  } finally {
    setSavePending(false);
  }
};

const attemptArchive = async (): Promise<void> => {
  if (archivePhase !== "confirming") return;
  setArchivePhase("working");
  // Caller-minted idempotency key, fresh on every attempt.
  const idempotencyKey = crypto.randomUUID();
  try {
    await props.api.archiveCampaign(props.campaign.campaignId, {
      expectedCampaignRevision: props.campaign.revision,
      idempotencyKey,
    });
    setArchivePhase("idle");
    props.onChanged?.();
  } catch (cause) {
    if (isConflict(cause)) {
      setSaveConflict(true);
      setArchivePhase("idle");
      props.onChanged?.();
    } else {
      setSaveError(describeError(cause, t("campaign.manage.settings.error")));
      setArchivePhase("idle");
    }
  }
};
```

`attemptRecover` mirrors `attemptArchive` with `recoverCampaign`; `attemptExport` calls `exportCampaign(campaignId, { idempotencyKey: crypto.randomUUID() })` and sets the done notice. Render (mirroring the claim `Dialog` at `CampaignCharacters.tsx:225-252` — closed state + confirming state, confirm button labeled `t("...confirm.confirm")` distinct from the opener):
}
```

The executor writes the full component following the `attemptClaim` shape exactly (pending guard, fresh key comment, try/catch with conflict branch calling `props.onChanged`, else `describeError`). Reuse the `FormField` adaptation note from Task 3.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix web run test -- src/campaigns/CampaignSettings.test.tsx`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add web/src/campaigns/CampaignSettings.tsx web/src/campaigns/CampaignSettings.test.tsx web/src/i18n/messages.ts
git commit -m "feat(g7): add GM campaign settings edit/archive/export panel"
```

---

### Task 5: CampaignMembers tab (roster, role change, removal)

**Files:**
- Create: `web/src/campaigns/CampaignMembers.tsx`
- Create: `web/src/campaigns/CampaignMembers.test.tsx`
- Modify: `web/src/i18n/messages.ts` (add `campaign.detail.members.*` keys)

**Interfaces:**
- Consumes: `useCampaignMembers` (Task 2); `CampaignsApi.changeMemberRole`, `CampaignsApi.removeMember` (Task 1); `CampaignMember` (`{campaignId, userId, role, status, generation, ...}`).
- Produces: `CampaignMembersTab({api, campaignId, actorId, campaignRevision, generation, online, onChanged, onAccessRevoked})`, `ownRole(members, actorId): "owner" | "co_gm" | "player" | null` (used by Task 7 for GM gating).

Behavior: roster lists active members with role labels; the actor's own role derives from the member whose `userId === actorId` (`ownRole` helper, exported for Task 7). Owner-only actions: promote/demote between `co_gm`/`player` via `Select` + confirm `Dialog` (demotions always confirm; promotions confirm too — security-sensitive either way); owner and co-GMs see remove buttons (backend enforces owner-protections and co-GM limits — the UI sends, the server decides; 403/404 render as error/unavailable states, never client-side policy). Self-row never offers self-removal here (self-leave stays in `CampaignDetail`). Every mutation sends `{role?, expectedCampaignRevision, idempotencyKey: crypto.randomUUID()}` and follows the 409 → `onChanged()` + conflict notice + fresh-key retry pattern. `onAccessRevoked` fires on 404 (membership gone).

i18n keys: `campaign.detail.members.loading: "Loading members…"`, `campaign.detail.members.loadFailed: "Members could not be loaded."`, `campaign.detail.members.listAriaLabel: "Campaign members"`, `campaign.detail.members.empty: "No members yet."`, `campaign.detail.members.role.owner: "Owner"`, `campaign.detail.members.role.co_gm: "Co-GM"`, `campaign.detail.members.role.player: "Player"`, `campaign.detail.members.you: "You"`, `campaign.detail.members.changeRole: "Change role"`, `campaign.detail.members.changeRole.confirm.title: "Change {name} to {role}?"`, `campaign.detail.members.changeRole.confirm.description: "Role changes take effect immediately for this campaign."`, `campaign.detail.members.changeRole.confirm.confirm: "Confirm role change"`, `campaign.detail.members.remove: "Remove {name}"`, `campaign.detail.members.remove.confirm.title: "Remove {name}?"`, `campaign.detail.members.remove.confirm.description: "Removal clears their controllers, claim designations, and content grants, and returns adopted characters. This cannot be undone."`, `campaign.detail.members.remove.confirm.confirm: "Confirm removal"`, `campaign.detail.members.conflict: "This campaign changed. The list was reloaded — review and retry."`, `campaign.detail.members.error: "The change failed. Try again."`.

- [ ] **Step 1: Write the failing component test**

```tsx
// web/src/campaigns/CampaignMembers.test.tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { CampaignMembersTab, ownRole } from "./CampaignMembers.js";

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const members = [
  { campaignId: "c1", userId: "u1", role: "owner", status: "active", generation: 1, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" },
  { campaignId: "c1", userId: "u2", role: "player", status: "active", generation: 1, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" },
];

describe("ownRole", () => {
  it("derives the actor role from the roster", () => {
    expect(ownRole(members as never, "u1")).toBe("owner");
    expect(ownRole(members as never, "u2")).toBe("player");
    expect(ownRole(members as never, "u9")).toBeNull();
  });
});

describe("CampaignMembersTab", () => {
  it("changes a member role behind confirmation with revision + fresh key", async () => {
    const api = {
      listMembers: vi.fn().mockResolvedValue({ members, nextCursor: null, requestId: "r" }),
      changeMemberRole: vi.fn().mockResolvedValue({ member: members[1], requestId: "r2" }),
    };
    render(<CampaignMembersTab api={api as never} campaignId="c1" actorId="u1" campaignRevision={4} generation={0} online onChanged={() => {}} onAccessRevoked={() => {}} />, { wrapper: wrapper() });
    expect(await screen.findByText(/co-gm/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /change role/i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm role change/i }));
    await vi.waitFor(() => expect(api.changeMemberRole).toHaveBeenCalledWith("c1", "u2", expect.objectContaining({
      expectedCampaignRevision: 4,
    })));
    const body = (api.changeMemberRole as ReturnType<typeof vi.fn>).mock.calls[0]![2];
    expect(typeof body.idempotencyKey).toBe("string");
  });

  it("hides management actions from player-role actors", async () => {
    const api = {
      listMembers: vi.fn().mockResolvedValue({ members, nextCursor: null, requestId: "r" }),
    };
    render(<CampaignMembersTab api={api as never} campaignId="c1" actorId="u2" campaignRevision={4} generation={0} online onChanged={() => {}} onAccessRevoked={() => {}} />, { wrapper: wrapper() });
    await screen.findByText(/owner/i);
    expect(screen.queryByRole("button", { name: /change role/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix web run test -- src/campaigns/CampaignMembers.test.tsx`
Expected: FAIL with "Cannot find module './CampaignMembers.js'".

- [ ] **Step 3: Write minimal component**

Follow `CampaignCharactersTab`'s owner/query shape (`CampaignCharacters.tsx:329-364`: `useQuery` on the lifetime key, pending/error states, `onChanged` invalidates the key + parent refetch). Roster rows show role label + "(You)" marker for the actor; management buttons render only when `ownRole(...) === "owner" || ownRole(...) === "co_gm"` (display gating only — the server remains the policy authority). Role change uses `Select` (co_gm/player) + confirm `Dialog`; removal uses confirm `Dialog` with the destructive description above. Mutations mirror `attemptClaim`: fresh `crypto.randomUUID()`, 409 → `onChanged()` + conflict notice, 404 → `onAccessRevoked()`.

```tsx
// web/src/campaigns/CampaignMembers.tsx
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { t } from "../i18n/index.js";
import { Button, Dialog, EmptyState, Panel, Select } from "../ui/index.js";
import type { CampaignsApi } from "./api.js";
import { campaignMembersKey, useCampaignMembers } from "./campaignQueries.js";
import type { CampaignMember } from "./types.js";

export function ownRole(members: CampaignMember[], actorId: string): "owner" | "co_gm" | "player" | null {
  const own = members.find((member) => member.userId === actorId);
  if (own === undefined || own.status !== "active") return null;
  return own.role;
}

// isNotFound/isConflict/describeError helpers identical to CampaignCharacters.tsx:21-44.
// CampaignMembersTab: useCampaignMembers(api, campaignId, actorId, generation, { enabled: true, online });
// pending → loading status; error → loadFailed EmptyState with retry invalidating campaignMembersKey(campaignId, actorId, generation);
// success → flatMap pages, Panel roster; management Dialogs per above.
```

Check `Select`'s option contract in `web/src/ui/` before wiring (mirror the creation-panel `Select` in `CampaignCharacters.tsx:253-313`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix web run test -- src/campaigns/CampaignMembers.test.tsx`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add web/src/campaigns/CampaignMembers.tsx web/src/campaigns/CampaignMembers.test.tsx web/src/i18n/messages.ts
git commit -m "feat(g7): add GM campaign member roster with role management"
```

---

### Task 6: InvitationManager (issue/rotate/revoke, token display-once)

**Files:**
- Create: `web/src/campaigns/InvitationManager.tsx`
- Create: `web/src/campaigns/InvitationManager.test.tsx`
- Modify: `web/src/i18n/messages.ts` (add `campaign.detail.invitations.manage.*` keys)

**Interfaces:**
- Consumes: `useCampaignInvitations` (Task 2); `CampaignsApi.issueInvitation`, `rotateInvitation`, `revokeInvitation` (Task 1); `IssueInvitationResponse` (`{invitation: {...} & ({token: string} | {tokenUnavailable: true}), requestId}`).
- Produces: `InvitationManager({api, campaignId, campaignRevision, actorId, generation, online, onChanged})` (mounted by the Members tab in Task 7 for GMs only).

Behavior: issue form (intended-role `Select` player/co_gm, optional expiry text input mapped to `expiresAt` or omitted) → `issueInvitation(campaignId, {intendedRole, ...(expiresAt?), expectedCampaignRevision, idempotencyKey})`. The returned token renders **once** in a prominent display with a "copy now, it will not be shown again" notice and is never stored in query cache, state beyond the display, logs, or error messages (mirror `InvitationReview.tsx:43-47` sanitize-redacts-`activeToken` discipline: keep the token in a single local state cleared on dismiss/rotate). Same-key replay returning `tokenUnavailable: true` renders the "issue again via rotate" notice (per backend contract: lost response → same-key replay gives `invitationId`, then explicit rotate with a new key). Invitation rows show intended role, status, expiry (metadata only — never tokens). Rotate sends `{expectedInvitationRevision, expectedCampaignRevision, idempotencyKey}` and displays the fresh token once; revoke sends the same shape behind a confirm `Dialog` (revocation does not remove membership — say so in the confirm text). 409 → `onChanged()` + conflict notice + fresh-key retry.

i18n keys: `campaign.detail.invitations.manage.title: "Invitations"`, `campaign.detail.invitations.manage.loading: "Loading invitations…"`, `campaign.detail.invitations.manage.loadFailed: "Invitations could not be loaded."`, `campaign.detail.invitations.manage.empty: "No invitations yet."`, `campaign.detail.invitations.manage.role.label: "Invite as"`, `campaign.detail.invitations.manage.role.player: "Player"`, `campaign.detail.invitations.manage.role.co_gm: "Co-GM"`, `campaign.detail.invitations.manage.expires.label: "Expiry (optional)"`, `campaign.detail.invitations.manage.issue: "Issue invitation"`, `campaign.detail.invitations.manage.issuing: "Issuing…"`, `campaign.detail.invitations.manage.token.title: "Share this invitation link token now"`, `campaign.detail.invitations.manage.token.hint: "It is shown once and never stored. Copy it now."`, `campaign.detail.invitations.manage.token.dismiss: "Done"`, `campaign.detail.invitations.manage.token.unavailable: "The token was already issued and cannot be recovered. Rotate the invitation for a new token."`, `campaign.detail.invitations.manage.rotate: "Rotate"`, `campaign.detail.invitations.manage.revoke: "Revoke"`, `campaign.detail.invitations.manage.revoke.confirm.title: "Revoke this invitation?"`, `campaign.detail.invitations.manage.revoke.confirm.description: "Revocation stops new joins on this link. It does not remove existing members."`, `campaign.detail.invitations.manage.revoke.confirm.confirm: "Revoke invitation"`, `campaign.detail.invitations.manage.conflict: "This campaign changed. The list was reloaded — review and retry."`, `campaign.detail.invitations.manage.error: "The request failed. Try again."`.

- [ ] **Step 1: Write the failing component test**

```tsx
// web/src/campaigns/InvitationManager.test.tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { InvitationManager } from "./InvitationManager.js";

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const issued = (token: string | null) => ({
  invitation: token === null
    ? { invitationId: "i1", campaignId: "c1", intendedRole: "player", status: "pending", expiresAt: "2026-10-01T00:00:00Z", invitationRevision: 1, issuedBy: "u1", tokenUnavailable: true as const }
    : { invitationId: "i1", campaignId: "c1", intendedRole: "player", status: "pending", expiresAt: "2026-10-01T00:00:00Z", invitationRevision: 1, issuedBy: "u1", token: token },
  requestId: "r",
});

describe("InvitationManager", () => {
  it("issues an invitation and shows the token once", async () => {
    const api = {
      listInvitations: vi.fn().mockResolvedValue({ invitations: [], nextCursor: null, requestId: "r0" }),
      issueInvitation: vi.fn().mockResolvedValue(issued("secret-token")),
    };
    render(<InvitationManager api={api as never} campaignId="c1" campaignRevision={4} actorId="u1" generation={0} online onChanged={() => {}} />, { wrapper: wrapper() });
    fireEvent.click(await screen.findByRole("button", { name: /issue invitation/i }));
    await vi.waitFor(() => expect(api.issueInvitation).toHaveBeenCalledWith("c1", expect.objectContaining({
      intendedRole: "player",
      expectedCampaignRevision: 4,
    })));
    expect(await screen.findByText("secret-token")).toBeVisible();
    expect(screen.getByText(/shown once/i)).toBeVisible();
  });

  it("reports tokenUnavailable replays without leaking a token", async () => {
    const api = {
      listInvitations: vi.fn().mockResolvedValue({ invitations: [], nextCursor: null, requestId: "r0" }),
      issueInvitation: vi.fn().mockResolvedValue(issued(null)),
    };
    render(<InvitationManager api={api as never} campaignId="c1" campaignRevision={4} actorId="u1" generation={0} online onChanged={() => {}} />, { wrapper: wrapper() });
    fireEvent.click(await screen.findByRole("button", { name: /issue invitation/i }));
    expect(await screen.findByText(/cannot be recovered/i)).toBeVisible();
  });

  it("revokes behind a confirmation dialog", async () => {
    const pending = { invitationId: "i1", intendedRole: "player", status: "pending", expiresAt: "2026-10-01T00:00:00Z", invitationRevision: 2, issuedBy: "u1", createdAt: "2026-09-01T00:00:00Z" };
    const api = {
      listInvitations: vi.fn().mockResolvedValue({ invitations: [pending], nextCursor: null, requestId: "r0" }),
      revokeInvitation: vi.fn().mockResolvedValue({ invitation: pending, requestId: "r2" }),
    };
    render(<InvitationManager api={api as never} campaignId="c1" campaignRevision={4} actorId="u1" generation={0} online onChanged={() => {}} />, { wrapper: wrapper() });
    fireEvent.click(await screen.findByRole("button", { name: /revoke/i }));
    fireEvent.click(await screen.findByRole("button", { name: /revoke invitation/i }));
    await vi.waitFor(() => expect(api.revokeInvitation).toHaveBeenCalledWith("c1", "i1", expect.objectContaining({
      expectedInvitationRevision: 2,
      expectedCampaignRevision: 4,
    })));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix web run test -- src/campaigns/InvitationManager.test.tsx`
Expected: FAIL with "Cannot find module './InvitationManager.js'".

- [ ] **Step 3: Write minimal component**

Mirror the `CampaignMembersTab` query shell (Task 5) for the metadata list plus the `attemptClaim` mutation shape for issue/rotate/revoke. Token state: `const [shownToken, setShownToken] = useState<{ inviteId: string; token: string } | null>(null)` — set only from fresh issue/rotate responses containing `token`, cleared on dismiss or when a newer token arrives. Narrow the union with `"token" in response.invitation`. The token must never be passed to `onChanged`, query invalidation payloads, or error text.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix web run test -- src/campaigns/InvitationManager.test.tsx`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add web/src/campaigns/InvitationManager.tsx web/src/campaigns/InvitationManager.test.tsx web/src/i18n/messages.ts
git commit -m "feat(g7): add GM invitation issue/rotate/revoke manager"
```

---

### Task 7: Members tab wiring, Phase 1 exit e2e, acceptance record

**Files:**
- Modify: `web/src/campaigns/CampaignDetail.tsx`
- Modify: `web/src/i18n/messages.ts` (add `campaign.detail.tabs.members: "Members"`)
- Create: `web/tests/e2e/gmSetupJourney.spec.ts`
- Create: `docs/acceptance/gui-2026-09-11-g7-gm-phase1.md`

**Interfaces:**
- Consumes: `CampaignMembersTab` + `ownRole` (Task 5), `InvitationManager` (Task 6), `CampaignSettingsView` (Task 4); `CampaignDetail`'s existing `Tabs` block (`CampaignDetail.tsx:180-221`), `handleAccessRevoked` (`CampaignDetail.tsx:52-59`), `detail.refetch` for `onChanged`.
- Produces: GM-gated Members tab; Phase 1 exit evidence; acceptance record.

Wiring rule: the Members tab mounts `CampaignMembersTab` (which loads the roster). GM-only blocks (`CampaignSettingsView`, `InvitationManager`) need the actor's own role — derive it inside a small wrapper in `CampaignDetail.tsx` that runs `useCampaignMembers` once and passes `isGm = role === "owner" || role === "co_gm"` down. Do **not** add a second members query inside `CampaignMembersTab` and the wrapper separately: `CampaignMembersTab` accepts an optional injected roster? No — keep it simple: the wrapper reads the same `campaignMembersKey` cache via `useCampaignMembers` with identical parameters (TanStack dedupes to one request), and renders settings/invitations only when `isGm` is true. Players see the roster tab without management sections.

- [ ] **Step 1: Write the failing detail-tab test**

Add to a new `web/src/campaigns/CampaignDetail.members.test.tsx`:

```tsx
// web/src/campaigns/CampaignDetail.members.test.tsx
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

describe("CampaignDetail members tab", () => {
  it("shows management sections to the campaign owner", async () => {
    const api = {
      openCampaign: vi.fn().mockResolvedValue({ campaign, requestId: "r" }),
      listMembers: vi.fn().mockResolvedValue({
        members: [{ campaignId: "c1", userId: "u1", role: "owner", status: "active", generation: 1, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" }],
        nextCursor: null, requestId: "r2",
      }),
      listInvitations: vi.fn().mockResolvedValue({ invitations: [], nextCursor: null, requestId: "r3" }),
    };
    render(<CampaignDetail api={api as never} campaignId="c1" actorId="u1" onLeft={() => {}} />, { wrapper: wrapper() });
    const tab = await screen.findByRole("tab", { name: /members/i });
    tab.click();
    expect(await screen.findByText(/campaign settings/i)).toBeVisible();
    expect(await screen.findByText(/^invitations$/i)).toBeVisible();
  });
});
```

Check the `Tabs` component's tablist roles in `web/src/ui/` before finalizing selectors (`role="tab"` vs buttons) — the G2 record notes `Menu` keeps disclosure semantics; verify `Tabs` renders real tabs.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix web run test -- src/campaigns/CampaignDetail.members.test.tsx`
Expected: FAIL (no Members tab).

- [ ] **Step 3: Wire the Members tab**

In `CampaignDetail.tsx`: import `CampaignMembersTab, ownRole`, `InvitationManager`, `CampaignSettingsView`, `useCampaignMembers`. Add a `tabs` entry `{ id: "members", label: t("campaign.detail.tabs.members"), content: <MembersManageSection ... /> }` after the characters entry. Implement `MembersManageSection` in the same file:

```tsx
function MembersManageSection(props: {
  api: CampaignsApi;
  campaignId: string;
  actorId: string;
  campaign: CampaignView;
  generation: number;
  online: boolean;
  onChanged: () => void;
  onAccessRevoked: () => void;
}) {
  const roster = useCampaignMembers(props.api, props.campaignId, props.actorId, props.generation, {
    enabled: true,
    online: props.online,
  });
  const members = roster.data?.pages.flatMap((page) => page.members) ?? [];
  const isGm = ownRole(members, props.actorId) === "owner" || ownRole(members, props.actorId) === "co_gm";
  return (
    <>
      <CampaignMembersTab
        api={props.api}
        campaignId={props.campaignId}
        actorId={props.actorId}
        campaignRevision={props.campaign.revision}
        generation={props.generation}
        online={props.online}
        onChanged={props.onChanged}
        onAccessRevoked={props.onAccessRevoked}
      />
      {isGm ? (
        <>
          <CampaignSettingsView api={props.api} campaign={props.campaign} onChanged={props.onChanged} />
          <InvitationManager
            api={props.api}
            campaignId={props.campaignId}
            campaignRevision={props.campaign.revision}
            actorId={props.actorId}
            generation={props.generation}
            online={props.online}
            onChanged={props.onChanged}
          />
        </>
      ) : null}
    </>
  );
}
```

`CampaignDetail` must receive `generation` and `online`: extend its props as optional (`generation?: number; online?: boolean`, defaulting `0`/`true`) and pass them from `CampaignDetailRouteView` (`router.tsx:463-479`: `generation` is already in scope; `online={identity.isOnline()}` mirrors `CampaignLibraryRouteView` at `router.tsx:431`). This keeps existing `CampaignDetail` callers/tests compiling.

Also extend `handleAccessRevoked` to purge the new keys: add `queryClient.removeQueries({ queryKey: ["campaigns", "members", props.campaignId] })` and the invitations equivalent — scoped by campaign prefix so all actor/generation entries drop.

- [ ] **Step 4: Run tests + typecheck + full web suite**

Run: `npm --prefix web run test -- src/campaigns/CampaignDetail.members.test.tsx`
Expected: PASS.
Run: `npm --prefix web run test`
Expected: full suite green.
Run: `npm --prefix web run typecheck`
Expected: clean.
Run from repo root: `npm run contracts:check`
Expected: pass.

- [ ] **Step 5: Write the Phase 1 exit e2e**

Create `web/tests/e2e/gmSetupJourney.spec.ts` mirroring `web/tests/e2e/campaignJourney.spec.ts:1-70` helpers (`signInAs`, `postJson`, `signInViaPanel`, `STEP_TIMEOUT`, dev sign-in panel, `publishOwnedClone` + `uid` from `../offline/test-auth.js`). Flow as the GM actor (`code-test-a`) **entirely through the UI**: `/campaigns/new` → select the seeded owned d20 clone version → title `G7 GM Setup <uid>` → Create → detail opens with pinned version shown → Members tab → issue player invitation → token shown once → dismiss → rotate → new token shown → revoke the rotated invitation → change nothing else. Then invitee flow (`code-test-b` via panel + token from the GM screen, or a fresh issue): accept at `/invitations?token=`, open campaign, then GM promotes the member to co-GM and removes them (confirm dialogs), verifying list updates and unavailable states. Seed only the owned d20 clone through the real System Builder API (same OD-01 rationale as `campaignJourney.spec.ts:14-18`); campaign setup itself runs through the UI — no direct campaign HTTP provisioning.

- [ ] **Step 6: Run the e2e**

Run from `web/` (env `CI=1 DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll_e2e AUTHORITATIVE_ROLL_SECRET=development-only-roll-secret-32-bytes`; Playwright starts its own backend + web per `playwright.config.ts`):
`npx playwright test tests/e2e/gmSetupJourney.spec.ts`
Expected: 1/1 pass. Record the actual run (time, viewport, theme) in the acceptance note — only checks actually run.

- [ ] **Step 7: Write the acceptance record + commit**

Create `docs/acceptance/gui-2026-09-11-g7-gm-phase1.md` mirroring `docs/acceptance/gui-2026-09-11-g7-player.md`: date, tree, exit demonstration steps, gates actually run with exact commands and counts, fixture, screenshots (none/DOM assertions), findings, limitations (production OIDC unvalidated, no real-device runs, no dark-mode/phone-viewport e2e unless run).

```bash
git add web/src/campaigns/CampaignDetail.tsx web/src/campaigns/CampaignDetail.members.test.tsx web/src/router.tsx web/src/i18n/messages.ts web/tests/e2e/gmSetupJourney.spec.ts docs/acceptance/gui-2026-09-11-g7-gm-phase1.md
git commit -m "feat(g7): wire GM members tab and Phase 1 exit demonstration"
```

---

## Deferred to later Phase 1 follow-ups (not this plan)

- Content authoring/grants/reveal-hide (spec Phase 2).
- Session board, one-tap bumps, roll-audience controls (spec Phase 2).
- Upgrade preview/commit backend command + UI (spec Phase 3).
- Two-device hardening, WCAG/load/SLO/runbook (spec Phase 4).
- Preview-as-player (deferred per spec).
- Export payload download/display (Task 4 reports readiness only).
