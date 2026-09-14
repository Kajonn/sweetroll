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
