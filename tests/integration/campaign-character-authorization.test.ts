import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compileDocument } from "../../src/systems/implementation/rules/compile-document.js";
import { prepareCampaignCharacter } from "../../src/characters/campaignPlacement.js";
import { buildI6Harness, ctxFor, type I6Harness, type TestActor } from "./i6-app.js";
import { buildD20V2Document } from "./i3-app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;

describeWithDatabase("campaign character authorization matrix (Task 5)", () => {
  let h: I6Harness;
  let unassigned: TestActor;
  let removed: TestActor;

  beforeAll(async () => {
    h = await buildI6Harness();
    // The fixture versions are private by default; matrix tests need the
    // campaign version usable by every member, like a shared table version.
    await h.pool.query(`UPDATE systems SET access = 'public'`);
    // The deterministic dev adapter only provisions four users; the matrix
    // needs six actors, so the extra two are plain SQL users. Module tests
    // address actors by ID, so no session cookies are required.
    for (const [name, slot] of [["Erin", "unassigned"], ["Finn", "removed"]] as const) {
      const rows = await h.pool.query<{ id: string }>(
        `INSERT INTO users (display_name) VALUES ($1) RETURNING id`,
        [name],
      );
      const actorId = rows.rows[0]?.id;
      if (actorId === undefined) throw new Error("user insert failed");
      if (slot === "unassigned") unassigned = { actorId, cookie: "" };
      else removed = { actorId, cookie: "" };
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

  async function activityKinds(characterId: string): Promise<Array<{ kind: string; scope: string | null }>> {
    const rows = await h.pool.query<{ kind: string; scope_campaign_id: string | null }>(
      `SELECT kind, scope_campaign_id FROM character_activity_events WHERE character_id = $1 ORDER BY occurred_at, id`,
      [characterId],
    );
    return rows.rows.map((row) => ({ kind: row.kind, scope: row.scope_campaign_id }));
  }

  type Setup = {
    campaignId: string;
    adoptedId: string;
    campaignCharId: string;
    uncontrolledId: string;
    standaloneId: string;
  };

  /**
   * Fresh campaign per test: gm owns, other is promoted to co-GM, player
   * controls the adopted + campaign-created sheets, erin is an active
   * player without control, finn is removed, outsider never joins.
   */
  async function setup(): Promise<Setup> {
    const created = await h.campaigns.create(ctxFor(h.users.gm), {
      systemVersionId: h.versionId,
      title: `Matrix ${randomUUID()}`,
      description: "",
      idempotencyKey: randomUUID(),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("campaign create failed");
    const campaignId = created.value.campaignId;

    await seedMember(campaignId, h.users.other.actorId);
    await seedMember(campaignId, h.users.player.actorId);
    await seedMember(campaignId, unassigned.actorId);
    await seedMember(campaignId, removed.actorId);
    const promoted = await h.campaigns.changeRole(ctxFor(h.users.gm), {
      campaignId,
      userId: h.users.other.actorId,
      role: "co_gm",
      expectedCampaignRevision: await campaignRevision(campaignId),
      idempotencyKey: randomUUID(),
    });
    expect(promoted.ok).toBe(true);
    const departed = await h.campaigns.removeMember(ctxFor(h.users.gm), {
      campaignId,
      userId: removed.actorId,
      expectedCampaignRevision: await campaignRevision(campaignId),
      idempotencyKey: randomUUID(),
    });
    expect(departed.ok).toBe(true);

    // Adopted sheet: player's standalone character, exact version pin.
    const personal = await h.characters.create(ctxFor(h.users.player), {
      systemVersionId: h.versionId,
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

    // Campaign-created sheet controlled by player.
    const prepared = await prepareCampaignCharacter(h.runtime, {
      systemVersionId: h.versionId,
      entityDefinitionId: "character",
    });
    if (!prepared.ok) throw new Error("prepare failed");
    const gmGen = await memberGeneration(campaignId, h.users.gm.actorId);
    const createdSheet = await inPlacementTxn(async (client) =>
      h.placement.createInCampaign(client, ctxFor(h.users.gm), {
        campaignId,
        expectedCampaignRevision: await campaignRevision(campaignId),
        membershipGeneration: gmGen,
        idempotencyKey: randomUUID(),
        name: `Campaign sheet ${randomUUID().slice(0, 8)}`,
        entityDefinitionId: "character",
        prepared: prepared.value,
        controllerUserIds: [h.users.player.actorId],
      }),
    );
    expect(createdSheet.ok).toBe(true);
    if (!createdSheet.ok) throw new Error("createInCampaign failed");

    // Campaign-created sheet controlled by erin (player must not see it).
    const uncontrolled = await inPlacementTxn(async (client) =>
      h.placement.createInCampaign(client, ctxFor(h.users.gm), {
        campaignId,
        expectedCampaignRevision: await campaignRevision(campaignId),
        membershipGeneration: await memberGeneration(campaignId, h.users.gm.actorId),
        idempotencyKey: randomUUID(),
        name: `Uncontrolled ${randomUUID().slice(0, 8)}`,
        entityDefinitionId: "character",
        prepared: prepared.value,
        controllerUserIds: [unassigned.actorId],
      }),
    );
    expect(uncontrolled.ok).toBe(true);
    if (!uncontrolled.ok) throw new Error("uncontrolled create failed");

    // Personal control sheet: erin's standalone character.
    const standalone = await h.characters.create(ctxFor(unassigned), {
      systemVersionId: h.versionId,
      entityDefinitionId: "character",
      name: `Personal ${randomUUID().slice(0, 8)}`,
      idempotencyKey: randomUUID(),
    });
    if (!standalone.ok) throw new Error("personal create failed");

    return {
      campaignId,
      adoptedId: personal.value.characterId,
      campaignCharId: createdSheet.value.characterId,
      uncontrolledId: uncontrolled.value.characterId,
      standaloneId: standalone.value.characterId,
    };
  }

  let v2Counter = 0;
  async function publishV2(): Promise<string> {
    v2Counter += 1;
    const versionId = randomUUID();
    const document = buildD20V2Document();
    const semanticVersion = `2.0.${v2Counter}`;
    const compiled = compileDocument(document, { systemId: h.systemId, versionId, semanticVersion });
    if (!compiled.ok) throw new Error(`v2 did not compile: ${JSON.stringify(compiled.diagnostics)}`);
    await h.pool.query(
      "INSERT INTO system_versions (id, system_id, semantic_version, checksum, package_json, lifecycle) VALUES ($1, $2, $3, $4, $5::jsonb, 'published')",
      [versionId, h.systemId, semanticVersion, compiled.value.integrity.checksum, JSON.stringify(compiled.value)],
    );
    return versionId;
  }

  async function setField(
    actor: TestActor,
    characterId: string,
    expectedRevision: number,
    value: number,
    key = randomUUID(),
  ) {
    return h.characters.apply(ctxFor(actor), {
      kind: "setField",
      characterId,
      fieldId: "ability",
      value,
      expectedRevision,
      idempotencyKey: key,
    });
  }

  // ------------------------------------------------------------------
  // open: direct URLs across the capability matrix
  // ------------------------------------------------------------------

  it("lets the campaign owner open every attached sheet with placement identity", async () => {
    const s = await setup();
    for (const characterId of [s.adoptedId, s.campaignCharId]) {
      const opened = await h.characters.open(ctxFor(h.users.gm), characterId);
      expect(opened.ok).toBe(true);
      if (!opened.ok) throw new Error("gm open failed");
      expect(opened.value.ownerId).toBeNull();
      expect(opened.value.campaignId).toBe(s.campaignId);
      expect(opened.value.placementGeneration).toBeGreaterThanOrEqual(1);
    }
    const adopted = await h.characters.open(ctxFor(h.users.gm), s.adoptedId);
    if (!adopted.ok) throw new Error("unreachable");
    expect(adopted.value.controllers).toEqual([h.users.player.actorId]);
    expect(adopted.value.returnOwnerId).toBe(h.users.player.actorId);
  });

  it("lets a co-GM open every attached sheet", async () => {
    const s = await setup();
    for (const characterId of [s.adoptedId, s.campaignCharId, s.uncontrolledId]) {
      const opened = await h.characters.open(ctxFor(h.users.other), characterId);
      expect(opened.ok).toBe(true);
    }
  });

  it("lets a controller open controlled sheets but not uncontrolled ones", async () => {
    const s = await setup();
    for (const characterId of [s.adoptedId, s.campaignCharId]) {
      const opened = await h.characters.open(ctxFor(h.users.player), characterId);
      expect(opened.ok).toBe(true);
      if (!opened.ok) throw new Error("unreachable");
      expect(opened.value.campaignId).toBe(s.campaignId);
    }
    const denied = await h.characters.open(ctxFor(h.users.player), s.uncontrolledId);
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("uncontrolled open must deny");
    expect(denied.error.code).toBe("not_found");
    expect(denied).not.toHaveProperty("value");
  });

  it("denies attached opens to unassigned players, removed members and outsiders", async () => {
    const s = await setup();
    for (const actor of [unassigned, removed, h.users.outsider]) {
      for (const characterId of [s.adoptedId, s.campaignCharId]) {
        const opened = await h.characters.open(ctxFor(actor), characterId);
        expect(opened.ok).toBe(false);
        if (opened.ok) throw new Error("attached open must deny");
        expect(opened.error.code).toBe("not_found");
        expect(opened).not.toHaveProperty("value");
      }
    }
  });

  it("lets an unassigned player open a sheet they control", async () => {
    const s = await setup();
    const opened = await h.characters.open(ctxFor(unassigned), s.uncontrolledId);
    expect(opened.ok).toBe(true);
  });

  // ------------------------------------------------------------------
  // apply: sheet edits across the matrix
  // ------------------------------------------------------------------

  it("lets the GM and controllers edit attached sheets", async () => {
    const s = await setup();
    const gmEdit = await setField(h.users.gm, s.adoptedId, 2, 14);
    expect(gmEdit.ok).toBe(true);
    if (!gmEdit.ok) throw new Error(`gm edit failed: ${JSON.stringify(gmEdit.error)}`);
    expect(gmEdit.value.character.revision).toBe(3);
    expect(gmEdit.value.character.campaignId).toBe(s.campaignId);

    const playerEdit = await setField(h.users.player, s.campaignCharId, 1, 12);
    expect(playerEdit.ok).toBe(true);
    const coGmEdit = await setField(h.users.other, s.uncontrolledId, 1, 11);
    expect(coGmEdit.ok).toBe(true);
    expect(await rollCount(s.adoptedId)).toBe(0);
  });

  it("lets controllers roll on controlled sheets with receipt stability", async () => {
    const s = await setup();
    const key = randomUUID();
    const first = await h.characters.apply(ctxFor(h.users.player), {
      kind: "executeAction",
      characterId: s.adoptedId,
      actionId: "check",
      inputs: { bonus: 2 },
      expectedRevision: 2,
      idempotencyKey: key,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(`roll failed: ${JSON.stringify(first.error)}`);
    expect(first.value.roll).not.toBeNull();

    const replay = await h.characters.apply(ctxFor(h.users.player), {
      kind: "executeAction",
      characterId: s.adoptedId,
      actionId: "check",
      inputs: { bonus: 2 },
      expectedRevision: 2,
      idempotencyKey: key,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error("unreachable");
    expect(replay.value.character.reconciliation.replayed).toBe(true);
    expect(replay.value.roll).toEqual(first.value.roll);
    expect(await rollCount(s.adoptedId)).toBe(1);
  });

  it("denies attached edits to unassigned players, removed members, outsiders and non-controllers", async () => {
    const s = await setup();
    const cases: Array<[TestActor, string]> = [
      [unassigned, s.adoptedId],
      [removed, s.adoptedId],
      [h.users.outsider, s.adoptedId],
      [h.users.player, s.uncontrolledId],
      [unassigned, s.campaignCharId],
    ];
    for (const [actor, characterId] of cases) {
      const edit = await setField(actor, characterId, 2, 14);
      expect(edit.ok).toBe(false);
      if (edit.ok) throw new Error("attached edit must deny");
      expect(edit.error.code).toBe("not_found");
      expect(edit).not.toHaveProperty("value");
    }
    expect(await rollCount(s.adoptedId)).toBe(0);
  });

  it("rejects attached edits while the campaign is archived but keeps reads and exports", async () => {
    const s = await setup();
    const archived = await h.campaigns.archive(ctxFor(h.users.gm), {
      campaignId: s.campaignId,
      expectedCampaignRevision: await campaignRevision(s.campaignId),
      idempotencyKey: randomUUID(),
    });
    expect(archived.ok).toBe(true);

    const edit = await setField(h.users.player, s.adoptedId, 2, 14);
    expect(edit.ok).toBe(false);
    if (edit.ok) throw new Error("archived-campaign edit must deny");
    expect(edit.error.code).toBe("conflict");

    const opened = await h.characters.open(ctxFor(h.users.player), s.adoptedId);
    expect(opened.ok).toBe(true);
    const exported = await h.characters.exportCharacter(ctxFor(h.users.player), { characterId: s.adoptedId });
    expect(exported.ok).toBe(true);
  });

  // ------------------------------------------------------------------
  // manage: rename / archive / recover / transfer
  // ------------------------------------------------------------------

  it("lets controllers and GMs rename attached sheets", async () => {
    const s = await setup();
    const renamed = await h.characters.manage(ctxFor(h.users.player), {
      kind: "rename",
      characterId: s.adoptedId,
      name: "Renamed hero",
      expectedRevision: 2,
      idempotencyKey: randomUUID(),
    });
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) throw new Error(`rename failed: ${JSON.stringify(renamed.error)}`);
    expect(renamed.value.character.name).toBe("Renamed hero");

    const gmRename = await h.characters.manage(ctxFor(h.users.gm), {
      kind: "rename",
      characterId: s.campaignCharId,
      name: "GM rename",
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(gmRename.ok).toBe(true);
  });

  it("restricts attached archive/recover to GMs", async () => {
    const s = await setup();
    const playerArchive = await h.characters.manage(ctxFor(h.users.player), {
      kind: "archive",
      characterId: s.adoptedId,
      expectedRevision: 2,
      idempotencyKey: randomUUID(),
    });
    expect(playerArchive.ok).toBe(false);
    if (playerArchive.ok) throw new Error("player archive must deny");

    const gmArchive = await h.characters.manage(ctxFor(h.users.gm), {
      kind: "archive",
      characterId: s.adoptedId,
      expectedRevision: 2,
      idempotencyKey: randomUUID(),
    });
    expect(gmArchive.ok).toBe(true);
    if (!gmArchive.ok) throw new Error("gm archive failed");
    expect(gmArchive.value.character.lifecycle).toBe("archived");

    const coGmRecover = await h.characters.manage(ctxFor(h.users.other), {
      kind: "recover",
      characterId: s.adoptedId,
      expectedRevision: 3,
      idempotencyKey: randomUUID(),
    });
    expect(coGmRecover.ok).toBe(true);
  });

  it("denies attached management to actors without a sheet capability", async () => {
    const s = await setup();
    const attempts = [
      { kind: "rename", name: "Nope" },
      { kind: "archive" },
      { kind: "transferOwnership", toUserId: h.users.gm.actorId },
    ] as const;
    for (const actor of [unassigned, removed, h.users.outsider]) {
      for (const attempt of attempts) {
        const result = await h.characters.manage(ctxFor(actor), {
          ...attempt,
          characterId: s.adoptedId,
          expectedRevision: 2,
          idempotencyKey: randomUUID(),
        } as never);
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("outsider manage must deny");
        expect(result.error.code).toBe("not_found");
        expect(result).not.toHaveProperty("value");
      }
    }
    // A non-controller member cannot rename even a sheet they can see listed nowhere.
    const denied = await h.characters.manage(ctxFor(unassigned), {
      kind: "rename",
      characterId: s.campaignCharId,
      name: "Nope",
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(denied.ok).toBe(false);
  });

  it("denies transfer out of the campaign for controllers and GMs", async () => {
    const s = await setup();
    for (const actor of [h.users.player, h.users.gm]) {
      const transferred = await h.characters.manage(ctxFor(actor), {
        kind: "transferOwnership",
        characterId: s.adoptedId,
        toUserId: unassigned.actorId,
        expectedRevision: 2,
        idempotencyKey: randomUUID(),
      });
      expect(transferred.ok).toBe(false);
      if (transferred.ok) throw new Error("attached transfer must deny");
      expect(transferred.error.code).toBe("not_found");
    }
    const row = await h.pool.query(`SELECT owner_id, campaign_id FROM characters WHERE id = $1`, [s.adoptedId]);
    expect(row.rows[0]).toMatchObject({ owner_id: null, campaign_id: s.campaignId });
  });

  // ------------------------------------------------------------------
  // list: personal library never leaks attached sheets
  // ------------------------------------------------------------------

  it("keeps attached sheets out of every personal library list", async () => {
    const s = await setup();
    for (const actor of [h.users.gm, h.users.other, h.users.player, unassigned]) {
      const listed = await h.characters.list(ctxFor(actor), { limit: 50, cursor: null });
      expect(listed.ok).toBe(true);
      if (!listed.ok) throw new Error("unreachable");
      const ids = listed.value.characters.map((entry) => entry.characterId);
      expect(ids).not.toContain(s.adoptedId);
      expect(ids).not.toContain(s.campaignCharId);
      expect(ids).not.toContain(s.uncontrolledId);
    }
    const personal = await h.characters.list(ctxFor(unassigned), { limit: 50, cursor: null });
    if (!personal.ok) throw new Error("unreachable");
    expect(personal.value.characters.map((entry) => entry.characterId)).toContain(s.standaloneId);
  });

  // ------------------------------------------------------------------
  // listActivity: history scoping
  // ------------------------------------------------------------------

  it("hides pre-adoption personal history from attached readers", async () => {
    const s = await setup();
    // Pre-adoption personal events exist (create + field set before adopt).
    const kinds = await activityKinds(s.adoptedId);
    expect(kinds.some((entry) => entry.scope === null)).toBe(true);

    const page = await h.characters.listActivity(ctxFor(h.users.player), {
      characterId: s.adoptedId,
      limit: 50,
      cursor: null,
    });
    expect(page.ok).toBe(true);
    if (!page.ok) throw new Error("unreachable");
    const visible = page.value.events.map((event) => event.kind);
    expect(visible).toContain("character_adopted");
    expect(visible).not.toContain("character_created");
    expect(visible).not.toContain("character_field_set");
  });

  it("restores pre-adoption history after return while hiding campaign history", async () => {
    const s = await setup();
    const departed = await h.campaigns.removeMember(ctxFor(h.users.gm), {
      campaignId: s.campaignId,
      userId: h.users.player.actorId,
      expectedCampaignRevision: await campaignRevision(s.campaignId),
      idempotencyKey: randomUUID(),
    });
    expect(departed.ok).toBe(true);

    const returned = await h.characters.open(ctxFor(h.users.player), s.adoptedId);
    expect(returned.ok).toBe(true);
    if (!returned.ok) throw new Error("unreachable");
    expect(returned.value.ownerId).toBe(h.users.player.actorId);
    expect(returned.value.campaignId).toBeNull();

    const page = await h.characters.listActivity(ctxFor(h.users.player), {
      characterId: s.adoptedId,
      limit: 50,
      cursor: null,
    });
    expect(page.ok).toBe(true);
    if (!page.ok) throw new Error("unreachable");
    const visible = page.value.events.map((event) => event.kind);
    expect(visible).toContain("character_created");
    expect(visible).not.toContain("character_adopted");
    expect(visible).not.toContain("character_returned");
  });

  it("denies attached activity to unassigned players, removed members and outsiders", async () => {
    const s = await setup();
    for (const actor of [unassigned, removed, h.users.outsider]) {
      const page = await h.characters.listActivity(ctxFor(actor), {
        characterId: s.adoptedId,
        limit: 10,
        cursor: null,
      });
      expect(page.ok).toBe(false);
      if (page.ok) throw new Error("attached activity must deny");
      expect(page.error.code).toBe("not_found");
    }
  });

  it("keeps campaign history inaccessible to departed actors", async () => {
    const s = await setup();
    // finn (removed) cannot read the still-attached sheet's campaign events.
    const page = await h.characters.listActivity(ctxFor(removed), {
      characterId: s.campaignCharId,
      limit: 10,
      cursor: null,
    });
    expect(page.ok).toBe(false);
  });

  // ------------------------------------------------------------------
  // exportCharacter
  // ------------------------------------------------------------------

  it("exports attached current state for GMs and controllers only", async () => {
    const s = await setup();
    for (const actor of [h.users.gm, h.users.other, h.users.player]) {
      const exported = await h.characters.exportCharacter(ctxFor(actor), { characterId: s.adoptedId });
      expect(exported.ok).toBe(true);
      if (!exported.ok) throw new Error(`export failed: ${JSON.stringify(exported.error)}`);
      expect(exported.value.migrationLineage).toEqual([]);
      expect(exported.value).not.toHaveProperty("ownerId");
      expect(exported.value).not.toHaveProperty("campaignId");
    }
    for (const actor of [unassigned, removed, h.users.outsider]) {
      const exported = await h.characters.exportCharacter(ctxFor(actor), { characterId: s.adoptedId });
      expect(exported.ok).toBe(false);
      if (exported.ok) throw new Error("attached export must deny");
      expect(exported.error.code).toBe("not_found");
    }
  });

  it("returns adopted state to the original owner on export without campaign lineage", async () => {
    const s = await setup();
    await setField(h.users.gm, s.adoptedId, 2, 14);
    await h.campaigns.removeMember(ctxFor(h.users.gm), {
      campaignId: s.campaignId,
      userId: h.users.player.actorId,
      expectedCampaignRevision: await campaignRevision(s.campaignId),
      idempotencyKey: randomUUID(),
    });
    const exported = await h.characters.exportCharacter(ctxFor(h.users.player), { characterId: s.adoptedId });
    expect(exported.ok).toBe(true);
    if (!exported.ok) throw new Error("unreachable");
    expect(exported.value.state.values).toMatchObject({ ability: 14 });
    expect(exported.value.migrationLineage).toEqual([]);
  });

  // ------------------------------------------------------------------
  // migration + duplicate denial while attached
  // ------------------------------------------------------------------

  it("denies attached migration preview, commit and rollback", async () => {
    const s = await setup();
    const targetVersionId = await publishV2();
    for (const actor of [h.users.player, h.users.gm]) {
      const preview = await h.characters.previewMigration(ctxFor(actor), {
        characterId: s.adoptedId,
        targetVersionId,
      });
      expect(preview.ok).toBe(false);
    }

    // A preview built before adoption cannot commit once attached.
    const personal = await h.characters.create(ctxFor(unassigned), {
      systemVersionId: h.versionId,
      entityDefinitionId: "character",
      name: `Migrate ${randomUUID().slice(0, 8)}`,
      idempotencyKey: randomUUID(),
    });
    if (!personal.ok) throw new Error("personal create failed");
    const preview = await h.characters.previewMigration(ctxFor(unassigned), {
      characterId: personal.value.characterId,
      targetVersionId,
      mappings: { ability: "ability_score" },
    });
    if (!preview.ok) throw new Error(`preview failed: ${JSON.stringify(preview.error)}`);
    await inPlacementTxn(async (client) =>
      h.placement.adopt(client, ctxFor(unassigned), {
        campaignId: s.campaignId,
        expectedCampaignRevision: await campaignRevision(s.campaignId),
        membershipGeneration: await memberGeneration(s.campaignId, unassigned.actorId),
        characterId: personal.value.characterId,
        expectedCharacterRevision: personal.value.revision,
        acknowledgedDisclosure: true,
        idempotencyKey: randomUUID(),
      }),
    );
    // A preview built before adoption cannot commit once attached. The
    // scope-first explicit gate denies before the owner-only lookup, so every
    // capable role (return owner, GM) gets the explicit attached-denial code.
    for (const actor of [unassigned, h.users.gm]) {
      const commit = await h.characters.commitMigration(ctxFor(actor), {
        characterId: personal.value.characterId,
        previewId: preview.value.previewId,
        expectedRevision: personal.value.revision,
        idempotencyKey: randomUUID(),
      });
      expect(commit.ok).toBe(false);
      if (commit.ok) throw new Error("attached commit must deny");
      expect(commit.error.code).toBe("not_found");
    }
    expect(await count("character_migrations", "character_id = $1", [personal.value.characterId])).toBe(0);
  });

  it("denies attached rollback", async () => {
    const targetVersionId = await publishV2();
    const personal = await h.characters.create(ctxFor(h.users.player), {
      systemVersionId: h.versionId,
      entityDefinitionId: "character",
      name: `Rollback ${randomUUID().slice(0, 8)}`,
      idempotencyKey: randomUUID(),
    });
    if (!personal.ok) throw new Error("personal create failed");
    const preview = await h.characters.previewMigration(ctxFor(h.users.player), {
      characterId: personal.value.characterId,
      targetVersionId,
      mappings: { ability: "ability_score" },
    });
    if (!preview.ok) throw new Error("preview failed");
    const commit = await h.characters.commitMigration(ctxFor(h.users.player), {
      characterId: personal.value.characterId,
      previewId: preview.value.previewId,
      expectedRevision: personal.value.revision,
      idempotencyKey: randomUUID(),
    });
    if (!commit.ok) throw new Error("commit failed");
    const migrationRows = await h.pool.query<{ id: string }>(
      `SELECT id FROM character_migrations WHERE character_id = $1`,
      [personal.value.characterId],
    );
    const migrationId = migrationRows.rows[0]?.id;
    if (migrationId === undefined) throw new Error("migration row missing");

    // Adopt into a campaign pinned to the migrated version (exact pin).
    const created = await h.campaigns.create(ctxFor(h.users.gm), {
      systemVersionId: targetVersionId,
      title: `Rollback campaign ${randomUUID()}`,
      description: "",
      idempotencyKey: randomUUID(),
    });
    if (!created.ok) throw new Error("campaign create failed");
    const campaignId = created.value.campaignId;
    await seedMember(campaignId, h.users.player.actorId);
    const adopted = await inPlacementTxn(async (client) =>
      h.placement.adopt(client, ctxFor(h.users.player), {
        campaignId,
        expectedCampaignRevision: await campaignRevision(campaignId),
        membershipGeneration: 1,
        characterId: personal.value.characterId,
        expectedCharacterRevision: commit.value.character.revision,
        acknowledgedDisclosure: true,
        idempotencyKey: randomUUID(),
      }),
    );
    expect(adopted.ok).toBe(true);

    // Attached rollback denies via the scope-first explicit gate for every
    // capable role (controller/return owner, GM), not via null-lookup failure.
    for (const actor of [h.users.player, h.users.gm]) {
      const rollback = await h.characters.rollbackMigration(ctxFor(actor), {
        characterId: personal.value.characterId,
        migrationId,
        idempotencyKey: randomUUID(),
      });
      expect(rollback.ok).toBe(false);
      if (rollback.ok) throw new Error("attached rollback must deny");
      expect(rollback.error.code).toBe("not_found");
    }
    const rolledBack = await h.pool.query<{ rolled_back_at: string | null }>(
      `SELECT rolled_back_at FROM character_migrations WHERE id = $1`,
      [migrationId],
    );
    expect(rolledBack.rows[0]?.rolled_back_at).toBeNull();
  });

  it("denies duplicating attached sheets into personal libraries", async () => {
    const s = await setup();
    for (const actor of [h.users.player, h.users.gm]) {
      const duplicated = await h.characters.duplicate(ctxFor(actor), {
        characterId: s.adoptedId,
        idempotencyKey: randomUUID(),
      });
      expect(duplicated.ok).toBe(false);
      if (duplicated.ok) throw new Error("attached duplicate must deny");
      expect(duplicated.error.code).toBe("not_found");
    }
    expect(await count("characters", "id <> $1 AND id <> $2 AND id <> $3 AND name LIKE 'Copy%'", [s.adoptedId, s.campaignCharId, s.uncontrolledId])).toBe(0);
  });

  // ------------------------------------------------------------------
  // replay: removal, rejoin, return, generations
  // ------------------------------------------------------------------

  it("denies campaign receipt replay after removal without a second execution", async () => {
    const s = await setup();
    const key = randomUUID();
    const first = await setField(h.users.player, s.adoptedId, 2, 14, key);
    expect(first.ok).toBe(true);
    expect(await rollCount(s.adoptedId)).toBe(0);

    await h.campaigns.removeMember(ctxFor(h.users.gm), {
      campaignId: s.campaignId,
      userId: h.users.player.actorId,
      expectedCampaignRevision: await campaignRevision(s.campaignId),
      idempotencyKey: randomUUID(),
    });

    const replay = await setField(h.users.player, s.adoptedId, 2, 14, key);
    expect(replay.ok).toBe(false);
    if (replay.ok) throw new Error("post-removal replay must deny");
    expect(replay.error.code).toBe("not_found");
    expect(replay).not.toHaveProperty("value");
    const executions = await count(
      "character_command_executions",
      "actor_id = $1 AND idempotency_key = $2 AND status = 'completed'",
      [h.users.player.actorId, key],
    );
    expect(executions).toBe(1);
  });

  it("returns result_unavailable on replay after rejoin without re-executing", async () => {
    // The receipt lives on a campaign-created sheet (adopted sheets return
    // on departure, which would deny rather than gate on generations). The
    // co-GM stays GM-capable across rejoin, so only the generation gate can
    // answer with result_unavailable.
    const s = await setup();
    const key = randomUUID();
    const first = await setField(h.users.other, s.campaignCharId, 1, 14, key);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(`setup edit failed: ${JSON.stringify(first.error)}`);

    await h.campaigns.removeMember(ctxFor(h.users.gm), {
      campaignId: s.campaignId,
      userId: h.users.other.actorId,
      expectedCampaignRevision: await campaignRevision(s.campaignId),
      idempotencyKey: randomUUID(),
    });
    // Rejoin lands on a new membership generation (invitations are Task 6;
    // direct SQL reactivation mirrors the Task 3 rejoin simulation).
    await h.pool.query(
      `UPDATE campaign_members SET status = 'active', generation = generation + 1
        WHERE campaign_id = $1 AND user_id = $2`,
      [s.campaignId, h.users.other.actorId],
    );

    const replay = await setField(h.users.other, s.campaignCharId, 1, 14, key);
    expect(replay.ok).toBe(false);
    if (replay.ok) throw new Error("post-rejoin replay must not disclose");
    expect(replay.error.code).toBe("result_unavailable");
    const executions = await count(
      "character_command_executions",
      "actor_id = $1 AND idempotency_key = $2 AND status = 'completed'",
      [h.users.other.actorId, key],
    );
    expect(executions).toBe(1);
    const reopened = await h.characters.open(ctxFor(h.users.other), s.campaignCharId);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) throw new Error("unreachable");
    expect(reopened.value.revision).toBe(2);
  });

  it("denies campaign-era receipts to the returned owner (no conversion to personal receipts)", async () => {
    const s = await setup();
    const key = randomUUID();
    const first = await setField(h.users.player, s.adoptedId, 2, 14, key);
    expect(first.ok).toBe(true);

    await h.campaigns.removeMember(ctxFor(h.users.gm), {
      campaignId: s.campaignId,
      userId: h.users.player.actorId,
      expectedCampaignRevision: await campaignRevision(s.campaignId),
      idempotencyKey: randomUUID(),
    });

    const returned = await h.characters.open(ctxFor(h.users.player), s.adoptedId);
    expect(returned.ok).toBe(true);
    if (!returned.ok) throw new Error("unreachable");
    expect(returned.value.ownerId).toBe(h.users.player.actorId);

    // The campaign-era receipt is inert once the sheet is standalone again:
    // same key and input replays nothing campaign-scoped.
    const replay = await h.characters.apply(ctxFor(h.users.player), {
      kind: "setField",
      characterId: s.adoptedId,
      fieldId: "ability",
      value: 14,
      expectedRevision: 2,
      idempotencyKey: key,
    });
    expect(replay.ok).toBe(false);
    if (replay.ok) throw new Error("campaign receipt must not convert to a personal receipt");
    expect(replay.error.code).toBe("not_found");
    expect(replay).not.toHaveProperty("value");
  });

  it("denies standalone receipts once the sheet is attached", async () => {
    const personal = await h.characters.create(ctxFor(h.users.player), {
      systemVersionId: h.versionId,
      entityDefinitionId: "character",
      name: `Pre-adopt ${randomUUID().slice(0, 8)}`,
      idempotencyKey: randomUUID(),
    });
    if (!personal.ok) throw new Error("create failed");
    const key = randomUUID();
    const first = await setField(h.users.player, personal.value.characterId, 1, 13, key);
    expect(first.ok).toBe(true);

    const created = await h.campaigns.create(ctxFor(h.users.gm), {
      systemVersionId: h.versionId,
      title: `Attach ${randomUUID()}`,
      description: "",
      idempotencyKey: randomUUID(),
    });
    if (!created.ok) throw new Error("campaign create failed");
    const campaignId = created.value.campaignId;
    await seedMember(campaignId, h.users.player.actorId);
    await inPlacementTxn(async (client) =>
      h.placement.adopt(client, ctxFor(h.users.player), {
        campaignId,
        expectedCampaignRevision: await campaignRevision(campaignId),
        membershipGeneration: 1,
        characterId: personal.value.characterId,
        expectedCharacterRevision: 2,
        acknowledgedDisclosure: true,
        idempotencyKey: randomUUID(),
      }),
    );

    const replay = await setField(h.users.player, personal.value.characterId, 1, 13, key);
    expect(replay.ok).toBe(false);
    if (replay.ok) throw new Error("standalone replay after adopt must deny");
    expect(replay.error.code).toBe("not_found");
  });

  it("returns result_unavailable when placement generation moved under a still-authorized actor", async () => {
    const s = await setup();
    const key = randomUUID();
    const first = await setField(h.users.player, s.adoptedId, 2, 14, key);
    expect(first.ok).toBe(true);

    // Departure returns the sheet (placement generation +1); rejoin and
    // re-adopt move it again. The first-attachment receipt must not replay
    // under the new generations even though the actor is a controller again.
    await h.campaigns.removeMember(ctxFor(h.users.gm), {
      campaignId: s.campaignId,
      userId: h.users.player.actorId,
      expectedCampaignRevision: await campaignRevision(s.campaignId),
      idempotencyKey: randomUUID(),
    });
    await h.pool.query(
      `UPDATE campaign_members SET status = 'active', generation = generation + 1
        WHERE campaign_id = $1 AND user_id = $2`,
      [s.campaignId, h.users.player.actorId],
    );
    const returned = await h.characters.open(ctxFor(h.users.player), s.adoptedId);
    if (!returned.ok) throw new Error("return failed");
    await inPlacementTxn(async (client) =>
      h.placement.adopt(client, ctxFor(h.users.player), {
        campaignId: s.campaignId,
        expectedCampaignRevision: await campaignRevision(s.campaignId),
        membershipGeneration: await memberGeneration(s.campaignId, h.users.player.actorId),
        characterId: s.adoptedId,
        expectedCharacterRevision: returned.value.revision,
        acknowledgedDisclosure: true,
        idempotencyKey: randomUUID(),
      }),
    );

    const replay = await setField(h.users.player, s.adoptedId, 2, 14, key);
    expect(replay.ok).toBe(false);
    if (replay.ok) throw new Error("stale-generation replay must not disclose");
    expect(replay.error.code).toBe("result_unavailable");
  });

  it("reauthorizes before conflict details after revocation", async () => {
    // The campaign-created sheet stays attached across departure (adopted
    // sheets would return and take the standalone path instead).
    const s = await setup();
    const advanced = await setField(h.users.gm, s.campaignCharId, 1, 12);
    expect(advanced.ok).toBe(true);
    // Stale revision while authorized: conflict with change details.
    const conflict = await setField(h.users.player, s.campaignCharId, 1, 14);
    expect(conflict.ok).toBe(false);
    if (conflict.ok) throw new Error("unreachable");
    expect(conflict.error.code).toBe("conflict");
    expect(conflict.error.changedDefinitionIds).toBeDefined();

    await h.campaigns.removeMember(ctxFor(h.users.gm), {
      campaignId: s.campaignId,
      userId: h.users.player.actorId,
      expectedCampaignRevision: await campaignRevision(s.campaignId),
      idempotencyKey: randomUUID(),
    });

    // Same stale command after revocation: generic denial, no details.
    const denied = await setField(h.users.player, s.campaignCharId, 1, 14, randomUUID());
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("not_found");
    expect(denied.error).not.toHaveProperty("changedDefinitionIds");
  });

  it("denies create replay after adoption", async () => {
    const createKey = randomUUID();
    const createName = `Create replay ${randomUUID().slice(0, 8)}`;
    const personal = await h.characters.create(ctxFor(h.users.player), {
      systemVersionId: h.versionId,
      entityDefinitionId: "character",
      name: createName,
      idempotencyKey: createKey,
    });
    if (!personal.ok) throw new Error("create failed");

    const created = await h.campaigns.create(ctxFor(h.users.gm), {
      systemVersionId: h.versionId,
      title: `Create replay campaign ${randomUUID()}`,
      description: "",
      idempotencyKey: randomUUID(),
    });
    if (!created.ok) throw new Error("campaign create failed");
    const campaignId = created.value.campaignId;
    await seedMember(campaignId, h.users.player.actorId);
    await inPlacementTxn(async (client) =>
      h.placement.adopt(client, ctxFor(h.users.player), {
        campaignId,
        expectedCampaignRevision: await campaignRevision(campaignId),
        membershipGeneration: 1,
        characterId: personal.value.characterId,
        expectedCharacterRevision: personal.value.revision,
        acknowledgedDisclosure: true,
        idempotencyKey: randomUUID(),
      }),
    );

    const replay = await h.characters.create(ctxFor(h.users.player), {
      systemVersionId: h.versionId,
      entityDefinitionId: "character",
      name: createName,
      idempotencyKey: createKey,
    });
    // Same input replays the stored create receipt, which must deny now that
    // the sheet is attached instead of disclosing it.
    expect(replay.ok).toBe(false);
    if (replay.ok) throw new Error("create replay after adopt must deny");
    expect(replay.error.code).toBe("not_found");
  });
});
