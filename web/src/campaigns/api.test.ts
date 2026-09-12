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
