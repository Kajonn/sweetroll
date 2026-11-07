import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { CampaignsApi } from "./api.js";
import {
  CAMPAIGN_LIST_PAGE_LIMIT,
  campaignInvitationsKey,
  campaignListKey,
  campaignMembersKey,
  sceneDetailKey,
  useApplyFogEdit,
  useCampaignList,
  useCampaignMembers,
  useScene,
} from "./campaignQueries.js";

function makeApi(): CampaignsApi & { listCampaigns: ReturnType<typeof vi.fn> } {
  return {
    listCampaigns: vi.fn(),
    openCampaign: vi.fn(),
    reviewInvitation: vi.fn(),
    acceptInvitation: vi.fn(),
    declineInvitation: vi.fn(),
    leaveCampaign: vi.fn(),
    listCampaignCharacters: vi.fn(),
    claimCharacter: vi.fn(),
    listContent: vi.fn(),
    openContent: vi.fn(),
    listActivity: vi.fn(),
  } as unknown as CampaignsApi & { listCampaigns: ReturnType<typeof vi.fn> };
}

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe("campaignListKey", () => {
  it("scopes the list key by account lifetime (actor + generation)", () => {
    expect(campaignListKey("actor-A", 0)).toEqual(["campaigns", "list", "actor-A", 0]);
    expect(campaignListKey("actor-A", 1)).toEqual(["campaigns", "list", "actor-A", 1]);
    expect(campaignListKey("actor-A", 0)).not.toEqual(campaignListKey("actor-B", 0));
  });
});

describe("useCampaignList", () => {
  it("does not fetch while signed out (enabled:false → fetch not called, status pending)", () => {
    const api = makeApi();
    const { result } = renderHook(
      () => useCampaignList(api, null, 0, { enabled: false, online: true }),
      { wrapper: wrapper() },
    );
    expect(api.listCampaigns).not.toHaveBeenCalled();
    expect(result.current.status).toBe("pending");
    expect(result.current.fetchStatus).toBe("idle");
  });

  it("fetches the first page with cursor + limit while signed in", async () => {
    const api = makeApi();
    api.listCampaigns.mockResolvedValue({ campaigns: [], nextCursor: null, requestId: "r1" });
    const { result } = renderHook(
      () => useCampaignList(api, "actor-1", 0, { enabled: true, online: true }),
      { wrapper: wrapper() },
    );
    await vi.waitFor(() => expect(api.listCampaigns).toHaveBeenCalledTimes(1));
    expect(api.listCampaigns).toHaveBeenCalledWith({ cursor: null, limit: CAMPAIGN_LIST_PAGE_LIMIT });
    await vi.waitFor(() => expect(result.current.status).toBe("success"));
  });
});

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
    await waitFor(() => expect(result.current.status).toBe("success"));
  });
});

describe("sceneDetailKey", () => {
  it("scopes the scene key by campaign, scene, actor, and generation", () => {
    expect(sceneDetailKey("c1", "s1", "u1", 2)).toEqual(["campaigns", "scene", "c1", "s1", "u1", 2]);
    expect(sceneDetailKey("c1", "s1", "u1", 2)).not.toEqual(sceneDetailKey("c1", "s1", "u2", 2));
    expect(sceneDetailKey("c1", "s1", "u1", 2)).not.toEqual(sceneDetailKey("c1", "s1", "u1", 3));
    expect(sceneDetailKey("c1", "s1", "u1", 2)).not.toEqual(sceneDetailKey("c1", "s2", "u1", 2));
  });
});

describe("useScene", () => {
  it("stays disabled while signed out or offline", () => {
    const api = { openScene: vi.fn() };
    const signedOut = renderHook(
      () => useScene(api as never, "c1", "s1", null, 0, { enabled: true, online: true }),
      { wrapper: wrapper() },
    );
    const offline = renderHook(
      () => useScene(api as never, "c1", "s1", "u1", 0, { enabled: true, online: false }),
      { wrapper: wrapper() },
    );
    expect(signedOut.result.current.status).toBe("pending");
    expect(offline.result.current.status).toBe("pending");
    expect(api.openScene).not.toHaveBeenCalled();
  });

  it("reads the scene while signed in", async () => {
    const api = {
      openScene: vi.fn().mockResolvedValue({ scene: { sceneId: "s1" }, requestId: "r" }),
    };
    const { result } = renderHook(
      () => useScene(api as never, "c1", "s1", "u1", 0, { enabled: true, online: true }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(api.openScene).toHaveBeenCalledWith("s1"));
    await waitFor(() => expect(result.current.status).toBe("success"));
  });
});

describe("useApplyFogEdit", () => {
  it("commits with a caller-minted key and invalidates the scene keys only", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const withClient = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const api = {
      applyFogEdit: vi.fn().mockResolvedValue({ scene: { sceneId: "s1" }, requestId: "r" }),
    };
    qc.setQueryData(sceneDetailKey("c1", "s1", "u1", 0), { scene: { sceneId: "s1" } });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useApplyFogEdit(api as never, "c1", "s1"), {
      wrapper: withClient,
    });
    const idempotencyKey = crypto.randomUUID();
    await result.current.mutateAsync({
      expectedSceneRevision: 2,
      op: { mode: "reveal", runs: [{ x: 0.5, y: 0.5, r: 0.1 }] },
      idempotencyKey,
    });
    expect(api.applyFogEdit).toHaveBeenCalledWith("s1", {
      expectedSceneRevision: 2,
      op: { mode: "reveal", runs: [{ x: 0.5, y: 0.5, r: 0.1 }] },
      idempotencyKey,
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["campaigns", "scene", "c1"] });
    // Displays get committed changes from the scene stream, not query caches.
    expect(invalidateSpy.mock.calls.some((call) => (call[0] as { queryKey?: readonly unknown[] }).queryKey?.[0] === "displays")).toBe(false);
  });
});
