import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildI6Harness, ctxFor, type I6Harness } from "./i6-app.js";
import { derivedTemplateDocument } from "../../src/systems/implementation/package/fixtures/campaign-derived.js";
const db = process.env.TEST_DATABASE_URL ? describe : describe.skip;
db("M2 retained character entry images", () => {
  let h: I6Harness, root: string, png: string, artVersion: string, systemArt: any;
  let holdDuplicate = false, releaseDuplicate = () => {}, enteredDuplicate = () => {};
  let duplicateGate: Promise<void> = Promise.resolve();
  const data = () => ({ description: "A silver blade", contentType: "image/png", dataBase64: png, idempotencyKey: randomUUID() });
  function request(who: keyof I6Harness["users"], method: "GET" | "PUT" | "POST" | "DELETE" | "PATCH", url: string, payload?: object) {
    return h.app.inject({ method, url, headers: { cookie: h.users[who].cookie }, ...(payload ? { payload } : {}) });
  }
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "sweetroll-character-art-")); process.env.SWEETROLL_MEDIA_DIR = root;
    h = await buildI6Harness({ document: derivedTemplateDocument(), wrapRuntime: runtime => ({ ...runtime, async resolve(input) {
      if (holdDuplicate && input.intent.kind === "observe") { holdDuplicate = false; enteredDuplicate(); await duplicateGate; }
      return runtime.resolve(input);
    } }) });
    await h.pool.query("UPDATE systems SET access='public' WHERE id=$1", [h.systemId]);
    png = (await sharp({ create: { width: 40, height: 20, channels: 3, background: "#52636b" } }).png().toBuffer()).toString("base64");
    const workspace = (await request("gm", "GET", `/systems/${h.systemId}`)).json().workspace;
    const added = await request("gm", "PUT", `/systems/${h.systemId}/templates/sword/image`, { ...data(), expectedRevision: workspace.draft.revision });
    expect(added.statusCode, added.body).toBe(200); systemArt = added.json();
    const published = await request("gm", "POST", `/systems/${h.systemId}/publish`, { expectedRevision: systemArt.revision, semanticVersion: "1.1.0", releaseNotes: "", acknowledgeBreaking: true, idempotencyKey: randomUUID() });
    expect(published.statusCode, published.body).toBe(200); artVersion = published.json().version.versionId;
  });
  afterAll(async () => { await h?.close(); delete process.env.SWEETROLL_MEDIA_DIR; if (root) await rm(root, { recursive: true, force: true }); });
  async function hero(version = artVersion) {
    const r = await h.characters.create(ctxFor(h.users.player), { name: "Armed explorer", systemVersionId: version, entityDefinitionId: "character", idempotencyKey: randomUUID() });
    if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.value;
  }
  async function sword() {
    const ch = await hero(), entryId = randomUUID();
    const r = await h.characters.apply(ctxFor(h.users.player), { kind: "addEntry", characterId: ch.characterId, expectedRevision: ch.revision, idempotencyKey: randomUUID(), entry: { entryId, slotId: "inventory", templateId: "sword", values: {} } });
    if (!r.ok) throw new Error(JSON.stringify(r.error)); return { ch: r.value.character, entryId };
  }
  it("moves the art pin with a rules version change and back on revert", async () => {
    // Placed at the version without art, then upgraded to the version that adds it.
    const ch = await hero(h.versionId), entryId = randomUUID();
    const placed = await h.characters.apply(ctxFor(h.users.player), { kind: "addEntry", characterId: ch.characterId, expectedRevision: ch.revision, idempotencyKey: randomUUID(), entry: { entryId, slotId: "inventory", templateId: "sword", values: {} } });
    if (!placed.ok) throw new Error(JSON.stringify(placed.error));
    const url = `/characters/${ch.characterId}/entries/${entryId}/image`;
    expect((await request("player", "GET", url)).json().image).toBeNull();
    const upgraded = await h.characters.manage(ctxFor(h.users.player), { kind: "changeVersion", characterId: ch.characterId, targetVersionId: artVersion, expectedRevision: placed.value.character.revision, idempotencyKey: randomUUID() });
    if (!upgraded.ok) throw new Error(JSON.stringify(upgraded.error));
    expect(upgraded.value.character.state.entries![entryId]!.image).toEqual(systemArt.image);
    expect((await request("player", "GET", url)).json().image).toEqual(systemArt.image);
    expect((await request("player", "GET", `${url}/${systemArt.image.fileId}`)).statusCode).toBe(200);
    const reverted = await h.characters.manage(ctxFor(h.users.player), { kind: "changeVersion", characterId: ch.characterId, targetVersionId: h.versionId, expectedRevision: upgraded.value.character.revision, idempotencyKey: randomUUID() });
    if (!reverted.ok) throw new Error(JSON.stringify(reverted.error));
    expect((await request("player", "GET", url)).json().image).toBeNull();
    expect((await request("player", "GET", `${url}/${systemArt.image.fileId}`)).statusCode).toBe(404);
  });

  it("rejects a duplicate whose rules snapshot changed before its retained art is copied", async () => {
    const { ch } = await sword();
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    enteredDuplicate = entered;
    duplicateGate = new Promise<void>(resolve => { releaseDuplicate = resolve; });
    holdDuplicate = true;
    const copying = h.characters.duplicate(ctxFor(h.users.player), { characterId: ch.characterId, idempotencyKey: randomUUID() });
    await waiting;
    try {
      const changed = await h.characters.apply(ctxFor(h.users.player), { kind: "setField", characterId: ch.characterId, fieldId: "ability", value: 14, expectedRevision: ch.revision, idempotencyKey: randomUUID() });
      expect(changed.ok).toBe(true);
    } finally { releaseDuplicate(); }
    expect(await copying).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
  it("pins exact published art and serves it through character authority after source changes", async () => {
    const { ch, entryId } = await sword();
    expect(ch.state.entries![entryId]!.image).toEqual(systemArt.image);
    const url = `/characters/${ch.characterId}/entries/${entryId}/image`;
    expect((await request("player", "GET", `${url}/${systemArt.image.fileId}`)).statusCode).toBe(200);
    for (const who of ["gm", "other", "outsider"] as const) expect((await request(who, "GET", `${url}/${systemArt.image.fileId}`)).statusCode).toBe(404);
    await request("gm", "PATCH", `/systems/${h.systemId}`, { access: "private", lifecycle: "archived" });
    try { expect((await request("player", "GET", `${url}/${systemArt.image.fileId}/thumbnail`)).statusCode).toBe(200); }
    finally { await request("gm", "PATCH", `/systems/${h.systemId}`, { access: "public", lifecycle: "active" }); }
  });
  it("keeps copy overrides independent of play, duplication, removal and entry UUID reuse", async () => {
    const { ch, entryId } = await sword(), url = `/characters/${ch.characterId}/entries/${entryId}/image`;
    const input = { ...data(), description: "A personal red blade", expectedCharacterRevision: ch.revision, expectedImageRevision: 0 };
    const r = await request("player", "PUT", url, input); expect(r.statusCode, r.body).toBe(200); const first = r.json();
    const played = await h.characters.apply(ctxFor(h.users.player), { kind: "setField", characterId: ch.characterId, fieldId: "ability", value: 13, expectedRevision: ch.revision, idempotencyKey: randomUUID() });
    if (!played.ok) throw new Error(JSON.stringify(played.error));
    expect((await request("player", "PUT", url, input)).json()).toMatchObject({ revision: first.revision, image: first.image });
    const copy = await h.characters.duplicate(ctxFor(h.users.player), { characterId: ch.characterId, idempotencyKey: randomUUID() });
    if (!copy.ok) throw new Error(JSON.stringify(copy.error));
    const copiedUrl = `/characters/${copy.value.characterId}/entries/${entryId}/image`;
    expect((await request("player", "GET", copiedUrl)).json().image).toEqual(first.image);
    const removed = await h.characters.apply(ctxFor(h.users.player), { kind: "removeEntry", characterId: ch.characterId, entryId, expectedRevision: played.value.character.revision, idempotencyKey: randomUUID() });
    if (!removed.ok) throw new Error(JSON.stringify(removed.error));
    expect((await request("player", "GET", `${url}/${first.image.fileId}`)).statusCode).toBe(404);
    expect((await request("player", "GET", `${copiedUrl}/${first.image.fileId}`)).statusCode).toBe(200);
    const fresh = await h.characters.apply(ctxFor(h.users.player), { kind: "addEntry", characterId: ch.characterId, expectedRevision: removed.value.character.revision, idempotencyKey: randomUUID(), entry: { entryId, slotId: "inventory", templateId: null, source: { kind: "personal" }, values: { name: "Different key", description: "", notes: "" }, quantity: 1 } });
    expect(fresh.ok).toBe(true);
    const current = (await request("player", "GET", url)).json();
    expect(current.image).toBeNull(); expect(current.revision).toBeGreaterThan(first.revision);
    expect((await request("player", "PUT", url, input)).statusCode).toBe(409);
  });
  it("retains disclosed campaign art after source replacement, narrowing and authorized return", async () => {
    const created = await h.campaigns.create(ctxFor(h.users.gm), { systemVersionId: h.versionId, title: "Retained art", description: "", idempotencyKey: randomUUID() });
    if (!created.ok) throw new Error(JSON.stringify(created.error)); const campaignId = created.value.campaignId;
    await h.pool.query("INSERT INTO campaign_members(campaign_id,user_id,role,status,generation) VALUES($1,$2,'player','active',1)", [campaignId, h.users.player.actorId]);
    const ch = await hero(h.versionId);
    const adopted = await h.campaigns.adoptCampaignCharacter(ctxFor(h.users.player), { campaignId, characterId: ch.characterId, expectedCampaignRevision: created.value.revision, expectedCharacterRevision: ch.revision, acknowledgedDisclosure: true, idempotencyKey: randomUUID() });
    if (!adopted.ok) throw new Error(JSON.stringify(adopted.error));
    const t = await h.campaigns.createTemplate(ctxFor(h.users.gm), { campaignId, kind: "item", content: { name: "Disclosed map" }, expectedTemplateRevision: 0, idempotencyKey: randomUUID() });
    if (!t.ok) throw new Error(JSON.stringify(t.error));
    const source = `/campaigns/${campaignId}/item-templates/${t.value.templateId}/image`;
    const art = await request("gm", "PUT", source, { ...data(), expectedTemplateRevision: t.value.revision }); expect(art.statusCode).toBe(200);
    const selected = await h.campaigns.openTemplate(ctxFor(h.users.gm), { campaignId, templateId: t.value.templateId }); if (!selected.ok) throw new Error("Template missing");
    const entryId = randomUUID(), parent = await h.characters.open(ctxFor(h.users.player), ch.characterId); if (!parent.ok) throw new Error("Character missing");
    const placed = await h.characters.apply(ctxFor(h.users.player), { kind: "addEntry", characterId: ch.characterId, expectedRevision: parent.value.revision, idempotencyKey: randomUUID(), entry: { entryId, slotId: "inventory", templateId: null, source: { kind: "campaign", campaignId, templateId: t.value.templateId, templateRevision: selected.value.revision, contentRevision: selected.value.contentRevision }, values: {} } });
    if (!placed.ok) throw new Error(JSON.stringify(placed.error));
    const pinnedUrl = `/characters/${ch.characterId}/entries/${entryId}/image/${art.json().image.fileId}`;
    const hidden = await h.campaigns.shareTemplate(ctxFor(h.users.gm), { campaignId, templateId: t.value.templateId, expectedTemplateRevision: selected.value.revision, audience: "gm_only", grants: [], idempotencyKey: randomUUID() }); if (!hidden.ok) throw new Error("Sharing failed");
    const changed = await request("gm", "PUT", source, { ...data(), expectedTemplateRevision: hidden.value.revision }); expect(changed.statusCode).toBe(200);
    expect((await request("player", "GET", `${source}/${art.json().image.fileId}`)).statusCode).toBe(404);
    expect((await request("player", "GET", pinnedUrl)).statusCode).toBe(200);
    const c = await h.campaigns.open(ctxFor(h.users.gm), { campaignId }); if (!c.ok) throw new Error("Campaign missing");
    expect((await h.campaigns.removeMember(ctxFor(h.users.gm), { campaignId, userId: h.users.player.actorId, expectedCampaignRevision: c.value.revision, idempotencyKey: randomUUID() })).ok).toBe(true);
    expect((await request("player", "GET", pinnedUrl)).statusCode).toBe(200);
    expect((await request("gm", "GET", pinnedUrl)).statusCode).toBe(404);
  });
});
