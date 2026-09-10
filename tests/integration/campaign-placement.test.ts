import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createCampaignPlacement,
  prepareCampaignCharacter,
} from "../../src/characters/campaignPlacement.js";
import { buildAttachedCharacterExportDocument } from "../../src/characters/export.js";
import { denyAttachedMigrationScope } from "../../src/characters/migration.js";
import { claimExecutionOnClient } from "../../src/characters/idempotency.js";
import { DEFAULT_CAMPAIGN_LIMITS } from "../../src/platform/config.js";
import { createCampaignsModule } from "../../src/campaigns/index.js";
import { compileDocument } from "../../src/systems/implementation/rules/compile-document.js";
import { buildI6Harness, ctxFor, type I6Harness } from "./i6-app.js";
import { buildD20V2Document } from "./i3-app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;

describe("campaign placement scope helpers (no database)", () => {
  it("denies migration scope only for attached rows", () => {
    expect(denyAttachedMigrationScope({ ownerId: "u1", campaignId: null })).toBeNull();
    expect(denyAttachedMigrationScope({ ownerId: null, campaignId: "c1" })).toEqual({ attached: true });
  });

  it("builds attached exports from current state only, with no history or owner payload", () => {
    const document = buildAttachedCharacterExportDocument(
      {
        characterId: "char-1",
        name: "Attached",
        entityDefinitionId: "character",
        lifecycle: "active",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-02-01T00:00:00.000Z"),
        systemVersionId: "v1",
        revision: 3,
        state: { schemaVersion: "1.0", values: { ability: 12 } },
      },
      "checksum-1",
    );
    expect(document).toMatchObject({
      schemaVersion: "1.0",
      characterId: "char-1",
      revision: 3,
      state: { schemaVersion: "1.0", values: { ability: 12 } },
      migrationLineage: [],
    });
    expect(document).not.toHaveProperty("ownerId");
    expect(document).not.toHaveProperty("actorId");
    expect(document).not.toHaveProperty("campaignId");
    expect(JSON.stringify(document)).not.toContain("pre-adoption");
  });
});

describeWithDatabase("campaign character placement and atomic return (Task 4)", () => {
  let h: I6Harness;

  beforeAll(async () => {
    h = await buildI6Harness();
    // The fixture versions are private by default; placement tests need the
    // campaign version usable by every member, like a shared table version.
    await h.pool.query(`UPDATE systems SET access = 'public'`);
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

  async function createCampaign() {
    const created = await h.campaigns.create(ctxFor(h.users.gm), {
      systemVersionId: h.versionId,
      title: `Placement ${randomUUID()}`,
      description: "",
      idempotencyKey: randomUUID(),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("campaign create failed");
    return created.value.campaignId;
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

  async function campaignRevision(campaignId: string): Promise<number> {
    const opened = await h.campaigns.open(ctxFor(h.users.gm), { campaignId });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("campaign vanished under test");
    return opened.value.revision;
  }

  async function createStandalone(
    owner: keyof I6Harness["users"],
    versionId?: string,
  ): Promise<{ characterId: string; revision: number; state: unknown }> {
    const created = await h.characters.create(ctxFor(h.users[owner]), {
      systemVersionId: versionId ?? h.versionId,
      entityDefinitionId: "character",
      name: `${owner} hero ${randomUUID().slice(0, 8)}`,
      idempotencyKey: randomUUID(),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(`standalone create failed: ${JSON.stringify(created.error)}`);
    return { characterId: created.value.characterId, revision: created.value.revision, state: created.value.state };
  }

  async function characterRow(characterId: string) {
    const rows = await h.pool.query(
      `SELECT id, owner_id, campaign_id, placement_generation, return_owner_id,
              revision, state_json, lifecycle
         FROM characters WHERE id = $1`,
      [characterId],
    );
    return rows.rows[0] as
      | {
          id: string;
          owner_id: string | null;
          campaign_id: string | null;
          placement_generation: number;
          return_owner_id: string | null;
          revision: number;
          state_json: unknown;
          lifecycle: string;
        }
      | undefined;
  }

  async function controllersOf(characterId: string): Promise<string[]> {
    const rows = await h.pool.query(
      `SELECT user_id FROM character_controllers WHERE character_id = $1 ORDER BY user_id`,
      [characterId],
    );
    return rows.rows.map((row) => row.user_id as string);
  }

  async function count(table: string, where: string, params: unknown[]): Promise<number> {
    const rows = await h.pool.query(`SELECT COUNT(*)::int AS count FROM ${table} WHERE ${where}`, params);
    return rows.rows[0].count as number;
  }

  async function adopt(
    campaignId: string,
    characterId: string,
    owner: keyof I6Harness["users"],
    options?: { expectedCampaignRevision?: number; expectedCharacterRevision?: number; acknowledged?: boolean; key?: string },
  ) {
    const expectedCampaignRevision = options?.expectedCampaignRevision ?? (await campaignRevision(campaignId));
    const row = await characterRow(characterId);
    return await inPlacementTxn((client) =>
      h.placement.adopt(client, ctxFor(h.users[owner]), {
        campaignId,
        expectedCampaignRevision,
        membershipGeneration: 1,
        characterId,
        expectedCharacterRevision: options?.expectedCharacterRevision ?? row?.revision ?? 1,
        acknowledgedDisclosure: options?.acknowledged ?? true,
        idempotencyKey: options?.key ?? randomUUID(),
      }),
    );
  }

  it("adopts a personal character with exact pin, consent and preserved state", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);
    const standalone = await createStandalone("player");
    const beforeState = standalone.state;

    const adopted = await adopt(campaignId, standalone.characterId, "player");
    expect(adopted.ok).toBe(true);
    if (!adopted.ok) return;
    expect(adopted.value).toMatchObject({
      ownerId: null,
      campaignId,
      controllers: [h.users.player.actorId],
      placementGeneration: 2,
      returnOwnerId: h.users.player.actorId,
      revision: 2,
    });
    expect(adopted.value.state).toEqual(beforeState);

    const row = await characterRow(standalone.characterId);
    expect(row).toMatchObject({
      owner_id: null,
      campaign_id: campaignId,
      placement_generation: 2,
      return_owner_id: h.users.player.actorId,
      revision: 2,
    });
    const placements = await h.pool.query(
      `SELECT generation, campaign_id, return_owner_id, ended_at
         FROM character_placements WHERE character_id = $1 ORDER BY generation`,
      [standalone.characterId],
    );
    expect(placements.rows).toEqual([
      { generation: 2, campaign_id: campaignId, return_owner_id: h.users.player.actorId, ended_at: null },
    ]);
    expect(await campaignRevision(campaignId)).toBe(2);
    const activity = await h.pool.query(
      `SELECT kind, scope_campaign_id FROM character_activity_events WHERE character_id = $1 ORDER BY occurred_at, id`,
      [standalone.characterId],
    );
    expect(activity.rows).toEqual([
      { kind: "character_created", scope_campaign_id: null },
      { kind: "character_adopted", scope_campaign_id: campaignId },
    ]);
  });

  it("replays adoption exactly with row-count stability and rejects mismatched keys", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);
    const standalone = await createStandalone("player");
    const key = randomUUID();
    // The replay reuses the identical input, including the original campaign revision.
    const first = await adopt(campaignId, standalone.characterId, "player", {
      key,
      expectedCampaignRevision: 1,
      expectedCharacterRevision: 1,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const counts = {
      characters: await count("characters", "id = $1", [standalone.characterId]),
      placements: await count("character_placements", "character_id = $1", [standalone.characterId]),
      controllers: await count("character_controllers", "character_id = $1", [standalone.characterId]),
      executions: await count(
        "character_command_executions",
        "actor_id = $1 AND command_kind = $2 AND idempotency_key = $3",
        [h.users.player.actorId, "character_campaign_adopt", key],
      ),
      activity: await count("character_activity_events", "character_id = $1", [standalone.characterId]),
    };
    const replayed = await adopt(campaignId, standalone.characterId, "player", {
      key,
      expectedCampaignRevision: 1,
      expectedCharacterRevision: 1,
    });
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.value.replayed).toBe(true);
    expect(replayed.value.characterId).toBe(first.value.characterId);
    expect(replayed.value.revision).toBe(first.value.revision);
    expect(await count("characters", "id = $1", [standalone.characterId])).toBe(counts.characters);
    expect(await count("character_placements", "character_id = $1", [standalone.characterId])).toBe(counts.placements);
    expect(await count("character_controllers", "character_id = $1", [standalone.characterId])).toBe(counts.controllers);
    expect(
      await count(
        "character_command_executions",
        "actor_id = $1 AND command_kind = $2 AND idempotency_key = $3",
        [h.users.player.actorId, "character_campaign_adopt", key],
      ),
    ).toBe(counts.executions);
    expect(await count("character_activity_events", "character_id = $1", [standalone.characterId])).toBe(counts.activity);
    expect(await campaignRevision(campaignId)).toBe(2);

    const mismatched = await adopt(campaignId, standalone.characterId, "player", {
      key,
      expectedCampaignRevision: 1,
      expectedCharacterRevision: 999,
    });
    expect(mismatched).toEqual({ ok: false, error: expect.objectContaining({ code: "idempotency_mismatch" }) });
  });

  it("rejects adoption on version mismatch, foreign sheets, removed owners, archived targets and missing consent", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);

    // Version mismatch: a real character pinned to another version gets a
    // definite validation error, not a silent repin.
    const foreignVersion = await createStandalone("player", h.otherVersionId);
    const mismatched = await adopt(campaignId, foreignVersion.characterId, "player");
    expect(mismatched).toEqual({ ok: false, error: expect.objectContaining({ code: "bad_request" }) });

    // Another user's character: no existence or scope leak.
    const gmSheet = await createStandalone("gm");
    const foreign = await adopt(campaignId, gmSheet.characterId, "player");
    expect(foreign).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });

    // Missing disclosure acknowledgement.
    const unconsented = await createStandalone("player");
    const noAck = await adopt(campaignId, unconsented.characterId, "player", { acknowledged: false });
    expect(noAck).toEqual({ ok: false, error: expect.objectContaining({ code: "bad_request" }) });

    // Removed owner: no longer an active member, so adoption collapses.
    const departed = await createStandalone("player");
    const removed = await h.campaigns.removeMember(ctxFor(h.users.gm), {
      campaignId,
      userId: h.users.player.actorId,
      expectedCampaignRevision: await campaignRevision(campaignId),
      idempotencyKey: randomUUID(),
    });
    expect(removed.ok).toBe(true);
    const afterRemoval = await adopt(campaignId, departed.characterId, "player");
    expect(afterRemoval).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });

    // Archived campaign target.
    const archivedCampaign = await createCampaign();
    await seedMember(archivedCampaign, h.users.other.actorId);
    const archivedSheet = await createStandalone("other");
    const archived = await h.campaigns.archive(ctxFor(h.users.gm), {
      campaignId: archivedCampaign,
      expectedCampaignRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(archived.ok).toBe(true);
    const onArchived = await adopt(archivedCampaign, archivedSheet.characterId, "other");
    expect(onArchived).toEqual({ ok: false, error: expect.objectContaining({ code: "conflict" }) });

    // Archived standalone sheet.
    const retiring = await createStandalone("other");
    const retired = await h.characters.manage(ctxFor(h.users.other), {
      kind: "archive",
      characterId: retiring.characterId,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(retired.ok).toBe(true);
    const liveCampaign = await createCampaign();
    await seedMember(liveCampaign, h.users.other.actorId);
    const retiredAdopt = await adopt(liveCampaign, retiring.characterId, "other");
    expect(retiredAdopt).toEqual({ ok: false, error: expect.objectContaining({ code: "conflict" }) });
  });

  it("creates campaign characters Runtime-prepared outside the transaction", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);

    let resolveCalls = 0;
    const counting = {
      ...h.runtime,
      resolve: (async (...args: Parameters<typeof h.runtime.resolve>) => {
        resolveCalls += 1;
        return h.runtime.resolve(...args);
      }) as typeof h.runtime.resolve,
    };
    const prepared = await prepareCampaignCharacter(counting, {
      systemVersionId: h.versionId,
      entityDefinitionId: "character",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(resolveCalls).toBe(1);

    // The placement module persists the prepared resolution without calling
    // Runtime again: the resolve count is unchanged across the transaction.
    const countingPlacement = createCampaignPlacement({ pool: h.pool, runtime: counting });
    const created = await inPlacementTxn((client) =>
      countingPlacement.createInCampaign(client, ctxFor(h.users.gm), {
        campaignId,
        expectedCampaignRevision: 1,
        membershipGeneration: 1,
        idempotencyKey: randomUUID(),
        name: "Unclaimed sentry",
        entityDefinitionId: "character",
        prepared: prepared.value,
      }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(resolveCalls).toBe(1);
    // Zero controllers is valid: no dummy owner is invented.
    expect(created.value).toMatchObject({
      ownerId: null,
      campaignId,
      controllers: [],
      placementGeneration: 1,
      returnOwnerId: null,
      revision: 1,
    });
    expect(created.value.state).toEqual(prepared.value.state);
    expect(await campaignRevision(campaignId)).toBe(2);

    // A prepared version that drifts from the pinned campaign version fails.
    const drifted = await prepareCampaignCharacter(h.runtime, {
      systemVersionId: h.otherVersionId,
      entityDefinitionId: "character",
    });
    expect(drifted.ok).toBe(true);
    if (!drifted.ok) return;
    const driftedCreate = await inPlacementTxn((client) =>
      h.placement.createInCampaign(client, ctxFor(h.users.gm), {
        campaignId,
        expectedCampaignRevision: 2,
        membershipGeneration: 1,
        idempotencyKey: randomUUID(),
        name: "Drifted",
        entityDefinitionId: "character",
        prepared: drifted.value,
      }),
    );
    expect(driftedCreate).toEqual({ ok: false, error: expect.objectContaining({ code: "bad_request" }) });
  });

  it("restricts campaign creation by role and membership", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);
    const prepared = await prepareCampaignCharacter(h.runtime, {
      systemVersionId: h.versionId,
      entityDefinitionId: "character",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    // A player creates only a self-controlled sheet.
    const selfMade = await inPlacementTxn((client) =>
      h.placement.createInCampaign(client, ctxFor(h.users.player), {
        campaignId,
        expectedCampaignRevision: 1,
        membershipGeneration: 1,
        idempotencyKey: randomUUID(),
        name: "Player scout",
        entityDefinitionId: "character",
        prepared: prepared.value,
      }),
    );
    expect(selfMade.ok).toBe(true);
    if (!selfMade.ok) return;
    expect(selfMade.value.controllers).toEqual([h.users.player.actorId]);

    const assignedElsewhere = await inPlacementTxn((client) =>
      h.placement.createInCampaign(client, ctxFor(h.users.player), {
        campaignId,
        expectedCampaignRevision: 2,
        membershipGeneration: 1,
        idempotencyKey: randomUUID(),
        name: "Player proxy",
        entityDefinitionId: "character",
        prepared: prepared.value,
        controllerUserIds: [h.users.other.actorId],
      }),
    );
    expect(assignedElsewhere).toEqual({ ok: false, error: expect.objectContaining({ code: "bad_request" }) });

    // A GM may assign active players at creation.
    const gmAssigned = await inPlacementTxn((client) =>
      h.placement.createInCampaign(client, ctxFor(h.users.gm), {
        campaignId,
        expectedCampaignRevision: 2,
        membershipGeneration: 1,
        idempotencyKey: randomUUID(),
        name: "GM assignee",
        entityDefinitionId: "character",
        prepared: prepared.value,
        controllerUserIds: [h.users.player.actorId],
      }),
    );
    expect(gmAssigned.ok).toBe(true);
    if (!gmAssigned.ok) return;
    expect(gmAssigned.value.controllers).toEqual([h.users.player.actorId]);

    // Controllers must be members of the SAME campaign.
    const crossCampaign = await inPlacementTxn((client) =>
      h.placement.createInCampaign(client, ctxFor(h.users.gm), {
        campaignId,
        expectedCampaignRevision: 3,
        membershipGeneration: 1,
        idempotencyKey: randomUUID(),
        name: "Outsider proxy",
        entityDefinitionId: "character",
        prepared: prepared.value,
        controllerUserIds: [h.users.other.actorId],
      }),
    );
    expect(crossCampaign).toEqual({ ok: false, error: expect.objectContaining({ code: "bad_request" }) });

    // Outsiders create nothing.
    const outsider = await inPlacementTxn((client) =>
      h.placement.createInCampaign(client, ctxFor(h.users.outsider), {
        campaignId,
        expectedCampaignRevision: 3,
        membershipGeneration: 1,
        idempotencyKey: randomUUID(),
        name: "Outsider sheet",
        entityDefinitionId: "character",
        prepared: prepared.value,
      }),
    );
    expect(outsider).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });
  });

  it("enforces a shared operator override for maxAttachedCharacters on the placement path", async () => {
    const limited = await buildI6Harness({
      limits: { ...DEFAULT_CAMPAIGN_LIMITS, maxAttachedCharacters: 1 },
    });
    try {
      await limited.pool.query(`UPDATE systems SET access = 'public'`);
      const created = await limited.campaigns.create(ctxFor(limited.users.gm), {
        systemVersionId: limited.versionId,
        title: `Limited ${randomUUID()}`,
        description: "",
        idempotencyKey: randomUUID(),
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const campaignId = created.value.campaignId;
      const prepared = await prepareCampaignCharacter(limited.runtime, {
        systemVersionId: limited.versionId,
        entityDefinitionId: "character",
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      const first = await limited.campaigns.createCampaignCharacter(ctxFor(limited.users.gm), {
        campaignId,
        expectedCampaignRevision: 1,
        idempotencyKey: randomUUID(),
        name: "First sheet",
        entityDefinitionId: "character",
        prepared: prepared.value,
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      // The tiny operator limit — not the 200 default — rejects the second
      // sheet through the module-owned placement transaction.
      const second = await limited.campaigns.createCampaignCharacter(ctxFor(limited.users.gm), {
        campaignId,
        expectedCampaignRevision: 2,
        idempotencyKey: randomUUID(),
        name: "Second sheet",
        entityDefinitionId: "character",
        prepared: prepared.value,
      });
      expect(second).toEqual({ ok: false, error: expect.objectContaining({ code: "bad_request" }) });
    } finally {
      await limited.close();
    }
  });

  it("assigns shared controllers, designates claimants and guards the return owner", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);
    await seedMember(campaignId, h.users.other.actorId);
    const standalone = await createStandalone("player");
    const adopted = await adopt(campaignId, standalone.characterId, "player");
    expect(adopted.ok).toBe(true);
    if (!adopted.ok) return;

    // Shared controllers, with a claim designation alongside.
    const assigned = await inPlacementTxn((client) =>
      h.placement.assign(client, ctxFor(h.users.gm), {
        campaignId,
        expectedCampaignRevision: 2,
        membershipGeneration: 1,
        characterId: standalone.characterId,
        expectedCharacterRevision: 2,
        controllerUserIds: [h.users.player.actorId, h.users.other.actorId],
        idempotencyKey: randomUUID(),
      }),
    );
    expect(assigned.ok).toBe(true);
    if (!assigned.ok) return;
    expect(assigned.value.controllers).toEqual([h.users.other.actorId, h.users.player.actorId].sort());
    expect(await controllersOf(standalone.characterId)).toEqual(
      [h.users.other.actorId, h.users.player.actorId].sort(),
    );

    // Assignment cannot drop the adoption return owner, even for a GM.
    const dropping = await inPlacementTxn((client) =>
      h.placement.assign(client, ctxFor(h.users.gm), {
        campaignId,
        expectedCampaignRevision: 3,
        membershipGeneration: 1,
        characterId: standalone.characterId,
        expectedCharacterRevision: 2,
        controllerUserIds: [h.users.other.actorId],
        idempotencyKey: randomUUID(),
      }),
    );
    expect(dropping).toEqual({ ok: false, error: expect.objectContaining({ code: "bad_request" }) });

    // Non-managers cannot replace controllers.
    const playerAssign = await inPlacementTxn((client) =>
      h.placement.assign(client, ctxFor(h.users.player), {
        campaignId,
        expectedCampaignRevision: 3,
        membershipGeneration: 1,
        characterId: standalone.characterId,
        expectedCharacterRevision: 2,
        controllerUserIds: [h.users.player.actorId],
        idempotencyKey: randomUUID(),
      }),
    );
    expect(playerAssign).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });

    // Stale character revisions conflict with the latest revision.
    const stale = await inPlacementTxn((client) =>
      h.placement.assign(client, ctxFor(h.users.gm), {
        campaignId,
        expectedCampaignRevision: 3,
        membershipGeneration: 1,
        characterId: standalone.characterId,
        expectedCharacterRevision: 1,
        controllerUserIds: [h.users.player.actorId, h.users.other.actorId],
        idempotencyKey: randomUUID(),
      }),
    );
    expect(stale).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "conflict", latestRevision: 2 }),
    });
  });

  it("claims only by designation, exactly once under concurrency", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);
    await seedMember(campaignId, h.users.other.actorId);
    const prepared = await prepareCampaignCharacter(h.runtime, {
      systemVersionId: h.versionId,
      entityDefinitionId: "character",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const created = await inPlacementTxn((client) =>
      h.placement.createInCampaign(client, ctxFor(h.users.gm), {
        campaignId,
        expectedCampaignRevision: 1,
        membershipGeneration: 1,
        idempotencyKey: randomUUID(),
        name: "Claimable",
        entityDefinitionId: "character",
        prepared: prepared.value,
      }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const characterId = created.value.characterId;

    // Without a designation, even an active member cannot claim.
    const undesignated = await inPlacementTxn((client) =>
      h.placement.claim(client, ctxFor(h.users.player), {
        campaignId,
        expectedCampaignRevision: 2,
        membershipGeneration: 1,
        characterId,
        expectedCharacterRevision: 1,
        idempotencyKey: randomUUID(),
      }),
    );
    expect(undesignated).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });

    const designated = await inPlacementTxn((client) =>
      h.placement.assign(client, ctxFor(h.users.gm), {
        campaignId,
        expectedCampaignRevision: 2,
        membershipGeneration: 1,
        characterId,
        expectedCharacterRevision: 1,
        controllerUserIds: [],
        designateClaimants: [h.users.player.actorId],
        idempotencyKey: randomUUID(),
      }),
    );
    expect(designated.ok).toBe(true);
    if (!designated.ok) return;

    const claimed = await inPlacementTxn((client) =>
      h.placement.claim(client, ctxFor(h.users.player), {
        campaignId,
        expectedCampaignRevision: 3,
        membershipGeneration: 1,
        characterId,
        expectedCharacterRevision: 1,
        idempotencyKey: randomUUID(),
      }),
    );
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    expect(claimed.value.controllers).toEqual([h.users.player.actorId]);
    expect(
      await count("character_claim_designations", "character_id = $1", [characterId]),
    ).toBe(0);

    // The designation is consumed: a second claim finds nothing.
    const reclaimed = await inPlacementTxn((client) =>
      h.placement.claim(client, ctxFor(h.users.player), {
        campaignId,
        expectedCampaignRevision: 4,
        membershipGeneration: 1,
        characterId,
        expectedCharacterRevision: 1,
        idempotencyKey: randomUUID(),
      }),
    );
    expect(reclaimed).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });

    // Concurrent claims for one fresh designation: exactly one wins.
    const redesignated = await inPlacementTxn((client) =>
      h.placement.assign(client, ctxFor(h.users.gm), {
        campaignId,
        expectedCampaignRevision: 4,
        membershipGeneration: 1,
        characterId,
        expectedCharacterRevision: 1,
        controllerUserIds: [],
        designateClaimants: [h.users.other.actorId],
        idempotencyKey: randomUUID(),
      }),
    );
    expect(redesignated.ok).toBe(true);
    if (!redesignated.ok) return;
    const raceRevision = await campaignRevision(campaignId);
    const racers = await Promise.all([
      inPlacementTxn((client) =>
        h.placement.claim(client, ctxFor(h.users.other), {
          campaignId,
          expectedCampaignRevision: raceRevision,
          membershipGeneration: 1,
          characterId,
          expectedCharacterRevision: 1,
          idempotencyKey: randomUUID(),
        }),
      ),
      inPlacementTxn((client) =>
        h.placement.claim(client, ctxFor(h.users.other), {
          campaignId,
          expectedCampaignRevision: raceRevision,
          membershipGeneration: 1,
          characterId,
          expectedCharacterRevision: 1,
          idempotencyKey: randomUUID(),
        }),
      ),
    ]);
    expect(racers.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(racers.filter((outcome) => !outcome.ok)).toHaveLength(1);
    expect(await controllersOf(characterId)).toEqual([h.users.other.actorId]);
  });

  it("returns adopted sheets atomically on member removal while campaign sheets stay", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);
    await seedMember(campaignId, h.users.other.actorId);

    const adoptedSheet = await createStandalone("player");
    const adopted = await adopt(campaignId, adoptedSheet.characterId, "player");
    expect(adopted.ok).toBe(true);
    if (!adopted.ok) return;
    const adoptedState = adopted.value.state;

    const prepared = await prepareCampaignCharacter(h.runtime, {
      systemVersionId: h.versionId,
      entityDefinitionId: "character",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const campMade = await inPlacementTxn((client) =>
      h.placement.createInCampaign(client, ctxFor(h.users.gm), {
        campaignId,
        expectedCampaignRevision: 2,
        membershipGeneration: 1,
        idempotencyKey: randomUUID(),
        name: "Party sheet",
        entityDefinitionId: "character",
        prepared: prepared.value,
        controllerUserIds: [h.users.player.actorId, h.users.other.actorId],
      }),
    );
    expect(campMade.ok).toBe(true);
    if (!campMade.ok) return;
    const campState = campMade.value.state;

    const revisionBefore = await campaignRevision(campaignId);
    const removed = await h.campaigns.removeMember(ctxFor(h.users.gm), {
      campaignId,
      userId: h.users.player.actorId,
      expectedCampaignRevision: revisionBefore,
      idempotencyKey: randomUUID(),
    });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    // The removal bumps the campaign exactly once; the return adds no extra bump.
    expect(await campaignRevision(campaignId)).toBe(revisionBefore + 1);

    // Adopted sheet: current state restored to the original owner, detached,
    // revision/generation advanced, history closed but not relabelled.
    const returned = await characterRow(adoptedSheet.characterId);
    expect(returned).toMatchObject({
      owner_id: h.users.player.actorId,
      campaign_id: null,
      placement_generation: 3,
      return_owner_id: null,
      revision: 3,
      lifecycle: "active",
    });
    expect(returned?.state_json).toEqual(adoptedState);
    expect(await controllersOf(adoptedSheet.characterId)).toEqual([]);
    const placements = await h.pool.query(
      `SELECT generation, campaign_id, return_owner_id, ended_at
         FROM character_placements WHERE character_id = $1 ORDER BY generation`,
      [adoptedSheet.characterId],
    );
    expect(placements.rows).toHaveLength(1);
    expect(placements.rows[0]).toMatchObject({
      generation: 2,
      campaign_id: campaignId,
      return_owner_id: h.users.player.actorId,
    });
    expect(placements.rows[0]?.ended_at).not.toBeNull();
    const history = await h.pool.query(
      `SELECT kind, scope_campaign_id FROM character_activity_events WHERE character_id = $1 ORDER BY occurred_at, id`,
      [adoptedSheet.characterId],
    );
    expect(history.rows.map((row) => row.kind)).toEqual([
      "character_created",
      "character_adopted",
      "character_returned",
    ]);
    expect(history.rows.map((row) => row.scope_campaign_id)).toEqual([null, campaignId, campaignId]);

    // The return owner reads their sheet standalone again; the departed
    // controller cannot.
    const reopened = await h.characters.open(ctxFor(h.users.player), adoptedSheet.characterId);
    expect(reopened.ok).toBe(true);
    const formerController = await h.characters.open(ctxFor(h.users.other), adoptedSheet.characterId);
    expect(formerController.ok).toBe(false);

    // Campaign-created sheet: stays with current state, minus the departed controller.
    const stayed = await characterRow(campMade.value.characterId);
    expect(stayed).toMatchObject({
      owner_id: null,
      campaign_id: campaignId,
      placement_generation: 1,
      return_owner_id: null,
      revision: 1,
    });
    expect(stayed?.state_json).toEqual(campState);
    expect(await controllersOf(campMade.value.characterId)).toEqual([h.users.other.actorId]);

    // Exact replay of the removal: same acknowledgement, no double return.
    const removalKey = randomUUID();
    const firstLeave = await h.campaigns.removeMember(ctxFor(h.users.other), {
      campaignId,
      userId: h.users.other.actorId,
      expectedCampaignRevision: revisionBefore + 1,
      idempotencyKey: removalKey,
    });
    expect(firstLeave.ok).toBe(true);
    const revAfterLeave = await campaignRevision(campaignId);
    // Exact replay reuses the identical input (including the original
    // expected revision): same acknowledgement, no second application.
    const replayedLeave = await h.campaigns.removeMember(ctxFor(h.users.other), {
      campaignId,
      userId: h.users.other.actorId,
      expectedCampaignRevision: revisionBefore + 1,
      idempotencyKey: removalKey,
    });
    expect(replayedLeave).toEqual(firstLeave);
    expect(await campaignRevision(campaignId)).toBe(revAfterLeave);
    expect(await controllersOf(campMade.value.characterId)).toEqual([]);
  });

  it("rolls the whole removal back when a return fails mid-departure", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);
    const first = await createStandalone("player");
    const second = await createStandalone("player");
    expect((await adopt(campaignId, first.characterId, "player")).ok).toBe(true);
    expect((await adopt(campaignId, second.characterId, "player")).ok).toBe(true);
    const revisionBefore = await campaignRevision(campaignId);

    let returns = 0;
    const failingPlacement = createCampaignPlacement({
      pool: h.pool,
      runtime: h.runtime,
      hooks: {
        afterSingleReturn: async () => {
          returns += 1;
          throw new Error("injected return failure");
        },
      },
    });
    const failingCampaigns = createCampaignsModule({
      pool: h.pool,
      limits: DEFAULT_CAMPAIGN_LIMITS,
      charactersPlacement: failingPlacement,
    });
    const doomedKey = randomUUID();
    const failed = await failingCampaigns.removeMember(ctxFor(h.users.gm), {
      campaignId,
      userId: h.users.player.actorId,
      expectedCampaignRevision: revisionBefore,
      idempotencyKey: doomedKey,
    });
    expect(failed).toEqual({ ok: false, error: expect.objectContaining({ code: "internal" }) });
    // The failure fired after the first of two returns, and everything rolled back.
    expect(returns).toBe(1);
    const membership = await h.pool.query(
      `SELECT status, generation FROM campaign_members WHERE campaign_id = $1 AND user_id = $2`,
      [campaignId, h.users.player.actorId],
    );
    expect(membership.rows[0]).toMatchObject({ status: "active", generation: 1 });
    expect((await characterRow(first.characterId))?.campaign_id).toBe(campaignId);
    expect((await characterRow(second.characterId))?.campaign_id).toBe(campaignId);
    expect(await campaignRevision(campaignId)).toBe(revisionBefore);
    expect(
      await count("campaign_audit_records", "campaign_id = $1 AND kind = $2", [campaignId, "campaign_member_removed"]),
    ).toBe(0);
    expect(
      await count(
        "campaign_command_executions",
        "actor_id = $1 AND command_kind = $2 AND idempotency_key = $3",
        [h.users.gm.actorId, "campaign_remove_member", doomedKey],
      ),
    ).toBe(0);

    // Without the injected failure the same departure commits cleanly.
    const retried = await h.campaigns.removeMember(ctxFor(h.users.gm), {
      campaignId,
      userId: h.users.player.actorId,
      expectedCampaignRevision: revisionBefore,
      idempotencyKey: randomUUID(),
    });
    expect(retried.ok).toBe(true);
    expect((await characterRow(first.characterId))?.owner_id).toBe(h.users.player.actorId);
    expect((await characterRow(second.characterId))?.owner_id).toBe(h.users.player.actorId);
  });

  it("returns adopted sheets on archived departure and linearizes sheet writes with removal", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);
    await seedMember(campaignId, h.users.other.actorId);
    const sheet = await createStandalone("player");
    expect((await adopt(campaignId, sheet.characterId, "player")).ok).toBe(true);
    const archived = await h.campaigns.archive(ctxFor(h.users.gm), {
      campaignId,
      expectedCampaignRevision: 2,
      idempotencyKey: randomUUID(),
    });
    expect(archived.ok).toBe(true);

    const departed = await h.campaigns.removeMember(ctxFor(h.users.gm), {
      campaignId,
      userId: h.users.player.actorId,
      expectedCampaignRevision: 3,
      idempotencyKey: randomUUID(),
    });
    expect(departed.ok).toBe(true);
    expect((await characterRow(sheet.characterId))?.owner_id).toBe(h.users.player.actorId);

    // Live campaign: a sheet write races departure through the campaign lock.
    // Exactly one wins; the loser conflicts; the sheet always ends returned.
    const liveCampaign = await createCampaign();
    await seedMember(liveCampaign, h.users.player.actorId);
    const liveSheet = await createStandalone("player");
    expect((await adopt(liveCampaign, liveSheet.characterId, "player")).ok).toBe(true);
    const liveRevision = await campaignRevision(liveCampaign);
    const [removalOutcome, assignOutcome] = await Promise.all([
      h.campaigns.removeMember(ctxFor(h.users.gm), {
        campaignId: liveCampaign,
        userId: h.users.player.actorId,
        expectedCampaignRevision: liveRevision,
        idempotencyKey: randomUUID(),
      }),
      inPlacementTxn((client) =>
        h.placement.assign(client, ctxFor(h.users.gm), {
          campaignId: liveCampaign,
          expectedCampaignRevision: liveRevision,
          membershipGeneration: 1,
          characterId: liveSheet.characterId,
          expectedCharacterRevision: 2,
          controllerUserIds: [h.users.player.actorId],
          idempotencyKey: randomUUID(),
        }),
      ),
    ]);
    const winners = [removalOutcome, assignOutcome].filter((outcome) => outcome.ok);
    expect(winners).toHaveLength(1);
    if (!removalOutcome.ok) {
      const retried = await h.campaigns.removeMember(ctxFor(h.users.gm), {
        campaignId: liveCampaign,
        userId: h.users.player.actorId,
        expectedCampaignRevision: await campaignRevision(liveCampaign),
        idempotencyKey: randomUUID(),
      });
      expect(retried.ok).toBe(true);
    }
    const final = await characterRow(liveSheet.characterId);
    expect(final).toMatchObject({ owner_id: h.users.player.actorId, campaign_id: null, revision: 3 });
  });

  it("preserves the return-owner controller across role promotion and denies stale writes after return", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);
    const sheet = await createStandalone("player");
    expect((await adopt(campaignId, sheet.characterId, "player")).ok).toBe(true);

    const promoted = await h.campaigns.changeRole(ctxFor(h.users.gm), {
      campaignId,
      userId: h.users.player.actorId,
      role: "co_gm",
      expectedCampaignRevision: 2,
      idempotencyKey: randomUUID(),
    });
    expect(promoted.ok).toBe(true);
    expect(await controllersOf(sheet.characterId)).toEqual([h.users.player.actorId]);

    const removed = await h.campaigns.removeMember(ctxFor(h.users.gm), {
      campaignId,
      userId: h.users.player.actorId,
      expectedCampaignRevision: 3,
      idempotencyKey: randomUUID(),
    });
    expect(removed.ok).toBe(true);
    expect((await characterRow(sheet.characterId))?.owner_id).toBe(h.users.player.actorId);

    // Queued against the attachment: the pre-return revision now conflicts.
    const staleWrite = await h.characters.manage(ctxFor(h.users.player), {
      kind: "rename",
      characterId: sheet.characterId,
      name: "Stale rename",
      expectedRevision: 2,
      idempotencyKey: randomUUID(),
    });
    expect(staleWrite).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "conflict", latestRevision: 3 }),
    });
    const freshWrite = await h.characters.manage(ctxFor(h.users.player), {
      kind: "rename",
      characterId: sheet.characterId,
      name: "Returned rename",
      expectedRevision: 3,
      idempotencyKey: randomUUID(),
    });
    expect(freshWrite.ok).toBe(true);
  });

  it("composes campaign capabilities into standalone paths on attached sheets (Task 5)", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);
    const sheet = await createStandalone("player");
    expect((await adopt(campaignId, sheet.characterId, "player")).ok).toBe(true);
    const player = ctxFor(h.users.player);
    const gm = ctxFor(h.users.gm);

    // I6 Task 5: the return-owner controller and the campaign GM read the
    // attached sheet through the same entry points, with campaign custody
    // instead of an invented owner.
    for (const ctx of [player, gm]) {
      const opened = await h.characters.open(ctx, sheet.characterId);
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      expect(opened.value).toMatchObject({
        ownerId: null,
        campaignId,
        controllers: [h.users.player.actorId],
        returnOwnerId: h.users.player.actorId,
      });
    }
    const edited = await h.characters.apply(player, {
      kind: "setField",
      characterId: sheet.characterId,
      fieldId: "ability",
      value: 10,
      expectedRevision: 2,
      idempotencyKey: randomUUID(),
    });
    expect(edited.ok).toBe(true);
    // Transfer/duplicate out of the campaign stay denied for both roles.
    expect(
      await h.characters.manage(player, {
        kind: "transferOwnership",
        characterId: sheet.characterId,
        toUserId: h.users.other.actorId,
        expectedRevision: 3,
        idempotencyKey: randomUUID(),
      }),
    ).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });
    expect(
      await h.characters.duplicate(player, { characterId: sheet.characterId, idempotencyKey: randomUUID() }),
    ).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });
    // Exports project the current sheet only; activity hides pre-adoption
    // personal history while attached.
    const exported = await h.characters.exportCharacter(gm, { characterId: sheet.characterId });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.value.migrationLineage).toEqual([]);
    const activity = await h.characters.listActivity(player, {
      characterId: sheet.characterId,
      limit: 10,
      cursor: null,
    });
    expect(activity.ok).toBe(true);
    if (!activity.ok) return;
    expect(activity.value.events.map((event) => event.kind)).toContain("character_adopted");
    expect(
      await h.characters.previewMigration(player, { characterId: sheet.characterId, targetVersionId: h.versionId }),
    ).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });
    // The owner-scoped list never surfaces attached sheets either.
    const listed = await h.characters.list(player, { limit: 100, cursor: null });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.characters.find((entry) => entry.characterId === sheet.characterId)).toBeUndefined();
  });

  it("invalidates pre-attachment migration previews and denies attached migration and duplication", async () => {
    // A real second version on the campaign system, compiled like migration tests do.
    const versionId = randomUUID();
    const document = buildD20V2Document();
    const compiled = compileDocument(document, { systemId: h.systemId, versionId, semanticVersion: "2.0.0" });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    await h.pool.query(
      `INSERT INTO system_versions (id, system_id, semantic_version, checksum, package_json, lifecycle)
       VALUES ($1, $2, '2.0.0', $3, $4::jsonb, 'published')`,
      [versionId, h.systemId, compiled.value.integrity.checksum, JSON.stringify(compiled.value)],
    );

    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);
    const sheet = await createStandalone("player");
    const player = ctxFor(h.users.player);

    // Adopt first on the v1 pin, then prove attached migration denies: the
    // preview below is cut after attachment and must fail like the old one.
    expect((await adopt(campaignId, sheet.characterId, "player")).ok).toBe(true);
    const attachedPreview = await h.characters.previewMigration(player, {
      characterId: sheet.characterId,
      targetVersionId: versionId,
    });
    expect(attachedPreview).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });

    // A v2-pinned campaign accepts the migrated sheet; its rollback then denies.
    const v2Campaign = await h.campaigns.create(ctxFor(h.users.gm), {
      systemVersionId: versionId,
      title: `Placement v2 ${randomUUID()}`,
      description: "",
      idempotencyKey: randomUUID(),
    });
    expect(v2Campaign.ok).toBe(true);
    if (!v2Campaign.ok) return;
    const v2CampaignId = v2Campaign.value.campaignId;
    await seedMember(v2CampaignId, h.users.other.actorId);
    const v2Sheet = await createStandalone("other");
    const v2Preview = await h.characters.previewMigration(ctxFor(h.users.other), {
      characterId: v2Sheet.characterId,
      targetVersionId: versionId,
    });
    expect(v2Preview.ok).toBe(true);
    if (!v2Preview.ok) return;
    const v2Commit = await h.characters.commitMigration(ctxFor(h.users.other), {
      characterId: v2Sheet.characterId,
      previewId: v2Preview.value.previewId,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(v2Commit.ok).toBe(true);
    if (!v2Commit.ok) return;
    const migrationId = await migrationIdOf(v2Sheet.characterId, versionId);
    expect(migrationId).not.toBeNull();

    expect(
      (await adopt(v2CampaignId, v2Sheet.characterId, "other", { expectedCharacterRevision: 2 })).ok,
    ).toBe(true);

    // The committed-then-attached migration cannot roll back: attached rollback denies.
    const rolledBack = await h.characters.rollbackMigration(ctxFor(h.users.other), {
      characterId: v2Sheet.characterId,
      migrationId: migrationId as string,
      idempotencyKey: randomUUID(),
    });
    expect(rolledBack).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });

    // A preview cut before attachment cannot commit after it.
    const previewBeforeAttach = await (async () => {
      const other = await createStandalone("other");
      const otherCampaign = await createCampaign();
      await seedMember(otherCampaign, h.users.other.actorId);
      const previewed = await h.characters.previewMigration(ctxFor(h.users.other), {
        characterId: other.characterId,
        targetVersionId: versionId,
      });
      expect(previewed.ok).toBe(true);
      if (!previewed.ok) throw new Error("preview failed");
      expect((await adopt(otherCampaign, other.characterId, "other")).ok).toBe(true);
      return h.characters.commitMigration(ctxFor(h.users.other), {
        characterId: other.characterId,
        previewId: previewed.value.previewId,
        expectedRevision: 2,
        idempotencyKey: randomUUID(),
      });
    })();
    expect(previewBeforeAttach).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });
  });

  it("denies stored duplicate replays once the copy is adopted", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);
    const sheet = await createStandalone("player");
    const key = randomUUID();
    const duplicated = await h.characters.duplicate(ctxFor(h.users.player), {
      characterId: sheet.characterId,
      idempotencyKey: key,
    });
    expect(duplicated.ok).toBe(true);
    if (!duplicated.ok) return;
    expect((await adopt(campaignId, duplicated.value.characterId, "player")).ok).toBe(true);

    const replayed = await h.characters.duplicate(ctxFor(h.users.player), {
      characterId: sheet.characterId,
      idempotencyKey: key,
    });
    expect(replayed).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });
    // The adoption itself is untouched by the denied replay.
    expect((await characterRow(duplicated.value.characterId))?.campaign_id).toBe(campaignId);
  });

  it("denies an in-transaction completed receipt once the sheet is adopted", async () => {
    // The gate starts open for setup and closes only around the racing call.
    let gate: Promise<void> = Promise.resolve();
    let releaseGate: () => void = () => {};
    const closeGate = () => {
      gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
    };
    const gatedHarness = await buildI6Harness({
      wrapRuntime: (runtime) => ({
        ...runtime,
        resolve: (async (...args: Parameters<typeof runtime.resolve>) => {
          await gate;
          return runtime.resolve(...args);
        }) as typeof runtime.resolve,
      }),
    });
    try {
      await gatedHarness.pool.query(`UPDATE systems SET access = 'public'`);
      const player = ctxFor(gatedHarness.users.player);
      const created = await gatedHarness.characters.create(player, {
        systemVersionId: gatedHarness.versionId,
        entityDefinitionId: "character",
        name: "Raced sheet",
        idempotencyKey: randomUUID(),
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const characterId = created.value.characterId;

      closeGate();
      const renameKey = randomUUID();
      const racing = gatedHarness.characters.manage(player, {
        kind: "rename",
        characterId,
        name: "Raced rename",
        expectedRevision: 1,
        idempotencyKey: renameKey,
      });
      // Wait for the claim to land, proving the call is stalled in Runtime.
      let executionId: string | null = null;
      for (let attempt = 0; attempt < 200 && executionId === null; attempt += 1) {
        const rows = await gatedHarness.pool.query<{ execution_id: string }>(
          `SELECT execution_id FROM character_command_executions
            WHERE actor_id = $1 AND command_kind = 'character_rename' AND idempotency_key = $2`,
          [gatedHarness.users.player.actorId, renameKey],
        );
        executionId = rows.rows[0]?.execution_id ?? null;
        if (executionId === null) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(executionId).not.toBeNull();

      // Adopt mid-flight, then mark the stalled execution completed: when the
      // gate opens, the transaction observes already_completed on an attached
      // sheet and must deny instead of replaying the crafted bytes.
      const createdCampaign = await gatedHarness.campaigns.create(ctxFor(gatedHarness.users.gm), {
        systemVersionId: gatedHarness.versionId,
        title: "Race campaign",
        description: "",
        idempotencyKey: randomUUID(),
      });
      expect(createdCampaign.ok).toBe(true);
      if (!createdCampaign.ok) return;
      const raceCampaignId = createdCampaign.value.campaignId;
      await gatedHarness.pool.query(
        `INSERT INTO campaign_members (campaign_id, user_id, role, status, generation)
         VALUES ($1, $2, 'player', 'active', 1)`,
        [raceCampaignId, gatedHarness.users.player.actorId],
      );
      const adopted = await (async () => {
        const client = await gatedHarness.pool.connect();
        try {
          await client.query("BEGIN");
          const outcome = await gatedHarness.placement.adopt(client, player, {
            campaignId: raceCampaignId,
            expectedCampaignRevision: 1,
            membershipGeneration: 1,
            characterId,
            expectedCharacterRevision: 1,
            acknowledgedDisclosure: true,
            idempotencyKey: randomUUID(),
          });
          await client.query(outcome.ok ? "COMMIT" : "ROLLBACK");
          return outcome;
        } finally {
          client.release();
        }
      })();
      expect(adopted.ok).toBe(true);
      await gatedHarness.pool.query(
        `UPDATE character_command_executions
            SET status = 'completed',
                result_json = '{"ok":false,"error":{"code":"bad_request","message":"crafted"}}'::jsonb
          WHERE execution_id = $1`,
        [executionId],
      );
      const activityBefore = await gatedHarness.pool.query(
        `SELECT COUNT(*)::int AS count FROM character_activity_events WHERE character_id = $1`,
        [characterId],
      );

      releaseGate();
      const outcome = await racing;
      expect(outcome).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });
      // The stalled call wrote nothing: still attached at the adoption revision.
      const row = await gatedHarness.pool.query(
        `SELECT campaign_id, revision FROM characters WHERE id = $1`,
        [characterId],
      );
      expect(row.rows[0]).toMatchObject({ campaign_id: raceCampaignId, revision: 2 });
      const activityAfter = await gatedHarness.pool.query(
        `SELECT COUNT(*)::int AS count FROM character_activity_events WHERE character_id = $1`,
        [characterId],
      );
      expect(activityAfter.rows[0].count).toBe(activityBefore.rows[0].count);
    } finally {
      await gatedHarness.close();
    }
  }, 120_000);

  it("claims executions on a caller-owned client with shared claim semantics", async () => {
    const client = await h.pool.connect();
    try {
      await client.query("BEGIN");
      const first = await claimExecutionOnClient(client, {
        actorId: h.users.player.actorId,
        commandKind: "placement_probe",
        idempotencyKey: randomUUID(),
        inputHash: "hash-a",
        newExecutionId: randomUUID,
        now: new Date(),
        leaseMs: 60_000,
        replayTtlMs: 30 * 86_400_000,
      });
      expect(first.status).toBe("claimed");
      const key = randomUUID();
      const claimed = await claimExecutionOnClient(client, {
        actorId: h.users.player.actorId,
        commandKind: "placement_probe",
        idempotencyKey: key,
        inputHash: "hash-b",
        newExecutionId: randomUUID,
        now: new Date(),
        leaseMs: 60_000,
        replayTtlMs: 30 * 86_400_000,
      });
      expect(claimed.status).toBe("claimed");
      const overlapping = await claimExecutionOnClient(client, {
        actorId: h.users.player.actorId,
        commandKind: "placement_probe",
        idempotencyKey: key,
        inputHash: "hash-b",
        newExecutionId: randomUUID,
        now: new Date(),
        leaseMs: 60_000,
        replayTtlMs: 30 * 86_400_000,
      });
      expect(overlapping.status).toBe("in_progress");
      const mismatched = await claimExecutionOnClient(client, {
        actorId: h.users.player.actorId,
        commandKind: "placement_probe",
        idempotencyKey: key,
        inputHash: "hash-other",
        newExecutionId: randomUUID,
        now: new Date(),
        leaseMs: 60_000,
        replayTtlMs: 30 * 86_400_000,
      });
      expect(mismatched.status).toBe("mismatch");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  async function migrationIdOf(characterId: string, targetVersionId: string): Promise<string | null> {
    const rows = await h.pool.query<{ id: string }>(
      `SELECT id FROM character_migrations WHERE character_id = $1 AND target_version_id = $2`,
      [characterId, targetVersionId],
    );
    return rows.rows[0]?.id ?? null;
  }
});
