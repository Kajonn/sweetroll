import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildI6Harness, ctxFor, type I6Harness } from "./i6-app.js";
const gate = vi.hoisted(() => ({ afterRead: null as null | (() => Promise<void>) }));
vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, readFile: async (...args: Parameters<typeof fs.readFile>) => { const bytes = await fs.readFile(...args); const callback = gate.afterRead; gate.afterRead = null; if (callback) await callback(); return bytes; } };
});
const db = process.env.TEST_DATABASE_URL ? describe : describe.skip;
db("M3 scene background library and safe replacement", () => {
  let h: I6Harness, root: string, campaignId: string, fileId: string, secondId: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "sweetroll-background-")); process.env.SWEETROLL_MEDIA_DIR = root; h = await buildI6Harness();
    const c = await h.campaigns.create(ctxFor(h.users.gm), { title: "M3 backgrounds", description: "", systemVersionId: h.versionId, idempotencyKey: randomUUID() }); if (!c.ok) throw Error("campaign"); campaignId = c.value.campaignId;
    const png = (await sharp({ create: { width: 500, height: 300, channels: 3, background: "#81352e" } }).png().toBuffer()).toString("base64");
    for (const name of ["Cave", "Forest"]) { const r = await h.campaigns.uploadImage(ctxFor(h.users.gm), { campaignId, name, contentType: "image/png", dataBase64: png, idempotencyKey: randomUUID() }); if (!r.ok) throw Error("upload"); if (name === "Cave") fileId = r.value.fileId; else secondId = r.value.fileId; }
    await h.pool.query("INSERT INTO campaign_members(campaign_id,user_id,role,status,generation) VALUES($1,$2,'player','active',1)", [campaignId, h.users.player.actorId]);
  });
  afterAll(async () => { gate.afterRead = null; await h?.close(); delete process.env.SWEETROLL_MEDIA_DIR; if (root) await rm(root, { recursive: true, force: true }); });
  function request(path: string, gm = true) { return h.app.inject({ method: "GET", url: path, headers: { cookie: (gm ? h.users.gm : h.users.player).cookie } }); }
  it("atomically conceals a changed background and clears tokens, preserving same-file and stale writes", async () => {
    const made = await h.campaigns.createScene(ctxFor(h.users.gm), { campaignId, backgroundFileId: fileId, idempotencyKey: randomUUID() }); if (!made.ok) throw Error("scene");
    const sceneId = made.value.sceneId;
    const fogged = await h.campaigns.applyFogEdit(ctxFor(h.users.gm), { sceneId, expectedSceneRevision: 1, op: { mode: "reveal", runs: [{ x: .5, y: .5, r: .4 }] }, idempotencyKey: randomUUID() }); expect(fogged.ok).toBe(true);
    const placed = await h.campaigns.placeToken(ctxFor(h.users.gm), { sceneId, expectedSceneRevision: 2, label: "Hero", x: .5, y: .5, size: .05, visible: true, imageFileId: null, idempotencyKey: randomUUID() }); if (!placed.ok) throw Error("token");
    const unchanged = await h.campaigns.updateScene(ctxFor(h.users.gm), { sceneId, expectedSceneRevision: 3, backgroundFileId: fileId, idempotencyKey: randomUUID() }); expect(unchanged).toMatchObject({ ok: true, value: { fog: placed.value.fog, tokens: placed.value.tokens, revision: 4 } });
    const stale = await h.campaigns.updateScene(ctxFor(h.users.gm), { sceneId, expectedSceneRevision: 3, backgroundFileId: secondId, idempotencyKey: randomUUID() }); expect(stale).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await h.campaigns.openScene(ctxFor(h.users.gm), { sceneId })).toEqual(unchanged);
    const input = { sceneId, expectedSceneRevision: 4, backgroundFileId: secondId, idempotencyKey: randomUUID() };
    const changed = await h.campaigns.updateScene(ctxFor(h.users.gm), input); expect(changed).toMatchObject({ ok: true, value: { backgroundFileId: secondId, fog: [], tokens: [], revision: 5 } });
    expect(await h.campaigns.updateScene(ctxFor(h.users.gm), input)).toEqual(changed);
  });
  it("lists bounded GM-only metadata and safe thumbnails with no cross-parent or player reads", async () => {
    const first = await request(`/campaigns/${campaignId}/images?limit=1`); expect(first.statusCode).toBe(200); expect(first.headers["cache-control"]).toContain("no-store");
    const page = first.json(); expect(page.images).toHaveLength(1); expect(page.nextCursor).toBeTruthy(); expect(page.images[0]).not.toHaveProperty("storageKey");
    const next = (await request(`/campaigns/${campaignId}/images?limit=1&cursor=${page.nextCursor}`)).json(); expect(next.images).toHaveLength(1); expect(next.images[0].fileId).not.toBe(page.images[0].fileId);
    expect((await request(`/campaigns/${campaignId}/images`, false)).statusCode).toBe(404);
    const thumb = await request(`/campaigns/${campaignId}/images/${fileId}/thumbnail`); expect(thumb.statusCode).toBe(200); expect(thumb.headers["content-type"]).toContain("image/webp"); expect(thumb.rawPayload.length).toBeLessThanOrEqual(65536); const metadata = await sharp(thumb.rawPayload).metadata(); expect(metadata.width).toBeLessThanOrEqual(256);
    expect((await request(`/campaigns/${campaignId}/images/${fileId}/thumbnail`, false)).statusCode).toBe(404);
    expect((await request(`/campaigns/${randomUUID()}/images/${fileId}/thumbnail`)).statusCode).toBe(404);
    const scenes = await request(`/campaigns/${campaignId}/scenes?limit=1`); expect(scenes.statusCode).toBe(200); expect(scenes.json().scenes).toHaveLength(1); expect(scenes.json().scenes[0]).not.toHaveProperty("fog");
    expect((await request(`/campaigns/${campaignId}/scenes`, false)).statusCode).toBe(404);
  });
  it("rechecks GM authority after reading original bytes", async () => {
    await h.pool.query("INSERT INTO campaign_members(campaign_id,user_id,role,status,generation) VALUES($1,$2,'co_gm','active',1)", [campaignId, h.users.other.actorId]);
    gate.afterRead = async () => { await h.pool.query("UPDATE campaign_members SET role='player' WHERE campaign_id=$1 AND user_id=$2", [campaignId, h.users.other.actorId]); };
    expect(await h.campaigns.openImage(ctxFor(h.users.other), { fileId })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});
