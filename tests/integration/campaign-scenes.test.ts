import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
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

describeWithDatabase("display pairing + redacted projection (Task 3 display commands)", () => {
  let h: I6Harness;
  let mediaDir: string;
  let displayDir: string;
  let redPngBase64: string;

  beforeAll(async () => {
    mediaDir = await mkdtemp(join(tmpdir(), "sweetroll-display-media-"));
    displayDir = await mkdtemp(join(tmpdir(), "sweetroll-display-deriv-"));
    process.env.SWEETROLL_MEDIA_DIR = mediaDir;
    process.env.SWEETROLL_DISPLAY_DIR = displayDir;
    h = await buildI6Harness();
    const bytes = await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 1 } },
    })
      .png()
      .toBuffer();
    redPngBase64 = bytes.toString("base64");
  });

  afterAll(async () => {
    await h.close();
    delete process.env.SWEETROLL_MEDIA_DIR;
    delete process.env.SWEETROLL_DISPLAY_DIR;
    await rm(mediaDir, { recursive: true, force: true });
    await rm(displayDir, { recursive: true, force: true });
  });

  async function createCampaign(): Promise<string> {
    const created = await h.campaigns.create(ctxFor(h.users.gm), {
      systemVersionId: h.versionId,
      title: `Display ${randomUUID()}`,
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

  async function uploadBackground(campaignId: string): Promise<{ fileId: string; revision: number }> {
    const uploaded = await h.campaigns.uploadImage(ctxFor(h.users.gm), {
      campaignId,
      name: "arena",
      contentType: "image/png",
      dataBase64: redPngBase64,
      idempotencyKey: randomUUID(),
    });
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) throw new Error("background upload failed");
    return { fileId: uploaded.value.fileId, revision: uploaded.value.revision };
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

  async function pairAndRedeem(campaignId: string): Promise<{ displayId: string; secret: string }> {
    const paired = await h.campaigns.pairDisplay(ctxFor(h.users.gm), { campaignId });
    expect(paired.ok).toBe(true);
    if (!paired.ok) throw new Error("pair failed");
    const redeemed = await h.campaigns.redeemDisplayCode({ code: paired.value.code });
    expect(redeemed.ok).toBe(true);
    if (!redeemed.ok) throw new Error("redeem failed");
    return redeemed.value;
  }

  async function originalBytes(fileId: string): Promise<Buffer> {
    const rows = await h.pool.query(`SELECT storage_key FROM media_files WHERE id = $1`, [fileId]);
    const storageKey = rows.rows[0]?.storage_key as string;
    return await readFile(join(mediaDir, storageKey));
  }

  async function derivativeFiles(sceneId?: string): Promise<string[]> {
    const names = (await readdir(displayDir)).filter((name) => name.endsWith(".png")).sort();
    return sceneId === undefined ? names : names.filter((name) => name.startsWith(`${sceneId}-rev`));
  }

  it("pair mints a 6-char code and redeem issues a credential that renders the projection once", async () => {
    const campaignId = await createCampaign();
    const { fileId } = await uploadBackground(campaignId);
    const { sceneId } = await createScene(campaignId, fileId);

    const paired = await h.campaigns.pairDisplay(ctxFor(h.users.gm), { campaignId });
    expect(paired.ok).toBe(true);
    if (!paired.ok) throw new Error("expected pair");
    expect(paired.value.code).toMatch(/^[A-Z0-9]{6}$/);

    const redeemed = await h.campaigns.redeemDisplayCode({ code: paired.value.code });
    expect(redeemed.ok).toBe(true);
    if (!redeemed.ok) throw new Error("expected redeem");
    const { displayId, secret } = redeemed.value;
    expect(displayId).toEqual(expect.any(String));
    expect(secret).toEqual(expect.any(String));

    const projection = await h.campaigns.getDisplayProjection({ displayId, secret, sceneId });
    expect(projection.ok).toBe(true);
    if (!projection.ok) throw new Error("expected projection");
    expect(projection.value).toMatchObject({ sceneId, sceneRevision: 1, tokens: [] });
    expect(projection.value.imageUrl).toBe(`/displays/${displayId}/scenes/${sceneId}/image?rev=1`);

    const secondRedeem = await h.campaigns.redeemDisplayCode({ code: paired.value.code });
    expect(secondRedeem).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });
  });

  it("expired and unknown codes redeem as not_found", async () => {
    const campaignId = await createCampaign();
    const paired = await h.campaigns.pairDisplay(ctxFor(h.users.gm), { campaignId });
    expect(paired.ok).toBe(true);
    if (!paired.ok) throw new Error("expected pair");

    const codeHash = createHash("sha256").update(paired.value.code, "utf8").digest("hex");
    await h.pool.query(`UPDATE display_codes SET expires_at = now() - interval '1 minute' WHERE code_hash = $1`, [
      codeHash,
    ]);
    const expired = await h.campaigns.redeemDisplayCode({ code: paired.value.code });
    expect(expired).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });

    const unknown = await h.campaigns.redeemDisplayCode({ code: "ZZZZZZ" });
    expect(unknown).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });
  });

  it("unknown credential, wrong secret and unknown scene collapse to not_found", async () => {
    const campaignId = await createCampaign();
    const { fileId } = await uploadBackground(campaignId);
    const { sceneId } = await createScene(campaignId, fileId);
    const { displayId, secret } = await pairAndRedeem(campaignId);

    const unknownDisplay = await h.campaigns.getDisplayProjection({
      displayId: randomUUID(),
      secret,
      sceneId,
    });
    expect(unknownDisplay).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });

    const wrongSecret = await h.campaigns.getDisplayProjection({
      displayId,
      secret: "wrong-secret-value",
      sceneId,
    });
    expect(wrongSecret).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });

    const unknownScene = await h.campaigns.getDisplayProjection({
      displayId,
      secret,
      sceneId: randomUUID(),
    });
    expect(unknownScene).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });
  });

  it("projection removes fog-concealed pixels server-side and omits hidden/fog-covered tokens", async () => {
    const campaignId = await createCampaign();
    const { fileId } = await uploadBackground(campaignId);
    const { sceneId, revision } = await createScene(campaignId, fileId);

    const revealed = await h.campaigns.applyFogEdit(ctxFor(h.users.gm), {
      sceneId,
      expectedSceneRevision: revision,
      op: { mode: "reveal", runs: [{ x: 0.5, y: 0.5, r: 0.2 }] },
      idempotencyKey: randomUUID(),
    });
    expect(revealed.ok).toBe(true);
    if (!revealed.ok) throw new Error("expected fog reveal");

    const scout = await h.campaigns.placeToken(ctxFor(h.users.gm), {
      sceneId,
      expectedSceneRevision: revealed.value.revision,
      label: "Scout",
      x: 0.5,
      y: 0.5,
      size: 0.05,
      visible: true,
      imageFileId: null,
      idempotencyKey: randomUUID(),
    });
    expect(scout.ok).toBe(true);
    if (!scout.ok) throw new Error("expected scout place");
    const scoutId = scout.value.tokens.find((t) => t.label === "Scout")?.tokenId;
    expect(scoutId).toEqual(expect.any(String));

    const corner = await h.campaigns.placeToken(ctxFor(h.users.gm), {
      sceneId,
      expectedSceneRevision: scout.value.revision,
      label: "Corner",
      x: 0.05,
      y: 0.05,
      size: 0.05,
      visible: true,
      imageFileId: null,
      idempotencyKey: randomUUID(),
    });
    expect(corner.ok).toBe(true);
    if (!corner.ok) throw new Error("expected corner place");
    const cornerId = corner.value.tokens.find((t) => t.label === "Corner")?.tokenId;
    expect(cornerId).toEqual(expect.any(String));

    const ghost = await h.campaigns.placeToken(ctxFor(h.users.gm), {
      sceneId,
      expectedSceneRevision: corner.value.revision,
      label: "Ghost",
      x: 0.5,
      y: 0.5,
      size: 0.05,
      visible: false,
      imageFileId: null,
      idempotencyKey: randomUUID(),
    });
    expect(ghost.ok).toBe(true);
    if (!ghost.ok) throw new Error("expected ghost place");
    const hiddenId = ghost.value.tokens.find((t) => t.label === "Ghost")?.tokenId;
    expect(hiddenId).toEqual(expect.any(String));

    const { displayId, secret } = await pairAndRedeem(campaignId);
    const projection = await h.campaigns.getDisplayProjection({ displayId, secret, sceneId });
    expect(projection.ok).toBe(true);
    if (!projection.ok) throw new Error("expected projection");
    expect(projection.value.sceneRevision).toBe(ghost.value.revision);
    expect(projection.value.tokens).toEqual([
      { tokenId: scoutId, label: "Scout", x: 0.5, y: 0.5, size: 0.05, imageUrl: null },
    ]);
    expect(projection.value.tokens.find((t) => t.tokenId === hiddenId)).toBeUndefined();
    expect(projection.value.tokens.find((t) => t.tokenId === cornerId)).toBeUndefined();

    // The derivative is cached on disk keyed by (sceneId, revision) and its
    // bytes differ from the original: concealed pixels are gone, not overlaid.
    const files = await derivativeFiles(sceneId);
    expect(files).toHaveLength(1);
    const derivative = await readFile(join(displayDir, files[0] as string));
    const original = await originalBytes(fileId);
    expect(derivative.equals(original)).toBe(false);
    const { data, info } = await sharp(derivative).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(64);
    expect(info.height).toBe(64);
    const cornerIdx = 0;
    expect([data[cornerIdx], data[cornerIdx + 1], data[cornerIdx + 2]]).toEqual([0, 0, 0]);
    const centerIdx = (32 * info.width + 32) * 4;
    expect([data[centerIdx], data[centerIdx + 1], data[centerIdx + 2]]).toEqual([200, 30, 30]);

    // A conceal stroke bumps the revision, blanks the revealed token list and
    // caches a second derivative instead of overwriting the first.
    const concealed = await h.campaigns.applyFogEdit(ctxFor(h.users.gm), {
      sceneId,
      expectedSceneRevision: ghost.value.revision,
      op: { mode: "conceal", runs: [{ x: 0.5, y: 0.5, r: 0.5 }] },
      idempotencyKey: randomUUID(),
    });
    expect(concealed.ok).toBe(true);
    if (!concealed.ok) throw new Error("expected fog conceal");
    const after = await h.campaigns.getDisplayProjection({ displayId, secret, sceneId });
    expect(after.ok).toBe(true);
    if (!after.ok) throw new Error("expected projection after conceal");
    expect(after.value.sceneRevision).toBe(concealed.value.revision);
    expect(after.value.tokens).toEqual([]);
    expect(await derivativeFiles(sceneId)).toHaveLength(2);
  });

  it("revoke kills the credential and denies players pairing or revoking", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);
    const { fileId } = await uploadBackground(campaignId);
    const { sceneId } = await createScene(campaignId, fileId);
    const { displayId, secret } = await pairAndRedeem(campaignId);

    const playerPair = await h.campaigns.pairDisplay(ctxFor(h.users.player), { campaignId });
    expect(playerPair).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });
    const playerRevoke = await h.campaigns.revokeDisplay(ctxFor(h.users.player), { displayId });
    expect(playerRevoke).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });

    // The player's denied revoke changed nothing: the credential still works.
    const before = await h.campaigns.getDisplayProjection({ displayId, secret, sceneId });
    expect(before.ok).toBe(true);

    const revoked = await h.campaigns.revokeDisplay(ctxFor(h.users.gm), { displayId });
    expect(revoked.ok).toBe(true);

    const after = await h.campaigns.getDisplayProjection({ displayId, secret, sceneId });
    expect(after).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });

    const again = await h.campaigns.revokeDisplay(ctxFor(h.users.gm), { displayId });
    expect(again).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });
  });

  it("rejects a cross-campaign scene through another campaign credential", async () => {
    const campaignId = await createCampaign();
    const { fileId } = await uploadBackground(campaignId);
    const { sceneId } = await createScene(campaignId, fileId);

    const otherCampaignId = await createCampaign();
    const other = await pairAndRedeem(otherCampaignId);

    const crossed = await h.campaigns.getDisplayProjection({
      displayId: other.displayId,
      secret: other.secret,
      sceneId,
    });
    expect(crossed).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });
  });

  it("fails closed when the pinned background is gone (orphaned pin)", async () => {
    const campaignId = await createCampaign();
    const { fileId, revision } = await uploadBackground(campaignId);
    const { sceneId } = await createScene(campaignId, fileId);
    const { displayId, secret } = await pairAndRedeem(campaignId);

    // Row deleted while pinned (no FK): the projection collapses to not_found.
    const deleted = await h.campaigns.deleteImage(ctxFor(h.users.gm), {
      fileId,
      expectedRevision: revision,
      idempotencyKey: randomUUID(),
    });
    expect(deleted.ok).toBe(true);
    const orphaned = await h.campaigns.getDisplayProjection({ displayId, secret, sceneId });
    expect(orphaned).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });

    // Row present but bytes missing from disk: same fail-closed collapse.
    const { fileId: secondFile } = await uploadBackground(campaignId);
    const second = await createScene(campaignId, secondFile);
    const rows = await h.pool.query(`SELECT storage_key FROM media_files WHERE id = $1`, [secondFile]);
    await unlink(join(mediaDir, rows.rows[0].storage_key as string));
    const missingBytes = await h.campaigns.getDisplayProjection({
      displayId,
      secret,
      sceneId: second.sceneId,
    });
    expect(missingBytes).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });
  });
});

describeWithDatabase("Task 4 transport support reads (openScene, openImage, credentials, image bytes)", () => {
  let h: I6Harness;
  let mediaDir: string;
  let displayDir: string;
  let redPngBase64: string;

  beforeAll(async () => {
    mediaDir = await mkdtemp(join(tmpdir(), "sweetroll-task4-media-"));
    displayDir = await mkdtemp(join(tmpdir(), "sweetroll-task4-deriv-"));
    process.env.SWEETROLL_MEDIA_DIR = mediaDir;
    process.env.SWEETROLL_DISPLAY_DIR = displayDir;
    h = await buildI6Harness();
    const bytes = await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 1 } },
    })
      .png()
      .toBuffer();
    redPngBase64 = bytes.toString("base64");
  });

  afterAll(async () => {
    await h.close();
    delete process.env.SWEETROLL_MEDIA_DIR;
    delete process.env.SWEETROLL_DISPLAY_DIR;
    await rm(mediaDir, { recursive: true, force: true });
    await rm(displayDir, { recursive: true, force: true });
  });

  async function createCampaign(): Promise<string> {
    const created = await h.campaigns.create(ctxFor(h.users.gm), {
      systemVersionId: h.versionId,
      title: `Task4 ${randomUUID()}`,
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

  async function uploadBackground(campaignId: string): Promise<{ fileId: string; revision: number }> {
    const uploaded = await h.campaigns.uploadImage(ctxFor(h.users.gm), {
      campaignId,
      name: "arena",
      contentType: "image/png",
      dataBase64: redPngBase64,
      idempotencyKey: randomUUID(),
    });
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) throw new Error("background upload failed");
    return { fileId: uploaded.value.fileId, revision: uploaded.value.revision };
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

  async function pairAndRedeem(campaignId: string): Promise<{ displayId: string; secret: string }> {
    const paired = await h.campaigns.pairDisplay(ctxFor(h.users.gm), { campaignId });
    expect(paired.ok).toBe(true);
    if (!paired.ok) throw new Error("pair failed");
    const redeemed = await h.campaigns.redeemDisplayCode({ code: paired.value.code });
    expect(redeemed.ok).toBe(true);
    if (!redeemed.ok) throw new Error("redeem failed");
    return redeemed.value;
  }

  async function derivativeNames(sceneId?: string): Promise<string[]> {
    const names = (await readdir(displayDir)).filter((name) => name.endsWith(".png")).sort();
    return sceneId === undefined ? names : names.filter((name) => name.startsWith(`${sceneId}-rev`));
  }

  it("openScene returns the full view to GMs and 404s players, outsiders and unknown scenes", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);
    const { fileId } = await uploadBackground(campaignId);
    const { sceneId } = await createScene(campaignId, fileId);

    const opened = await h.campaigns.openScene(ctxFor(h.users.gm), { sceneId });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("expected openScene");
    expect(opened.value).toMatchObject({ sceneId, campaignId, revision: 1, backgroundFileId: fileId });

    const player = await h.campaigns.openScene(ctxFor(h.users.player), { sceneId });
    expect(player).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });
    const outsider = await h.campaigns.openScene(ctxFor(h.users.outsider), { sceneId });
    expect(outsider).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });
    const unknown = await h.campaigns.openScene(ctxFor(h.users.gm), { sceneId: randomUUID() });
    expect(unknown).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });
  });

  it("openImage returns the original bytes to GMs and 404s players and unknown files", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);
    const { fileId } = await uploadBackground(campaignId);

    const opened = await h.campaigns.openImage(ctxFor(h.users.gm), { fileId });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("expected openImage");
    expect(opened.value.file).toMatchObject({ fileId, campaignId, mediaType: "image/png" });
    expect(opened.value.contentType).toBe("image/png");
    expect(opened.value.bytes.equals(Buffer.from(redPngBase64, "base64"))).toBe(true);

    const player = await h.campaigns.openImage(ctxFor(h.users.player), { fileId });
    expect(player).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });
    const unknown = await h.campaigns.openImage(ctxFor(h.users.gm), { fileId: randomUUID() });
    expect(unknown).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });
  });

  it("listDisplayCredentials returns metadata without secrets and marks revokes", async () => {
    const campaignId = await createCampaign();
    await seedMember(campaignId, h.users.player.actorId);

    const empty = await h.campaigns.listDisplayCredentials(ctxFor(h.users.gm), { campaignId });
    expect(empty).toEqual({ ok: true, value: [] });

    const first = await pairAndRedeem(campaignId);
    const second = await pairAndRedeem(campaignId);

    const listed = await h.campaigns.listDisplayCredentials(ctxFor(h.users.gm), { campaignId });
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error("expected list");
    expect(listed.value).toHaveLength(2);
    expect(listed.value.map((entry) => entry.displayId).sort()).toEqual(
      [first.displayId, second.displayId].sort(),
    );
    for (const entry of listed.value) {
      expect(entry.campaignId).toBe(campaignId);
      expect(entry.revokedAt).toBeNull();
      expect(entry.createdAt).toBeInstanceOf(Date);
    }
    // No secret material anywhere in the metadata envelope.
    expect(JSON.stringify(listed.value)).not.toMatch(/secret/i);

    const player = await h.campaigns.listDisplayCredentials(ctxFor(h.users.player), { campaignId });
    expect(player).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });

    const revoked = await h.campaigns.revokeDisplay(ctxFor(h.users.gm), { displayId: first.displayId });
    expect(revoked.ok).toBe(true);
    const relisted = await h.campaigns.listDisplayCredentials(ctxFor(h.users.gm), { campaignId });
    expect(relisted.ok).toBe(true);
    if (!relisted.ok) throw new Error("expected relist");
    expect(relisted.value).toHaveLength(2);
    const revokedEntry = relisted.value.find((entry) => entry.displayId === first.displayId);
    expect(revokedEntry?.revokedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(relisted.value)).not.toMatch(/secret/i);
  });

  it("getDisplaySceneImage serves the cached derivative and rejects stale revs and bad secrets", async () => {
    const campaignId = await createCampaign();
    const { fileId } = await uploadBackground(campaignId);
    const { sceneId, revision } = await createScene(campaignId, fileId);
    const { displayId, secret } = await pairAndRedeem(campaignId);

    const projection = await h.campaigns.getDisplayProjection({ displayId, secret, sceneId });
    expect(projection.ok).toBe(true);
    const derivative = await readFile(join(displayDir, `${sceneId}-rev${revision}.png`));

    const image = await h.campaigns.getDisplaySceneImage({ displayId, secret, sceneId, rev: revision });
    expect(image.ok).toBe(true);
    if (!image.ok) throw new Error("expected scene image");
    expect(image.value.contentType).toBe("image/png");
    expect(image.value.revision).toBe(revision);
    expect(image.value.bytes.equals(derivative)).toBe(true);

    const stale = await h.campaigns.getDisplaySceneImage({ displayId, secret, sceneId, rev: revision + 1 });
    expect(stale).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });
    const badSecret = await h.campaigns.getDisplaySceneImage({
      displayId,
      secret: "wrong-secret",
      sceneId,
      rev: revision,
    });
    expect(badSecret).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });
  });

  it("getDisplayTokenImage serves original bytes only for visible, revealed, image-backed tokens", async () => {
    const campaignId = await createCampaign();
    const { fileId } = await uploadBackground(campaignId);
    const portrait = await uploadBackground(campaignId);
    const created = await createScene(campaignId, fileId);
    let revision = created.revision;
    const { sceneId } = created;

    // Scenes start fully fogged: reveal the token's neighborhood first.
    const revealed = await h.campaigns.applyFogEdit(ctxFor(h.users.gm), {
      sceneId,
      expectedSceneRevision: revision,
      op: { mode: "reveal", runs: [{ x: 0.5, y: 0.5, r: 0.4 }] },
      idempotencyKey: randomUUID(),
    });
    expect(revealed.ok).toBe(true);
    if (!revealed.ok) throw new Error("expected fog reveal");
    revision = revealed.value.revision;

    const placed = await h.campaigns.placeToken(ctxFor(h.users.gm), {
      sceneId,
      expectedSceneRevision: revision,
      label: "Hero",
      x: 0.5,
      y: 0.5,
      size: 0.1,
      visible: true,
      imageFileId: portrait.fileId,
      idempotencyKey: randomUUID(),
    });
    expect(placed.ok).toBe(true);
    if (!placed.ok) throw new Error("expected place");
    const tokenId = placed.value.tokens[0]?.tokenId;
    expect(tokenId).toEqual(expect.any(String));
    if (tokenId === undefined) throw new Error("expected token");

    const hidden = await h.campaigns.placeToken(ctxFor(h.users.gm), {
      sceneId,
      expectedSceneRevision: placed.value.revision,
      label: "Secret",
      x: 0.1,
      y: 0.1,
      size: 0.1,
      visible: false,
      imageFileId: portrait.fileId,
      idempotencyKey: randomUUID(),
    });
    expect(hidden.ok).toBe(true);
    if (!hidden.ok) throw new Error("expected hidden place");
    const hiddenId = hidden.value.tokens.find((token) => token.label === "Secret")?.tokenId;
    if (hiddenId === undefined) throw new Error("expected hidden token");

    const { displayId, secret } = await pairAndRedeem(campaignId);

    const image = await h.campaigns.getDisplayTokenImage({ displayId, secret, sceneId, tokenId });
    expect(image.ok).toBe(true);
    if (!image.ok) throw new Error("expected token image");
    expect(image.value.contentType).toBe("image/png");
    expect(image.value.bytes.equals(Buffer.from(redPngBase64, "base64"))).toBe(true);

    const concealed = await h.campaigns.getDisplayTokenImage({ displayId, secret, sceneId, tokenId: hiddenId });
    expect(concealed).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });
    const unknown = await h.campaigns.getDisplayTokenImage({
      displayId,
      secret,
      sceneId,
      tokenId: randomUUID(),
    });
    expect(unknown).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found" }) });
  });

  it("revoke purges cached derivatives and the next credential regenerates them lazily", async () => {
    const campaignId = await createCampaign();
    const { fileId } = await uploadBackground(campaignId);
    const { sceneId } = await createScene(campaignId, fileId);
    const { displayId, secret } = await pairAndRedeem(campaignId);

    const projection = await h.campaigns.getDisplayProjection({ displayId, secret, sceneId });
    expect(projection.ok).toBe(true);
    expect(await derivativeNames(sceneId)).toHaveLength(1);

    const revoked = await h.campaigns.revokeDisplay(ctxFor(h.users.gm), { displayId });
    expect(revoked.ok).toBe(true);
    // Revoke purged the campaign's cached derivatives (nothing else is
    // asserted about other campaigns' files here).
    expect(await derivativeNames(sceneId)).toHaveLength(0);

    // A fresh credential regenerates the derivative lazily on next projection.
    const next = await pairAndRedeem(campaignId);
    const again = await h.campaigns.getDisplayProjection({
      displayId: next.displayId,
      secret: next.secret,
      sceneId,
    });
    expect(again.ok).toBe(true);
    if (!again.ok) throw new Error("expected regenerated projection");
    expect(again.value.imageUrl).toBe(`/displays/${next.displayId}/scenes/${sceneId}/image?rev=1`);
    expect(await derivativeNames(sceneId)).toHaveLength(1);
  });
});
