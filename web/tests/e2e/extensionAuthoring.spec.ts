import { expect, test, type Page } from "../fixtures/browserTest";

import { createCatalogCampaign } from "../fixtures/campaignTemplates.js";
import { json, key } from "../fixtures/configurablePush.js";
import { derivedTemplateDocument } from "../../../src/systems/implementation/package/fixtures/campaign-derived.js";

/**
 * Design 6.8 / extensions plan E6: the author creates an extension from the
 * library, adds a template in the creator's extension mode, saves and
 * publishes it; a player creates a character with the extension ticked and
 * adds the extension item from the picker, where it is grouped under the
 * extension's name.
 */
async function expectNoHorizontalScroll(page: Page) {
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
}

test("author publishes an extension in the GUI; a player uses its item", async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  if (!baseURL) throw new Error("Browser base URL required");
  const gm = await browser.newContext({ baseURL });
  const co = await browser.newContext({ baseURL });
  const player = await browser.newContext({ baseURL });
  try {
    const { systemId, versionId } = await createCatalogCampaign(
      gm.request,
      co.request,
      player.request,
      (document) => Object.assign(document, derivedTemplateDocument()),
    );
    const system = await json(gm.request, "GET", `/api/systems/${systemId}`);
    const systemName = system.workspace.system.name as string;
    const extensionName = `Frost pack ${key().slice(0, 6)}`;

    // Author: library → Extensions → Create extension.
    const page = await gm.newPage();
    await page.goto("/");
    const row = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: systemName, exact: true }) });
    await row.getByRole("button", { name: "Extensions" }).click();
    const panel = row.getByRole("region", { name: `Extensions of ${systemName}` });
    await expect(panel.getByText("No extensions yet.")).toBeVisible();
    await panel.getByRole("button", { name: "Create extension" }).click();
    const dialog = page.getByRole("dialog", { name: "Create an extension" });
    await dialog.getByLabel("Extension name").fill(extensionName);
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page).toHaveURL(/\/extensions\/[0-9a-f-]{36}$/);
    const extensionId = page.url().split("/").pop()!;
    await expect(page.getByRole("heading", { name: `Extension: ${extensionName}` })).toBeVisible();

    // Creator in extension mode: Overview, Templates and Publish only.
    const tabs = page.getByRole("tablist", { name: "Extension sections" });
    await expect(tabs.getByRole("tab")).toHaveText(["Overview", "Templates", "Publish"]);
    await tabs.getByRole("tab", { name: "Templates" }).click();
    await expect(page.getByTestId("slots-section")).toHaveCount(0);
    await page.getByTestId("templates-add-button").click();
    await page.locator('[data-testid^="template-label-"]').first().fill("Frost blade");
    await page.getByTestId("extension-save").click();
    await expect(page.getByText("Draft saved.")).toBeVisible();
    await expectNoHorizontalScroll(page);

    await tabs.getByRole("tab", { name: "Publish" }).click();
    await expect(page.getByText("The saved draft can be published.")).toBeVisible();
    await page.getByLabel("Version number").fill("1.0.0");
    await page.getByRole("button", { name: "Publish version" }).click();
    await expect(page.getByText("Version 1.0.0 published.")).toBeVisible();
    // Sharing reuses the system routes (decision X2).
    await json(gm.request, "PATCH", `/api/systems/${extensionId}`, { access: "public" });

    await page.goto("/");
    await row.getByRole("button", { name: "Extensions" }).click();
    await expect(panel.getByRole("link", { name: extensionName })).toBeVisible();
    await expect(panel.getByText("1.0.0")).toBeVisible();

    // Player: create a character with the extension ticked.
    const playerPage = await player.newPage();
    await playerPage.goto("/characters/new");
    await playerPage.getByRole("textbox", { name: "System version ID" }).fill(versionId);
    await playerPage.getByRole("button", { name: "Look up version" }).click();
    await playerPage.getByRole("checkbox", { name: `${extensionName} 1.0.0` }).check();
    await playerPage.getByLabel("Entity").selectOption({ label: "Character" });
    await playerPage.getByLabel("Character name").fill(`Frost hero ${key().slice(0, 6)}`);
    await playerPage.getByRole("button", { name: "Create character" }).click();
    await expect(playerPage).toHaveURL(/\/characters\/[0-9a-f-]{36}$/);
    const characterId = playerPage.url().split("/").pop()!;
    const created = await json(player.request, "GET", `/api/characters/${characterId}`);
    expect(created.character.extensions.map((ref: { extensionId: string }) => ref.extensionId)).toEqual([extensionId]);

    // The picker groups the extension item under the extension's name.
    await playerPage.getByTestId("slot-add-inventory").click();
    const picker = playerPage.getByTestId("slot-template-picker-inventory");
    await expect(picker.locator(`optgroup[label="${extensionName}"] option`)).toHaveText(["Frost blade"]);
    await expect(picker.locator('optgroup[label="Rules"] option').first()).toBeAttached();
    await picker.selectOption({ label: "Frost blade" });
    await playerPage.getByTestId("slot-add-confirm-inventory").click();
    await expect(playerPage.getByTestId("slot-list-inventory").getByText("Frost blade", { exact: true })).toBeVisible();
    await expect.poll(async () => {
      const view = await json(player.request, "GET", `/api/characters/${characterId}`);
      return Object.values(view.character.state.entries as Record<string, { extensionId?: string }>).map((entry) => entry.extensionId ?? null);
    }).toEqual([extensionId]);
    await expectNoHorizontalScroll(playerPage);
  } finally {
    await gm.close();
    await co.close();
    await player.close();
  }
});
