import { expect, test } from "../fixtures/browserTest";
import { atEachViewport, expectAccessible, expectCreatorUsable, expectWithinViewport, playAtEachViewport } from "../fixtures/guiChecks";
import { expectSheetSaved } from "../fixtures/sheetSaved";
import { advancedD20Document } from "../../../src/systems/implementation/package/fixtures/advanced-d20.js";
import { uid } from "../offline/test-auth.js";

test("Roadwardens derive armor and health in the creator, player sheet and GM session", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await page.getByTestId("dev-signin").click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  const document = advancedD20Document();
  const systemName = `Roadwardens ${uid()}`;
  document.metadata.name = systemName;
  const created = await page.request.post("/api/systems", {
    data: { source: { kind: "blank", name: systemName }, idempotencyKey: uid() },
  });
  expect(created.status()).toBe(201);
  const { workspace } = await created.json();
  const systemId = workspace.system.systemId;
  try {
    const saved = await page.request.put(`/api/systems/${systemId}/draft`, {
      data: { expectedRevision: workspace.draft.revision, document },
    });
    expect(saved.status(), await saved.text()).toBe(200);
    await page.goto(`/systems/${systemId}`);
    await page.getByTestId("document-editor-tab-attributes").click();
    const healthField = page.getByTestId("resource-field-health");
    await healthField.getByText("Maximum formula", { exact: true }).first().click();
    await expect(healthField.getByRole("combobox", { name: "Maximum formula" })).toHaveValue("health_max");

    await expectCreatorUsable(page, "tables and equipment creator");
    await page.getByTestId("document-editor-publish").click();
    await page.getByTestId("publish-dialog-semver").fill("1.0.0");
    await page.getByTestId("publish-dialog-release-notes").fill("Roadwardens rules");
    await page.getByTestId("publish-dialog-submit").click();
    await expect(page.getByTestId("publish-dialog-success")).toBeVisible();

    await page.getByTestId("publish-dialog-create-character").click();
    await page.getByLabel("Entity", { exact: true }).selectOption("character");
    await page.getByLabel("Character name").fill("Tarin");
    await page.getByRole("button", { name: "Create character", exact: true }).click();
    await expect(page).toHaveURL(/\/characters\/[0-9a-f-]+$/);
    const characterId = page.url().split("/").at(-1)!;
    const readDerived = async () => {
      const response = await page.request.get(`/api/characters/${characterId}`);
      return (await response.json()).character.derivedValues;
    };
    await expect(page.getByLabel("Rank", { exact: true })).toHaveValue("rookie");
    await page.getByTestId("slot-add-equipment").click();
    await page.getByTestId("slot-template-picker-equipment").selectOption("leather");
    await page.getByTestId("slot-add-confirm-equipment").click();
    await expect.poll(readDerived).toMatchObject({ defense: 12, carried: 3 });
    await playAtEachViewport(page, "table and equipment roll on the sheet", page.getByRole("button", { name: "Inspect armor", exact: true }),
      () => expect(page.getByText("Armor check: 4", { exact: true })).toBeVisible());
    const level = page.getByLabel("Level", { exact: true });
    await level.fill("4");
    await level.press("Enter");
    await expectSheetSaved(page);
    await expect.poll(readDerived).toMatchObject({ proficiency_bonus: 3 });
    await expect(page.getByText("10 / 18", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /set health/i }).click();
    await expect(page.getByLabel("Maximum Health", { exact: true })).toHaveCount(0);

    await page.goto("/campaigns/new");
    await page.getByRole("button", { name: `${systemName} 1.0.0` }).click();
    await page.getByLabel("Campaign title").fill(`Roadwardens table ${uid()}`);
    await page.getByRole("button", { name: "Create campaign" }).click();
    await expect(page).toHaveURL(/\/campaigns\/[0-9a-f-]+/);
    const campaignUrl = page.url();
    await page.getByLabel("Character name").fill("Watch captain");
    await page.getByLabel("Entity definition").selectOption("character");
    await page.getByRole("button", { name: "New campaign character" }).click();
    await expect(page).toHaveURL(/\/characters\/[0-9a-f-]+$/);
    await level.fill("4");
    await level.press("Enter");
    await expect(page.getByText("10 / 18", { exact: true })).toBeVisible();
    await expectSheetSaved(page);
    await page.goto(campaignUrl);
    await page.getByRole("tab", { name: "Session" }).click();
    await page.getByRole("button", { name: "Open Watch captain" }).click();
    await expect(page.getByText("10 / 18", { exact: true })).toBeVisible();
    // The armor check is granted by an item, so the board shows the computed maximum only.
    await atEachViewport(page, () => expectWithinViewport(page.getByText("10 / 18", { exact: true })));
    await expectAccessible(page, "computed maximum on the GM board");
  } finally {
    if (process.env.SWEETROLL_E2E_EPHEMERAL_DB !== "1") await page.request.delete(`/api/systems/${systemId}`);
  }
});
