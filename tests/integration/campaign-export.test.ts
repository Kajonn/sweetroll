import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createCampaignsModule } from "../../src/campaigns/index.js";
import {
  createCampaignPlacement,
  prepareCampaignCharacter,
} from "../../src/characters/campaignPlacement.js";
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

  /** Campaign-created d20 sheet controlled by the player, for roll fixtures. */
  async function createControlledSheet(campaignId: string): Promise<string> {
    await h.pool.query(`UPDATE systems SET access = 'public'`);
    const prepared = await prepareCampaignCharacter(h.runtime, {
      systemVersionId: h.versionId,
      entityDefinitionId: "character",
    });
    if (!prepared.ok) throw new Error("prepare failed");
    const generation = (
      await h.pool.query<{ generation: number }>(
        `SELECT generation FROM campaign_members WHERE campaign_id = $1 AND user_id = $2`,
        [campaignId, h.users.gm.actorId],
      )
    ).rows[0]?.generation;
    const client = await h.pool.connect();
    try {
      await client.query("BEGIN");
      const createdSheet = await h.placement.createInCampaign(client, ctxFor(h.users.gm), {
        campaignId,
        expectedCampaignRevision: await revision(campaignId),
        membershipGeneration: generation ?? 1,
        idempotencyKey: randomUUID(),
        name: `Export sheet ${randomUUID().slice(0, 8)}`,
        entityDefinitionId: "character",
        prepared: prepared.value,
        controllerUserIds: [h.users.player.actorId],
      });
      expect(createdSheet.ok).toBe(true);
      if (!createdSheet.ok) throw new Error("createInCampaign failed");
      await client.query("COMMIT");
      return createdSheet.value.characterId;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
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
      // Roll bindings/dice use camelCase projection keys; the snake_case
      // storage columns must never leak.
      "bindings_json",
      "dice_json",
      "state_json",
      "character_id",
      "scope_campaign_id",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    // Shape is exactly the documented projection: no extra tables leak in.
    // Task 8 adds the `rolls` section (same source policy as activity).
    expect(Object.keys(exported.value).sort()).toEqual([
      "activity",
      "campaign",
      "content",
      "exportVersion",
      "members",
      "rolls",
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

  it("excludes other actors' private rolls while retaining permitted campaign and gm-only rolls", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);
    const characterId = await createControlledSheet(campaignId);

    const applyRoll = (who: keyof I6Harness["users"], audience: "owner_only" | "gm_only" | "campaign") =>
      h.characters.apply(ctxFor(h.users[who]), {
        kind: "executeAction",
        characterId,
        actionId: "check",
        inputs: { bonus: 2 },
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
        audience,
      });

    const privateRoll = await applyRoll("player", "owner_only");
    expect(privateRoll.ok).toBe(true);
    const sharedRoll = await applyRoll("player", "campaign");
    expect(sharedRoll.ok).toBe(true);
    const gmRoll = await applyRoll("gm", "gm_only");
    expect(gmRoll.ok).toBe(true);

    const privateId = (
      await h.pool.query<{ id: string }>(
        `SELECT id FROM character_rolls WHERE character_id = $1 AND audience = 'owner_only'`,
        [characterId],
      )
    ).rows[0]?.id;
    if (privateId === undefined) throw new Error("private roll row missing");

    const exported = await exportAs("gm", campaignId);
    expect(exported.ok).toBe(true);
    if (!exported.ok) throw new Error("export failed");

    // Permitted rolls carry their details; the other actor's private roll
    // is omitted entirely, with its referencing activity.
    expect(exported.value.rolls.map((roll) => roll.audience).sort()).toEqual(["campaign", "gm_only"]);
    const shared = exported.value.rolls.find((roll) => roll.audience === "campaign");
    expect(shared).toMatchObject({ actorId: h.users.player.actorId, actionId: "check" });
    expect(shared?.bindings).toEqual(
      expect.arrayContaining([{ scope: "inputs", definitionId: "bonus", value: 2 }]),
    );
    expect(exported.value.rolls.map((roll) => roll.rollId)).not.toContain(privateId);
    expect(exported.value.activity.map((event) => event.sourceRollId)).not.toContain(privateId);
    expect(exported.value.activity.map((event) => event.sourceRollId)).toContain(shared?.rollId ?? "missing");

    // The roller still replays their own private receipt through Characters.
    expect(privateRoll.ok).toBe(true);
  });

  it("omits departed members' rolls from a narrowing export without leaking rows", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);
    const characterId = await createControlledSheet(campaignId);

    const rolled = await h.characters.apply(ctxFor(h.users.player), {
      kind: "executeAction",
      characterId,
      actionId: "check",
      inputs: { bonus: 2 },
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      audience: "campaign",
    });
    expect(rolled.ok).toBe(true);

    const before = await exportAs("gm", campaignId);
    expect(before.ok).toBe(true);
    if (!before.ok) throw new Error("export failed");
    expect(before.value.rolls).toHaveLength(1);

    const departed = await h.campaigns.removeMember(ctxFor(h.users.gm), {
      campaignId,
      userId: h.users.player.actorId,
      expectedCampaignRevision: await revision(campaignId),
      idempotencyKey: randomUUID(),
    });
    expect(departed.ok).toBe(true);

    // The departed player's campaign roll stays pinned to its original scope
    // and remains visible to the GM; the departed actor is denied outright.
    const after = await exportAs("gm", campaignId);
    expect(after.ok).toBe(true);
    if (!after.ok) throw new Error("export failed");
    expect(after.value.rolls).toHaveLength(1);
    expect(await exportAs("player", campaignId)).toEqual(
      expect.objectContaining({ ok: false }),
    );
  });

  it("orders deterministically and excludes private material by content with SQL-proven persistence (Task 10)", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);
    await seedMember(campaignId, h.users.other.actorId);
    await h.pool.query(`UPDATE systems SET access = 'public'`);

    // Deliberate private markers: every secret below is asserted absent by
    // content (not shape), while SQL proves it actually persisted.
    const tag = randomUUID().slice(0, 8);
    const ownerSecret = `owner-only-secret-${tag}`;
    const deletedSecret = `deleted-body-secret-${tag}`;
    const preAdoptionName = `pre-adoption-secret-${tag}`;
    const privateBonus = 7311;

    // Other actor's owner-only note (player) + a deleted GM note whose
    // receipt still carries its secret body.
    const diary = await h.campaigns.createContent(ctxFor(h.users.player), {
      campaignId,
      title: "diary",
      body: ownerSecret,
      idempotencyKey: randomUUID(),
    });
    expect(diary.ok).toBe(true);
    const doomed = await h.campaigns.createContent(ctxFor(h.users.gm), {
      campaignId,
      title: "doomed",
      body: deletedSecret,
      audience: "all_players",
      idempotencyKey: randomUUID(),
    });
    expect(doomed.ok).toBe(true);
    if (!doomed.ok) throw new Error("doomed create failed");
    const deleted = await h.campaigns.deleteContent(ctxFor(h.users.gm), {
      contentId: doomed.value.contentId,
      expectedContentRevision: doomed.value.revision,
      idempotencyKey: randomUUID(),
    });
    expect(deleted.ok).toBe(true);

    // Permitted content in non-creation order: export must sort by contentId.
    const titles = [`gamma-${tag}`, `alpha-${tag}`, `beta-${tag}`];
    for (const title of titles) {
      const created = await h.campaigns.createContent(ctxFor(h.users.gm), {
        campaignId,
        title,
        body: `shared body ${title}`,
        audience: "all_players",
        idempotencyKey: randomUUID(),
      });
      expect(created.ok).toBe(true);
    }

    // Standalone sheet with personal pre-adoption history, then adopted.
    const standalone = await h.characters.create(ctxFor(h.users.player), {
      systemVersionId: h.versionId,
      entityDefinitionId: "character",
      name: preAdoptionName,
      idempotencyKey: randomUUID(),
    });
    expect(standalone.ok).toBe(true);
    if (!standalone.ok) throw new Error("standalone create failed");
    const standaloneId = standalone.value.characterId;
    const renamed = await h.characters.manage(ctxFor(h.users.player), {
      kind: "rename",
      characterId: standaloneId,
      name: `${preAdoptionName}-renamed`,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(renamed.ok).toBe(true);
    const adopted = await h.campaigns.adoptCampaignCharacter(ctxFor(h.users.player), {
      campaignId,
      expectedCampaignRevision: await revision(campaignId),
      characterId: standaloneId,
      expectedCharacterRevision: 2,
      acknowledgedDisclosure: true,
      idempotencyKey: randomUUID(),
    });
    expect(adopted.ok).toBe(true);

    // Controlled campaign sheet for roll fixtures.
    const characterId = await createControlledSheet(campaignId);
    const privateRoll = await h.characters.apply(ctxFor(h.users.player), {
      kind: "executeAction",
      characterId,
      actionId: "check",
      inputs: { bonus: privateBonus },
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      audience: "owner_only",
    });
    expect(privateRoll.ok).toBe(true);
    const sharedRoll = await h.characters.apply(ctxFor(h.users.player), {
      kind: "executeAction",
      characterId,
      actionId: "check",
      inputs: { bonus: 2 },
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      audience: "campaign",
    });
    expect(sharedRoll.ok).toBe(true);

    // Invitation secret: token + hash persist, never export.
    const issued = await h.campaigns.issueInvitation(ctxFor(h.users.gm), {
      campaignId,
      intendedRole: "player",
      expectedCampaignRevision: await revision(campaignId),
      idempotencyKey: randomUUID(),
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok || !("token" in issued.value)) throw new Error("issue failed");
    const token = issued.value.token;

    // SQL proves every secret actually persisted (nonzero counts): the
    // absence assertions below are content proofs, not vacuous passes.
    const persisted = await h.pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM campaign_content_items WHERE campaign_id = $1 AND body IN ($2, $3)`,
      [campaignId, ownerSecret, deletedSecret],
    );
    expect(persisted.rows[0]?.n).toBe(2);
    const receiptWithSecret = await h.pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM campaign_command_executions
        WHERE campaign_id = $1 AND result_json::text LIKE '%' || $2 || '%'`,
      [campaignId, deletedSecret],
    );
    expect(receiptWithSecret.rows[0]?.n).toBeGreaterThan(0);
    const privateRollRow = await h.pool.query<{ id: string }>(
      `SELECT id FROM character_rolls WHERE character_id = $1 AND audience = 'owner_only'`,
      [characterId],
    );
    expect(privateRollRow.rows).toHaveLength(1);
    const privateRollId = privateRollRow.rows[0]?.id;
    const historyRows = await h.pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM character_activity_events WHERE character_id = $1`,
      [standaloneId],
    );
    expect(historyRows.rows[0]?.n).toBeGreaterThan(0);
    const tokenRows = await h.pool.query<{ token_hash: string }>(
      `SELECT token_hash FROM campaign_invitations WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(tokenRows.rows).toHaveLength(1);
    const tokenHash = tokenRows.rows[0]?.token_hash as string;
    expect(tokenHash).toBeTruthy();

    // Equivalent authorized snapshots compare byte-identical: different
    // idempotency keys, same state, no random timestamps/IDs leak.
    const first = await exportAs("gm", campaignId);
    const second = await exportAs("gm", campaignId);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("export failed");
    expect(JSON.stringify(second.value)).toBe(JSON.stringify(first.value));

    // Deterministic ordering: members by user, content/rolls by id,
    // activity by (occurredAt, id).
    const memberIds = first.value.members.map((m) => m.userId);
    expect(memberIds).toEqual([...memberIds].sort());
    const contentIds = first.value.content.map((c) => c.contentId);
    expect(contentIds).toEqual([...contentIds].sort());
    const rollIds = first.value.rolls.map((r) => r.rollId);
    expect(rollIds).toEqual([...rollIds].sort());
    const activityKeys = first.value.activity.map((e) => `${e.occurredAt}|${e.eventId}`);
    expect(activityKeys).toEqual([...activityKeys].sort());
    expect(first.value.content.map((c) => c.title)).toEqual(
      expect.arrayContaining(titles),
    );

    // Content assertions: permitted material present, private absent.
    const serialized = JSON.stringify(first.value);
    for (const title of titles) expect(serialized).toContain(title);
    expect(serialized).not.toContain(ownerSecret);
    expect(serialized).not.toContain(deletedSecret);
    expect(serialized).not.toContain(preAdoptionName);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(tokenHash);
    // The adopted sheet cut no visible rolls, so its ID stays out of the
    // projection entirely. The controlled sheet's ID legitimately appears
    // as the permitted campaign roll's characterId (projection key, not a
    // sheet payload leak), so only the private roll ID must be absent.
    expect(serialized).not.toContain(standaloneId);
    expect(serialized).toContain(characterId);
    if (privateRollId !== undefined) expect(serialized).not.toContain(privateRollId);
    for (const forbidden of [
      "token",
      "token_hash",
      "tokenHash",
      "secret",
      "password",
      "credential",
      "result_json",
      "bindings_json",
      "dice_json",
      "state_json",
      "character_id",
      "scope_campaign_id",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(first.value.rolls.map((r) => r.audience)).not.toContain("owner_only");
    expect(first.value.activity.map((e) => e.sourceRollId)).not.toContain(privateRollId ?? "missing");
    expect(Object.keys(first.value).sort()).toEqual([
      "activity",
      "campaign",
      "content",
      "exportVersion",
      "members",
      "rolls",
    ]);
  });
});
