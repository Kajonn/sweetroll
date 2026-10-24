import {namedDicePoolDocument} from "../../src/systems/implementation/package/fixtures/named-dice-pool.js";
import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prepareCampaignCharacter } from "../../src/characters/campaignPlacement.js";
import { buildI6Harness, ctxFor, type I6Harness, type TestActor } from "./i6-app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;

type RollAudience = "owner_only" | "gm_only" | "campaign";

describeWithDatabase("campaign roll audiences and atomic activity (Task 8)", () => {
  let h: I6Harness;
  let secondController: TestActor;
  let unassigned: TestActor;

  beforeAll(async () => {
    h = await buildI6Harness();
    // The fixture versions are private by default; shared-table rolls need
    // the campaign version usable by every member.
    await h.pool.query(`UPDATE systems SET access = 'public'`);
    for (const [name, slot] of [["Riley", "second"], ["Erin", "unassigned"]] as const) {
      const rows = await h.pool.query<{ id: string }>(
        `INSERT INTO users (display_name) VALUES ($1) RETURNING id`,
        [name],
      );
      const actorId = rows.rows[0]?.id;
      if (actorId === undefined) throw new Error("user insert failed");
      if (slot === "second") secondController = { actorId, cookie: "" };
      else unassigned = { actorId, cookie: "" };
    }
  });

  afterAll(async () => {
    await h.close();
  });

  async function inPlacementTxn<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await h.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await work(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function campaignRevision(campaignId: string): Promise<number> {
    const opened = await h.campaigns.open(ctxFor(h.users.gm), { campaignId });
    if (!opened.ok) throw new Error("campaign vanished under test");
    return opened.value.revision;
  }

  async function memberGeneration(campaignId: string, userId: string): Promise<number> {
    const rows = await h.pool.query<{ generation: number }>(
      `SELECT generation FROM campaign_members WHERE campaign_id = $1 AND user_id = $2`,
      [campaignId, userId],
    );
    return rows.rows[0]?.generation ?? 1;
  }

  async function seedMember(campaignId: string, userId: string, role: "co_gm" | "player" = "player"): Promise<void> {
    await h.pool.query(
      `INSERT INTO campaign_members (campaign_id, user_id, role, status, generation)
       VALUES ($1, $2, $3, 'active', 1)`,
      [campaignId, userId, role],
    );
  }

  async function count(table: string, where: string, params: unknown[]): Promise<number> {
    const rows = await h.pool.query(`SELECT COUNT(*)::int AS count FROM ${table} WHERE ${where}`, params);
    return rows.rows[0].count as number;
  }

  async function rollCount(characterId: string): Promise<number> {
    return count("character_rolls", "character_id = $1", [characterId]);
  }

  async function campaignEventCount(campaignId: string, kind: string): Promise<number> {
    return count("campaign_activity_events", "campaign_id = $1 AND kind = $2", [campaignId, kind]);
  }

  async function rollAudience(characterId: string, actorId: string): Promise<RollAudience> {
    const rows = await h.pool.query<{ audience: string }>(
      `SELECT audience FROM character_rolls WHERE character_id = $1 AND actor_id = $2 ORDER BY occurred_at, id`,
      [characterId, actorId],
    );
    if (rows.rows.length === 0) throw new Error("expected a stored roll");
    return rows.rows[rows.rows.length - 1]!.audience as RollAudience;
  }

  type Setup = {
    campaignId: string;
    adoptedId: string;
    sharedId: string;
  };

  /**
   * Fresh campaign per test: gm owns, other is co-GM (two GMs), player and
   * riley are active players, erin is an active player without control,
   * outsider never joins. One adopted sheet (player's) and one
   * campaign-created sheet controlled by player + riley (two controllers).
   */
  async function setup(versionId=h.versionId): Promise<Setup> {
    const created = await h.campaigns.create(ctxFor(h.users.gm), {
      systemVersionId: versionId,
      title: `Rolls ${randomUUID()}`,
      description: "",
      idempotencyKey: randomUUID(),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("campaign create failed");
    const campaignId = created.value.campaignId;

    await seedMember(campaignId, h.users.other.actorId, "co_gm");
    await seedMember(campaignId, h.users.player.actorId);
    await seedMember(campaignId, secondController.actorId);
    await seedMember(campaignId, unassigned.actorId);

    const personal = await h.characters.create(ctxFor(h.users.player), {
      systemVersionId: versionId,
      entityDefinitionId: "character",
      name: `Adopted ${randomUUID().slice(0, 8)}`,
      idempotencyKey: randomUUID(),
    });
    if (!personal.ok) throw new Error(`standalone create failed: ${JSON.stringify(personal.error)}`);
    const adopted = await inPlacementTxn(async (client) =>
      h.placement.adopt(client, ctxFor(h.users.player), {
        campaignId,
        expectedCampaignRevision: await campaignRevision(campaignId),
        membershipGeneration: await memberGeneration(campaignId, h.users.player.actorId),
        characterId: personal.value.characterId,
        expectedCharacterRevision: personal.value.revision,
        acknowledgedDisclosure: true,
        idempotencyKey: randomUUID(),
      }),
    );
    expect(adopted.ok).toBe(true);
    if (!adopted.ok) throw new Error("adopt failed");

    const prepared = await prepareCampaignCharacter(h.runtime, {
      systemVersionId: versionId,
      entityDefinitionId: "character",
    });
    if (!prepared.ok) throw new Error("prepare failed");
    const shared = await inPlacementTxn(async (client) =>
      h.placement.createInCampaign(client, ctxFor(h.users.gm), {
        campaignId,
        expectedCampaignRevision: await campaignRevision(campaignId),
        membershipGeneration: await memberGeneration(campaignId, h.users.gm.actorId),
        idempotencyKey: randomUUID(),
        name: `Shared ${randomUUID().slice(0, 8)}`,
        entityDefinitionId: "character",
        prepared: prepared.value,
        controllerUserIds: [h.users.player.actorId, secondController.actorId],
      }),
    );
    expect(shared.ok).toBe(true);
    if (!shared.ok) throw new Error("createInCampaign failed");

    return {
      campaignId,
      adoptedId: personal.value.characterId,
      sharedId: shared.value.characterId,
    };
  }

  async function roll(
    actor: TestActor,
    characterId: string,
    expectedRevision: number,
    input: { audience?: RollAudience; key?: string } = {},
  ) {
    return h.characters.apply(ctxFor(actor), {
      kind: "executeAction",
      characterId,
      actionId: "check",
      inputs: { bonus: 2 },
      expectedRevision,
      idempotencyKey: input.key ?? randomUUID(),
      ...(input.audience === undefined ? {} : { audience: input.audience }),
    });
  }

  /**
   * Roll visibility through the campaign activity feed (every active member
   * may list; each event carries its roll source only). Export-based checks
   * below cover the GM projection separately.
   */
  async function visibleRollSources(who: TestActor, campaignId: string): Promise<string[]> {
    const activity = await h.campaigns.listActivity(ctxFor(who), { campaignId });
    expect(activity.ok).toBe(true);
    if (!activity.ok) throw new Error("activity failed");
    return activity.value.events
      .filter((event) => event.kind === "roll_executed")
      .map((event) => event.sourceRollId)
      .filter((id): id is string => id !== null);
  }

  async function exportedRolls(who: TestActor, campaignId: string) {
    const exported = await h.campaigns.exportCampaign(ctxFor(who), {
      campaignId,
      idempotencyKey: randomUUID(),
    });
    expect(exported.ok).toBe(true);
    if (!exported.ok) throw new Error("export failed");
    return exported.value;
  }

  // ------------------------------------------------------------------
  // audience visibility across two controllers and multiple GMs
  // ------------------------------------------------------------------

  it("keeps actor-private rolls visible only to the roller", async () => {
    const s = await setup();
    const first = await roll(h.users.player, s.sharedId, 1, { audience: "owner_only" });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(`private roll failed: ${JSON.stringify(first.error)}`);
    expect(first.value.roll?.audience).toBe("owner_only");
    expect(await rollAudience(s.sharedId, h.users.player.actorId)).toBe("owner_only");
    expect(await rollCount(s.sharedId)).toBe(1);
    expect(await campaignEventCount(s.campaignId, "roll_executed")).toBe(1);

    // The roller replays their own receipt; the other controller and both
    // GMs keep sheet access but never see the private roll.
    const exported = await exportedRolls(h.users.gm, s.campaignId);
    expect(exported.rolls).toEqual([]);
    expect(exported.activity.map((event) => event.sourceRollId).filter((id) => id !== null)).toEqual([]);

    expect(await visibleRollSources(secondController, s.campaignId)).toEqual([]);
    expect(await visibleRollSources(h.users.other, s.campaignId)).toEqual([]);
    expect(await visibleRollSources(h.users.player, s.campaignId)).toHaveLength(1);

    const outsiderActivity = await h.campaigns.listActivity(ctxFor(h.users.outsider), { campaignId: s.campaignId });
    expect(outsiderActivity.ok).toBe(false);
  });

  it("shares gm_only rolls with the roller and current GMs only", async () => {
    const s = await setup();
    const first = await roll(h.users.player, s.sharedId, 1, { audience: "gm_only" });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(`gm roll failed: ${JSON.stringify(first.error)}`);
    expect(first.value.roll?.audience).toBe("gm_only");

    const gmRolls = await visibleRollSources(h.users.gm, s.campaignId);
    expect(gmRolls).toHaveLength(1);
    const coGmRolls = await visibleRollSources(h.users.other, s.campaignId);
    expect(coGmRolls).toEqual(gmRolls);
    // The roller reads their own gm_only roll; the other controller and
    // unassigned players cannot.
    expect(await visibleRollSources(h.users.player, s.campaignId)).toEqual(gmRolls);
    expect(await visibleRollSources(secondController, s.campaignId)).toEqual([]);
    expect(await visibleRollSources(unassigned, s.campaignId)).toEqual([]);

    const exported = await exportedRolls(h.users.gm, s.campaignId);
    expect(exported.rolls).toHaveLength(1);
    expect(exported.rolls[0]).toMatchObject({ audience: "gm_only", actorId: h.users.player.actorId });
    expect(exported.activity.map((event) => event.sourceRollId)).toContain(exported.rolls[0]!.rollId);
  });

  it("shares campaign rolls with every active member", async () => {
    const s = await setup();
    const first = await roll(secondController, s.sharedId, 1, { audience: "campaign" });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(`campaign roll failed: ${JSON.stringify(first.error)}`);
    expect(first.value.roll?.audience).toBe("campaign");

    for (const who of [h.users.gm, h.users.other, h.users.player, secondController, unassigned] as const) {
      expect(await visibleRollSources(who, s.campaignId)).toHaveLength(1);
    }
    const outsiderActivity = await h.campaigns.listActivity(ctxFor(h.users.outsider), { campaignId: s.campaignId });
    expect(outsiderActivity.ok).toBe(false);
  });

  it("never reveals private roll inputs or bindings through sheet reads", async () => {
    const s = await setup();
    const first = await roll(h.users.player, s.sharedId, 1, { audience: "owner_only" });
    expect(first.ok).toBe(true);

    for (const who of [h.users.gm, h.users.other, secondController] as const) {
      const opened = await h.characters.open(ctxFor(who), s.sharedId);
      expect(opened.ok).toBe(true);
      if (!opened.ok) throw new Error("open failed");
      // The sheet projection carries the action's input *schema* (as it
      // always has), but never the private roll: no dice, bindings, totals
      // or rendered roll output.
      const serialized = JSON.stringify(opened.value);
      expect(serialized).not.toContain("bindings");
      expect(serialized).not.toContain("dice");
      expect(serialized).not.toContain("Result:");
    }

    const activity = await h.characters.listActivity(ctxFor(h.users.gm), {
      characterId: s.sharedId,
      limit: 20,
      cursor: null,
    });
    expect(activity.ok).toBe(true);
    if (!activity.ok) throw new Error("activity failed");
    // Minimized payloads only: the action id, never inputs or bindings.
    const actionEvents = activity.value.events.filter((event) => event.kind === "character_action_executed");
    expect(actionEvents).toHaveLength(1);
    for (const event of actionEvents) {
      expect(event.payload).toEqual({ actionId: "check", changedDefinitionIds: [] });
    }
    const serialized = JSON.stringify(activity.value.events);
    expect(serialized).not.toContain("bindings");
  });

  it("redacts private roll existence in character activity for out-of-audience sheet readers", async () => {
    const s = await setup();
    const first = await roll(h.users.player, s.sharedId, 1, { audience: "owner_only" });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(`private roll failed: ${JSON.stringify(first.error)}`);

    async function characterRollIds(who: TestActor): Promise<{ rollIds: (string | null)[]; kinds: string[] }> {
      const activity = await h.characters.listActivity(ctxFor(who), {
        characterId: s.sharedId,
        limit: 20,
        cursor: null,
      });
      expect(activity.ok).toBe(true);
      if (!activity.ok) throw new Error("character activity failed");
      const actionEvents = activity.value.events.filter((event) => event.kind === "character_action_executed");
      expect(actionEvents).toHaveLength(1);
      return {
        rollIds: actionEvents.map((event) => event.rollId),
        kinds: activity.value.events.map((event) => event.kind),
      };
    }

    // The rolling actor still sees the correlatable roll UUID.
    const roller = await characterRollIds(h.users.player);
    expect(roller.rollIds[0]).toBe(await rollIdOf(s.sharedId));
    // Revision/state-change visibility is kept for every sheet reader.
    expect(roller.kinds).toContain("character_action_executed");

    // The other controller and both GMs keep sheet access and the event,
    // but never the correlatable roll UUID.
    for (const who of [secondController, h.users.gm, h.users.other] as const) {
      const seen = await characterRollIds(who);
      expect(seen.rollIds).toEqual([null]);
      expect(seen.kinds).toContain("character_action_executed");
    }

    // Campaign activity behavior is unchanged: the private roll stays
    // visible only to the roller there.
    expect(await visibleRollSources(h.users.player, s.campaignId)).toHaveLength(1);
    expect(await visibleRollSources(secondController, s.campaignId)).toEqual([]);
    expect(await visibleRollSources(h.users.gm, s.campaignId)).toEqual([]);
  });

  // ------------------------------------------------------------------
  // standalone vocabulary
  // ------------------------------------------------------------------

  it("rejects campaign and gm_only audiences on standalone sheets", async () => {
    const created = await h.characters.create(ctxFor(h.users.player), {
      systemVersionId: h.versionId,
      entityDefinitionId: "character",
      name: `Solo ${randomUUID().slice(0, 8)}`,
      idempotencyKey: randomUUID(),
    });
    if (!created.ok) throw new Error("standalone create failed");
    const characterId = created.value.characterId;

    for (const audience of ["campaign", "gm_only"] as const) {
      const denied = await roll(h.users.player, characterId, 1, { audience });
      expect(denied.ok).toBe(false);
      if (denied.ok) throw new Error(`${audience} must deny on standalone`);
      expect(denied.error.code).toBe("bad_request");
    }
    expect(await rollCount(characterId)).toBe(0);

    const explicit = await roll(h.users.player, characterId, 1, { audience: "owner_only" });
    expect(explicit.ok).toBe(true);
    if (!explicit.ok) throw new Error("explicit owner_only failed");
    expect(explicit.value.roll?.audience).toBe("owner_only");

    const omitted = await roll(h.users.player, characterId, 1);
    expect(omitted.ok).toBe(true);
    if (!omitted.ok) throw new Error("omitted audience failed");
    expect(omitted.value.roll?.audience).toBe("owner_only");
    expect(await rollCount(characterId)).toBe(2);
  });

  it("rejects unknown audiences without falling back wider", async () => {
    const s = await setup();
    const denied = await h.characters.apply(ctxFor(h.users.player), {
      kind: "executeAction",
      characterId: s.sharedId,
      actionId: "check",
      inputs: { bonus: 2 },
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      audience: "everyone" as RollAudience,
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unknown audience must deny");
    expect(denied.error.code).toBe("bad_request");
    expect(await rollCount(s.sharedId)).toBe(0);
    expect(await campaignEventCount(s.campaignId, "roll_executed")).toBe(0);
  });

  // ------------------------------------------------------------------
  // effective default fixed at first claim
  // ------------------------------------------------------------------

  it("resolves an omitted audience once from the campaign default", async () => {
    const s = await setup();
    await h.pool.query(`UPDATE campaigns SET roll_audience_default = 'gm_only' WHERE id = $1`, [s.campaignId]);

    const first = await roll(h.users.player, s.sharedId, 1);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(`default roll failed: ${JSON.stringify(first.error)}`);
    expect(first.value.roll?.audience).toBe("gm_only");
    expect(await rollAudience(s.sharedId, h.users.player.actorId)).toBe("gm_only");
  });

  it("keeps recorded dice and audience on replay after the default changes", async () => {
    const s = await setup();
    await h.pool.query(`UPDATE campaigns SET roll_audience_default = 'gm_only' WHERE id = $1`, [s.campaignId]);

    const key = randomUUID();
    const first = await roll(h.users.player, s.sharedId, 1, { key });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("first roll failed");

    await h.pool.query(`UPDATE campaigns SET roll_audience_default = 'campaign' WHERE id = $1`, [s.campaignId]);

    const replay = await roll(h.users.player, s.sharedId, 1, { key });
    expect(replay.ok).toBe(true);
    if (!replay.ok || !first.ok) throw new Error("replay failed");
    expect(replay.value.roll).toEqual(first.value.roll);
    expect(replay.value.roll?.audience).toBe("gm_only");
    expect(replay.value.character.reconciliation.replayed).toBe(true);
    expect(await rollCount(s.sharedId)).toBe(1);
    expect(await campaignEventCount(s.campaignId, "roll_executed")).toBe(1);
  });

  it("mismatches when the explicit audience changes on the same key", async () => {
    const s = await setup();
    const key = randomUUID();
    const first = await roll(h.users.player, s.sharedId, 1, { audience: "owner_only", key });
    expect(first.ok).toBe(true);

    // Widening denied: same key, wider audience.
    const widened = await roll(h.users.player, s.sharedId, 1, { audience: "campaign", key });
    expect(widened.ok).toBe(false);
    if (widened.ok) throw new Error("widening must mismatch");
    expect(widened.error.code).toBe("idempotency_mismatch");

    // Narrowing also mismatches: the recorded input never moves.
    const narrowed = await roll(h.users.player, s.sharedId, 1, { audience: "gm_only", key });
    expect(narrowed.ok).toBe(false);
    if (narrowed.ok) throw new Error("narrowing must mismatch");
    expect(narrowed.error.code).toBe("idempotency_mismatch");

    // Omitted versus explicit mismatches even when the default agrees.
    await h.pool.query(`UPDATE campaigns SET roll_audience_default = 'owner_only' WHERE id = $1`, [s.campaignId]);
    const omitted = await roll(h.users.player, s.sharedId, 1, { key });
    expect(omitted.ok).toBe(false);
    if (omitted.ok) throw new Error("omitted retarget must mismatch");
    expect(omitted.error.code).toBe("idempotency_mismatch");

    expect(await rollCount(s.sharedId)).toBe(1);
  });

  // ------------------------------------------------------------------
  // atomicity: no partial events
  // ------------------------------------------------------------------

  it("commits roll, character result, campaign activity and receipt atomically", async () => {
    const s = await setup();
    const key = randomUUID();
    const requestId = randomUUID();
    const first = await h.characters.apply(ctxFor(h.users.player, requestId), {
      kind: "executeAction",
      characterId: s.sharedId,
      actionId: "check",
      inputs: { bonus: 2 },
      expectedRevision: 1,
      idempotencyKey: key,
      audience: "campaign",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("roll failed");

    expect(await rollCount(s.sharedId)).toBe(1);
    const rollRow = await h.pool.query<{ audience: string; scope_campaign_id: string; request_id: string }>(
      `SELECT audience, scope_campaign_id, request_id FROM character_rolls WHERE character_id = $1`,
      [s.sharedId],
    );
    expect(rollRow.rows).toHaveLength(1);
    expect(rollRow.rows[0]).toMatchObject({
      audience: "campaign",
      scope_campaign_id: s.campaignId,
      request_id: requestId,
    });

    const characterEvents = await h.pool.query<{ kind: string; scope_campaign_id: string; roll_id: string | null }>(
      `SELECT kind, scope_campaign_id, roll_id FROM character_activity_events
        WHERE character_id = $1 AND kind = 'character_action_executed'`,
      [s.sharedId],
    );
    expect(characterEvents.rows).toHaveLength(1);
    expect(characterEvents.rows[0]?.scope_campaign_id).toBe(s.campaignId);
    expect(characterEvents.rows[0]?.roll_id).toBe(await rollIdOf(s.sharedId));

    const campaignEvents = await h.pool.query<{ kind: string; source_roll_id: string | null; request_id: string }>(
      `SELECT kind, source_roll_id, request_id FROM campaign_activity_events WHERE campaign_id = $1`,
      [s.campaignId],
    );
    expect(campaignEvents.rows).toHaveLength(1);
    expect(campaignEvents.rows[0]?.kind).toBe("roll_executed");
    expect(campaignEvents.rows[0]?.request_id).toBe(requestId);

    const receipt = await h.pool.query(
      `SELECT COUNT(*)::int AS count FROM character_command_executions
        WHERE actor_id = $1 AND command_kind = 'character_execute_action' AND idempotency_key = $2 AND status = 'completed'`,
      [h.users.player.actorId, key],
    );
    expect(receipt.rows[0].count).toBe(1);
  });

  it("produces no partial event when roll generation fails", async () => {
    const s = await setup();
    const failed = await h.characters.apply(ctxFor(h.users.player), {
      kind: "executeAction",
      characterId: s.sharedId,
      actionId: "check",
      inputs: { unknown_input: 1 },
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      audience: "campaign",
    });
    expect(failed.ok).toBe(false);
    expect(await rollCount(s.sharedId)).toBe(0);
    expect(await campaignEventCount(s.campaignId, "roll_executed")).toBe(0);
    expect(await count("character_activity_events", "character_id = $1 AND kind = 'character_action_executed'", [s.sharedId])).toBe(0);
  });

  it("produces no partial event once permission is revoked", async () => {
    const s = await setup();
    const departed = await h.campaigns.removeMember(ctxFor(h.users.gm), {
      campaignId: s.campaignId,
      userId: h.users.player.actorId,
      expectedCampaignRevision: await campaignRevision(s.campaignId),
      idempotencyKey: randomUUID(),
    });
    expect(departed.ok).toBe(true);

    const denied = await roll(h.users.player, s.sharedId, 1, { audience: "campaign" });
    expect(denied.ok).toBe(false);
    expect(await rollCount(s.sharedId)).toBe(0);
    expect(await campaignEventCount(s.campaignId, "roll_executed")).toBe(0);
    expect(await count("character_activity_events", "character_id = $1 AND kind = 'character_action_executed'", [s.sharedId])).toBe(0);
  });

  it("rejects rolls while the campaign is archived", async () => {
    const s = await setup();
    const archived = await h.campaigns.archive(ctxFor(h.users.gm), {
      campaignId: s.campaignId,
      expectedCampaignRevision: await campaignRevision(s.campaignId),
      idempotencyKey: randomUUID(),
    });
    expect(archived.ok).toBe(true);

    const denied = await roll(h.users.player, s.sharedId, 1, { audience: "campaign" });
    expect(denied.ok).toBe(false);
    expect(await rollCount(s.sharedId)).toBe(0);
    expect(await campaignEventCount(s.campaignId, "roll_executed")).toBe(0);
  });

  // ------------------------------------------------------------------
  // return hides campaign history while the current sheet stays available
  // ------------------------------------------------------------------

  it("hides campaign history after return while the current sheet stays available", async () => {
    const s = await setup();
    const rolled = await roll(h.users.player, s.adoptedId, 2, { audience: "campaign" });
    expect(rolled.ok).toBe(true);
    expect(await rollCount(s.adoptedId)).toBe(1);

    const departed = await h.campaigns.removeMember(ctxFor(h.users.gm), {
      campaignId: s.campaignId,
      userId: h.users.player.actorId,
      expectedCampaignRevision: await campaignRevision(s.campaignId),
      idempotencyKey: randomUUID(),
    });
    expect(departed.ok).toBe(true);

    // The current sheet returned and stays readable/exportable.
    const opened = await h.characters.open(ctxFor(h.users.player), s.adoptedId);
    expect(opened.ok).toBe(true);
    const exported = await h.characters.exportCharacter(ctxFor(h.users.player), { characterId: s.adoptedId });
    expect(exported.ok).toBe(true);

    // Campaign-scoped history stays hidden through every personal path.
    const activity = await h.characters.listActivity(ctxFor(h.users.player), {
      characterId: s.adoptedId,
      limit: 20,
      cursor: null,
    });
    expect(activity.ok).toBe(true);
    if (!activity.ok) throw new Error("activity failed");
    expect(activity.value.events.map((event) => event.kind)).not.toContain("character_action_executed");

    // The departed actor cannot reach the campaign roll through campaign reads.
    const campaignActivity = await h.campaigns.listActivity(ctxFor(h.users.player), { campaignId: s.campaignId });
    expect(campaignActivity.ok).toBe(false);
    const campaignExport = await h.campaigns.exportCampaign(ctxFor(h.users.player), {
      campaignId: s.campaignId,
      idempotencyKey: randomUUID(),
    });
    expect(campaignExport.ok).toBe(false);

    // The stored roll keeps its original campaign scope (never relabelled).
    const stored = await h.pool.query<{ scope_campaign_id: string }>(
      `SELECT scope_campaign_id FROM character_rolls WHERE character_id = $1`,
      [s.adoptedId],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.scope_campaign_id).toBe(s.campaignId);
  });

  // ------------------------------------------------------------------
  // second system evidence (d6 pool) + idempotency stability
  // ------------------------------------------------------------------

  it("records audiences and reauthorizes same-key success and failure replays", async () => {
    const created = await h.campaigns.create(ctxFor(h.users.gm), {
      systemVersionId: h.otherVersionId,
      title: `Pool ${randomUUID()}`,
      description: "",
      idempotencyKey: randomUUID(),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("campaign create failed");
    const campaignId = created.value.campaignId;
    await seedMember(campaignId, h.users.player.actorId);

    const personal = await h.characters.create(ctxFor(h.users.player), {
      systemVersionId: h.otherVersionId,
      entityDefinitionId: "character",
      name: `Pool hero ${randomUUID().slice(0, 8)}`,
      idempotencyKey: randomUUID(),
    });
    if (!personal.ok) throw new Error("standalone create failed");
    const adopted = await inPlacementTxn(async (client) =>
      h.placement.adopt(client, ctxFor(h.users.player), {
        campaignId,
        expectedCampaignRevision: await campaignRevision(campaignId),
        membershipGeneration: await memberGeneration(campaignId, h.users.player.actorId),
        characterId: personal.value.characterId,
        expectedCharacterRevision: personal.value.revision,
        acknowledgedDisclosure: true,
        idempotencyKey: randomUUID(),
      }),
    );
    expect(adopted.ok).toBe(true);
    if (!adopted.ok) throw new Error("adopt failed");

    const key = randomUUID();
    const applyPool = (idempotencyKey: string, audience?: RollAudience) =>
      h.characters.apply(ctxFor(h.users.player), {
        kind: "executeAction",
        characterId: personal.value.characterId,
        actionId: "test_pool",
        inputs: { bonus_dice: 1 },
        expectedRevision: 2,
        idempotencyKey,
        ...(audience === undefined ? {} : { audience }),
      });

    const failedKey = randomUUID();
    const failPool = () => h.characters.apply(ctxFor(h.users.player), {
      kind: "executeAction",
      characterId: personal.value.characterId,
      actionId: "test_pool",
      inputs: { bonus_dice: -3 },
      expectedRevision: 2,
      idempotencyKey: failedKey,
    });
    const firstFailure = await failPool();
    expect(firstFailure).toMatchObject({ ok: false, error: { code: "invalid_value" } });
    // Treat the first response as lost; a same-key retry must replay its
    // reviewable failure while the original campaign authorization remains.
    const replayedFailure = await failPool();
    expect(replayedFailure).toEqual(firstFailure);
    const failureReceipt = await h.pool.query<{ result_json: unknown }>(
      `SELECT result_json FROM character_command_executions WHERE actor_id = $1 AND idempotency_key = $2`,
      [h.users.player.actorId, failedKey],
    );
    expect(failureReceipt.rows[0]?.result_json).toMatchObject({
      ok: false,
      scope: { campaignId, placementGeneration: 2, membershipGeneration: 1, audience: null },
    });

    const first = await applyPool(key, "gm_only");
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(`pool roll failed: ${JSON.stringify(first.error)}`);
    expect(first.value.roll?.audience).toBe("gm_only");
    expect(first.value.roll?.dice).toHaveLength(3);

    const replay = await applyPool(key, "gm_only");
    expect(replay.ok).toBe(true);
    if (!replay.ok || !first.ok) throw new Error("replay failed");
    expect(replay.value.roll).toEqual(first.value.roll);
    expect(await rollCount(personal.value.characterId)).toBe(1);
    expect(await campaignEventCount(campaignId, "roll_executed")).toBe(1);

    const exported = await exportedRolls(h.users.gm, campaignId);
    expect(exported.rolls).toHaveLength(1);
    expect(exported.rolls[0]).toMatchObject({ audience: "gm_only" });

    const removed = await h.campaigns.removeMember(ctxFor(h.users.gm), {
      campaignId,
      userId: h.users.player.actorId,
      expectedCampaignRevision: await campaignRevision(campaignId),
      idempotencyKey: randomUUID(),
    });
    expect(removed.ok).toBe(true);
    expect(await failPool()).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  async function rollIdOf(characterId: string): Promise<string> {
    const rows = await h.pool.query<{ id: string }>(
      `SELECT id FROM character_rolls WHERE character_id = $1 ORDER BY occurred_at, id`,
      [characterId],
    );
    if (rows.rows.length !== 1) throw new Error("expected exactly one roll");
    return rows.rows[0]!.id;
  }
  it("preserves grouped results in campaign storage/export and audience-filtered history",async()=>{
    const headers={cookie:h.users.gm.cookie};
    const created=await h.app.inject({method:"POST",url:"/systems",headers,payload:{source:{kind:"blank",name:"Grouped campaign fixture"},idempotencyKey:randomUUID()}});
    expect(created.statusCode,created.body).toBe(201);const workspace=created.json().workspace;
    const saved=await h.app.inject({method:"PUT",url:`/systems/${workspace.system.systemId}/draft`,headers,payload:{expectedRevision:workspace.draft.revision,document:namedDicePoolDocument()}});
    expect(saved.statusCode,saved.body).toBe(200);
    const published=await h.app.inject({method:"POST",url:`/systems/${workspace.system.systemId}/publish`,headers,payload:{expectedRevision:saved.json().workspace.draft.revision,semanticVersion:"1.0.0",releaseNotes:"",idempotencyKey:randomUUID(),acknowledgeBreaking:true}});
    expect(published.statusCode,published.body).toBe(200);
    await h.pool.query("UPDATE systems SET access='public' WHERE id=$1",[workspace.system.systemId]);
    const s=await setup(published.json().version.versionId);
    const command={kind:"executeAction" as const,characterId:s.sharedId,actionId:"test_pool",inputs:{bonus_dice:1},expectedRevision:1,idempotencyKey:randomUUID(),audience:"owner_only" as const};
    const first=await h.characters.apply(ctxFor(h.users.player),command);
    expect(first.ok).toBe(true);if(!first.ok)throw new Error(JSON.stringify(first.error));
    expect(first.value.roll?.breakdown?.groups).toHaveLength(3);
    const replay=await h.characters.apply(ctxFor(h.users.player),command);expect(replay.ok&&replay.value.roll).toEqual(first.value.roll);
    for(const who of [h.users.gm,h.users.other,secondController]){
      const history=await h.characters.listActivity(ctxFor(who),{characterId:s.sharedId,limit:20,cursor:null});
      expect(history.ok).toBe(true);if(!history.ok)throw new Error("history failed");
      expect(history.value.events.every(e=>e.roll===undefined&&e.rollId===null)).toBe(true);
    }
    const own=await h.characters.listActivity(ctxFor(h.users.player),{characterId:s.sharedId,limit:20,cursor:null});
    expect(own.ok&&own.value.events.some(e=>e.roll?.breakdown!==undefined)).toBe(true);
    const shared=await h.characters.apply(ctxFor(h.users.player),{...command,idempotencyKey:randomUUID(),audience:"campaign"});
    expect(shared.ok).toBe(true);if(!shared.ok)throw new Error("shared roll failed");
    const exported=await h.campaigns.exportCampaign(ctxFor(h.users.gm),{campaignId:s.campaignId,idempotencyKey:randomUUID()});
    expect(exported.ok).toBe(true);if(!exported.ok)throw new Error("export failed");
    expect(exported.value.rolls).toHaveLength(1);
    expect(exported.value.rolls[0]?.breakdown).toEqual(shared.value.roll?.breakdown);
    await h.pool.query("UPDATE campaign_members SET status='removed',generation=generation+1 WHERE campaign_id=$1 AND user_id=$2",[s.campaignId,h.users.player.actorId]);
    const revoked=await h.characters.apply(ctxFor(h.users.player),command);expect(revoked.ok).toBe(false);
  });

  async function setupPushCampaign(){
    const headers={cookie:h.users.gm.cookie};const doc=namedDicePoolDocument();doc.schemaVersion="1.2";
    const action=doc.actions.find(a=>a.kind==="roll")!;if(action.kind!=="roll")throw Error("fixture");action.pushPolicy={version:"1.0",maxAttempts:2,successThreshold:1,allowOnSuccess:true,groups:[{groupId:"attribute",lockedFaces:[],reportedFaces:[1]}]};
    const created=await h.app.inject({method:"POST",url:"/systems",headers,payload:{source:{kind:"blank",name:"Push campaign"},idempotencyKey:randomUUID()}});expect(created.statusCode,created.body).toBe(201);const w=created.json().workspace;
    const saved=await h.app.inject({method:"PUT",url:`/systems/${w.system.systemId}/draft`,headers,payload:{expectedRevision:w.draft.revision,document:doc}});expect(saved.statusCode,saved.body).toBe(200);
    const published=await h.app.inject({method:"POST",url:`/systems/${w.system.systemId}/publish`,headers,payload:{expectedRevision:saved.json().workspace.draft.revision,semanticVersion:"1.0.0",releaseNotes:"",acknowledgeBreaking:true,idempotencyKey:randomUUID()}});expect(published.statusCode,published.body).toBe(200);
    await h.pool.query("UPDATE systems SET access='public' WHERE id=$1",[w.system.systemId]);return setup(published.json().version.versionId);
  }
  async function pushRoot(s:Setup,audience:RollAudience="gm_only"){
    const r=await h.characters.apply(ctxFor(h.users.player),{kind:"executeAction",characterId:s.sharedId,actionId:"test_pool",inputs:{bonus_dice:1},expectedRevision:1,idempotencyKey:randomUUID(),audience});expect(r.ok).toBe(true);if(!r.ok)throw Error(JSON.stringify(r.error));return r.value.roll!;
  }
  it("preserves the root audience principal after a co-GM executes a child and is demoted",async()=>{
    const s=await setupPushCampaign();await h.pool.query("UPDATE campaigns SET roll_audience_default='gm_only' WHERE id=$1",[s.campaignId]);const root=await pushRoot(s);
    const command={kind:"pushRoll" as const,characterId:s.sharedId,parentRollId:root.push!.rollId,expectedRevision:1,idempotencyKey:randomUUID()};
    const child=await h.characters.apply(ctxFor(h.users.other),command);expect(child.ok).toBe(true);if(!child.ok)throw Error(JSON.stringify(child.error));
    const row=await h.pool.query("SELECT actor_id,audience_actor_id,audience FROM character_rolls WHERE id=$1",[child.value.roll!.push!.rollId]);expect(row.rows[0]).toEqual({actor_id:h.users.other.actorId,audience_actor_id:h.users.player.actorId,audience:"gm_only"});
    await h.pool.query("INSERT INTO character_controllers (character_id,campaign_id,user_id) VALUES ($1,$2,$3)",[s.sharedId,s.campaignId,h.users.other.actorId]);
    // Keep generation unchanged deliberately: this tests principal visibility rather than only the receipt-generation barrier.
    await h.pool.query("UPDATE campaign_members SET role='player' WHERE campaign_id=$1 AND user_id=$2",[s.campaignId,h.users.other.actorId]);
    expect((await h.characters.open(ctxFor(h.users.other),s.sharedId)).ok).toBe(true);
    expect((await h.characters.readRoll(ctxFor(h.users.other),{characterId:s.sharedId,rollId:child.value.roll!.push!.rollId})).ok).toBe(false);
    expect((await h.characters.pushOptions(ctxFor(h.users.other),{characterId:s.sharedId,rollId:child.value.roll!.push!.rollId})).ok).toBe(false);
    const replay=await h.characters.apply(ctxFor(h.users.other),command);expect(replay).toMatchObject({ok:false,error:{code:"not_found"}});
    const history=await h.characters.listActivity(ctxFor(h.users.other),{characterId:s.sharedId,limit:20,cursor:null});expect(history.ok&&history.value.events.every(e=>e.roll===undefined&&e.rollId===null)).toBe(true);
    expect(await visibleRollSources(h.users.other,s.campaignId)).toEqual([]);
    const exp=await h.campaigns.exportCampaign(ctxFor(h.users.other),{campaignId:s.campaignId,idempotencyKey:randomUUID()});expect(exp.ok).toBe(false);
    const gm=await h.campaigns.exportCampaign(ctxFor(h.users.gm),{campaignId:s.campaignId,idempotencyKey:randomUUID()});expect(gm.ok&&gm.value.rolls.find(r=>r.rollId===child.value.roll!.push!.rollId)?.push).toEqual(child.value.roll!.push);
  });
  it("rejects a push whose narrowed child would be hidden from its executor, and never widens later",async()=>{
    const s=await setupPushCampaign(),root=await pushRoot(s);
    await h.pool.query("UPDATE campaigns SET roll_audience_default='owner_only' WHERE id=$1",[s.campaignId]);
    const options=await h.characters.pushOptions(ctxFor(h.users.other),{characterId:s.sharedId,rollId:root.push!.rollId});expect(options).toMatchObject({ok:true,value:{canPush:false,reason:"audience_restricted",eligibleDiceIds:[]}});
    const hidden=await h.characters.apply(ctxFor(h.users.other),{kind:"pushRoll",characterId:s.sharedId,parentRollId:root.push!.rollId,expectedRevision:1,idempotencyKey:randomUUID()});expect(hidden.ok).toBe(false);
    expect((await h.pool.query("SELECT count(*)::int AS n FROM character_rolls WHERE parent_roll_id=$1",[root.push!.rollId])).rows[0].n).toBe(0);
    const child=await h.characters.apply(ctxFor(h.users.player),{kind:"pushRoll",characterId:s.sharedId,parentRollId:root.push!.rollId,expectedRevision:1,idempotencyKey:randomUUID()});expect(child.ok).toBe(true);if(!child.ok)throw Error(JSON.stringify(child.error));expect(child.value.roll!.audience).toBe("owner_only");
    await h.pool.query("UPDATE campaigns SET roll_audience_default='campaign' WHERE id=$1",[s.campaignId]);
    const next=await h.characters.apply(ctxFor(h.users.player),{kind:"pushRoll",characterId:s.sharedId,parentRollId:child.value.roll!.push!.rollId,expectedRevision:1,idempotencyKey:randomUUID()});expect(next.ok).toBe(true);if(!next.ok)throw Error(JSON.stringify(next.error));expect(next.value.roll!.audience).toBe("owner_only");
    expect((await h.characters.readRoll(ctxFor(h.users.gm),{characterId:s.sharedId,rollId:next.value.roll!.push!.rollId})).ok).toBe(false);
  });
  it("allows only one competing controller/co-GM child even with different keys and actors",async()=>{
    const s=await setupPushCampaign();await h.pool.query("UPDATE campaigns SET roll_audience_default='campaign' WHERE id=$1",[s.campaignId]);const root=await pushRoot(s,"campaign");
    const command={kind:"pushRoll" as const,characterId:s.sharedId,parentRollId:root.push!.rollId,expectedRevision:1};
    const results=await Promise.all([h.characters.apply(ctxFor(h.users.player),{...command,idempotencyKey:randomUUID()}),h.characters.apply(ctxFor(h.users.other),{...command,idempotencyKey:randomUUID()})]);expect(results.filter(r=>r.ok)).toHaveLength(1);expect(results.filter(r=>!r.ok).map(r=>!r.ok&&r.error.code)).toEqual(["conflict"]);
    expect((await h.pool.query("SELECT audience_actor_id FROM character_rolls WHERE parent_roll_id=$1",[root.push!.rollId])).rows).toEqual([{audience_actor_id:h.users.player.actorId}]);
  });

});
