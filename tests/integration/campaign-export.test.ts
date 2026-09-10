import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createCampaignsModule } from "../../src/campaigns/index.js";
import { createCampaignPlacement } from "../../src/characters/campaignPlacement.js";
import { DEFAULT_CAMPAIGN_LIMITS } from "../../src/platform/config.js";
import { buildI6Harness, ctxFor, type I6Harness } from "./i6-app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;

describeWithDatabase("campaign export projection (Task 7)", () => {
  let h: I6Harness;

  beforeAll(async () => {
    h = await buildI6Harness();
  });

  afterAll(async () => {
    await h.close();
  });

  async function createCampaign(): Promise<string> {
    const created = await h.campaigns.create(ctxFor(h.users.gm), {
      systemVersionId: h.versionId,
      title: `Export ${randomUUID()}`,
      description: "export fixture",
      idempotencyKey: randomUUID(),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("campaign create failed");
    return created.value.campaignId;
  }

  async function revision(campaignId: string): Promise<number> {
    const opened = await h.campaigns.open(ctxFor(h.users.gm), { campaignId });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("campaign vanished under test");
    return opened.value.revision;
  }

  async function seedMember(
    campaignId: string,
    userId: string,
    role: "co_gm" | "player" = "player",
  ): Promise<void> {
    await h.pool.query(
      `INSERT INTO campaign_members (campaign_id, user_id, role, status, generation)
       VALUES ($1, $2, $3, 'active', 1)`,
      [campaignId, userId, role],
    );
  }

  async function exportAs(who: keyof I6Harness["users"], campaignId: string, key: string = randomUUID()) {
    return h.campaigns.exportCampaign(ctxFor(h.users[who]), { campaignId, idempotencyKey: key });
  }

  it("exports a deterministic snapshot that replays byte-identical", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);
    await h.campaigns.createContent(ctxFor(h.users.gm), {
      campaignId,
      title: "session zero",
      body: "the party meets",
      tags: ["recap"],
      audience: "all_players",
      idempotencyKey: randomUUID(),
    });

    const first = await exportAs("gm", campaignId);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("export failed");
    expect(first.value.exportVersion).toBe(1);

    const second = await exportAs("gm", campaignId);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("export failed");
    expect(JSON.stringify(second.value)).toBe(JSON.stringify(first.value));
  });

  it("replays the same snapshot for the same key and mismatches on retarget", async () => {
    const campaignId = await createCampaign();
    const key = randomUUID();
    const first = await exportAs("gm", campaignId, key);
    expect(first.ok).toBe(true);
    const replay = await exportAs("gm", campaignId, key);
    expect(replay.ok).toBe(true);
    if (!first.ok || !replay.ok) throw new Error("export failed");
    expect(JSON.stringify(replay.value)).toBe(JSON.stringify(first.value));

    // The input hash covers the campaign: the same key elsewhere mismatches.
    const otherId = await createCampaign();
    const retarget = await exportAs("gm", otherId, key);
    expect(retarget.ok).toBe(false);
    if (!retarget.ok) expect(retarget.error.code).toBe("idempotency_mismatch");
  });

  it("restricts export to active GMs and allows archived snapshots", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);
    await seedMember(campaignId, h.users.other.actorId, "co_gm");

    expect((await exportAs("player", campaignId)).ok).toBe(false);
    const playerDenied = await exportAs("player", campaignId);
    if (!playerDenied.ok) expect(playerDenied.error.code).toBe("not_found");
    expect((await exportAs("outsider", campaignId)).ok).toBe(false);

    const coGm = await exportAs("other", campaignId);
    expect(coGm.ok).toBe(true);

    const archived = await h.campaigns.archive(ctxFor(h.users.gm), {
      campaignId,
      expectedCampaignRevision: await revision(campaignId),
      idempotencyKey: randomUUID(),
    });
    expect(archived.ok).toBe(true);
    const whileArchived = await exportAs("gm", campaignId);
    expect(whileArchived.ok).toBe(true);
    if (whileArchived.ok) expect(whileArchived.value.campaign.status).toBe("archived");
  });

  it("denies export replay once the exporter loses GM standing", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.other.actorId, "co_gm");
    const key = randomUUID();

    const first = await exportAs("other", campaignId, key);
    expect(first.ok).toBe(true);

    // Demote the co-GM to player: the same-key replay must not disclose.
    const demoted = await h.campaigns.changeRole(ctxFor(h.users.gm), {
      campaignId,
      userId: h.users.other.actorId,
      role: "player",
      expectedCampaignRevision: await revision(campaignId),
      idempotencyKey: randomUUID(),
    });
    expect(demoted.ok).toBe(true);
    const replay = await exportAs("other", campaignId, key);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.code).toBe("not_found");
  });

  it("expires export receipts into result_unavailable", async () => {
    const campaignId = await createCampaign();
    const key = randomUUID();
    const first = await exportAs("gm", campaignId, key);
    expect(first.ok).toBe(true);

    await h.pool.query(
      `UPDATE campaign_command_executions SET expires_at = now() - interval '1 second'
        WHERE actor_id = $1 AND command_kind = 'campaign_export' AND idempotency_key = $2`,
      [h.users.gm.actorId, key],
    );
    const replay = await exportAs("gm", campaignId, key);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.code).toBe("result_unavailable");
  });

  it("excludes another actor's owner-only notes while keeping readable content", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);

    const secret = await h.campaigns.createContent(ctxFor(h.users.player), {
      campaignId,
      title: "player diary",
      body: "quill scratchings no gm may read",
      idempotencyKey: randomUUID(),
    });
    expect(secret.ok).toBe(true);
    const shared = await h.campaigns.createContent(ctxFor(h.users.gm), {
      campaignId,
      title: "handout",
      body: "a map of the region",
      audience: "all_players",
      idempotencyKey: randomUUID(),
    });
    expect(shared.ok).toBe(true);
    const selected = await h.campaigns.createContent(ctxFor(h.users.gm), {
      campaignId,
      title: "whisper",
      body: "a secret for the rogue",
      audience: "selected_players",
      grantedUserIds: [h.users.player.actorId],
      idempotencyKey: randomUUID(),
    });
    expect(selected.ok).toBe(true);
    if (!selected.ok) throw new Error("selected create failed");

    const exported = await exportAs("gm", campaignId);
    expect(exported.ok).toBe(true);
    if (!exported.ok) throw new Error("export failed");
    const bodies = exported.value.content.map((item) => item.body);
    expect(bodies).toContain("a map of the region");
    expect(bodies).toContain("a secret for the rogue");
    expect(bodies).not.toContain("quill scratchings no gm may read");
    expect(exported.value.content.map((item) => item.contentId)).not.toContain(
      secret.ok ? secret.value.contentId : "missing",
    );

    const whisper = exported.value.content.find((item) => item.title === "whisper");
    expect(whisper?.grantedUserIds).toEqual([h.users.player.actorId]);
    const handout = exported.value.content.find((item) => item.title === "handout");
    expect(handout).not.toHaveProperty("grantedUserIds");

    // No activity event may reference the excluded note either.
    expect(
      exported.value.activity.map((event) => event.sourceContentId),
    ).not.toContain(secret.ok ? secret.value.contentId : "missing");
  });

  it("omits deleted content and its narrowed activity from the snapshot", async () => {
    const campaignId = await createCampaign();
    const created = await h.campaigns.createContent(ctxFor(h.users.gm), {
      campaignId,
      title: "doomed",
      body: "soon forgotten",
      audience: "all_players",
      idempotencyKey: randomUUID(),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("create failed");

    const deleted = await h.campaigns.deleteContent(ctxFor(h.users.gm), {
      contentId: created.value.contentId,
      expectedContentRevision: created.value.revision,
      idempotencyKey: randomUUID(),
    });
    expect(deleted.ok).toBe(true);

    const exported = await exportAs("gm", campaignId);
    expect(exported.ok).toBe(true);
    if (!exported.ok) throw new Error("export failed");
    expect(exported.value.content.map((item) => item.contentId)).not.toContain(created.value.contentId);
    expect(exported.value.activity.map((event) => event.sourceContentId)).not.toContain(
      created.value.contentId,
    );
  });

  it("carries no invitation secrets, receipts or character payloads", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);

    const issued = await h.campaigns.issueInvitation(ctxFor(h.users.gm), {
      campaignId,
      intendedRole: "player",
      expectedCampaignRevision: await revision(campaignId),
      idempotencyKey: randomUUID(),
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok || !("token" in issued.value)) throw new Error("issue failed");
    const token = issued.value.token;
    const hashRows = await h.pool.query(
      `SELECT token_hash FROM campaign_invitations WHERE campaign_id = $1`,
      [campaignId],
    );
    const tokenHash = hashRows.rows[0].token_hash as string;

    const exported = await exportAs("gm", campaignId);
    expect(exported.ok).toBe(true);
    if (!exported.ok) throw new Error("export failed");
    const serialized = JSON.stringify(exported.value);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(tokenHash);
    for (const forbidden of [
      "token",
      "token_hash",
      "tokenHash",
      "secret",
      "password",
      "credential",
      "result_json",
      "bindings",
      "state_json",
      "character_id",
      "scope_campaign_id",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    // Shape is exactly the documented projection: no extra tables leak in.
    expect(Object.keys(exported.value).sort()).toEqual([
      "activity",
      "campaign",
      "content",
      "exportVersion",
      "members",
    ]);
    expect(createHash("sha256").update(serialized, "utf8").digest("hex")).toHaveLength(64);
  });

  it("rejects exports above the configured record and byte bounds", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);
    await h.campaigns.createContent(ctxFor(h.users.gm), {
      campaignId,
      title: "handout",
      body: "read me",
      audience: "all_players",
      idempotencyKey: randomUUID(),
    });

    const placement = createCampaignPlacement({ pool: h.pool, runtime: h.runtime });
    const tinyRecords = createCampaignsModule({
      pool: h.pool,
      limits: { ...DEFAULT_CAMPAIGN_LIMITS, exportMaxRecords: 2 },
      charactersPlacement: placement,
    });
    const tooMany = await tinyRecords.exportCampaign(ctxFor(h.users.gm), {
      campaignId,
      idempotencyKey: randomUUID(),
    });
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.error.code).toBe("export_too_large");

    const tinyBytes = createCampaignsModule({
      pool: h.pool,
      limits: { ...DEFAULT_CAMPAIGN_LIMITS, exportMaxBytes: 16 },
      charactersPlacement: placement,
    });
    const tooBig = await tinyBytes.exportCampaign(ctxFor(h.users.gm), {
      campaignId,
      idempotencyKey: randomUUID(),
    });
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.error.code).toBe("export_too_large");

    // Bound rejections leave no receipt behind: a later exact key recomputes.
    const stored = await h.pool.query(
      `SELECT COUNT(*)::int AS count FROM campaign_command_executions
        WHERE campaign_id = $1 AND command_kind = 'campaign_export'`,
      [campaignId],
    );
    expect(stored.rows[0].count).toBe(0);
  });

  it("reflects the current snapshot instead of stale state", async () => {
    const campaignId = await createCampaign();
    const before = await exportAs("gm", campaignId);
    expect(before.ok).toBe(true);

    await h.campaigns.createContent(ctxFor(h.users.gm), {
      campaignId,
      title: "after the snapshot",
      body: "new ink",
      audience: "all_players",
      idempotencyKey: randomUUID(),
    });
    const after = await exportAs("gm", campaignId);
    expect(after.ok).toBe(true);
    if (!before.ok || !after.ok) throw new Error("export failed");
    expect(JSON.stringify(after.value)).not.toBe(JSON.stringify(before.value));
    expect(after.value.content.map((item) => item.title)).toContain("after the snapshot");
  });
});
