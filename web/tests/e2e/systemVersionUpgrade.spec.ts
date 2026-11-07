import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { createCatalogCampaign } from "../fixtures/campaignTemplates.js";
import { json, key } from "../fixtures/configurablePush.js";
import { derivedTemplateDocument } from "../../../src/systems/implementation/package/fixtures/campaign-derived.js";

/**
 * Design 6.7 / system version plan stage 4: an author publishes an additive
 * version that changes an item stat; a player upgrades a standalone
 * character through the sheet, sees the new stat, reverts with current values
 * kept; the GM upgrades the campaign with its characters from Settings.
 * Seeds through the API like the other campaign journeys.
 */
async function publishNext(request: APIRequestContext, systemId: string, semanticVersion: string) {
  const opened = await json(request, "GET", `/api/systems/${systemId}`);
  const document = structuredClone(opened.workspace.draft.document);
  const sword = document.templates.find((template: { id: string }) => template.id === "sword");
  sword.fields.find((field: { id: string }) => field.id === "damage_bonus").default = 2;
  document.templates.push({ id: "shield", kind: "item", label: "Shield", fields: [], grantedActions: [] });
  const saved = await json(request, "PUT", `/api/systems/${systemId}/draft`, {
    expectedRevision: opened.workspace.draft.revision,
    document,
  });
  const published = await json(request, "POST", `/api/systems/${systemId}/publish`, {
    expectedRevision: saved.workspace.draft.revision,
    semanticVersion,
    releaseNotes: "Sharper swords and new shields.",
    acknowledgeBreaking: true,
    idempotencyKey: key(),
  });
  return published.version.versionId as string;
}

async function expectNoHorizontalScroll(page: Page) {
  for (const width of [360, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
}

test("player upgrades and reverts a character; GM upgrades the campaign", async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  if (!baseURL) throw new Error("Browser base URL required");
  const gm = await browser.newContext({ baseURL });
  const co = await browser.newContext({ baseURL });
  const player = await browser.newContext({ baseURL });
  try {
    const { systemId, campaignId, versionId: v1 } = await createCatalogCampaign(
      gm.request,
      co.request,
      player.request,
      (document) => Object.assign(document, derivedTemplateDocument()),
    );
    // A standalone player character carrying the system sword.
    const created = await json(player.request, "POST", "/api/characters", {
      systemVersionId: v1,
      entityDefinitionId: "character",
      name: `Upgrader ${key().slice(0, 6)}`,
      idempotencyKey: key(),
    });
    const characterId = created.character.characterId as string;
    const entryId = key();
    await json(player.request, "POST", `/api/characters/${characterId}/entries`, {
      entry: { entryId, slotId: "inventory", templateId: "sword", source: { kind: "system", templateId: "sword" }, values: {} },
      expectedRevision: created.character.revision,
      idempotencyKey: key(),
    });
    const v2 = await publishNext(gm.request, systemId, "1.1.0");

    // Player: check, preview and upgrade from the sheet.
    const page = await player.newPage();
    await page.goto(`/characters/${characterId}`);
    await page.getByRole("button", { name: "Rules version" }).click();
    const dialog = page.getByRole("dialog", { name: "Rules version" });
    await expect(dialog.getByText("Sharper swords and new shields.")).toBeVisible();
    await dialog.getByRole("radio", { name: /Upgrade to 1\.1\.0/ }).check();
    await expect(dialog.getByText("Ready: nothing blocks this change.")).toBeVisible();
    await expect(dialog.getByText(/updated to new defaults: damage_bonus/)).toBeVisible();
    await expectNoHorizontalScroll(page);
    const upgraded = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith(`/characters/${characterId}/version`));
    await dialog.getByRole("button", { name: "Upgrade" }).click();
    expect((await upgraded).status()).toBe(200);
    await expect(dialog).toBeHidden();
    await expect(page.getByText(v2, { exact: false })).toBeVisible();
    const afterUpgrade = await json(player.request, "GET", `/api/characters/${characterId}`);
    expect(afterUpgrade.character.state.entries[entryId].values.damage_bonus).toBe(2);

    // Player: revert to the recorded previous version.
    await page.getByRole("button", { name: "Rules version" }).click();
    await dialog.getByRole("radio", { name: /Revert to 1\.0\.0/ }).check();
    await expect(dialog.getByText("Ready: nothing blocks this change.")).toBeVisible();
    await dialog.getByRole("button", { name: "Revert" }).click();
    await expect(dialog).toBeHidden();
    const afterRevert = await json(player.request, "GET", `/api/characters/${characterId}`);
    expect(afterRevert.character.systemVersionId).toBe(v1);
    expect(afterRevert.character.state.entries[entryId].values.damage_bonus).toBe(1);

    // GM: upgrade the whole campaign from Settings.
    const gmPage = await gm.newPage();
    await gmPage.goto(`/campaigns/${campaignId}`);
    await gmPage.getByRole("tab", { name: "Settings" }).click();
    await gmPage.getByRole("radio", { name: /Upgrade to 1\.1\.0/ }).check();
    await expect(gmPage.getByText(/can move/)).toBeVisible();
    await expectNoHorizontalScroll(gmPage);
    await gmPage.getByRole("button", { name: "Upgrade", exact: true }).click();
    const campaignChanged = gmPage.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith(`/campaigns/${campaignId}/version`));
    await gmPage.getByRole("dialog").getByRole("button", { name: "Upgrade" }).click();
    expect((await campaignChanged).status()).toBe(200);
    await expect(gmPage.getByText("The rules version was changed.")).toBeVisible();
    const campaign = await json(gm.request, "GET", `/api/campaigns/${campaignId}`);
    expect(campaign.campaign.systemVersionId).toBe(v2);
  } finally {
    await gm.close();
    await co.close();
    await player.close();
  }
});
