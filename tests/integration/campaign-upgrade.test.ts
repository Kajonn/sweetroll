import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prepareCampaignCharacter } from "../../src/characters/campaignPlacement.js";
import { compileDocument } from "../../src/systems/implementation/rules/compile-document.js";
import type { RequestContext } from "../../src/systems/authoring.js";
import { buildI6Harness, ctxFor, type I6Harness } from "./i6-app.js";
import { buildD20V2Document } from "./i3-app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;

describeWithDatabase("campaign upgrade preview (Phase 3 Task 1)", () => {
  let h: I6Harness;
  /** Newer published version of the GM's system (the upgrade target). */
  let v2: string;

  beforeAll(async () => {
    h = await buildI6Harness();
    // The fixture versions are private by default; upgrade tests need the
    // campaign version usable by every member, like a shared table version.
    await h.pool.query(`UPDATE systems SET access = 'public'`);
    v2 = await publishV2(h, h.systemId);
  });

  afterAll(async () => {
    await h.close();
  });

  async function publishV2(harness: I6Harness, systemId: string): Promise<string> {
    const versionId = randomUUID();
    const compiled = compileDocument(buildD20V2Document(), {
      systemId,
      versionId,
      semanticVersion: "2.0.0",
    });
    if (!compiled.ok) throw new Error(`v2 did not compile: ${JSON.stringify(compiled.diagnostics)}`);
    await harness.pool.query(
      "INSERT INTO system_versions (id, system_id, semantic_version, checksum, package_json, lifecycle) VALUES ($1, $2, '2.0.0', $3, $4::jsonb, 'published')",
      [versionId, systemId, compiled.value.integrity.checksum, JSON.stringify(compiled.value)],
    );
    return versionId;
  }

  async function createCampaign(): Promise<string> {
    const created = await h.campaigns.create(ctxFor(h.users.gm), {
      systemVersionId: h.versionId,
      title: `Upgrade ${randomUUID()}`,
      description: "",
      idempotencyKey: randomUUID(),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("campaign create failed");
    return created.value.campaignId;
  }

  async function addCharacter(campaignId: string, expectedCampaignRevision: number): Promise<string> {
    const prepared = await prepareCampaignCharacter(h.runtime, {
      systemVersionId: h.versionId,
      entityDefinitionId: "character",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error("prepare campaign character failed");
    const created = await h.campaigns.createCampaignCharacter(ctxFor(h.users.gm), {
      campaignId,
      expectedCampaignRevision,
      idempotencyKey: randomUUID(),
      name: `Upgrade sheet ${randomUUID().slice(0, 8)}`,
      entityDefinitionId: "character",
      prepared: prepared.value,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(`campaign character create failed: ${JSON.stringify(created.error)}`);
    return created.value.characterId;
  }

  async function seedMember(campaignId: string, userId: string, role: "co_gm" | "player" = "player"): Promise<void> {
    await h.pool.query(
      `INSERT INTO campaign_members (campaign_id, user_id, role, status, generation)
       VALUES ($1, $2, $3, 'active', 1)`,
      [campaignId, userId, role],
    );
  }

  function anonymousCtx(): RequestContext {
    return { actorId: randomUUID(), requestId: randomUUID() };
  }

  async function countRows(table: string): Promise<number> {
    const rows = await h.pool.query(`SELECT COUNT(*)::int AS count FROM ${table}`);
    return rows.rows[0].count as number;
  }

  it("previews an upgrade with per-character warnings and no row writes", async () => {
    const campaignId = await createCampaign();
    const characterId = await addCharacter(campaignId, 1);
    const previewsBefore = await countRows("character_migration_previews");
    const auditsBefore = await countRows("campaign_audit_records");

    const preview = await h.campaigns.previewUpgrade(ctxFor(h.users.gm), {
      campaignId,
      targetVersionId: v2,
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) throw new Error("expected upgrade preview");
    expect(preview.value).toMatchObject({ campaignId, sourceVersionId: h.versionId, targetVersionId: v2 });
    expect(preview.value.targetSemanticVersion).toBe("2.0.0");
    expect(preview.value.campaignRevision).toEqual(expect.any(Number));
    expect(preview.value.characters).toHaveLength(1);
    expect(preview.value.characters[0]).toMatchObject({ characterId, sourceVersionId: h.versionId });
    expect(preview.value.characters[0]!.warnings).toEqual(expect.any(Array));
    expect(preview.value.characters[0]!.warnings.length).toBeGreaterThan(0);
    expect(preview.value.characters[0]!.requiresMapping).toBe(true);
    // The preview envelope carries no candidate state or projections.
    expect(JSON.stringify(preview.value)).not.toContain("candidateState");
    expect(JSON.stringify(preview.value)).not.toContain("candidateProjection");
    // Read-only: no preview rows, no audit rows, campaign revision untouched.
    expect(await countRows("character_migration_previews")).toBe(previewsBefore);
    expect(await countRows("campaign_audit_records")).toBe(auditsBefore);
    const opened = await h.campaigns.open(ctxFor(h.users.gm), { campaignId });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("campaign vanished under test");
    expect(opened.value.systemVersionId).toBe(h.versionId);
  });

  it("denies preview to players, outsiders, unauthenticated callers and across campaigns", async () => {
    const campaignId = await createCampaign();
    await addCharacter(campaignId, 1);
    await seedMember(campaignId, h.users.player.actorId);
    const otherCampaignId = await createCampaign();

    const player = await h.campaigns.previewUpgrade(ctxFor(h.users.player), {
      campaignId,
      targetVersionId: v2,
    });
    expect(player).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });

    const outsider = await h.campaigns.previewUpgrade(ctxFor(h.users.outsider), {
      campaignId,
      targetVersionId: v2,
    });
    expect(outsider).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });

    const unauthenticated = await h.campaigns.previewUpgrade(anonymousCtx(), {
      campaignId,
      targetVersionId: v2,
    });
    expect(unauthenticated).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });

    // A member of campaign A learns nothing about campaign B by guessing its ID.
    const crossCampaign = await h.campaigns.previewUpgrade(ctxFor(h.users.player), {
      campaignId: otherCampaignId,
      targetVersionId: v2,
    });
    expect(crossCampaign).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });

    // Unknown campaign IDs collapse the same way.
    const missing = await h.campaigns.previewUpgrade(ctxFor(h.users.gm), {
      campaignId: randomUUID(),
      targetVersionId: v2,
    });
    expect(missing).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });
  });

  it("rejects a target equal to the campaign pin", async () => {
    const campaignId = await createCampaign();
    await addCharacter(campaignId, 1);
    const preview = await h.campaigns.previewUpgrade(ctxFor(h.users.gm), {
      campaignId,
      targetVersionId: h.versionId,
    });
    expect(preview).toEqual({ ok: false, error: expect.objectContaining({ code: "bad_request" }) });
  });

  it("rejects a target from another system", async () => {
    const campaignId = await createCampaign();
    await addCharacter(campaignId, 1);
    const preview = await h.campaigns.previewUpgrade(ctxFor(h.users.gm), {
      campaignId,
      targetVersionId: h.otherVersionId,
    });
    expect(preview).toEqual({ ok: false, error: expect.objectContaining({ code: "bad_request" }) });
  });

  it("rejects an unpublished target", async () => {
    const campaignId = await createCampaign();
    await addCharacter(campaignId, 1);
    await h.pool.query(`UPDATE system_versions SET lifecycle = 'deprecated' WHERE id = $1`, [v2]);
    try {
      const preview = await h.campaigns.previewUpgrade(ctxFor(h.users.gm), {
        campaignId,
        targetVersionId: v2,
      });
      expect(preview).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });
    } finally {
      await h.pool.query(`UPDATE system_versions SET lifecycle = 'published' WHERE id = $1`, [v2]);
    }
  });

  it("uses a link-only target by exact ID without listing it", async () => {
    const campaignId = await createCampaign();
    await addCharacter(campaignId, 1);
    await h.pool.query(`UPDATE systems SET access = 'link' WHERE id = $1`, [h.systemId]);
    try {
      const preview = await h.campaigns.previewUpgrade(ctxFor(h.users.gm), {
        campaignId,
        targetVersionId: v2,
      });
      expect(preview.ok).toBe(true);
      if (!preview.ok) throw new Error("expected link-only upgrade preview");

      // No discovery endpoint lists the link-only version to a non-owner.
      const catalog = await h.characters.listCreationVersions(ctxFor(h.users.other), {
        systemId: h.systemId,
      });
      expect(catalog.ok).toBe(true);
      if (!catalog.ok) throw new Error("creation versions read failed");
      expect(catalog.value.versions.map((entry) => entry.versionId)).not.toContain(v2);
    } finally {
      await h.pool.query(`UPDATE systems SET access = 'public' WHERE id = $1`, [h.systemId]);
    }
  });

  it("keeps preview readable on an archived campaign", async () => {
    const campaignId = await createCampaign();
    await addCharacter(campaignId, 1);
    const archived = await h.campaigns.archive(ctxFor(h.users.gm), {
      campaignId,
      expectedCampaignRevision: 2,
      idempotencyKey: randomUUID(),
    });
    expect(archived.ok).toBe(true);
    if (!archived.ok) throw new Error("campaign archive failed");

    const preview = await h.campaigns.previewUpgrade(ctxFor(h.users.gm), {
      campaignId,
      targetVersionId: v2,
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) throw new Error("expected archived-campaign upgrade preview");
    expect(preview.value).toMatchObject({ campaignId, sourceVersionId: h.versionId, targetVersionId: v2 });
  });

  it("previews a campaign with zero attached characters", async () => {
    const campaignId = await createCampaign();
    const preview = await h.campaigns.previewUpgrade(ctxFor(h.users.gm), {
      campaignId,
      targetVersionId: v2,
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) throw new Error("expected empty upgrade preview");
    expect(preview.value).toMatchObject({ campaignId, sourceVersionId: h.versionId, targetVersionId: v2 });
    expect(preview.value.characters).toEqual([]);
  });
});

describeWithDatabase("campaign upgrade commit (Phase 3 Task 2)", () => {
  let h: I6Harness;
  /** Newer published version of the GM's system (the upgrade target). */
  let v2: string;
  /**
   * Explicit mapping covering the renamed `ability` → `ability_score` drop.
   * Commits with dropped sources require caller mappings (their presence
   * proves GM engagement with the preview warnings); `proficient` was
   * deleted in v2 with no valid target, so its drop stays preview-disclosed.
   */
  const COVERING_MAPPINGS = { ability: "ability_score" };

  beforeAll(async () => {
    h = await buildI6Harness();
    await h.pool.query(`UPDATE systems SET access = 'public'`);
    v2 = await publishV2(h, h.systemId);
  });

  afterAll(async () => {
    await h.close();
  });

  async function publishV2(harness: I6Harness, systemId: string, semanticVersion = "2.0.0"): Promise<string> {
    const versionId = randomUUID();
    const compiled = compileDocument(buildD20V2Document(), {
      systemId,
      versionId,
      semanticVersion,
    });
    if (!compiled.ok) throw new Error(`v2 did not compile: ${JSON.stringify(compiled.diagnostics)}`);
    await harness.pool.query(
      "INSERT INTO system_versions (id, system_id, semantic_version, checksum, package_json, lifecycle) VALUES ($1, $2, $3, $4, $5::jsonb, 'published')",
      [versionId, systemId, semanticVersion, compiled.value.integrity.checksum, JSON.stringify(compiled.value)],
    );
    return versionId;
  }

  async function createCampaign(): Promise<string> {
    const created = await h.campaigns.create(ctxFor(h.users.gm), {
      systemVersionId: h.versionId,
      title: `Upgrade commit ${randomUUID()}`,
      description: "",
      idempotencyKey: randomUUID(),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("campaign create failed");
    return created.value.campaignId;
  }

  async function addCharacter(campaignId: string, expectedCampaignRevision: number): Promise<string> {
    const prepared = await prepareCampaignCharacter(h.runtime, {
      systemVersionId: h.versionId,
      entityDefinitionId: "character",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error("prepare campaign character failed");
    const created = await h.campaigns.createCampaignCharacter(ctxFor(h.users.gm), {
      campaignId,
      expectedCampaignRevision,
      idempotencyKey: randomUUID(),
      name: `Upgrade sheet ${randomUUID().slice(0, 8)}`,
      entityDefinitionId: "character",
      prepared: prepared.value,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(`campaign character create failed: ${JSON.stringify(created.error)}`);
    return created.value.characterId;
  }

  async function seedMember(campaignId: string, userId: string, role: "co_gm" | "player" = "player"): Promise<void> {
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

  async function characterVersion(characterId: string): Promise<string> {
    const rows = await h.pool.query(`SELECT system_version_id FROM characters WHERE id = $1`, [characterId]);
    return rows.rows[0].system_version_id as string;
  }

  async function migrationCount(): Promise<number> {
    const rows = await h.pool.query(`SELECT COUNT(*)::int AS count FROM character_migrations`);
    return rows.rows[0].count as number;
  }

  async function auditRows(campaignId: string, kind: string): Promise<Array<{ summary: string }>> {
    const rows = await h.pool.query(
      `SELECT summary FROM campaign_audit_records WHERE campaign_id = $1 AND kind = $2 ORDER BY occurred_at`,
      [campaignId, kind],
    );
    return rows.rows as Array<{ summary: string }>;
  }

  it("commits an upgrade atomically: pin moves, characters repinned, audit records migration IDs", async () => {
    const campaignId = await createCampaign();
    const firstCharacterId = await addCharacter(campaignId, 1);
    const secondCharacterId = await addCharacter(campaignId, 2);
    const rev = await campaignRevision(campaignId);

    // A second campaign on the same pin: snapshot it for the isolation proof.
    const otherCampaignId = await createCampaign();
    const otherCharacterId = await addCharacter(otherCampaignId, 1);
    const otherOpened = await h.campaigns.open(ctxFor(h.users.gm), { campaignId: otherCampaignId });
    expect(otherOpened.ok).toBe(true);
    if (!otherOpened.ok) throw new Error("other campaign vanished under test");
    const otherBefore = JSON.stringify(otherOpened.value);
    const otherCharsBefore = await h.pool.query(
      `SELECT id, system_version_id, revision FROM characters WHERE campaign_id = $1 ORDER BY id`,
      [otherCampaignId],
    );

    const first = await h.campaigns.commitUpgrade(ctxFor(h.users.gm), {
      campaignId,
      targetVersionId: v2,
      expectedCampaignRevision: rev,
      idempotencyKey: randomUUID(),
      mappings: COVERING_MAPPINGS,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(`expected upgrade commit: ${JSON.stringify(first)}`);
    expect(first.value).toMatchObject({
      campaignId,
      campaignRevision: rev + 1,
      sourceVersionId: h.versionId,
      targetVersionId: v2,
    });
    expect([...first.value.migratedCharacterIds].sort()).toEqual(
      [firstCharacterId, secondCharacterId].sort(),
    );

    // The pin moved and every attached character is repinned.
    const opened = await h.campaigns.open(ctxFor(h.users.gm), { campaignId });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("campaign vanished under test");
    expect(opened.value.systemVersionId).toBe(v2);
    expect(opened.value.revision).toBe(rev + 1);
    expect(await characterVersion(firstCharacterId)).toBe(v2);
    expect(await characterVersion(secondCharacterId)).toBe(v2);

    // Per-character migration lineage exists and the campaign audit names it.
    const lineage = await h.pool.query(
      `SELECT id, character_id FROM character_migrations WHERE character_id = ANY($1) ORDER BY character_id`,
      [[firstCharacterId, secondCharacterId]],
    );
    expect(lineage.rows).toHaveLength(2);
    const recordedIds = lineage.rows.map((row) => row.id as string).sort();
    const audits = await auditRows(campaignId, "campaign_upgrade_committed");
    expect(audits).toHaveLength(1);
    expect(audits[0]!.summary).toContain(h.versionId);
    expect(audits[0]!.summary).toContain(v2);
    expect(audits[0]!.summary).toContain(firstCharacterId);
    expect(audits[0]!.summary).toContain(secondCharacterId);
    for (const migrationId of recordedIds) {
      expect(audits[0]!.summary).toContain(migrationId);
    }

    // Attached scope keeps campaign custody: controllers survive the commit.
    // Campaign-created sheets carry no controller rows at all (custody is
    // the campaign_id; GMs see every sheet via membership), so the attached
    // commit view's controllers: [] mirrors the stored truth — verified here
    // against character_controllers and the GM roster read.
    const controllerRows = await h.pool.query(
      `SELECT character_id FROM character_controllers WHERE character_id = ANY($1)`,
      [[firstCharacterId, secondCharacterId]],
    );
    expect(controllerRows.rows).toEqual([]);
    const roster = await h.campaigns.listCharacters(ctxFor(h.users.gm), { campaignId });
    expect(roster.ok).toBe(true);
    if (!roster.ok) throw new Error("roster read failed");
    for (const row of roster.value.characters) {
      expect(row.controllers).toEqual([]);
      expect(row.systemVersionId).toBe(v2);
    }

    // The second campaign on the same pin is byte-identical after.
    const otherAfter = await h.campaigns.open(ctxFor(h.users.gm), { campaignId: otherCampaignId });
    expect(otherAfter.ok).toBe(true);
    if (!otherAfter.ok) throw new Error("other campaign vanished under test");
    expect(JSON.stringify(otherAfter.value)).toBe(otherBefore);
    const otherCharsAfter = await h.pool.query(
      `SELECT id, system_version_id, revision FROM characters WHERE campaign_id = $1 ORDER BY id`,
      [otherCampaignId],
    );
    expect(otherCharsAfter.rows).toEqual(otherCharsBefore.rows);
    expect(await characterVersion(otherCharacterId)).toBe(h.versionId);
  });

  it("denies commit to players", async () => {
    const campaignId = await createCampaign();
    await addCharacter(campaignId, 1);
    await seedMember(campaignId, h.users.player.actorId);
    const rev = await campaignRevision(campaignId);

    const denied = await h.campaigns.commitUpgrade(ctxFor(h.users.player), {
      campaignId,
      targetVersionId: v2,
      expectedCampaignRevision: rev,
      idempotencyKey: randomUUID(),
    });
    expect(denied).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });
    expect((await h.campaigns.open(ctxFor(h.users.gm), { campaignId })).value?.systemVersionId).toBe(h.versionId);
  });

  it("rejects a stale expectedCampaignRevision with latestRevision and zero writes", async () => {
    const campaignId = await createCampaign();
    const characterId = await addCharacter(campaignId, 1);
    const rev = await campaignRevision(campaignId);
    const migrationsBefore = await migrationCount();

    const stale = await h.campaigns.commitUpgrade(ctxFor(h.users.gm), {
      campaignId,
      targetVersionId: v2,
      expectedCampaignRevision: rev - 1,
      idempotencyKey: randomUUID(),
    });
    expect(stale).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "conflict", latestRevision: rev }),
    });
    // Zero writes: the pin, the campaign revision and the migration lineage
    // are all untouched.
    expect((await h.campaigns.open(ctxFor(h.users.gm), { campaignId })).value?.systemVersionId).toBe(h.versionId);
    expect(await campaignRevision(campaignId)).toBe(rev);
    expect(await characterVersion(characterId)).toBe(h.versionId);
    expect(await migrationCount()).toBe(migrationsBefore);
  });

  it("replays the stored envelope on idempotency-key reuse with no second lineage", async () => {
    const campaignId = await createCampaign();
    await addCharacter(campaignId, 1);
    const rev = await campaignRevision(campaignId);
    const key = randomUUID();

    const first = await h.campaigns.commitUpgrade(ctxFor(h.users.gm), {
      campaignId,
      targetVersionId: v2,
      expectedCampaignRevision: rev,
      idempotencyKey: key,
      mappings: COVERING_MAPPINGS,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected upgrade commit");
    const migrationsAfterFirst = await migrationCount();
    const auditsAfterFirst = await auditRows(campaignId, "campaign_upgrade_committed");

    // Replayed with the post-commit revision (a waiter behind the row lock
    // replays instead of re-applying): the stored envelope comes back.
    const replay = await h.campaigns.commitUpgrade(ctxFor(h.users.gm), {
      campaignId,
      targetVersionId: v2,
      expectedCampaignRevision: first.value.campaignRevision,
      idempotencyKey: key,
      mappings: COVERING_MAPPINGS,
    });
    expect(replay).toEqual(first);
    expect(await migrationCount()).toBe(migrationsAfterFirst);
    expect(await auditRows(campaignId, "campaign_upgrade_committed")).toEqual(auditsAfterFirst);
    expect(await campaignRevision(campaignId)).toBe(first.value.campaignRevision);
  });

  it("fails the whole commit when a character is archived between preview and commit", async () => {
    // D3 recomputes previews server-side inside the commit transaction, so a
    // plain revision bump before commit is absorbed rather than failed; the
    // campaign-first lock order additionally serializes character writes
    // against the commit. What fails closed is state the in-transaction
    // preview does not capture: archiving the sheet (a real GM command)
    // after preview makes the in-transaction attached commit reject with an
    // explicit per-character 409, and the whole commit rolls back.
    const campaignId = await createCampaign();
    const archivedCharacterId = await addCharacter(campaignId, 1);
    const untouchedCharacterId = await addCharacter(campaignId, 2);
    const rev = await campaignRevision(campaignId);

    const preview = await h.campaigns.previewUpgrade(ctxFor(h.users.gm), {
      campaignId,
      targetVersionId: v2,
    });
    expect(preview.ok).toBe(true);

    const roster = await h.campaigns.listCharacters(ctxFor(h.users.gm), { campaignId });
    expect(roster.ok).toBe(true);
    if (!roster.ok) throw new Error("roster read failed");
    const archivedRevision = roster.value.characters.find((row) => row.characterId === archivedCharacterId)?.revision;
    expect(archivedRevision).toEqual(expect.any(Number));
    const archived = await h.characters.manage(ctxFor(h.users.gm), {
      kind: "archive",
      characterId: archivedCharacterId,
      expectedRevision: archivedRevision!,
      idempotencyKey: randomUUID(),
    });
    expect(archived.ok).toBe(true);

    const previewsBefore = await h.pool.query(`SELECT COUNT(*)::int AS count FROM character_migration_previews`);
    const migrationsBefore = await migrationCount();
    const commit = await h.campaigns.commitUpgrade(ctxFor(h.users.gm), {
      campaignId,
      targetVersionId: v2,
      expectedCampaignRevision: rev,
      idempotencyKey: randomUUID(),
      mappings: COVERING_MAPPINGS,
    });
    expect(commit.ok).toBe(false);
    if (commit.ok) throw new Error("archived-character commit must fail");
    expect(commit.error.code).toBe("conflict");
    expect(commit.error.message).toContain(archivedCharacterId);

    // No partial migration: the pin, both characters, the campaign revision
    // and even the transient preview rows are all untouched.
    expect((await h.campaigns.open(ctxFor(h.users.gm), { campaignId })).value?.systemVersionId).toBe(h.versionId);
    expect(await characterVersion(archivedCharacterId)).toBe(h.versionId);
    expect(await characterVersion(untouchedCharacterId)).toBe(h.versionId);
    expect(await campaignRevision(campaignId)).toBe(rev);
    expect(await migrationCount()).toBe(migrationsBefore);
    const previewsAfter = await h.pool.query(`SELECT COUNT(*)::int AS count FROM character_migration_previews`);
    expect(previewsAfter.rows[0].count).toBe(previewsBefore.rows[0].count);
  });

  it("absorbs a pre-commit character revision bump and still commits", async () => {
    // D3 recomputes previews server-side inside the commit transaction, so a
    // revision bump landing between the client's preview and the commit is
    // absorbed, not failed: the in-transaction preview is built from the
    // latest committed character state. This locks in that behavior.
    const campaignId = await createCampaign();
    const editedCharacterId = await addCharacter(campaignId, 1);
    const rev = await campaignRevision(campaignId);

    const preview = await h.campaigns.previewUpgrade(ctxFor(h.users.gm), {
      campaignId,
      targetVersionId: v2,
    });
    expect(preview.ok).toBe(true);

    // A real command bumps the character revision after the preview.
    const roster = await h.campaigns.listCharacters(ctxFor(h.users.gm), { campaignId });
    expect(roster.ok).toBe(true);
    if (!roster.ok) throw new Error("roster read failed");
    const editedRevision = roster.value.characters.find((row) => row.characterId === editedCharacterId)?.revision;
    expect(editedRevision).toEqual(expect.any(Number));
    const renamed = await h.characters.manage(ctxFor(h.users.gm), {
      kind: "rename",
      characterId: editedCharacterId,
      name: `Edited after preview ${randomUUID().slice(0, 8)}`,
      expectedRevision: editedRevision!,
      idempotencyKey: randomUUID(),
    });
    expect(renamed.ok).toBe(true);

    const commit = await h.campaigns.commitUpgrade(ctxFor(h.users.gm), {
      campaignId,
      targetVersionId: v2,
      expectedCampaignRevision: rev,
      idempotencyKey: randomUUID(),
      mappings: COVERING_MAPPINGS,
    });
    expect(commit.ok).toBe(true);
    if (!commit.ok) throw new Error(`expected absorbing commit: ${JSON.stringify(commit)}`);
    expect(commit.value).toMatchObject({
      campaignId,
      campaignRevision: rev + 1,
      sourceVersionId: h.versionId,
      targetVersionId: v2,
      migratedCharacterIds: [editedCharacterId],
    });
    expect((await h.campaigns.open(ctxFor(h.users.gm), { campaignId })).value?.systemVersionId).toBe(v2);
    expect(await characterVersion(editedCharacterId)).toBe(v2);
  });

  it("rejects a missing required mapping with an explicit error naming character and definition", async () => {
    // The fixture drops `ability`/`proficient` with no mapping supplied: the
    // commit must fail closed with invalid_value (no silent drop) instead of
    // migrating. The expected definition name is read off the live preview
    // warnings, not hardcoded to the fixture.
    const campaignId = await createCampaign();
    const characterId = await addCharacter(campaignId, 1);
    const rev = await campaignRevision(campaignId);

    const preview = await h.campaigns.previewUpgrade(ctxFor(h.users.gm), {
      campaignId,
      targetVersionId: v2,
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) throw new Error("expected upgrade preview");
    const dropWarning = preview.value.characters
      .find((row) => row.characterId === characterId)?.warnings
      .find((warning) => warning.includes("have no target and will be dropped"));
    expect(dropWarning).toEqual(expect.any(String));
    const definition = dropWarning!.match(/"([^"]+)"/)?.[1];
    expect(definition).toEqual(expect.any(String));

    const migrationsBefore = await migrationCount();
    const commit = await h.campaigns.commitUpgrade(ctxFor(h.users.gm), {
      campaignId,
      targetVersionId: v2,
      expectedCampaignRevision: rev,
      idempotencyKey: randomUUID(),
    });
    expect(commit.ok).toBe(false);
    if (commit.ok) throw new Error("mapping-less commit must fail");
    expect(commit.error.code).toBe("invalid_value");
    expect(commit.error.message).toContain(characterId);
    expect(commit.error.message).toContain(definition!);

    // Zero writes: the pin, the campaign revision and the migration lineage
    // are all untouched.
    expect((await h.campaigns.open(ctxFor(h.users.gm), { campaignId })).value?.systemVersionId).toBe(h.versionId);
    expect(await characterVersion(characterId)).toBe(h.versionId);
    expect(await campaignRevision(campaignId)).toBe(rev);
    expect(await migrationCount()).toBe(migrationsBefore);
  });

  it("rejects unknown mapping fields with an explicit error naming character and definition", async () => {
    const campaignId = await createCampaign();
    const characterId = await addCharacter(campaignId, 1);
    const rev = await campaignRevision(campaignId);
    const migrationsBefore = await migrationCount();

    const commit = await h.campaigns.commitUpgrade(ctxFor(h.users.gm), {
      campaignId,
      targetVersionId: v2,
      expectedCampaignRevision: rev,
      idempotencyKey: randomUUID(),
      mappings: { "no-such-source-field": "body" },
    });
    expect(commit.ok).toBe(false);
    if (commit.ok) throw new Error("bad-mapping commit must fail");
    expect(commit.error.code).toBe("invalid_value");
    expect(commit.error.message).toContain(characterId);
    expect(commit.error.message).toContain("no-such-source-field");

    expect((await h.campaigns.open(ctxFor(h.users.gm), { campaignId })).value?.systemVersionId).toBe(h.versionId);
    expect(await campaignRevision(campaignId)).toBe(rev);
    expect(await migrationCount()).toBe(migrationsBefore);
  });

  it("denies commit on an archived campaign even though preview stays readable", async () => {
    const campaignId = await createCampaign();
    await addCharacter(campaignId, 1);
    const archived = await h.campaigns.archive(ctxFor(h.users.gm), {
      campaignId,
      expectedCampaignRevision: 2,
      idempotencyKey: randomUUID(),
    });
    expect(archived.ok).toBe(true);
    if (!archived.ok) throw new Error("campaign archive failed");
    const archivedRev = archived.value.revision;

    const preview = await h.campaigns.previewUpgrade(ctxFor(h.users.gm), {
      campaignId,
      targetVersionId: v2,
    });
    expect(preview.ok).toBe(true);

    const commit = await h.campaigns.commitUpgrade(ctxFor(h.users.gm), {
      campaignId,
      targetVersionId: v2,
      expectedCampaignRevision: archivedRev,
      idempotencyKey: randomUUID(),
    });
    expect(commit).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "conflict", latestRevision: archivedRev }),
    });
    expect((await h.campaigns.open(ctxFor(h.users.gm), { campaignId })).value?.systemVersionId).toBe(h.versionId);
  });

  it("commits pin-only for a campaign with zero attached characters", async () => {
    const campaignId = await createCampaign();
    const rev = await campaignRevision(campaignId);

    const commit = await h.campaigns.commitUpgrade(ctxFor(h.users.gm), {
      campaignId,
      targetVersionId: v2,
      expectedCampaignRevision: rev,
      idempotencyKey: randomUUID(),
    });
    expect(commit.ok).toBe(true);
    if (!commit.ok) throw new Error(`expected pin-only commit: ${JSON.stringify(commit)}`);
    expect(commit.value).toMatchObject({
      campaignId,
      campaignRevision: rev + 1,
      sourceVersionId: h.versionId,
      targetVersionId: v2,
      migratedCharacterIds: [],
    });
    expect((await h.campaigns.open(ctxFor(h.users.gm), { campaignId })).value?.systemVersionId).toBe(v2);
    expect(await auditRows(campaignId, "campaign_upgrade_committed")).toHaveLength(1);
  });

  it("lets any active GM commit, independent of who previewed (GM handoff)", async () => {
    const campaignId = await createCampaign();
    await addCharacter(campaignId, 1);
    await seedMember(campaignId, h.users.other.actorId, "co_gm");

    // The incoming co-GM previews; the owner commits — no preview-owner
    // binding survives because commit recomputes previews in-transaction.
    const preview = await h.campaigns.previewUpgrade(ctxFor(h.users.other), {
      campaignId,
      targetVersionId: v2,
    });
    expect(preview.ok).toBe(true);

    const rev = await campaignRevision(campaignId);
    const commit = await h.campaigns.commitUpgrade(ctxFor(h.users.gm), {
      campaignId,
      targetVersionId: v2,
      expectedCampaignRevision: rev,
      idempotencyKey: randomUUID(),
      mappings: COVERING_MAPPINGS,
    });
    expect(commit.ok).toBe(true);
    if (!commit.ok) throw new Error(`expected handoff commit: ${JSON.stringify(commit)}`);
    expect((await h.campaigns.open(ctxFor(h.users.gm), { campaignId })).value?.systemVersionId).toBe(v2);

    // And the reverse direction: the co-GM commits the next upgrade alone.
    // v3 is the same document, but `level` has no sheet element so the
    // projection reports it as dropped — the commit gate applies uniformly
    // and the same-ID explicit mapping records the engagement.
    const v3 = await publishV2(h, h.systemId, "3.0.0");
    const revAfter = await campaignRevision(campaignId);
    const coGmCommit = await h.campaigns.commitUpgrade(ctxFor(h.users.other), {
      campaignId,
      targetVersionId: v3,
      expectedCampaignRevision: revAfter,
      idempotencyKey: randomUUID(),
      mappings: { level: "level" },
    });
    expect(coGmCommit.ok).toBe(true);
    expect((await h.campaigns.open(ctxFor(h.users.other), { campaignId })).value?.systemVersionId).toBe(v3);
  });
});
