import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { CampaignsApi } from "./api.js";
import { CAMPAIGN_LIST_PAGE_LIMIT, campaignListKey, useCampaignList } from "./campaignQueries.js";

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
