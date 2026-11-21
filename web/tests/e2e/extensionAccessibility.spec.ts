import AxeBuilder from "@axe-core/playwright";

import { expect, test, type APIRequestContext, type Locator, type Page } from "../fixtures/browserTest";

import { createCatalogCampaign } from "../fixtures/campaignTemplates.js";
import { json, key } from "../fixtures/configurablePush.js";
import { derivedTemplateDocument } from "../../../src/systems/implementation/package/fixtures/campaign-derived.js";

/**
 * Extensions plan E6, remaining checks: a keyboard-only path through the
 * extension screens, and the same screens in light and dark at 360, 768 and
 * 1280px with axe (serious or critical findings, including colour contrast)
 * and no horizontal scroll.
 */

/** Presses Tab until `target` has focus: the control is reachable in tab order. */
async function tabTo(page: Page, target: Locator, limit = 80) {
  for (let step = 0; step < limit; step += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`Not reachable with Tab: ${target.toString()}`);
}

async function expectAccessible(page: Page, label: string) {
  for (const width of [360, 768, 1280]) {
    for (const colorScheme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme });
      // The app follows the device setting: the resolved theme must match before checking contrast.
      await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label} ${width}px ${colorScheme}: horizontal scroll`).toBe(true);
      const results = await new AxeBuilder({ page }).analyze();
      const serious = results.violations
        .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
        .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`);
      expect(serious, `${label} ${width}px ${colorScheme}`).toEqual([]);
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function uniqueSystem(gm: APIRequestContext, co: APIRequestContext, player: APIRequestContext) {
  const systemName = `Keyboard base ${key().slice(0, 8)}`;
  const seeded = await createCatalogCampaign(gm, co, player, (document) => {
    Object.assign(document, derivedTemplateDocument());
    (document.metadata as { name: string }).name = systemName;
  });
  return { ...seeded, systemName };
}

test("extension screens work with the keyboard alone", async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  if (!baseURL) throw new Error("Browser base URL required");
  const gm = await browser.newContext({ baseURL });
  const co = await browser.newContext({ baseURL });
  const player = await browser.newContext({ baseURL });
  try {
    const { systemName, versionId } = await uniqueSystem(gm.request, co.request, player.request);
    const extensionName = `Keyboard pack ${key().slice(0, 6)}`;
    const page = await gm.newPage();
    await page.goto("/");
    const row = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: systemName, exact: true }) });

    // Library: open the system's extensions and create one.
    await tabTo(page, row.getByRole("button", { name: "Extensions" }));
    await page.keyboard.press("Enter");
    const panel = row.getByRole("region", { name: `Extensions of ${systemName}` });
    await tabTo(page, panel.getByRole("button", { name: "Create extension" }));
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Create an extension" });
    await expect(dialog.getByLabel("Extension name")).toBeFocused();
    await page.keyboard.type(extensionName);
    await tabTo(page, dialog.getByRole("button", { name: "Create", exact: true }));
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/extensions\/[0-9a-f-]{36}$/);
    const extensionId = page.url().split("/").pop()!;

    // Editor: arrow keys move between the tabs.
    const tabs = page.getByRole("tablist", { name: "Extension sections" });
    await tabTo(page, tabs.getByRole("tab", { name: "Overview" }));
    await page.keyboard.press("ArrowRight");
    await expect(tabs.getByRole("tab", { name: "Templates" })).toBeFocused();
    await tabTo(page, page.getByTestId("templates-add-button"));
    await page.keyboard.press("Enter");
    const label = page.locator('[data-testid^="template-label-"]').first();
    await tabTo(page, label);
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("Keyboard blade");
    await tabTo(page, page.getByTestId("extension-save"));
    await page.keyboard.press("Enter");
    await expect(page.getByText("Draft saved.")).toBeVisible();

    await tabTo(page, tabs.getByRole("tab", { name: "Templates" }));
    await page.keyboard.press("ArrowRight");
    await expect(tabs.getByRole("tab", { name: "Publish" })).toBeFocused();
    await tabTo(page, page.getByLabel("Version number"));
    await page.keyboard.type("1.0.0");
    await tabTo(page, page.getByRole("button", { name: "Publish version" }));
    await page.keyboard.press("Enter");
    await expect(page.getByText("Version 1.0.0 published.")).toBeVisible();
    await json(gm.request, "PATCH", `/api/systems/${extensionId}`, { access: "public" });

    // Player: create a character and add the extension in Rules and extensions.
    const created = await json(player.request, "POST", "/api/characters", {
      systemVersionId: versionId, entityDefinitionId: "character", name: `Keys ${key().slice(0, 6)}`, idempotencyKey: key(),
    });
    const characterId = created.character.characterId as string;
    const sheet = await player.newPage();
    await sheet.goto(`/characters/${characterId}`);
    await tabTo(sheet, sheet.getByRole("button", { name: "Rules and extensions" }));
    await sheet.keyboard.press("Enter");
    const rules = sheet.getByRole("dialog", { name: "Rules and extensions" });
    const add = rules.getByRole("radio", { name: new RegExp(`^Add ${extensionName} 1\\.0\\.0`) });
    await tabTo(sheet, add);
    await sheet.keyboard.press("Space");
    await expect(add).toBeChecked();
    await expect(rules.getByText("Ready: nothing blocks this change.")).toBeVisible();
    await tabTo(sheet, rules.getByRole("button", { name: "Add extension", exact: true }));
    await sheet.keyboard.press("Enter");
    await expect(rules).toBeHidden();
    await expect.poll(async () => (await json(player.request, "GET", `/api/characters/${characterId}`)).character.extensions
      .map((ref: { extensionId: string }) => ref.extensionId)).toEqual([extensionId]);
  } finally {
    await Promise.all([gm.close(), co.close(), player.close()]);
  }
});

test("extension screens in light and dark at three widths", async ({ browser, baseURL }) => {
  test.setTimeout(240_000);
  if (!baseURL) throw new Error("Browser base URL required");
  const gm = await browser.newContext({ baseURL });
  const co = await browser.newContext({ baseURL });
  const player = await browser.newContext({ baseURL });
  try {
    const { systemId, systemName, versionId } = await uniqueSystem(gm.request, co.request, player.request);
    const extensionName = `Contrast pack ${key().slice(0, 6)}`;
    const created = await json(gm.request, "POST", `/api/systems/${systemId}/extensions`, { baseVersionId: versionId, name: extensionName, idempotencyKey: key() });
    const extensionId = created.workspace.extension.extensionId as string;
    const document = {
      schemaVersion: "2.0", metadata: { name: extensionName, description: "", language: "en" }, expressions: [],
      templates: [{ kind: "item", id: "contrast_blade", label: "Contrast blade", fields: [], grantedActions: [] }],
    };
    const saved = await json(gm.request, "PUT", `/api/extensions/${extensionId}/draft`, { expectedRevision: created.workspace.draft.revision, document });
    await json(gm.request, "POST", `/api/extensions/${extensionId}/publish`, {
      expectedRevision: saved.workspace.draft.revision, semanticVersion: "1.0.0", releaseNotes: "", acknowledgeBreaking: false, idempotencyKey: key(),
    });
    await json(gm.request, "PATCH", `/api/systems/${extensionId}`, { access: "public" });

    const page = await gm.newPage();
    await page.goto("/");
    const row = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: systemName, exact: true }) });
    await row.getByRole("button", { name: "Extensions" }).click();
    await expect(row.getByRole("region", { name: `Extensions of ${systemName}` }).getByRole("link", { name: extensionName })).toBeVisible();
    await expectAccessible(page, "library extensions");

    await page.goto(`/extensions/${extensionId}`);
    const tabs = page.getByRole("tablist", { name: "Extension sections" });
    for (const tab of ["Overview", "Templates", "Publish"]) {
      await tabs.getByRole("tab", { name: tab }).click();
      await expectAccessible(page, `extension editor ${tab}`);
    }

    const playerPage = await player.newPage();
    await playerPage.goto("/characters/new");
    await playerPage.getByRole("textbox", { name: "System version ID" }).fill(versionId);
    await playerPage.getByRole("button", { name: "Look up version" }).click();
    await expect(playerPage.getByRole("checkbox", { name: `${extensionName} 1.0.0` })).toBeVisible();
    await expectAccessible(playerPage, "character creation");

    const character = await json(player.request, "POST", "/api/characters", {
      systemVersionId: versionId, entityDefinitionId: "character", name: `Contrast ${key().slice(0, 6)}`,
      extensions: [{ extensionId, versionId: (await json(gm.request, "GET", `/api/extensions/${extensionId}`)).workspace.versions[0].versionId }],
      idempotencyKey: key(),
    });
    await playerPage.goto(`/characters/${character.character.characterId}`);
    await playerPage.getByTestId("slot-add-inventory").click();
    await expect(playerPage.getByTestId("slot-template-picker-inventory").locator(`optgroup[label="${extensionName}"]`)).toBeAttached();
    await expectAccessible(playerPage, "grouped item picker");
    await playerPage.keyboard.press("Escape");
    await playerPage.getByRole("button", { name: "Rules and extensions" }).click();
    await expect(playerPage.getByRole("radio", { name: `Remove ${extensionName}` })).toBeVisible();
    await expectAccessible(playerPage, "rules and extensions dialog");
  } finally {
    await Promise.all([gm.close(), co.close(), player.close()]);
  }
});
