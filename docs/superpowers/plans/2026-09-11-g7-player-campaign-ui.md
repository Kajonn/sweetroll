# G7 Player Campaign UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Players can review/accept invitations, browse campaigns, claim/create campaign characters, and read permitted content/activity through the real I6 HTTP contracts with shared controls.

**Architecture:** New `web/src/campaigns/` domain seam (`types.ts` derived from `operations`, `api.ts` thin `ApiClient` wrappers, `campaignQueries.ts` lifetime-scoped TanStack hooks) mirroring `web/src/characters/` + `web/src/player/characterQueries.ts`; new TanStack routes under `/campaigns` and `/invitations` reusing the `*RouteView` template in `web/src/router.tsx`; AppShell gains a Campaigns nav entry (header + phone bottom nav) together with the routes, never alone.

**Tech Stack:** React + TypeScript, TanStack Router/Query, CSS modules, `web/src/ui/` shared controls, generated `web/src/api/schema.d.ts` (`paths`/`operations`) via `npm run contracts:check`.

**Spec:** `design_v2.md` §17.8 Player integration tasks 1–5 + §13 cursor/idempotency/revision rules; GUI plan `docs/superpowers/plans/2026-09-08-gui-integration.md` G7 player boxes; backend contract source `src/transport/http/campaigns.ts:503-936`.

## Global Constraints

- One deployable artifact; no new backend routes, no package-format change, no second character renderer (reuse `CharacterDetail`/`CharacterRoute` session for sheets).
- All campaign reads/writes go through `ApiClient` (`credentials:include`, `x-request-id`, JSON bodies even for DELETEs); tokens travel in POST bodies only, never URLs.
- Every mutation sends a caller-minted `idempotencyKey` (UUID); after any `409`, re-read then mint a fresh key — never reuse.
- `409 conflict` carries `latestRevision` (parsed as `ApiError.latestRevision`); surface explicit retry/reload, never "Merge".
- Query keys always include actor + generation: `["campaigns", ..., actorId, generation, ...]`; `enabled` requires `actorId !== null && online`; sign-out/account-switch relies on AppShell `cancelQueries/removeQueries` + lifetime remount `key=`.
- Shared controls (`Button, Panel, PageHeader, EmptyState, FormField, Select, Dialog`) for all new surfaces; controls never decide authorization — server 404/409s render as unavailable/conflict states.
- No `campaign` string stays out of `web/src/player/` (I5 campaign-free rule preserved by putting new code in `web/src/campaigns/` + router + shell only).
- TDD red-green per task; `npm run contracts:check` stays green (no schema edit expected — consuming only).

---

### Task 1: CampaignsApi domain seam + derived types

**Files:**
- Create: `web/src/campaigns/types.ts`
- Create: `web/src/campaigns/api.ts`
- Create: `web/src/campaigns/campaignQueries.ts`
- Create: `web/src/campaigns/api.test.ts`
- Create: `web/src/campaigns/campaignQueries.test.tsx`

**Interfaces:**
- Consumes: `ApiClient.fetch` from `web/src/api/client.ts:50-60`; `operations` from `web/src/api/schema.js`.
- Produces: `CampaignsApi` (used by Tasks 2–5); `campaignListKey(actorId, generation)`, `useCampaignList(api, actorId, generation, options)` (used by Task 3); `CampaignSummary`, `CampaignView`, `InvitationReview`, `ContentSummary`, `CampaignActivityEvent` types (used by Tasks 2–5).

- [ ] **Step 1: Write the failing types + api test**

```tsx
// web/src/campaigns/api.test.ts
import { describe, expect, it, vi } from "vitest";
import { createCampaignsApi } from "./api.js";

describe("createCampaignsApi", () => {
  it("lists campaigns with cursor + limit query params", async () => {
    const fetch = vi.fn().mockResolvedValue({ campaigns: [], nextCursor: null, requestId: "r1" });
    const api = createCampaignsApi({ fetch } as never);
    await api.listCampaigns({ cursor: null, limit: 25 });
    expect(fetch).toHaveBeenCalledWith("GET", "/campaigns", {
      query: { cursor: undefined, limit: 25 },
    });
  });

  it("reviews an invitation by token in the POST body only", async () => {
    const fetch = vi.fn().mockResolvedValue({ review: { invitationId: "i1" }, requestId: "r2" });
    const api = createCampaignsApi({ fetch } as never);
    await api.reviewInvitation({ token: "secret-token" });
    expect(fetch).toHaveBeenCalledWith("POST", "/invitations/review", {
      body: { token: "secret-token" },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix web run test -- src/campaigns/api.test.ts`
Expected: FAIL with "Cannot find module './api.js'".

- [ ] **Step 3: Write minimal types + implementation**

```ts
// web/src/campaigns/types.ts
import type { operations } from "../api/schema.js";

export type CampaignListResponse =
  operations["get_campaigns"]["responses"]["200"]["content"]["application/json"];
export type CampaignSummary = CampaignListResponse["campaigns"][number];

export type CampaignViewResponse =
  operations["get_campaigns_id"]["responses"]["200"]["content"]["application/json"];
export type CampaignView = CampaignViewResponse["campaign"];

export type InvitationReviewResponse =
  operations["post_invitations_review"]["responses"]["200"]["content"]["application/json"];
export type InvitationReview = InvitationReviewResponse["review"];

export type InvitationAcceptBody = NonNullable<
  operations["post_invitations_accept"]["requestBody"]
>["content"]["application/json"];
export type InvitationAcceptResponse =
  operations["post_invitations_accept"]["responses"]["200"]["content"]["application/json"];

export type CampaignCharacterListResponse =
  operations["get_campaigns_id_characters"]["responses"]["200"]["content"]["application/json"];
export type CampaignCharacterSummary = CampaignCharacterListResponse["characters"][number];

export type CampaignContentListResponse =
  operations["get_campaigns_id_content"]["responses"]["200"]["content"]["application/json"];
export type ContentSummary = CampaignContentListResponse["content"][number];

export type CampaignContentResponse =
  operations["get_content_id"]["responses"]["200"]["content"]["application/json"];
export type ContentView = CampaignContentResponse["content"];

export type CampaignActivityResponse =
  operations["get_campaigns_id_activity"]["responses"]["200"]["content"]["application/json"];
export type CampaignActivityEvent = CampaignActivityResponse["events"][number];
```

```ts
// web/src/campaigns/api.ts
import type { ApiClient } from "../api/client.js";
import type {
  CampaignActivityResponse,
  CampaignCharacterListResponse,
  CampaignContentListResponse,
  CampaignContentResponse,
  CampaignListResponse,
  CampaignViewResponse,
  ContentView,
  InvitationAcceptBody,
  InvitationAcceptResponse,
} from "./types.js";
import type { operations } from "../api/schema.js";

export type CampaignListQuery = { cursor?: string | null; limit?: number };
export type ReviewInvitationBody = { token: string };
export type DeclineInvitationBody = {
  campaignId: string;
  token: string;
  expectedInvitationRevision: number;
  reviewedAccessRevision: number;
  idempotencyKey: string;
};
export type ClaimCharacterBody = {
  expectedCampaignRevision: number;
  expectedCharacterRevision: number;
  idempotencyKey: string;
};

type ReviewBody = NonNullable<
  operations["post_invitations_review"]["requestBody"]
>["content"]["application/json"];
type DeclineResponse =
  operations["post_invitations_decline"]["responses"]["200"]["content"]["application/json"];
type ContentListQuery = { cursor?: string | null; limit?: number };
type ActivityListQuery = { cursor?: string | null; limit?: number };

export type CampaignsApi = {
  listCampaigns(input?: CampaignListQuery): Promise<CampaignListResponse>;
  openCampaign(campaignId: string): Promise<CampaignViewResponse>;
  reviewInvitation(body: ReviewInvitationBody): Promise<InvitationReviewResponse>;
  acceptInvitation(body: InvitationAcceptBody): Promise<InvitationAcceptResponse>;
  declineInvitation(body: DeclineInvitationBody): Promise<DeclineResponse>;
  leaveCampaign(campaignId: string, memberUserId: string, body: { expectedCampaignRevision: number; idempotencyKey: string }): Promise<unknown>;
  listCampaignCharacters(campaignId: string, input?: CampaignListQuery): Promise<CampaignCharacterListResponse>;
  claimCharacter(campaignId: string, characterId: string, body: ClaimCharacterBody): Promise<unknown>;
  listContent(campaignId: string, input?: ContentListQuery): Promise<CampaignContentListResponse>;
  openContent(contentId: string): Promise<CampaignContentResponse>;
  listActivity(campaignId: string, input?: ActivityListQuery): Promise<CampaignActivityResponse>;
};

export function createCampaignsApi(client: ApiClient): CampaignsApi {
  return {
    listCampaigns: (input) =>
      input === undefined
        ? client.fetch<CampaignListResponse>("GET", "/campaigns")
        : client.fetch<CampaignListResponse>("GET", "/campaigns", {
          query: { cursor: input.cursor ?? undefined, limit: input.limit ?? undefined },
        }),
    openCampaign: (campaignId) =>
      client.fetch<CampaignViewResponse>("GET", `/campaigns/${campaignId}`),
    reviewInvitation: (body) =>
      client.fetch<InvitationReviewResponse>("POST", "/invitations/review", {
        body: body as ReviewBody,
      }),
    acceptInvitation: (body) =>
      client.fetch<InvitationAcceptResponse>("POST", "/invitations/accept", { body }),
    declineInvitation: (body) =>
      client.fetch<DeclineResponse>("POST", "/invitations/decline", { body }),
    leaveCampaign: (campaignId, memberUserId, body) =>
      client.fetch("DELETE", `/campaigns/${campaignId}/members/${memberUserId}`, { body }),
    listCampaignCharacters: (campaignId, input) =>
      client.fetch<CampaignCharacterListResponse>("GET", `/campaigns/${campaignId}/characters`, {
        query: input === undefined ? undefined : { cursor: input.cursor ?? undefined, limit: input.limit ?? undefined },
      }),
    claimCharacter: (campaignId, characterId, body) =>
      client.fetch("POST", `/campaigns/${campaignId}/characters/${characterId}/claim`, { body }),
    listContent: (campaignId, input) =>
      client.fetch<CampaignContentListResponse>("GET", `/campaigns/${campaignId}/content`, {
        query: input === undefined ? undefined : { cursor: input.cursor ?? undefined, limit: input.limit ?? undefined },
      }),
    openContent: (contentId) =>
      client.fetch<CampaignContentResponse>("GET", `/content/${contentId}`),
    listActivity: (campaignId, input) =>
      client.fetch<CampaignActivityResponse>("GET", `/campaigns/${campaignId}/activity`, {
        query: input === undefined ? undefined : { cursor: input.cursor ?? undefined, limit: input.limit ?? undefined },
      }),
  };
}
```

```ts
// web/src/campaigns/campaignQueries.ts
import { useInfiniteQuery } from "@tanstack/react-query";
import type { CampaignsApi, CampaignListQuery } from "./api.js";

export const CAMPAIGN_LIST_PAGE_LIMIT = 25;

export function campaignListKey(actorId: string | null, generation: number) {
  return ["campaigns", "list", actorId, generation];
}

export function useCampaignList(
  api: CampaignsApi,
  actorId: string | null,
  generation: number,
  options: { enabled: boolean; online: boolean },
) {
  return useInfiniteQuery({
    queryKey: campaignListKey(actorId, generation),
    queryFn: ({ pageParam }: { pageParam: string | null }) => {
      const query: CampaignListQuery = { cursor: pageParam, limit: CAMPAIGN_LIST_PAGE_LIMIT };
      return api.listCampaigns(query);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? null,
    enabled: options.enabled && options.online && actorId !== null,
    staleTime: 30_000,
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix web run test -- src/campaigns/api.test.ts src/campaigns/campaignQueries.test.tsx`
Expected: PASS. `campaignQueries.test.tsx` asserts the key contains actor+generation and no fetch happens while signed out (`enabled:false` → `fetch` not called, status `pending`).

- [ ] **Step 5: Commit**

```bash
git add web/src/campaigns/types.ts web/src/campaigns/api.ts web/src/campaigns/campaignQueries.ts web/src/campaigns/api.test.ts web/src/campaigns/campaignQueries.test.tsx
git commit -m "feat(g7): add campaigns API seam with lifetime-scoped list query"
```

### Task 2: Invitation review / accept / decline route

**Files:**
- Create: `web/src/campaigns/InvitationReview.tsx`
- Create: `web/src/campaigns/InvitationReview.test.tsx`
- Modify: `web/src/router.tsx` (add `/invitations` route + `InvitationsRouteView`)
- Modify: `web/src/i18n/messages.ts` (add `campaign.invitations.*` strings; follow existing `character.*` key style)

**Interfaces:**
- Consumes: `CampaignsApi.reviewInvitation/acceptInvitation/declineInvitation` (Task 1); `Panel, PageHeader, EmptyState, Button, FormField` from `web/src/ui/index.ts`; `t()` from `web/src/i18n/index.ts`.
- Produces: `/invitations?token=` route (used by Task 3 empty-state link); `InvitationsRouteView` export (router only).

- [ ] **Step 1: Write the failing component test**

```tsx
// web/src/campaigns/InvitationReview.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InvitationReviewView } from "./InvitationReview.js";

describe("InvitationReviewView", () => {
  it("shows campaign identity and confirm/decline actions after review", async () => {
    const api = {
      reviewInvitation: vi.fn().mockResolvedValue({
        review: {
          invitationId: "i1", campaignId: "c1", campaignTitle: "Thursday Knights",
          systemVersionId: "v1", inviterDisplayName: "Ada", intendedRole: "player",
          expiresAt: "2026-10-01T00:00:00Z", invitationRevision: 1, accessRevision: 3,
        },
        requestId: "r1",
      }),
    };
    render(<InvitationReviewView api={api as never} actorId="u1" token="tok" />);
    expect(await screen.findByText("Thursday Knights")).toBeVisible();
    expect(screen.getByRole("button", { name: /accept/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /decline/i })).toBeVisible();
  });

  it("maps unknown/expired tokens to an unavailable state, never the token", async () => {
    const api = {
      reviewInvitation: vi.fn().mockRejectedValue({ code: "not_found", status: 404, message: "nope" }),
    };
    const { container } = render(<InvitationReviewView api={api as never} actorId="u1" token="tok" />);
    expect(await screen.findByText(/unavailable|expired|revoked/i)).toBeVisible();
    expect(container.textContent).not.toContain("tok");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix web run test -- src/campaigns/InvitationReview.test.tsx`
Expected: FAIL with "Cannot find module './InvitationReview.js'".

- [ ] **Step 3: Write minimal implementation**

```tsx
// web/src/campaigns/InvitationReview.tsx (presentational core; router supplies api/actorId/token)
import { useState } from "react";
import { Button, EmptyState, PageHeader, Panel } from "../ui/index.js";
import type { CampaignsApi } from "./api.js";
import type { InvitationReview } from "./types.js";

export function InvitationReviewView(props: { api: CampaignsApi; actorId: string | null; token: string }) {
  const [review, setReview] = useState<InvitationReview | null>(null);
  const [phase, setPhase] = useState<"entering" | "reviewing" | "reviewed" | "unavailable" | "accepted" | "declined" | "conflict">("reviewing");
  const [error, setError] = useState<string | null>(null);
  // ... review on mount via props.api.reviewInvitation({ token: props.token });
  // accept: mint crypto.randomUUID() idempotencyKey, send
  // { campaignId, token, expectedInvitationRevision, reviewedAccessRevision, idempotencyKey };
  // 404 -> "unavailable" (never echo token); 409 -> "conflict" with re-review button.
  return (
    <section aria-labelledby="invitation-heading">
      <PageHeader id="invitation-heading" title="Campaign invitation" />
      {/* states per phase using Panel/EmptyState/Button */}
    </section>
  );
}
```

Full component: token entry `FormField` when no token in search; review panel shows `campaignTitle`, `inviterDisplayName`, `intendedRole`, `expiresAt` + explicit "you join as player" identity confirmation; Accept/Decline buttons mint `crypto.randomUUID()` keys; `not_found` → unavailable EmptyState (generic text, no token echo); `conflict` → re-review button (re-calls review, then retry with fresh key); success → link to `/campaigns/{campaignId}`.

Router addition (follow `charactersNewRoute` pattern):

```tsx
const invitationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invitations",
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === "string" ? search.token : undefined,
  }),
  component: InvitationsRouteView,
});
```

`InvitationsRouteView`: `useIdentityTick` → null/anon guards (signed-out shows sign-in prompt, then return via `storePostSigninPath("/invitations?token=…")`) → `useCampaignsApi()` (sibling of `useCharactersApi`: `useMemo(() => createCampaignsApi(createApiClient({ baseUrl: "/api" })), [])`) → lifetime `key={`${actor}:${generation}`}` → `<InvitationReviewView api actorId token>`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix web run test -- src/campaigns/InvitationReview.test.tsx`
Expected: PASS. Then `npm --prefix web run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add web/src/campaigns/InvitationReview.tsx web/src/campaigns/InvitationReview.test.tsx web/src/router.tsx web/src/i18n/messages.ts
git commit -m "feat(g7): add invitation review/accept/decline route"
```

### Task 3: Campaign list + detail shell + navigation

**Files:**
- Create: `web/src/campaigns/CampaignLibrary.tsx`
- Create: `web/src/campaigns/CampaignLibrary.test.tsx`
- Create: `web/src/campaigns/CampaignDetail.tsx` (tabs shell: Characters/Content/Activity; leave flow)
- Modify: `web/src/router.tsx` (add `/campaigns`, `/campaigns/$campaignId` routes)
- Modify: `web/src/shell/AppShell.tsx` (header + `player-bottom-nav` Campaigns entry)
- Modify: `web/src/i18n/messages.ts` (`shell.nav.campaigns`, `campaign.*` strings)

**Interfaces:**
- Consumes: `useCampaignList`, `CampaignsApi.openCampaign/leaveCampaign` (Task 1); `Tabs, PageHeader, Panel, EmptyState, Button` from ui.
- Produces: `/campaigns`, `/campaigns/$campaignId` routes (Task 4–5 build the tab bodies); `Campaigns` nav entries.

- [ ] **Step 1: Write the failing library test**

```tsx
// web/src/campaigns/CampaignLibrary.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CampaignLibraryView } from "./CampaignLibrary.js";

describe("CampaignLibraryView", () => {
  it("links each campaign to its detail route and offers invitation entry", () => {
    render(<CampaignLibraryView
      campaigns={[{ campaignId: "c1", title: "Thursday Knights", status: "active", revision: 2, accessRevision: 3, updatedAt: "2026-09-01T00:00:00Z" }]}
      hasNextPage={false} onLoadMore={() => {}} onEnterToken={() => {}} />);
    expect(screen.getByRole("link", { name: /thursday knights/i })).toHaveAttribute("href", "/campaigns/c1");
    expect(screen.getByRole("link", { name: /invitation|join/i })).toHaveAttribute("href", "/invitations");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix web run test -- src/campaigns/CampaignLibrary.test.tsx`
Expected: FAIL with "Cannot find module './CampaignLibrary.js'".

- [ ] **Step 3: Write minimal implementation**

`CampaignLibrary.tsx`: presentational list (router view owns the `useCampaignList` hook with `key={campaignLibraryViewKey(actor, generation)}` = `` `${actor ?? "signed-out"}:${generation}` ``); rows link to `/campaigns/{campaignId}`; empty state links to `/invitations`; "load more" when `hasNextPage`. `CampaignDetail.tsx`: `openCampaign` on mount; `Tabs` with Characters/Content/Activity tabs (bodies land in Tasks 4–5; this task ships honest `EmptyState` placeholders inside tabs? NO placeholders — ship tabs with real Characters list from Task 4 landing first: order Tasks so Characters tab renders `listCampaignCharacters` here; keep Content/Activity tabs for Task 5). Rework: this task ships list + detail shell + Characters tab + leave flow (DELETE members/self with `{expectedCampaignRevision, idempotencyKey}` + confirm Dialog + post-leave navigate to `/campaigns` + `removeQueries` for that campaign key). Nav: header anchor `/campaigns` with `t("shell.nav.campaigns")`; bottom nav adds Campaigns between Characters and Activity.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix web run test -- src/campaigns/CampaignLibrary.test.tsx`
Expected: PASS. Then full `npm --prefix web run test -- src/campaigns` + `typecheck`.

- [ ] **Step 5: Commit**

```bash
git add web/src/campaigns/CampaignLibrary.tsx web/src/campaigns/CampaignLibrary.test.tsx web/src/campaigns/CampaignDetail.tsx web/src/router.tsx web/src/shell/AppShell.tsx web/src/i18n/messages.ts
git commit -m "feat(g7): add campaign list, detail shell, characters tab, leave flow, nav"
```

### Task 4: Campaign character claiming + creation indicators

**Files:**
- Create: `web/src/campaigns/CampaignCharacters.tsx`
- Create: `web/src/campaigns/CampaignCharacters.test.tsx`
- Modify: `web/src/campaigns/CampaignDetail.tsx` (render real tab body)

**Interfaces:**
- Consumes: `CampaignsApi.listCampaignCharacters/claimCharacter` (Task 1); existing `CharacterDetail` renderer for opened sheets (no new renderer).
- Produces: Characters tab body with ownership/editability indicators.

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/campaigns/CampaignCharacters.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CampaignCharactersView } from "./CampaignCharacters.js";

describe("CampaignCharactersView", () => {
  it("marks claimable sheets and claims with a fresh idempotency key", async () => {
    const api = { claimCharacter: vi.fn().mockResolvedValue({ character: {}, requestId: "r" }) };
    render(<CampaignCharactersView api={api as never} campaignId="c1" campaignRevision={2}
      characters={[{ characterId: "s1", campaignId: "c1", name: "Bram", entityDefinitionId: "hero",
        systemVersionId: "v1", revision: 4, lifecycle: "active", placementGeneration: 1,
        controllers: [], updatedAt: "2026-09-01T00:00:00Z", claimable: true } as never]}
      characterRevisionById={{ s1: 4 }} onOpenCharacter={() => {}} />);
    const button = screen.getByRole("button", { name: /claim bram/i });
    button.click();
    await vi.waitFor(() => expect(api.claimCharacter).toHaveBeenCalled());
    const body = (api.claimCharacter as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(body.expectedCampaignRevision).toBe(2);
    expect(typeof body.idempotencyKey).toBe("string");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix web run test -- src/campaigns/CampaignCharacters.test.tsx`
Expected: FAIL with "Cannot find module './CampaignCharacters.js'".

- [ ] **Step 3: Write minimal implementation**

Rows show name + controllers count + lifecycle + explicit "you control / claimable / view-only" indicator text (never color alone); claimable rows offer Claim (confirm Dialog disclosing campaign custody; `claimCharacter(campaignId, id, { expectedCampaignRevision, expectedCharacterRevision, idempotencyKey: crypto.randomUUID() })`; `404` → row becomes unavailable; `409` → reload list + "someone else claimed it" message with fresh retry). "New campaign character" entry routes to existing `/characters/new` picker seam? NO — campaign creation is `POST /campaigns/:id/characters` (Task 4 adds `createCampaignCharacter` to `CampaignsApi` with `{ name, entityDefinitionId, initialValues?, controllerUserIds?, expectedCampaignRevision, idempotencyKey }` + a minimal create form reusing creation-options metadata loader). Sheet opens reuse `onOpenCharacter` navigation to `/characters/$characterId` (same renderer).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix web run test -- src/campaigns/CampaignCharacters.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/campaigns/CampaignCharacters.tsx web/src/campaigns/CampaignCharacters.test.tsx web/src/campaigns/CampaignDetail.tsx web/src/campaigns/api.ts
git commit -m "feat(g7): add campaign character claiming, creation, indicators"
```

### Task 5: Permitted content + activity + revocation purge + e2e

**Files:**
- Create: `web/src/campaigns/CampaignContent.tsx`
- Create: `web/src/campaigns/CampaignActivity.tsx`
- Create: `web/src/campaigns/CampaignContent.test.tsx`
- Create: `web/tests/e2e/campaignJourney.spec.ts`
- Modify: `web/src/campaigns/CampaignDetail.tsx` (wire Content/Activity tabs)
- Modify: `docs/acceptance/gui-2026-09-11-g7-player.md` (new acceptance record)

**Interfaces:**
- Consumes: `CampaignsApi.listContent/openContent/listActivity` (Task 1); AppShell `removeQueries` + `store.clearAccount` purge paths (existing).
- Produces: G7 player exit evidence; acceptance record.

- [ ] **Step 1: Write the failing content test**

```tsx
// web/src/campaigns/CampaignContent.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { audienceLabel, CampaignContentView } from "./CampaignContent.js";

describe("audienceLabel", () => {
  it("names the audience in plain language for every level", () => {
    expect(audienceLabel("gm_only")).toMatch(/gm|game master/i);
    expect(audienceLabel("all_players")).toMatch(/all players|everyone/i);
    expect(audienceLabel("selected_players")).toMatch(/selected|specific/i);
    expect(audienceLabel("owner_only")).toMatch(/only you|private/i);
  });
});

describe("CampaignContentView", () => {
  it("renders persistent audience markings and hides revoked notes", () => {
    render(<CampaignContentView items={[
      { contentId: "n1", title: "Map", audience: "all_players", revision: 1, status: "active" },
      { contentId: "n2", title: "Secret", audience: "gm_only", revision: 1, status: "active" },
    ] as never} revokedIds={new Set(["n2"])} onOpenContent={() => {}} />);
    expect(screen.getByText(/all players|everyone/i)).toBeVisible();
    expect(screen.queryByText("Secret")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix web run test -- src/campaigns/CampaignContent.test.tsx`
Expected: FAIL with "Cannot find module './CampaignContent.js'".

- [ ] **Step 3: Write minimal implementation**

`audienceLabel(audience)` maps all four levels to plain language; list rows carry persistent audience marks; revoked/inaccessible ids passed as `revokedIds` are excluded from render (never mounted); detail opens via `openContent`; `404` on open → "unavailable" EmptyState + list invalidation; activity tab renders `listActivity` events (kind + actor + timestamp, no secret payloads). Purge: on `not_found` for a previously-readable campaign/content, the detail view calls `queryClient.removeQueries({ queryKey: ["campaigns"] })` scoped to that campaign key and navigates back with an "access changed" notice; sign-out path already purges via AppShell. E2E `campaignJourney.spec.ts` (fresh-DB-safe, unique names): dev sign-in A → create campaign via API? NO direct-HTTP provisioning in e2e except seeding the campaign through the real UI? Compromise (matches G6 precedent of API-seeded fixtures): issue invitation through real `POST /campaigns/:id/invitations` HTTP (GM actor), then UI flow as invitee B: `/invitations?token=` review → accept → `/campaigns` list shows it → open → claim character → read permitted content → leave → list no longer shows it + reload shows unavailable. Per-roll audience selection stays server-driven (existing sheet behavior); no new roll UI in this task.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix web run test -- src/campaigns/CampaignContent.test.tsx`
Expected: PASS. Then `CI=1 DATABASE_URL=… AUTHORITATIVE_ROLL_SECRET=… npx playwright test tests/e2e/campaignJourney.spec.ts` from `web/`.
Expected: PASS.

- [ ] **Step 5: Commit + acceptance record**

```bash
git add web/src/campaigns/CampaignContent.tsx web/src/campaigns/CampaignActivity.tsx web/src/campaigns/CampaignContent.test.tsx web/src/campaigns/CampaignDetail.tsx web/tests/e2e/campaignJourney.spec.ts docs/acceptance/gui-2026-09-11-g7-player.md
git commit -m "feat(g7): add campaign content, activity, revocation purge, e2e"
```

## Self-Review

- Spec coverage: design §17.8 player task 1 → Task 2; task 2 → Tasks 3–4; task 3 → Task 5 (content/activity/audience); task 4 → Task 5 (revocation purge); task 5 → Task 5 (e2e). GM setup/session-board/co-GM/content-authoring/preview-as-player belong to I7 GM work, explicitly out of this plan. Per-roll audience *selection* UI is deferred: rolls execute through the existing sheet with server policy; selection widgets come with I7 roll-audience controls.
- Placeholder scan: no TBD/TODO; every step names exact files, commands, expected outputs.
- Type consistency: `CampaignsApi`/`CampaignSummary`/`CampaignView`/`InvitationReview` names stable across tasks; query-key shape `["campaigns", "list", actorId, generation]` reused by purge scoping.
