import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildI6Harness, ctxFor, type I6Harness } from "./i6-app.js";
import { derivedTemplateDocument } from "../../src/systems/implementation/package/fixtures/campaign-derived.js";
const db = process.env.TEST_DATABASE_URL ? describe : describe.skip;
db("M2 campaign and proposal image audiences", () => {
  let h: I6Harness, root: string, png: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "sweetroll-campaign-art-")); process.env.SWEETROLL_MEDIA_DIR = root;
    h = await buildI6Harness({ document: derivedTemplateDocument() });
    png = (await sharp({ create: { width: 40, height: 20, channels: 3, background: "#58513e" } }).png().toBuffer()).toString("base64");
  });
  afterAll(async () => { await h?.close(); delete process.env.SWEETROLL_MEDIA_DIR; if (root) await rm(root, { recursive: true, force: true }); });
  async function campaign() {
    const r = await h.campaigns.create(ctxFor(h.users.gm), { title: "Item art", description: "", systemVersionId: h.versionId, idempotencyKey: randomUUID() });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    for (const user of [h.users.player, h.users.other]) await h.pool.query("INSERT INTO campaign_members(campaign_id,user_id,role,status,generation) VALUES($1,$2,'player','active',1)", [r.value.campaignId, user.actorId]);
    return r.value.campaignId;
  }
  const data = () => ({ description: "A brass key", contentType: "image/png", dataBase64: png, idempotencyKey: randomUUID() });
  function request(who: keyof I6Harness["users"], method: "GET" | "PUT" | "POST" | "DELETE", url: string, payload?: object) {
    return h.app.inject({ method, url, headers: { cookie: h.users[who].cookie }, ...(payload ? { payload } : {}) });
  }
  it("enforces exact template audiences for metadata, bytes, preview and membership generations", async () => {
    const campaignId = await campaign();
    const t = await h.campaigns.createTemplate(ctxFor(h.users.gm), { campaignId, kind: "item", content: { name: "Secret key" }, audience: "gm_only", expectedTemplateRevision: 0, idempotencyKey: randomUUID() });
    if (!t.ok) throw new Error(JSON.stringify(t.error));
    const url = `/campaigns/${campaignId}/item-templates/${t.value.templateId}/image`;
    const input = { ...data(), expectedTemplateRevision: t.value.revision };
    const r = await request("gm", "PUT", url, input); expect(r.statusCode, r.body).toBe(200);
    const state = r.json();
    for (const who of ["player", "other", "outsider"] as const) {
      expect((await request(who, "GET", url)).statusCode).toBe(404);
      expect((await request(who, "GET", `${url}/${state.image.fileId}/thumbnail`)).statusCode).toBe(404);
    }
    const selected = await h.campaigns.shareTemplate(ctxFor(h.users.gm), { campaignId, templateId: t.value.templateId, audience: "selected_players", grants: [{ userId: h.users.player.actorId, generation: 1 }], expectedTemplateRevision: state.revision, idempotencyKey: randomUUID() });
    expect(selected.ok).toBe(true);
    expect((await request("player", "GET", `${url}/${state.image.fileId}`)).statusCode).toBe(200);
    expect((await request("other", "GET", `${url}/${state.image.fileId}`)).statusCode).toBe(404);
    expect((await h.campaigns.previewTemplates(ctxFor(h.users.gm), { campaignId, targetUserId: h.users.other.actorId })).value?.templates).toEqual([]);
    await h.pool.query("UPDATE campaign_members SET generation=2 WHERE campaign_id=$1 AND user_id=$2", [campaignId, h.users.player.actorId]);
    expect((await request("player", "GET", `${url}/${state.image.fileId}`)).statusCode).toBe(404);
  });
  it("keeps proposal text immutable, binds approval to reviewed art and retains the approved image", async () => {
    const campaignId = await campaign();
    const p = await h.campaigns.submitProposal(ctxFor(h.users.player), { campaignId, kind: "item", content: { name: "Player key" }, expectedProposalRevision: 0, idempotencyKey: randomUUID() });
    if (!p.ok) throw new Error(JSON.stringify(p.error));
    const proposal = p.value.proposal, url = `/campaigns/${campaignId}/item-proposals/${proposal.proposalId}/image`;
    const r = await request("player", "PUT", url, { ...data(), expectedProposalRevision: proposal.revision, expectedImageRevision: 0 });
    expect(r.statusCode, r.body).toBe(200); const state = r.json();
    expect((await request("other", "GET", `${url}/${state.image.fileId}`)).statusCode).toBe(404);
    const pending = await h.campaigns.openProposal(ctxFor(h.users.gm), { campaignId, proposalId: proposal.proposalId });
    expect(pending).toMatchObject({ ok: true, value: { revision: 1, content: proposal.content, imageRevision: 1, image: state.image } });
    const base = { campaignId, proposalId: proposal.proposalId, expectedProposalRevision: 1 };
    expect(await h.campaigns.approveProposal(ctxFor(h.users.gm), { ...base, expectedImageRevision: 0, idempotencyKey: randomUUID() })).toMatchObject({ ok: false, error: { code: "conflict" } });
    const approved = await h.campaigns.approveProposal(ctxFor(h.users.gm), { ...base, expectedImageRevision: 1, idempotencyKey: randomUUID() });
    if (!approved.ok || !approved.value.template) throw new Error(JSON.stringify(approved));
    expect(approved.value.template.image).toEqual(state.image);
    expect((await request("player", "PUT", url, { ...data(), expectedProposalRevision: 2, expectedImageRevision: 1 })).statusCode).toBe(409);
    const templateUrl = `/campaigns/${campaignId}/item-templates/${approved.value.template.templateId}/image/${state.image.fileId}`;
    expect((await request("other", "GET", templateUrl)).statusCode).toBe(200);
    expect((await request("other", "GET", `${url}/${state.image.fileId}`)).statusCode).toBe(404);
  });
});
