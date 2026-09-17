import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildI6Harness, ctxFor, type I6Harness } from "./i6-app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;

/**
 * Preview-as-player parity (Task 1): the GM-only content preview projection
 * returns exactly what the target member's own list/reader return, through
 * the real policy engine. No volatile fields are excluded: both sides read
 * the same rows and the comparison is byte-identical after JSON
 * serialization (requestId lives only in the HTTP envelope, never in the
 * compared module values).
 */
describeWithDatabase("campaign content preview projection (preview-as-player Task 1)", () => {
  let h: I6Harness;

  beforeAll(async () => {
    h = await buildI6Harness();
  });

  afterAll(async () => {
    await h.close();
  });

  function cookie(who: keyof I6Harness["users"]) {
    return { cookie: h.users[who].cookie };
  }

  async function createCampaign(): Promise<string> {
    const created = await h.campaigns.create(ctxFor(h.users.gm), {
      systemVersionId: h.versionId,
      title: `Preview ${randomUUID()}`,
      description: "",
      idempotencyKey: randomUUID(),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("campaign create failed");
    return created.value.campaignId;
  }

  async function seedMember(campaignId: string, userId: string): Promise<void> {
    await h.pool.query(
      `INSERT INTO campaign_members (campaign_id, user_id, role, status, generation)
       VALUES ($1, $2, 'player', 'active', 1)`,
      [campaignId, userId],
    );
  }

  async function createNote(
    campaignId: string,
    who: keyof I6Harness["users"],
    options: {
      title: string;
      audience?: "gm_only" | "all_players" | "selected_players" | "owner_only";
      grantedUserIds?: string[];
    },
  ) {
    const created = await h.campaigns.createContent(ctxFor(h.users[who]), {
      campaignId,
      title: options.title,
      body: `${options.title} body`,
      audience: options.audience,
      grantedUserIds: options.grantedUserIds,
      idempotencyKey: randomUUID(),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(`create failed: ${JSON.stringify(created.error)}`);
    return created.value;
  }

  it("projects the target member's exact list and reader rows", async () => {
    const campaignId = await createCampaign();
    const playerId = h.users.player.actorId;
    const otherId = h.users.other.actorId;
    await seedMember(campaignId, playerId);
    await seedMember(campaignId, otherId);

    const gmOnly = await createNote(campaignId, "gm", { title: "gm only", audience: "gm_only" });
    const shared = await createNote(campaignId, "gm", { title: "shared", audience: "all_players" });
    const selected = await createNote(campaignId, "gm", {
      title: "selected",
      audience: "selected_players",
      grantedUserIds: [playerId],
    });
    const playerPrivate = await createNote(campaignId, "player", { title: "player secret" });
    expect(playerPrivate.audience).toBe("owner_only");

    // List parity: GM preview-as-player equals the member's own list,
    // field-for-field (gm_only hidden, ungranted selected hidden, the
    // member's own owner-only note visible).
    const previewed = await h.campaigns.previewContent(ctxFor(h.users.gm), {
      campaignId,
      targetUserId: playerId,
    });
    expect(previewed.ok).toBe(true);
    if (!previewed.ok) throw new Error(`preview failed: ${JSON.stringify(previewed.error)}`);
    expect(previewed.value.kind).toBe("list");
    if (previewed.value.kind !== "list") throw new Error("expected a list projection");

    const listed = await h.campaigns.listContent(ctxFor(h.users.player), {
      campaignId,
      limit: 100,
      cursor: null,
    });
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error(`list failed: ${JSON.stringify(listed.error)}`);
    expect(JSON.stringify(previewed.value.content)).toBe(JSON.stringify(listed.value.content));
    expect(previewed.value.content.map((row) => row.title).sort()).toEqual(
      ["player secret", "selected", "shared"].sort(),
    );

    // The ungranted member sees a strict subset through the same projection.
    const otherPreview = await h.campaigns.previewContent(ctxFor(h.users.gm), {
      campaignId,
      targetUserId: otherId,
    });
    expect(otherPreview.ok).toBe(true);
    if (!otherPreview.ok) throw new Error(`preview failed: ${JSON.stringify(otherPreview.error)}`);
    expect(otherPreview.value.kind).toBe("list");
    if (otherPreview.value.kind !== "list") throw new Error("expected a list projection");
    const otherList = await h.campaigns.listContent(ctxFor(h.users.other), {
      campaignId,
      limit: 100,
      cursor: null,
    });
    expect(otherList.ok).toBe(true);
    if (!otherList.ok) throw new Error(`list failed: ${JSON.stringify(otherList.error)}`);
    expect(JSON.stringify(otherPreview.value.content)).toBe(JSON.stringify(otherList.value.content));
    expect(otherPreview.value.content.map((row) => row.title)).toEqual(["shared"]);

    // Reader parity: a readable note projects byte-identical to the
    // member's own reader; an unreadable one 404s exactly like the reader.
    const previewedItem = await h.campaigns.previewContent(ctxFor(h.users.gm), {
      campaignId,
      targetUserId: playerId,
      contentId: shared.contentId,
    });
    expect(previewedItem.ok).toBe(true);
    if (!previewedItem.ok) throw new Error(`preview failed: ${JSON.stringify(previewedItem.error)}`);
    expect(previewedItem.value.kind).toBe("item");
    if (previewedItem.value.kind !== "item") throw new Error("expected an item projection");
    const opened = await h.campaigns.openContent(ctxFor(h.users.player), {
      contentId: shared.contentId,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(`open failed: ${JSON.stringify(opened.error)}`);
    expect(JSON.stringify(previewedItem.value.content)).toBe(JSON.stringify(opened.value));

    const hiddenItem = await h.campaigns.previewContent(ctxFor(h.users.gm), {
      campaignId,
      targetUserId: playerId,
      contentId: gmOnly.contentId,
    });
    expect(hiddenItem.ok).toBe(false);
    if (hiddenItem.ok) throw new Error("expected the gm_only note to stay hidden");
    expect(hiddenItem.error.code).toBe("not_found");
    const hiddenReal = await h.campaigns.openContent(ctxFor(h.users.player), {
      contentId: gmOnly.contentId,
    });
    expect(hiddenReal.ok).toBe(false);
    if (hiddenReal.ok) throw new Error("expected the real reader to deny the gm_only note");
    expect(hiddenReal.error.code).toBe("not_found");
    expect(hiddenItem.error.message).toBe(hiddenReal.error.message);

    // The ungranted selected note 404s for the other member through both paths.
    const ungrantedItem = await h.campaigns.previewContent(ctxFor(h.users.gm), {
      campaignId,
      targetUserId: otherId,
      contentId: selected.contentId,
    });
    expect(ungrantedItem.ok).toBe(false);
    if (ungrantedItem.ok) throw new Error("expected the ungranted note to stay hidden");
    expect(ungrantedItem.error.code).toBe("not_found");
  });

  it("gates callers and targets (member 403 / outsider+removed caller 404 / unknown-target 404 / removed-target 404)", async () => {
    const campaignId = await createCampaign();
    const playerId = h.users.player.actorId;
    const otherId = h.users.other.actorId;
    const outsiderId = h.users.outsider.actorId;
    await seedMember(campaignId, playerId);
    await seedMember(campaignId, otherId);
    await createNote(campaignId, "gm", { title: "shared", audience: "all_players" });

    // A non-GM member caller learns nothing: 403, never rows.
    const memberCall = await h.campaigns.previewContent(ctxFor(h.users.player), {
      campaignId,
      targetUserId: otherId,
    });
    expect(memberCall.ok).toBe(false);
    if (memberCall.ok) throw new Error("expected a member caller to be denied");
    expect(memberCall.error.code).toBe("forbidden");

    // An outsider caller collapses to the same not_found as an unknown
    // campaign: no existence oracle.
    const outsiderCall = await h.campaigns.previewContent(ctxFor(h.users.outsider), {
      campaignId,
      targetUserId: playerId,
    });
    expect(outsiderCall.ok).toBe(false);
    if (outsiderCall.ok) throw new Error("expected an outsider caller to miss");
    expect(outsiderCall.error.code).toBe("not_found");
    expect(outsiderCall.error.message).toBe("The requested campaign does not exist.");
    const outsiderUnknown = await h.campaigns.previewContent(ctxFor(h.users.outsider), {
      campaignId: randomUUID(),
      targetUserId: playerId,
    });
    expect(outsiderUnknown.ok).toBe(false);
    if (outsiderUnknown.ok) throw new Error("expected an unknown campaign to miss");
    expect(JSON.stringify(outsiderUnknown.error)).toBe(JSON.stringify(outsiderCall.error));

    // A non-member target collapses to 404.
    const nonMemberTarget = await h.campaigns.previewContent(ctxFor(h.users.gm), {
      campaignId,
      targetUserId: outsiderId,
    });
    expect(nonMemberTarget.ok).toBe(false);
    if (nonMemberTarget.ok) throw new Error("expected a non-member target to miss");
    expect(nonMemberTarget.error.code).toBe("not_found");

    // A removed-member target collapses to 404 as well.
    const opened = await h.campaigns.open(ctxFor(h.users.gm), { campaignId });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("campaign vanished under test");
    const removed = await h.campaigns.removeMember(ctxFor(h.users.gm), {
      campaignId,
      userId: otherId,
      expectedCampaignRevision: opened.value.revision,
      idempotencyKey: randomUUID(),
    });
    expect(removed.ok).toBe(true);
    const removedTarget = await h.campaigns.previewContent(ctxFor(h.users.gm), {
      campaignId,
      targetUserId: otherId,
    });
    expect(removedTarget.ok).toBe(false);
    if (removedTarget.ok) throw new Error("expected a removed target to miss");
    expect(removedTarget.error.code).toBe("not_found");

    // A removed-member caller collapses the same way: only active members
    // ever reach the GM gate.
    const removedCaller = await h.campaigns.previewContent(ctxFor(h.users.other), {
      campaignId,
      targetUserId: playerId,
    });
    expect(removedCaller.ok).toBe(false);
    if (removedCaller.ok) throw new Error("expected a removed caller to miss");
    expect(removedCaller.error.code).toBe("not_found");
    expect(removedCaller.error.message).toBe("The requested campaign does not exist.");

    // Unknown campaigns 404.
    const unknown = await h.campaigns.previewContent(ctxFor(h.users.gm), {
      campaignId: randomUUID(),
      targetUserId: playerId,
    });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) throw new Error("expected an unknown campaign to miss");
    expect(unknown.error.code).toBe("not_found");
  });

  it("serves the matrix over HTTP (GM 200 / member 403 / outsider 404 / signed-out 401 / removed-target 404)", async () => {
    const campaignId = await createCampaign();
    const playerId = h.users.player.actorId;
    const otherId = h.users.other.actorId;
    await seedMember(campaignId, playerId);
    await seedMember(campaignId, otherId);
    await createNote(campaignId, "gm", { title: "gm only", audience: "gm_only" });
    await createNote(campaignId, "gm", { title: "shared", audience: "all_players" });

    // GM preview matches the member's own HTTP list, row for row.
    const previewed = await h.app.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/content-preview`,
      headers: cookie("gm"),
      payload: { targetUserId: playerId },
    });
    expect(previewed.statusCode).toBe(200);
    const memberList = await h.app.inject({
      method: "GET",
      url: `/campaigns/${campaignId}/content`,
      headers: cookie("player"),
    });
    expect(memberList.statusCode).toBe(200);
    expect(previewed.json().content).toEqual(memberList.json().content);
    expect(previewed.json().nextCursor).toBeNull();

    // Member caller: 403. Signed-out: 401.
    const memberCall = await h.app.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/content-preview`,
      headers: cookie("player"),
      payload: { targetUserId: otherId },
    });
    expect(memberCall.statusCode).toBe(403);
    expect(memberCall.json().error.code).toBe("forbidden");
    // Outsider caller: 404, indistinguishable from an unknown campaign.
    const outsiderCall = await h.app.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/content-preview`,
      headers: cookie("outsider"),
      payload: { targetUserId: playerId },
    });
    expect(outsiderCall.statusCode).toBe(404);
    expect(outsiderCall.json().error.code).toBe("not_found");
    const signedOut = await h.app.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/content-preview`,
      payload: { targetUserId: playerId },
    });
    expect(signedOut.statusCode).toBe(401);

    // Removed target: 404 over HTTP too.
    const opened = await h.campaigns.open(ctxFor(h.users.gm), { campaignId });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("campaign vanished under test");
    const removed = await h.campaigns.removeMember(ctxFor(h.users.gm), {
      campaignId,
      userId: otherId,
      expectedCampaignRevision: opened.value.revision,
      idempotencyKey: randomUUID(),
    });
    expect(removed.ok).toBe(true);
    const removedTarget = await h.app.inject({
      method: "POST",
      url: `/campaigns/${campaignId}/content-preview`,
      headers: cookie("gm"),
      payload: { targetUserId: otherId },
    });
    expect(removedTarget.statusCode).toBe(404);
  });
});
