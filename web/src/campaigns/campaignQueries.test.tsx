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
  campaignUpgradePreviewKey,
  displayProjectionKey,
  sceneDetailKey,
  useApplyFogEdit,
  useCampaignList,
  useCampaignMembers,
  useCommitUpgrade,
  useDisplayProjection,
  useScene,
  useUpgradePreview,
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

describe("campaignUpgradePreviewKey", () => {
  it("scopes the preview key by campaign, actor, generation, and target", () => {
    expect(campaignUpgradePreviewKey("c1", "u1", 2, "v2")).toEqual(
      ["campaigns", "upgrade-preview", "c1", "u1", 2, "v2"],
    );
    expect(campaignUpgradePreviewKey("c1", "u1", 2, "v2")).not.toEqual(
      campaignUpgradePreviewKey("c1", "u1", 2, "v3"),
    );
    expect(campaignUpgradePreviewKey("c1", "u1", 2, "v2")).not.toEqual(
      campaignUpgradePreviewKey("c1", "u2", 2, "v2"),
    );
  });
});

describe("useUpgradePreview", () => {
  it("stays disabled while signed out or offline", () => {
    const api = { previewUpgrade: vi.fn() };
    const signedOut = renderHook(
      () => useUpgradePreview(api as never, "c1", null, 0, "v2", { enabled: true, online: true }),
      { wrapper: wrapper() },
    );
    const offline = renderHook(
      () => useUpgradePreview(api as never, "c1", "u1", 0, "v2", { enabled: true, online: false }),
      { wrapper: wrapper() },
    );
    expect(signedOut.result.current.status).toBe("pending");
    expect(offline.result.current.status).toBe("pending");
    expect(api.previewUpgrade).not.toHaveBeenCalled();
  });

  it("fetches the preview for the target version while signed in", async () => {
    const api = {
      previewUpgrade: vi.fn().mockResolvedValue({ campaignId: "c1", characters: [], requestId: "r" }),
    };
    const { result } = renderHook(
      () => useUpgradePreview(api as never, "c1", "u1", 0, "v2", { enabled: true, online: true }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(api.previewUpgrade).toHaveBeenCalledWith("c1", { targetVersionId: "v2" }));
    await waitFor(() => expect(result.current.status).toBe("success"));
  });
});

describe("useCommitUpgrade", () => {
  it("commits with a caller-minted key and invalidates the roster/content/campaign keys", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const withClient = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const api = {
      commitUpgrade: vi.fn().mockResolvedValue({
        campaignId: "c1",
        campaignRevision: 4,
        sourceVersionId: "v1",
        targetVersionId: "v2",
        migratedCharacterIds: [],
        requestId: "r",
      }),
    };
    qc.setQueryData(["campaigns", "characters", "c1", "u1", 0], { characters: [] });
    qc.setQueryData(["campaigns", "content", "c1", "u1", 0, "active"], { content: [] });
    qc.setQueryData(["campaigns", "activity", "c1"], { events: [] });
    qc.setQueryData(["campaigns", "session", "c1", "u1", 0, "content"], { content: [] });
    qc.setQueryData(["campaigns", "detail", "c1"], { campaign: { campaignId: "c1" } });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useCommitUpgrade(api as never, "c1"), {
      wrapper: withClient,
    });
    const idempotencyKey = crypto.randomUUID();
    await result.current.mutateAsync({
      targetVersionId: "v2",
      expectedCampaignRevision: 3,
      idempotencyKey,
    });
    expect(api.commitUpgrade).toHaveBeenCalledWith("c1", {
      targetVersionId: "v2",
      expectedCampaignRevision: 3,
      idempotencyKey,
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["campaigns", "characters", "c1"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["campaigns", "content", "c1"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["campaigns", "activity", "c1"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["campaigns", "session", "c1"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["campaigns", "detail", "c1"] });
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

describe("displayProjectionKey", () => {
  it("keys the projection by display credential, scene, and revision", () => {
    expect(displayProjectionKey("d1", "s1", 3)).toEqual(["displays", "projection", "d1", "s1", 3]);
    expect(displayProjectionKey("d1", "s1", 3)).not.toEqual(displayProjectionKey("d1", "s1", 4));
    expect(displayProjectionKey("d1", "s1", 3)).not.toEqual(displayProjectionKey("d2", "s1", 3));
  });
});

describe("useDisplayProjection", () => {
  it("stays disabled without a credential or while offline", () => {
    const api = { getDisplayProjection: vi.fn() };
    const noCredential = renderHook(
      () => useDisplayProjection(api as never, "d1", "s1", 3, null, { enabled: true, online: true }),
      { wrapper: wrapper() },
    );
    const offline = renderHook(
      () => useDisplayProjection(api as never, "d1", "s1", 3, "s3cr3t", { enabled: true, online: false }),
      { wrapper: wrapper() },
    );
    expect(noCredential.result.current.status).toBe("pending");
    expect(offline.result.current.status).toBe("pending");
    expect(api.getDisplayProjection).not.toHaveBeenCalled();
  });

  it("reads the projection with the display credential while online", async () => {
    const api = {
      getDisplayProjection: vi.fn().mockResolvedValue({ projection: { sceneId: "s1" }, requestId: "r" }),
    };
    const { result } = renderHook(
      () => useDisplayProjection(api as never, "d1", "s1", 3, "s3cr3t", { enabled: true, online: true }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(api.getDisplayProjection).toHaveBeenCalledWith("d1", "s1", "s3cr3t"));
    await waitFor(() => expect(result.current.status).toBe("success"));
  });
});

describe("useApplyFogEdit", () => {
  it("commits with a caller-minted key and invalidates the scene and projection keys", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const withClient = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const api = {
      applyFogEdit: vi.fn().mockResolvedValue({ scene: { sceneId: "s1" }, requestId: "r" }),
    };
    qc.setQueryData(sceneDetailKey("c1", "s1", "u1", 0), { scene: { sceneId: "s1" } });
    qc.setQueryData(displayProjectionKey("d1", "s1", 3), { projection: { sceneId: "s1" } });
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
    const projectionCall = invalidateSpy.mock.calls.find((call) => {
      const key = (call[0] as { queryKey?: readonly unknown[] }).queryKey;
      return key?.[0] === "displays";
    });
    expect(projectionCall).toBeDefined();
    const predicate = (projectionCall?.[0] as { predicate?: (query: { queryKey: unknown }) => boolean })
      .predicate;
    expect(predicate).toEqual(expect.any(Function));
    expect(predicate?.({ queryKey: displayProjectionKey("d1", "s1", 3) })).toBe(true);
    expect(predicate?.({ queryKey: displayProjectionKey("d1", "s2", 3) })).toBe(false);
  });
});
