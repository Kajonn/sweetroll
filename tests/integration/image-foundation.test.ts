import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildI6Harness, ctxFor, type I6Harness } from "./i6-app.js";

const describeDB = process.env.TEST_DATABASE_URL ? describe : describe.skip;
describeDB("M0 authorized, scanned and retained images", () => {
  let h: I6Harness, dir: string;
  let verdict: "clean" | "infected" | "unavailable" = "clean";
  const scanImage = vi.fn(async () => { if (verdict === "unavailable") throw new Error("Unavailable"); return verdict; });
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "sweetroll-m0-")); process.env.SWEETROLL_MEDIA_DIR = dir;
    h = await buildI6Harness({ scanImage });
  });
  afterAll(async () => { await h?.close(); delete process.env.SWEETROLL_MEDIA_DIR; if (dir) await rm(dir, { recursive: true, force: true }); });
  async function fixture() {
    const c = await h.campaigns.create(ctxFor(h.users.gm), { title: "M0 image test", systemVersionId: h.versionId, idempotencyKey: randomUUID() });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    const bytes = await sharp({ create: { width: 20, height: 10, channels: 3, background: "blue" } }).jpeg().withMetadata({ exif: { IFD0: { Artist: "Private" } } }).toBuffer();
    return { campaignId: c.value.campaignId, name: "A landscape", contentType: "image/jpeg" as const, dataBase64: bytes.toString("base64"), idempotencyKey: randomUUID() };
  }
  it("scans and strips private metadata before storing, then replays without rescanning", async () => {
    verdict = "clean"; const input = await fixture();
    const uploaded = await h.campaigns.uploadImage(ctxFor(h.users.gm), input);
    expect(uploaded.ok).toBe(true); if (!uploaded.ok) return;
    const opened = await h.campaigns.openImage(ctxFor(h.users.gm), { fileId: uploaded.value.fileId });
    expect(opened.ok).toBe(true); if (!opened.ok) return;
    expect((await sharp(opened.value.bytes).metadata()).exif).toBeUndefined();
    verdict = "unavailable";
    expect(await h.campaigns.uploadImage(ctxFor(h.users.gm), input)).toEqual(uploaded);
  });
  it("rejects infected/scanner-unavailable uploads without leaving media rows", async () => {
    for (const state of ["infected", "unavailable"] as const) {
      verdict = state; const input = await fixture();
      expect(await h.campaigns.uploadImage(ctxFor(h.users.gm), input)).toMatchObject({ ok: false, error: { code: state === "infected" ? "unprocessable" : "temporarily_unavailable" } });
      expect((await h.pool.query("SELECT count(*)::int n FROM media_files WHERE campaign_id=$1", [input.campaignId])).rows[0].n).toBe(0);
    }
  });
  it("authorizes before scanning another campaign's image bytes", async () => {
    verdict = "clean"; const input = await fixture(); const before = scanImage.mock.calls.length;
    expect(await h.campaigns.uploadImage(ctxFor(h.users.outsider), input)).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(scanImage.mock.calls.length).toBe(before);
  });
  it("enforces retained campaign byte quotas inside the campaign lock", async () => {
    verdict = "clean"; const input = await fixture();
    await h.pool.query("INSERT INTO media_files(campaign_id,owner_id,name,media_type,size_bytes,width,height,checksum,storage_key) VALUES ($1,$2,'quota fixture','image/png',104857600,1,1,'fixture',$3)", [input.campaignId,h.users.gm.actorId,randomUUID()]);
    expect(await h.campaigns.uploadImage(ctxFor(h.users.gm), input)).toMatchObject({ ok: false, error: { code: "too_large" } });
  });
  it("restores matching metadata and private bytes from a scoped backup", async () => {
    verdict = "clean"; const input = await fixture();
    const uploaded = await h.campaigns.uploadImage(ctxFor(h.users.gm), input);
    if (!uploaded.ok) throw new Error("Upload failed");
    const row = (await h.pool.query("SELECT row_to_json(media_files) saved FROM media_files WHERE id=$1", [uploaded.value.fileId])).rows[0].saved;
    const path = join(dir, row.storage_key);
    const backup = await readFile(path);
    await h.pool.query("DELETE FROM media_files WHERE id=$1", [uploaded.value.fileId]);
    await unlink(path);
    expect((await h.campaigns.openImage(ctxFor(h.users.gm), { fileId: uploaded.value.fileId })).ok).toBe(false);
    await writeFile(path, backup, { mode: 0o600, flag: "wx" });
    await h.pool.query("INSERT INTO media_files SELECT * FROM json_populate_record(NULL::media_files,$1::json)", [JSON.stringify(row)]);
    const restored = await h.campaigns.openImage(ctxFor(h.users.gm), { fileId: uploaded.value.fileId });
    expect(restored.ok).toBe(true);
    if (restored.ok) { expect(restored.value.file).toEqual(uploaded.value); expect(restored.value.bytes.equals(backup)).toBe(true); }
  });
  it("cannot delete an in-use background and preserves its bytes", async () => {
    verdict = "clean"; const input = await fixture();
    const file = await h.campaigns.uploadImage(ctxFor(h.users.gm), input); if (!file.ok) throw new Error("Upload failed");
    const scene = await h.campaigns.createScene(ctxFor(h.users.gm), { campaignId: input.campaignId, backgroundFileId: file.value.fileId, idempotencyKey: randomUUID() });
    expect(scene.ok).toBe(true);
    expect(await h.campaigns.deleteImage(ctxFor(h.users.gm), { fileId: file.value.fileId, expectedRevision: 1, idempotencyKey: randomUUID() })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect((await h.campaigns.openImage(ctxFor(h.users.gm), { fileId: file.value.fileId })).ok).toBe(true);
  });
});
