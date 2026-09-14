import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildI6Harness, ctxFor, type I6Harness } from "./i6-app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;

// 1x1 transparent PNG fixture (inline base64, per the I7b Task 1 brief).
const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// Minimal PNG whose IHDR claims 5000x10 (over the 4096 px cap). Pixel data is
// a valid zlib stream of zero scanlines; decoders report dimensions from the
// header without touching IDAT.
const OVER_DIMENSION_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAE4gAAAAKCAAAAAB9veuXAAAAR0lEQVR4nO3BAQ0AAADCoPdPbQ8HFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJ8Gw1oAAZ23Yb4AAAAASUVORK5CYII=";

// Plain text bytes: valid base64, but no image magic of any kind.
const NOT_AN_IMAGE_BASE64 = Buffer.from("hello world", "utf8").toString("base64");

describeWithDatabase("campaign image upload/delete (Task 1 media foundation)", () => {
  let h: I6Harness;
  let mediaDir: string;

  beforeAll(async () => {
    mediaDir = await mkdtemp(join(tmpdir(), "sweetroll-media-test-"));
    process.env.SWEETROLL_MEDIA_DIR = mediaDir;
    h = await buildI6Harness();
  });

  afterAll(async () => {
    await h.close();
    delete process.env.SWEETROLL_MEDIA_DIR;
    await rm(mediaDir, { recursive: true, force: true });
  });

  async function createCampaign(): Promise<string> {
    const created = await h.campaigns.create(ctxFor(h.users.gm), {
      systemVersionId: h.versionId,
      title: `Media ${randomUUID()}`,
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

  async function mediaRowCount(fileId: string): Promise<number> {
    const rows = await h.pool.query(`SELECT COUNT(*)::int AS count FROM media_files WHERE id = $1`, [fileId]);
    return rows.rows[0].count as number;
  }

  it("GM uploads a 1x1 PNG and the dimensions are echoed", async () => {
    const campaignId = await createCampaign();
    const uploaded = await h.campaigns.uploadImage(ctxFor(h.users.gm), {
      campaignId,
      name: "cave",
      contentType: "image/png",
      dataBase64: ONE_BY_ONE_PNG_BASE64,
      idempotencyKey: randomUUID(),
    });
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) throw new Error("expected upload");
    expect(uploaded.value).toMatchObject({ width: 1, height: 1, mediaType: "image/png" });
  });

  it("denies player upload with a generic 404", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);
    const denied = await h.campaigns.uploadImage(ctxFor(h.users.player), {
      campaignId,
      name: "cave",
      contentType: "image/png",
      dataBase64: ONE_BY_ONE_PNG_BASE64,
      idempotencyKey: randomUUID(),
    });
    expect(denied).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });
  });

  it("rejects oversized, over-dimension and bad-magic uploads", async () => {
    const campaignId = await createCampaign();

    const oversized = await h.campaigns.uploadImage(ctxFor(h.users.gm), {
      campaignId,
      name: "huge",
      contentType: "image/png",
      dataBase64: Buffer.alloc(5 * 1024 * 1024 + 1, 7).toString("base64"),
      idempotencyKey: randomUUID(),
    });
    expect(oversized).toEqual({ ok: false, error: expect.objectContaining({ code: "too_large" }) });

    const overDimension = await h.campaigns.uploadImage(ctxFor(h.users.gm), {
      campaignId,
      name: "wide",
      contentType: "image/png",
      dataBase64: OVER_DIMENSION_PNG_BASE64,
      idempotencyKey: randomUUID(),
    });
    expect(overDimension).toEqual({ ok: false, error: expect.objectContaining({ code: "unprocessable" }) });

    const badMagic = await h.campaigns.uploadImage(ctxFor(h.users.gm), {
      campaignId,
      name: "text",
      contentType: "image/png",
      dataBase64: NOT_AN_IMAGE_BASE64,
      idempotencyKey: randomUUID(),
    });
    expect(badMagic).toEqual({ ok: false, error: expect.objectContaining({ code: "unprocessable" }) });

    const mismatched = await h.campaigns.uploadImage(ctxFor(h.users.gm), {
      campaignId,
      name: "png-as-jpeg",
      contentType: "image/jpeg",
      dataBase64: ONE_BY_ONE_PNG_BASE64,
      idempotencyKey: randomUUID(),
    });
    expect(mismatched).toEqual({ ok: false, error: expect.objectContaining({ code: "unprocessable" }) });
  });

  it("replays an identical upload key without a second row", async () => {
    const campaignId = await createCampaign();
    const idempotencyKey = randomUUID();
    const input = {
      campaignId,
      name: "cave",
      contentType: "image/png" as const,
      dataBase64: ONE_BY_ONE_PNG_BASE64,
      idempotencyKey,
    };
    const first = await h.campaigns.uploadImage(ctxFor(h.users.gm), input);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected upload");
    const replayed = await h.campaigns.uploadImage(ctxFor(h.users.gm), { ...input });
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) throw new Error("expected replay");
    expect(replayed.value.fileId).toBe(first.value.fileId);
    expect(await mediaRowCount(first.value.fileId)).toBe(1);
  });

  it("delete removes the row and a second delete returns 404", async () => {
    const campaignId = await createCampaign();
    const uploaded = await h.campaigns.uploadImage(ctxFor(h.users.gm), {
      campaignId,
      name: "cave",
      contentType: "image/png",
      dataBase64: ONE_BY_ONE_PNG_BASE64,
      idempotencyKey: randomUUID(),
    });
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) throw new Error("expected upload");

    const deleted = await h.campaigns.deleteImage(ctxFor(h.users.gm), {
      fileId: uploaded.value.fileId,
      expectedRevision: uploaded.value.revision,
      idempotencyKey: randomUUID(),
    });
    expect(deleted.ok).toBe(true);
    expect(await mediaRowCount(uploaded.value.fileId)).toBe(0);

    const again = await h.campaigns.deleteImage(ctxFor(h.users.gm), {
      fileId: uploaded.value.fileId,
      expectedRevision: uploaded.value.revision,
      idempotencyKey: randomUUID(),
    });
    expect(again).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });
  });
});

describeWithDatabase("campaign scenes, fog and tokens (Task 2 scene commands)", () => {
  let h: I6Harness;
  let mediaDir: string;

  beforeAll(async () => {
    mediaDir = await mkdtemp(join(tmpdir(), "sweetroll-scene-test-"));
    process.env.SWEETROLL_MEDIA_DIR = mediaDir;
    h = await buildI6Harness();
  });

  afterAll(async () => {
    await h.close();
    delete process.env.SWEETROLL_MEDIA_DIR;
    await rm(mediaDir, { recursive: true, force: true });
  });

  async function createCampaign(): Promise<string> {
    const created = await h.campaigns.create(ctxFor(h.users.gm), {
      systemVersionId: h.versionId,
      title: `Scene ${randomUUID()}`,
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

  async function uploadBackground(campaignId: string): Promise<string> {
    const uploaded = await h.campaigns.uploadImage(ctxFor(h.users.gm), {
      campaignId,
      name: "cave",
      contentType: "image/png",
      dataBase64: ONE_BY_ONE_PNG_BASE64,
      idempotencyKey: randomUUID(),
    });
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) throw new Error("background upload failed");
    return uploaded.value.fileId;
  }

  async function createScene(
    campaignId: string,
    backgroundFileId: string,
  ): Promise<{ sceneId: string; revision: number }> {
    const created = await h.campaigns.createScene(ctxFor(h.users.gm), {
      campaignId,
      backgroundFileId,
      idempotencyKey: randomUUID(),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("scene create failed");
    return { sceneId: created.value.sceneId, revision: created.value.revision };
  }

  async function sceneRowCount(sceneId: string): Promise<number> {
    const rows = await h.pool.query(`SELECT COUNT(*)::int AS count FROM scenes WHERE id = $1`, [sceneId]);
    return rows.rows[0].count as number;
  }

  it("GM creates a scene pinned to the uploaded background, fully fogged with no tokens", async () => {
    const campaignId = await createCampaign();
    const backgroundFileId = await uploadBackground(campaignId);
    const created = await h.campaigns.createScene(ctxFor(h.users.gm), {
      campaignId,
      backgroundFileId,
      idempotencyKey: randomUUID(),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("expected scene");
    expect(created.value.sceneId).toEqual(expect.any(String));
    expect(created.value).toMatchObject({
      campaignId,
      backgroundFileId,
      revision: 1,
      fog: [],
      tokens: [],
    });
  });

  it("fog edits append under the revision guard and replay exactly once", async () => {
    const campaignId = await createCampaign();
    const { sceneId, revision } = await createScene(campaignId, await uploadBackground(campaignId));
    const idempotencyKey = randomUUID();
    const edited = await h.campaigns.applyFogEdit(ctxFor(h.users.gm), {
      sceneId,
      expectedSceneRevision: revision,
      op: { mode: "reveal", runs: [{ x: 0.5, y: 0.5, r: 0.1 }] },
      idempotencyKey,
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) throw new Error("expected fog edit");
    expect(edited.value.revision).toBe(revision + 1);
    expect(edited.value.fog).toHaveLength(1);

    const replayed = await h.campaigns.applyFogEdit(ctxFor(h.users.gm), {
      sceneId,
      expectedSceneRevision: revision,
      op: { mode: "reveal", runs: [{ x: 0.5, y: 0.5, r: 0.1 }] },
      idempotencyKey,
    });
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) throw new Error("expected fog replay");
    expect(replayed.value.revision).toBe(revision + 1);
    expect(replayed.value.fog).toHaveLength(1);
  });

  it("stale expectedSceneRevision conflicts with latestRevision and writes nothing", async () => {
    const campaignId = await createCampaign();
    const { sceneId, revision } = await createScene(campaignId, await uploadBackground(campaignId));
    const first = await h.campaigns.applyFogEdit(ctxFor(h.users.gm), {
      sceneId,
      expectedSceneRevision: revision,
      op: { mode: "reveal", runs: [{ x: 0.2, y: 0.2, r: 0.1 }] },
      idempotencyKey: randomUUID(),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected first fog edit");
    const rev = first.value.revision;

    const stale = await h.campaigns.applyFogEdit(ctxFor(h.users.gm), {
      sceneId,
      expectedSceneRevision: rev - 1,
      op: { mode: "reveal", runs: [{ x: 0.5, y: 0.5, r: 0.1 }] },
      idempotencyKey: randomUUID(),
    });
    expect(stale.ok).toBe(false);
    expect(stale).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "conflict", latestRevision: rev }),
    });

    // The stale call wrote nothing: a fresh edit at the true revision still
    // applies exactly once.
    const fresh = await h.campaigns.applyFogEdit(ctxFor(h.users.gm), {
      sceneId,
      expectedSceneRevision: rev,
      op: { mode: "conceal", runs: [{ x: 0.5, y: 0.5, r: 0.1 }] },
      idempotencyKey: randomUUID(),
    });
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) throw new Error("expected fresh fog edit");
    expect(fresh.value.revision).toBe(rev + 1);
    expect(fresh.value.fog).toHaveLength(2);
  });

  it("rejects cross-campaign and missing backgrounds with not_found", async () => {
    const campaignId = await createCampaign();
    const otherCampaignId = await createCampaign();
    const foreignFileId = await uploadBackground(otherCampaignId);

    const crossCampaign = await h.campaigns.createScene(ctxFor(h.users.gm), {
      campaignId,
      backgroundFileId: foreignFileId,
      idempotencyKey: randomUUID(),
    });
    expect(crossCampaign).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });

    const missing = await h.campaigns.createScene(ctxFor(h.users.gm), {
      campaignId,
      backgroundFileId: randomUUID(),
      idempotencyKey: randomUUID(),
    });
    expect(missing).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });
  });

  it("rejects out-of-range coordinates with bad_request", async () => {
    const campaignId = await createCampaign();
    const { sceneId, revision } = await createScene(campaignId, await uploadBackground(campaignId));

    const placed = await h.campaigns.placeToken(ctxFor(h.users.gm), {
      sceneId,
      expectedSceneRevision: revision,
      label: "Goblin",
      x: 1.5,
      y: 0.5,
      size: 0.05,
      visible: true,
      imageFileId: null,
      idempotencyKey: randomUUID(),
    });
    expect(placed).toEqual({ ok: false, error: expect.objectContaining({ code: "bad_request" }) });

    const valid = await h.campaigns.placeToken(ctxFor(h.users.gm), {
      sceneId,
      expectedSceneRevision: revision,
      label: "Goblin",
      x: 0.25,
      y: 0.75,
      size: 0.05,
      visible: true,
      imageFileId: null,
      idempotencyKey: randomUUID(),
    });
    expect(valid.ok).toBe(true);
    if (!valid.ok) throw new Error("expected token place");
    const token = valid.value.tokens[0];
    expect(token).toBeDefined();
    if (token === undefined) throw new Error("expected placed token");

    const moved = await h.campaigns.moveToken(ctxFor(h.users.gm), {
      sceneId,
      tokenId: token.tokenId,
      expectedSceneRevision: valid.value.revision,
      x: 0.5,
      y: -0.2,
      idempotencyKey: randomUUID(),
    });
    expect(moved).toEqual({ ok: false, error: expect.objectContaining({ code: "bad_request" }) });
  });

  it("denies player scene mutations with a generic 404", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);
    const backgroundFileId = await uploadBackground(campaignId);
    const { sceneId, revision } = await createScene(campaignId, backgroundFileId);

    const created = await h.campaigns.createScene(ctxFor(h.users.player), {
      campaignId,
      backgroundFileId,
      idempotencyKey: randomUUID(),
    });
    expect(created).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });

    const edited = await h.campaigns.applyFogEdit(ctxFor(h.users.player), {
      sceneId,
      expectedSceneRevision: revision,
      op: { mode: "reveal", runs: [{ x: 0.5, y: 0.5, r: 0.1 }] },
      idempotencyKey: randomUUID(),
    });
    expect(edited).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });

    const placed = await h.campaigns.placeToken(ctxFor(h.users.player), {
      sceneId,
      expectedSceneRevision: revision,
      label: "Goblin",
      x: 0.5,
      y: 0.5,
      size: 0.05,
      visible: true,
      imageFileId: null,
      idempotencyKey: randomUUID(),
    });
    expect(placed).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });
  });

  it("replays an identical create key with the stored envelope and no second row", async () => {
    const campaignId = await createCampaign();
    const backgroundFileId = await uploadBackground(campaignId);
    const idempotencyKey = randomUUID();
    const first = await h.campaigns.createScene(ctxFor(h.users.gm), {
      campaignId,
      backgroundFileId,
      idempotencyKey,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected scene");

    const replayed = await h.campaigns.createScene(ctxFor(h.users.gm), {
      campaignId,
      backgroundFileId,
      idempotencyKey,
    });
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) throw new Error("expected replay");
    expect(replayed.value.sceneId).toBe(first.value.sceneId);
    expect(replayed.value.revision).toBe(first.value.revision);
    expect(await sceneRowCount(first.value.sceneId)).toBe(1);
  });

  it("places, moves and removes tokens under the revision guard", async () => {
    const campaignId = await createCampaign();
    const { sceneId, revision } = await createScene(campaignId, await uploadBackground(campaignId));

    const placed = await h.campaigns.placeToken(ctxFor(h.users.gm), {
      sceneId,
      expectedSceneRevision: revision,
      label: "Goblin",
      x: 0.25,
      y: 0.75,
      size: 0.05,
      visible: true,
      imageFileId: null,
      idempotencyKey: randomUUID(),
    });
    expect(placed.ok).toBe(true);
    if (!placed.ok) throw new Error("expected token place");
    expect(placed.value.revision).toBe(revision + 1);
    const token = placed.value.tokens[0];
    expect(token).toBeDefined();
    if (token === undefined) throw new Error("expected placed token");
    expect(token).toMatchObject({ label: "Goblin", x: 0.25, y: 0.75, size: 0.05, visible: true });
    expect(token.tokenId).toEqual(expect.any(String));

    const moved = await h.campaigns.moveToken(ctxFor(h.users.gm), {
      sceneId,
      tokenId: token.tokenId,
      expectedSceneRevision: revision + 1,
      x: 0.5,
      y: 0.5,
      idempotencyKey: randomUUID(),
    });
    expect(moved.ok).toBe(true);
    if (!moved.ok) throw new Error("expected token move");
    expect(moved.value.revision).toBe(revision + 2);
    expect(moved.value.tokens[0]).toMatchObject({ tokenId: token.tokenId, x: 0.5, y: 0.5 });

    const staleMove = await h.campaigns.moveToken(ctxFor(h.users.gm), {
      sceneId,
      tokenId: token.tokenId,
      expectedSceneRevision: revision + 1,
      x: 0.1,
      y: 0.1,
      idempotencyKey: randomUUID(),
    });
    expect(staleMove).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "conflict", latestRevision: revision + 2 }),
    });

    const removed = await h.campaigns.removeToken(ctxFor(h.users.gm), {
      sceneId,
      tokenId: token.tokenId,
      expectedSceneRevision: revision + 2,
      idempotencyKey: randomUUID(),
    });
    expect(removed.ok).toBe(true);
    if (!removed.ok) throw new Error("expected token remove");
    expect(removed.value.revision).toBe(revision + 3);
    expect(removed.value.tokens).toEqual([]);

    const again = await h.campaigns.removeToken(ctxFor(h.users.gm), {
      sceneId,
      tokenId: token.tokenId,
      expectedSceneRevision: revision + 3,
      idempotencyKey: randomUUID(),
    });
    expect(again).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });
  });

  it("updateScene swaps the background under the revision guard", async () => {
    const campaignId = await createCampaign();
    const firstFile = await uploadBackground(campaignId);
    const secondFile = await uploadBackground(campaignId);
    const { sceneId, revision } = await createScene(campaignId, firstFile);

    const updated = await h.campaigns.updateScene(ctxFor(h.users.gm), {
      sceneId,
      expectedSceneRevision: revision,
      backgroundFileId: secondFile,
      idempotencyKey: randomUUID(),
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) throw new Error("expected scene update");
    expect(updated.value.revision).toBe(revision + 1);
    expect(updated.value.backgroundFileId).toBe(secondFile);

    const stale = await h.campaigns.updateScene(ctxFor(h.users.gm), {
      sceneId,
      expectedSceneRevision: revision,
      backgroundFileId: firstFile,
      idempotencyKey: randomUUID(),
    });
    expect(stale).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "conflict", latestRevision: revision + 1 }),
    });

    const otherCampaignId = await createCampaign();
    const foreignFileId = await uploadBackground(otherCampaignId);
    const rejected = await h.campaigns.updateScene(ctxFor(h.users.gm), {
      sceneId,
      expectedSceneRevision: revision + 1,
      backgroundFileId: foreignFileId,
      idempotencyKey: randomUUID(),
    });
    expect(rejected).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });
  });
});
