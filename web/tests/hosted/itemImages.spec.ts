import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { test, expect, type Page, type Locator } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { derivedTemplateDocument } from "../../../src/systems/implementation/package/fixtures/campaign-derived.js";
const key = () => randomUUID();
async function result(page: Page, method: string, path: string, data?: unknown) {
  return page.evaluate(async ({ method, path, data }) => {
    const r = await fetch(path, { method, cache: "no-store", ...(data === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(data) }) });
    return { status: r.status, body: await r.json() };
  }, { method, path, data });
}
async function json(page: Page, method: string, path: string, data?: unknown) {
  const r = await result(page, method, path, data); expect(r.status, `${method} ${path}: ${r.body.error?.message ?? ""}`).toBeGreaterThanOrEqual(200); expect(r.status).toBeLessThan(300); return r.body;
}
async function status(page: Page, path: string) { return page.evaluate(async path => (await fetch(path, { cache: "no-store" })).status, path); }
async function upload(scope: Page | Locator, png: Buffer, description: string) {
  await scope.getByLabel("Image file", { exact: true }).setInputFiles({ name: "art.png", mimeType: "image/png", buffer: png });
  await scope.getByLabel("Image description", { exact: true }).fill(description);
  await scope.getByRole("button", { name: /^(Upload|Replace) artwork$/ }).click();
  await expect(scope.getByAltText(description, { exact: true })).toBeVisible();
}
test("M2 immutable item art, private catalogs, suggestions, retained copies and play", async ({ browser, baseURL }, info) => {
  test.setTimeout(480_000); if (!baseURL) throw new Error("Hosted URL required");
  const contexts = await Promise.all(Array.from({ length: 4 }, () => browser.newContext({ baseURL, ignoreHTTPSErrors: true, ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY } } : {}) })));
  const pages = await Promise.all(contexts.map(c => c.newPage())); const gm = pages[0]!, players = pages.slice(1), player = players[0]!;
  const systems: string[] = [], characters: Array<{ page: Page; id: string }> = []; let campaignId: string | undefined;
  const png = await sharp({ create: { width: 90, height: 60, channels: 3, background: "#725b38" } }).png().withMetadata({ exif: { IFD0: { Artist: "Private M2 fixture" } } }).toBuffer();
  let failed = false;
  try {
    for (const [i, page] of pages.entries()) { await page.goto("/"); await json(page, "POST", "/dev/signin", { code: i === 0 ? "code-journey-gm" : `code-journey-p${i}`, redirectUri: new URL("/cb", page.url()).href }); }
    const ws = (await json(gm, "POST", "/api/systems", { source: { kind: "clone", versionId: "a0000000-0000-5000-8000-000000000002" }, idempotencyKey: key() })).workspace;
    const sid = ws.system.systemId; systems.push(sid);
    const doc = derivedTemplateDocument(); doc.metadata.name = `M2 artwork ${key().slice(0, 8)}`;
    doc.templates!.push({ id: "spark", kind: "spell", label: "Spark", fields: [], grantedActions: [] }, { id: "rope", kind: "item", label: "Rope", fields: [], grantedActions: [] });
    doc.slots![0]!.accepts = ["item", "spell"]; doc.slots![0]!.maxEntries = 8;
    await json(gm, "PUT", `/api/systems/${sid}/draft`, { expectedRevision: ws.draft.revision, document: doc });
    await json(gm, "PATCH", `/api/systems/${sid}`, { lifecycle: "active", access: "public" });
    await gm.goto(`/systems/${sid}?tab=templates`);
    for (const id of ["sword", "spark", "rope"]) {
      const row = gm.getByTestId(`template-row-${id}`).locator("..");
      await expect(row.getByRole("button", { name: "Edit artwork", exact: true })).toBeEnabled();
      await row.getByRole("button", { name: "Edit artwork", exact: true }).click();
      const dialog = gm.getByRole("dialog", { name: "Item artwork", exact: true });
      await upload(dialog, png, `Published ${id} illustration`);
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
    }
    await expect(gm.getByTestId("document-editor-publish")).toBeEnabled();
    const ready = (await json(gm, "GET", `/api/systems/${sid}`)).workspace;
    const version = (await json(gm, "POST", `/api/systems/${sid}/publish`, { expectedRevision: ready.draft.revision, semanticVersion: "1.0.0", releaseNotes: "Artwork journey", acknowledgeBreaking: true, idempotencyKey: key() })).version;
    const exported = await json(gm, "GET", `/api/system-versions/${version.versionId}/export`); expect(exported.images).toHaveLength(3);
    for (const source of [{ kind: "clone", versionId: version.versionId }, { kind: "import", content: JSON.stringify(exported) }]) {
      const copy = (await json(gm, "POST", "/api/systems", { source, idempotencyKey: key() })).workspace; systems.push(copy.system.systemId);
      const art = copy.draft.document.templates.find((t: any) => t.id === "sword").image;
      expect(await status(gm, `/api/systems/${copy.system.systemId}/templates/sword/image/${art.fileId}/thumbnail`)).toBe(200);
    }
    const campaign = (await json(gm, "POST", "/api/campaigns", { title: `M2 art campaign ${key().slice(0, 8)}`, systemVersionId: version.versionId, idempotencyKey: key() })).campaign;
    campaignId = campaign.campaignId;
    const identities: any[] = [];
    for (const p of players) {
      identities.push(await json(p, "GET", "/api/me"));
      const c = (await json(gm, "GET", `/api/campaigns/${campaignId}`)).campaign;
      const invitation = (await json(gm, "POST", `/api/campaigns/${campaignId}/invitations`, { intendedRole: "player", expectedCampaignRevision: c.revision, idempotencyKey: key() })).invitation;
      const review = (await json(p, "POST", "/api/invitations/review", { token: invitation.token })).review;
      await json(p, "POST", "/api/invitations/accept", { campaignId, token: invitation.token, expectedInvitationRevision: review.invitationRevision, reviewedAccessRevision: review.accessRevision, idempotencyKey: key() });
    }
    let hero = (await json(player, "POST", "/api/characters", { name: "M2 illustrated explorer", systemVersionId: version.versionId, entityDefinitionId: "character", idempotencyKey: key() })).character;
    characters.push({ page: player, id: hero.characterId });
    const entryIds = new Map<string, string>();
    for (const templateId of ["sword", "spark", "rope"]) {
      const entryId = key(); entryIds.set(templateId, entryId);
      hero = (await json(player, "POST", `/api/characters/${hero.characterId}/entries`, { expectedRevision: hero.revision, idempotencyKey: key(), entry: { entryId, slotId: "inventory", templateId, values: {} } })).result.character;
    }
    const currentCampaign = (await json(gm, "GET", `/api/campaigns/${campaignId}`)).campaign;
    await json(player, "POST", `/api/campaigns/${campaignId}/characters/${hero.characterId}/adopt`, { expectedCampaignRevision: currentCampaign.revision, expectedCharacterRevision: hero.revision, acknowledgedDisclosure: true, idempotencyKey: key() });
    await player.setViewportSize({ width: 360, height: 1000 }); await player.goto(`/characters/${hero.characterId}`);
    for (const id of entryIds.keys()) { await player.getByTestId(`slot-entry-${entryIds.get(id)}`).scrollIntoViewIfNeeded(); await expect(player.getByAltText(`Published ${id} illustration`, { exact: true })).toBeVisible(); }
    const sword = player.getByTestId(`slot-entry-${entryIds.get("sword")}`);
    await sword.getByRole("button", { name: "Edit artwork", exact: true }).click();
    await upload(sword, png, "My blue sword");
    await sword.getByRole("button", { name: "Close artwork editor", exact: true }).click();
    await player.getByRole("button", { name: "Check", exact: true }).click(); await expect(player.getByRole("region", { name: "Roll result", exact: true })).toBeVisible();
    const template = (await json(gm, "POST", `/api/campaigns/${campaignId}/item-templates`, { kind: "item", content: { name: "Campaign key" }, audience: "all_players", expectedTemplateRevision: 0, idempotencyKey: key() })).template;
    const tpath = `/api/campaigns/${campaignId}/item-templates/${template.templateId}`;
    await gm.goto(`/campaigns/${campaignId}`); await gm.getByRole("tab", { name: "Items & powers", exact: true }).click();
    const templateRow = gm.locator("li").filter({ has: gm.getByRole("heading", { name: "Campaign key", exact: true }) });
    await templateRow.getByRole("button", { name: "Edit artwork", exact: true }).click();
    await upload(gm.getByRole("dialog", { name: "Item artwork", exact: true }), png, "Brass campaign key");
    await gm.getByRole("dialog", { name: "Item artwork", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
    const illustrated = (await json(gm, "GET", tpath)).template;
    hero = (await json(player, "GET", `/api/characters/${hero.characterId}`)).character; const retainedId = key();
    hero = (await json(player, "POST", `/api/characters/${hero.characterId}/entries`, { expectedRevision: hero.revision, idempotencyKey: key(), entry: { entryId: retainedId, slotId: "inventory", templateId: null, source: { kind: "campaign", campaignId, templateId: template.templateId, templateRevision: illustrated.revision, contentRevision: illustrated.contentRevision }, values: {} } })).result.character;
    let shared = (await json(gm, "POST", `${tpath}/sharing`, { audience: "selected_players", grants: [{ userId: identities[1].userId, generation: 1 }], expectedTemplateRevision: illustrated.revision, idempotencyKey: key() })).template;
    for (const [i, p] of players.entries()) {
      const preview = await json(gm, "POST", `/api/campaigns/${campaignId}/item-template-preview`, { targetUserId: identities[i].userId });
      expect(preview.templates.some((t: any) => t.templateId === template.templateId)).toBe(i === 1);
      expect(await status(p, `${tpath}/image/${illustrated.image.fileId}/thumbnail`)).toBe(i === 1 ? 200 : 404);
    }
    const replacement = await json(gm, "PUT", `${tpath}/image`, { expectedTemplateRevision: shared.revision, description: "Replacement catalog key", contentType: "image/png", dataBase64: png.toString("base64"), idempotencyKey: key() });
    await json(gm, "POST", `${tpath}/archive`, { expectedTemplateRevision: replacement.revision, idempotencyKey: key() });
    const retainedPath = `/api/characters/${hero.characterId}/entries/${retainedId}/image/${illustrated.image.fileId}`;
    expect(await status(player, retainedPath)).toBe(200); expect(await status(gm, retainedPath)).toBe(200);
    const proposal = (await json(player, "POST", `/api/campaigns/${campaignId}/item-proposals`, { kind: "spell", content: { name: "Player lantern" }, expectedProposalRevision: 0, idempotencyKey: key() })).proposal;
    await player.goto(`/campaigns/${campaignId}`); await player.getByRole("tab", { name: "Items & powers", exact: true }).click();
    const proposalRow = player.locator("li").filter({ has: player.getByRole("heading", { name: "Player lantern", exact: true }) });
    await proposalRow.getByRole("button", { name: "Edit artwork", exact: true }).click();
    await upload(player.getByRole("dialog", { name: "Item artwork", exact: true }), png, "Lantern spell suggestion");
    await player.getByRole("dialog", { name: "Item artwork", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
    const ppath = `/api/campaigns/${campaignId}/item-proposals/${proposal.proposalId}/image`, pimage = await json(player, "GET", ppath);
    for (const p of players.slice(1)) expect(await status(p, `${ppath}/${pimage.image.fileId}`)).toBe(404);
    await gm.reload(); await gm.getByRole("tab", { name: "Items & powers", exact: true }).click(); const reviewRow = gm.locator("li").filter({ has: gm.getByRole("heading", { name: "Player lantern", exact: true }) });
    await reviewRow.getByRole("button", { name: "Review suggestion", exact: true }).click();
    await expect(gm.getByRole("dialog").getByAltText("Lantern spell suggestion", { exact: true })).toBeVisible();
    await gm.getByRole("button", { name: "Approve and publish to all members", exact: true }).click();
    await expect(gm.getByRole("dialog")).not.toBeVisible();
    await player.goto(`/characters/${hero.characterId}`); await player.getByTestId(`slot-entry-${retainedId}`).scrollIntoViewIfNeeded(); await expect(player.getByAltText("Brass campaign key", { exact: true })).toBeVisible();
    expect((await new AxeBuilder({ page: player }).analyze()).violations).toEqual([]);
    expect(await player.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await player.screenshot({ path: info.outputPath("items-player-360.png"), fullPage: true });
    await expect(player.getByText("Available offline", { exact: true })).toBeVisible({ timeout: 60_000 });
    await contexts[1]!.setOffline(true); await player.reload(); await player.getByTestId(`slot-entry-${retainedId}`).scrollIntoViewIfNeeded(); await expect(player.getByText("Artwork unavailable offline").first()).toBeVisible();
    await player.getByLabel("Ability Score", { exact: true }).fill("15"); await player.getByLabel("Ability Score", { exact: true }).press("Tab"); await contexts[1]!.setOffline(false);
    await expect.poll(async () => (await json(player, "GET", `/api/characters/${hero.characterId}`)).character.state.values.ability).toBe(15);
    const beforeReturn = (await json(gm, "GET", `/api/campaigns/${campaignId}`)).campaign;
    await json(gm, "DELETE", `/api/campaigns/${campaignId}/members/${identities[0].userId}`, { expectedCampaignRevision: beforeReturn.revision, idempotencyKey: key() });
    expect(await status(gm, retainedPath)).toBe(404); expect(await status(player, retainedPath)).toBe(200);
    await player.reload(); await player.getByTestId(`slot-entry-${retainedId}`).scrollIntoViewIfNeeded(); await expect(player.getByAltText("Brass campaign key", { exact: true })).toBeVisible();
    await player.getByRole("button", { name: "Check", exact: true }).click(); await expect(player.getByRole("region", { name: "Roll result", exact: true })).toBeVisible();
  } catch (cause) { failed = true; console.error("M2 journey failure:", cause); throw cause; } finally {
    const cleanupErrors: unknown[] = [];
    for (const context of contexts) await context.setOffline(false);
    for (const { page, id } of characters) try {
      let ch = (await json(page, "GET", `/api/characters/${id}`)).character;
      if (ch.campaignId) {
        const who = await json(page, "GET", "/api/me"), c = (await json(gm, "GET", `/api/campaigns/${ch.campaignId}`)).campaign;
        await json(gm, "DELETE", `/api/campaigns/${ch.campaignId}/members/${who.userId}`, { expectedCampaignRevision: c.revision, idempotencyKey: key() });
        ch = (await json(page, "GET", `/api/characters/${id}`)).character;
      }
      await json(page, "PATCH", `/api/characters/${id}`, { command: "archive", expectedRevision: ch.revision, idempotencyKey: key() });
    } catch (cause) { cleanupErrors.push(cause); }
    if (campaignId) try { const c = (await json(gm, "GET", `/api/campaigns/${campaignId}`)).campaign; await json(gm, "POST", `/api/campaigns/${campaignId}/archive`, { expectedCampaignRevision: c.revision, idempotencyKey: key() }); } catch (cause) { cleanupErrors.push(cause); }
    for (const id of systems) try { await json(gm, "PATCH", `/api/systems/${id}`, { lifecycle: "archived", access: "private" }); } catch (cause) { cleanupErrors.push(cause); }
    for (const context of contexts) await context.close();
    if (cleanupErrors.length) { console.error("M2 scoped cleanup errors:", cleanupErrors); if (!failed) throw new AggregateError(cleanupErrors); }
  }
});
