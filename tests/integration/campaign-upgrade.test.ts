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
