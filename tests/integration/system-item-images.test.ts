import { calculatePackageChecksum } from "../../src/systems/implementation/package/canonical.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildI6Harness, type I6Harness } from "./i6-app.js";
import { derivedTemplateDocument } from "../../src/systems/implementation/package/fixtures/campaign-derived.js";

const db = process.env.TEST_DATABASE_URL ? describe : describe.skip;
db("M2 system item image ownership and portable publication", () => {
  let h: I6Harness, root: string, png: string;
  let scan: "clean" | "infected" = "clean";
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "sweetroll-system-art-"));
    process.env.SWEETROLL_MEDIA_DIR = root;
    h = await buildI6Harness({ document: derivedTemplateDocument(), scanImage: async () => scan });
    png = (await sharp({ create: { width: 40, height: 20, channels: 3, background: "#695538" } }).png().withMetadata({ exif: { IFD0: { Artist: "Private art fixture" } } }).toBuffer()).toString("base64");
  });
  afterAll(async () => { await h?.close(); delete process.env.SWEETROLL_MEDIA_DIR; if (root) await rm(root, { recursive: true, force: true }); });
  async function request(method: "GET" | "PUT" | "POST", url: string, payload?: object, cookie = h.users.gm.cookie) {
    return h.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  }
  async function system() {
    const r = await request("POST", "/systems", { source: { kind: "clone", versionId: h.versionId }, idempotencyKey: randomUUID() });
    expect(r.statusCode, r.body).toBe(201); return r.json().workspace;
  }
  async function upload(workspace: any, description = "A steel sword") {
    const payload = { expectedRevision: workspace.draft.revision, description, contentType: "image/png", dataBase64: png, idempotencyKey: randomUUID() };
    const url = `/systems/${workspace.system.systemId}/templates/sword/image`;
    const r = await request("PUT", url, payload);
    expect(r.statusCode, r.body).toBe(200); return { state: r.json(), payload, url };
  }
  it("scans, attaches and freezes exact art through publication and later draft replacement", async () => {
    const workspace = await system(), { state, payload, url } = await upload(workspace);
    expect(state).toMatchObject({ revision: workspace.draft.revision + 1, image: { description: "A steel sword", width: 40, height: 20 } });
    expect((await request("PUT", url, payload)).json()).toMatchObject({ revision: state.revision, image: state.image });
    const read = await request("GET", `${url}/${state.image.fileId}`);
    expect(read.statusCode).toBe(200); expect(read.headers["cache-control"]).toBe("private, no-store");
    expect((await sharp(read.rawPayload).metadata()).exif).toBeUndefined();
    expect(createHash("sha256").update(read.rawPayload).digest("hex")).toBe(state.image.checksum);
    const published = await request("POST", `/systems/${workspace.system.systemId}/publish`, { expectedRevision: state.revision, semanticVersion: "1.0.0", releaseNotes: "", acknowledgeBreaking: true, idempotencyKey: randomUUID() });
    expect(published.statusCode, published.body).toBe(200);
    const version = published.json().version;
    expect(version.package.templates.find((t: any) => t.id === "sword").image).toEqual(state.image);
    const changed = await upload({ ...workspace, draft: { revision: state.revision } }, "A copper sword");
    expect(changed.state.image.fileId).not.toBe(state.image.fileId);
    const pinned = await request("GET", `/system-versions/${version.versionId}/templates/sword/image/${state.image.fileId}`);
    expect(pinned.statusCode).toBe(200); expect(pinned.rawPayload).toEqual(read.rawPayload);
  });
  it("clones and exports a complete bounded manifest, then rescans and imports local art", async () => {
    const workspace = await system(), { state } = await upload(workspace);
    const published = await request("POST", `/systems/${workspace.system.systemId}/publish`, { expectedRevision: state.revision, semanticVersion: "1.0.0", releaseNotes: "", acknowledgeBreaking: true, idempotencyKey: randomUUID() });
    expect(published.statusCode).toBe(200);
    const versionId = published.json().version.versionId;
    const cloned = await request("POST", "/systems", { source: { kind: "clone", versionId }, idempotencyKey: randomUUID() });
    expect(cloned.statusCode).toBe(201);
    const clonedId = cloned.json().workspace.system.systemId;
    expect((await request("GET", `/systems/${clonedId}/templates/sword/image/${state.image.fileId}`)).statusCode).toBe(200);
    const exported = await request("GET", `/system-versions/${versionId}/export`);
    expect(exported.statusCode).toBe(200);
    const bundle = exported.json(); expect(bundle.images).toHaveLength(1);
    expect(bundle.images[0]).toMatchObject({ fileId: state.image.fileId, checksum: state.image.checksum, contentType: "image/png" });
    expect(createHash("sha256").update(Buffer.from(bundle.images[0].dataBase64, "base64")).digest("hex")).toBe(state.image.checksum);
    const imported = await request("POST", "/systems", { source: { kind: "import", content: JSON.stringify(bundle) }, idempotencyKey: randomUUID() });
    expect(imported.statusCode, imported.body).toBe(201);
    const copy = imported.json().workspace;
    const image = copy.draft.document.templates.find((t: any) => t.id === "sword").image;
    expect(image.fileId).not.toBe(state.image.fileId);
    expect((await request("GET", `/systems/${copy.system.systemId}/templates/sword/image/${image.fileId}`)).statusCode).toBe(200);
    const contradictory = structuredClone(bundle);
    const original = contradictory.package.templates.find((t: any) => t.id === "sword");
    contradictory.package.templates.push({ id: "other_art", kind: "item", label: "Other", fields: [], grantedActions: [], image: { ...original.image } });
    original.image.width += 1;
    contradictory.package.integrity.checksum = calculatePackageChecksum(contradictory.package);
    expect((await request("POST", "/systems", { source: { kind: "import", content: JSON.stringify(contradictory) }, idempotencyKey: randomUUID() })).statusCode).toBe(422);
    const missing = { ...bundle, images: [] };
    expect((await request("POST", "/systems", { source: { kind: "import", content: JSON.stringify(missing) }, idempotencyKey: randomUUID() })).statusCode).toBe(422);
    scan = "infected";
    try { expect((await request("POST", "/systems", { source: { kind: "import", content: JSON.stringify(bundle) }, idempotencyKey: randomUUID() })).statusCode).toBe(422); }
    finally { scan = "clean"; }
  });
  it("denies foreign draft reads and guessed references without disclosing or changing art", async () => {
    const first = await system(), second = await system();
    const { state, url } = await upload(first);
    expect((await request("GET", `${url}/${state.image.fileId}`, undefined, h.users.player.cookie)).statusCode).toBe(404);
    const forged = structuredClone(second.draft.document);
    forged.templates.find((t: any) => t.id === "sword").image = state.image;
    const denied = await request("PUT", `/systems/${second.system.systemId}/draft`, { expectedRevision: second.draft.revision, document: forged });
    expect(denied.statusCode).toBe(422);
    const unchanged = (await request("GET", `/systems/${second.system.systemId}`)).json().workspace;
    expect(unchanged.draft.revision).toBe(second.draft.revision);
    expect(unchanged.draft.document.templates.find((t: any) => t.id === "sword")).not.toHaveProperty("image");
  });
});
