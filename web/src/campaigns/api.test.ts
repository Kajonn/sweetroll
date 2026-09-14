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

  it("lists claimable characters with cursor + limit query params", async () => {
    const fetch = vi.fn().mockResolvedValue({ characters: [], nextCursor: null, requestId: "r4" });
    const api = createCampaignsApi({ fetch } as never);
    await api.listClaimableCharacters("c1", { cursor: null, limit: 25 });
    expect(fetch).toHaveBeenCalledWith("GET", "/campaigns/c1/claimable-characters", {
      query: { cursor: undefined, limit: 25 },
    });
  });

  it("lists deleted content summaries with the status query param", async () => {
    const fetch = vi.fn().mockResolvedValue({ content: [], nextCursor: null, requestId: "r5" });
    const api = createCampaignsApi({ fetch } as never);
    await api.listContent("c1", { status: "deleted", limit: 25 });
    expect(fetch).toHaveBeenCalledWith("GET", "/campaigns/c1/content", {
      query: { cursor: undefined, limit: 25, status: "deleted" },
    });
  });
});

describe("createCampaignsApi campaign upgrade", () => {
  it("previews an upgrade with exactly target, mappings, and defaults", async () => {
    const fetch = vi.fn().mockResolvedValue({ campaignId: "c1", characters: [], requestId: "r6" });
    const api = createCampaignsApi({ fetch } as never);
    await api.previewUpgrade("c1", {
      targetVersionId: "v2",
      mappings: { "def-a": "map-1" },
      defaults: { "def-b": 7 },
    });
    expect(fetch).toHaveBeenCalledWith("POST", "/campaigns/c1/upgrade-previews", {
      body: { targetVersionId: "v2", mappings: { "def-a": "map-1" }, defaults: { "def-b": 7 } },
    });
  });

  it("commits an upgrade with exactly target, revision, idempotency key, mappings, and defaults", async () => {
    const idempotencyKey = crypto.randomUUID();
    const fetch = vi.fn().mockResolvedValue({ campaignId: "c1", migratedCharacterIds: [], requestId: "r7" });
    const api = createCampaignsApi({ fetch } as never);
    await api.commitUpgrade("c1", {
      targetVersionId: "v2",
      expectedCampaignRevision: 3,
      idempotencyKey,
      mappings: { "def-a": "map-1" },
      defaults: { "def-b": 7 },
    });
    expect(fetch).toHaveBeenCalledWith("POST", "/campaigns/c1/upgrade-commits", {
      body: {
        targetVersionId: "v2",
        expectedCampaignRevision: 3,
        idempotencyKey,
        mappings: { "def-a": "map-1" },
        defaults: { "def-b": 7 },
      },
    });
  });
});

describe("createCampaignsApi scenes", () => {
  it("uploads an image with exactly name, contentType, dataBase64, and idempotency key", async () => {
    const fetch = vi.fn().mockResolvedValue({ image: { fileId: "f1" }, requestId: "r1" });
    const api = createCampaignsApi({ fetch } as never);
    await api.uploadImage("c1", {
      name: "cave",
      contentType: "image/png",
      dataBase64: "iVBORw0KGgo=",
      idempotencyKey: "k1",
    });
    expect(fetch).toHaveBeenCalledWith("POST", "/campaigns/c1/images", {
      body: { name: "cave", contentType: "image/png", dataBase64: "iVBORw0KGgo=", idempotencyKey: "k1" },
    });
  });

  it("applies a fog edit with exactly revision, op, and idempotency key", async () => {
    const fetch = vi.fn().mockResolvedValue({ scene: { sceneId: "s1" }, requestId: "r2" });
    const api = createCampaignsApi({ fetch } as never);
    await api.applyFogEdit("s1", {
      expectedSceneRevision: 2,
      op: { mode: "reveal", runs: [{ x: 0.5, y: 0.5, r: 0.1 }] },
      idempotencyKey: "k2",
    });
    expect(fetch).toHaveBeenCalledWith("POST", "/scenes/s1/fog-edits", {
      body: {
        expectedSceneRevision: 2,
        op: { mode: "reveal", runs: [{ x: 0.5, y: 0.5, r: 0.1 }] },
        idempotencyKey: "k2",
      },
    });
  });
});

describe("createCampaignsApi display", () => {
  it("pairs a display with an empty JSON body", async () => {
    const fetch = vi.fn().mockResolvedValue({ code: "AB12CD", requestId: "r1" });
    const api = createCampaignsApi({ fetch } as never);
    await api.pairDisplay("c1");
    expect(fetch).toHaveBeenCalledWith("POST", "/campaigns/c1/display-codes", { body: {} });
  });

  it("redeems a pairing code in the POST body only", async () => {
    const fetch = vi.fn().mockResolvedValue({ display: { displayId: "d1", secret: "s3cr3t" }, requestId: "r2" });
    const api = createCampaignsApi({ fetch } as never);
    await api.redeemDisplay({ code: "AB12CD" });
    expect(fetch).toHaveBeenCalledWith("POST", "/displays/redeem", { body: { code: "AB12CD" } });
  });

  it("revokes a display with an empty JSON body", async () => {
    const fetch = vi.fn().mockResolvedValue({ display: { displayId: "d1" }, requestId: "r3" });
    const api = createCampaignsApi({ fetch } as never);
    await api.revokeDisplay("c1", "d1");
    expect(fetch).toHaveBeenCalledWith("POST", "/campaigns/c1/displays/d1/revoke", { body: {} });
  });

  it("reads the projection with the secret in the header, never the URL", async () => {
    const fetch = vi.fn().mockResolvedValue({ projection: { sceneId: "s1" }, requestId: "r4" });
    const api = createCampaignsApi({ fetch } as never);
    await api.getDisplayProjection("d1", "s1", "s3cr3t");
    expect(fetch).toHaveBeenCalledWith("GET", "/displays/d1/scenes/s1/projection", {
      headers: { "x-display-secret": "s3cr3t" },
    });
    expect(fetch.mock.calls[0]?.[1]).not.toContain("s3cr3t");
  });
});
