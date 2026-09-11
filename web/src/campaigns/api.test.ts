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
