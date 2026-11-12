import { expect, test } from "../fixtures/browserTest";
import { atEachViewport, expectAccessible, expectWithinViewport, pressFromKeyboard } from "../fixtures/guiChecks";
import { expectSheetSaved } from "../fixtures/sheetSaved";
import { d20Document } from "../../../src/systems/implementation/package/fixtures/d20.js";
import { uid } from "../offline/test-auth.js";

// Rules coverage R1 (design 6.3): an amount in one command and direct input of current and maximum.
test("a player applies damage in one command and raises the maximum; the GM board keeps one-tap steps", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await page.getByTestId("dev-signin").click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  const systemName = `Resource Editing ${uid()}`;
  const created = await page.request.post("/api/systems", {
    data: { source: { kind: "blank", name: systemName }, idempotencyKey: uid() },
  });
  expect(created.status()).toBe(201);
  const { workspace } = await created.json();
  const systemId = workspace.system.systemId;
  try {
    const document = structuredClone(d20Document);
    document.metadata.name = systemName;
    const stored = await page.request.put(`/api/systems/${systemId}/draft`, {
      data: { expectedRevision: workspace.draft.revision, document },
    });
    expect(stored.status()).toBe(200);
    await page.goto(`/systems/${systemId}`);
    await page.getByTestId("document-editor-publish").click();
    await page.getByTestId("publish-dialog-semver").fill("1.0.0");
    await page.getByTestId("publish-dialog-release-notes").fill("Resource editing");
    await page.getByTestId("publish-dialog-submit").click();
    await expect(page.getByTestId("publish-dialog-success")).toBeVisible();
    await page.getByTestId("publish-dialog-create-character").click();
    await page.getByLabel("Entity", { exact: true }).selectOption("character");
    await page.getByLabel("Character name").fill("Tova");
    await page.getByRole("button", { name: "Create character", exact: true }).click();
    await expect(page).toHaveURL(/\/characters\/[0-9a-f-]+$/);
    await expect(page.getByText("10 / 10", { exact: true })).toBeVisible();

    const writes: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === "POST" && path.includes("/resources/health/")) writes.push(path.split("/").at(-1)!);
    });
    const amount = page.getByLabel("Amount for Health", { exact: true });
    const subtract = page.getByRole("button", { name: "Subtract from Health", exact: true });
    const add = page.getByRole("button", { name: "Add to Health", exact: true });
    const set = page.getByRole("button", { name: "Set Health", exact: true });

    // Every control is reachable at each width, and unusable amounts keep the buttons off.
    await atEachViewport(page, async () => {
      for (const control of [amount, subtract, add, set]) await expectWithinViewport(control);
    });
    await expect(subtract).toBeDisabled();
    await amount.fill("0");
    await expect(subtract).toBeDisabled();
    await expectAccessible(page, "resource controls on the sheet");

    // Direct input raises the maximum and the current value together.
    await set.click();
    await page.getByLabel("Maximum Health", { exact: true }).fill("31");
    await expect(page.getByRole("alert").filter({ hasText: "maximum no higher than 30" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save Health", exact: true })).toBeDisabled();
    await page.getByLabel("Maximum Health", { exact: true }).fill("20");
    await page.getByLabel("Current Health", { exact: true }).fill("20");
    await expectAccessible(page, "resource direct input");
    await page.getByRole("button", { name: "Save Health", exact: true }).click();
    await expect(page.getByText("20 / 20", { exact: true })).toBeVisible();
    await expectSheetSaved(page);

    // 17 damage is one command, entered and submitted from the keyboard at phone width.
    await page.setViewportSize({ width: 360, height: 640 });
    await amount.fill("17");
    await amount.press("Enter");
    await expect(page.getByText("3 / 20", { exact: true })).toBeVisible();
    await expectSheetSaved(page);
    // Healing stops at the maximum.
    await amount.fill("25");
    await pressFromKeyboard(add);
    await expect(page.getByText("20 / 20", { exact: true })).toBeVisible();
    await expectSheetSaved(page);
    await expect(add).toBeDisabled();
    expect(writes).toEqual(["set", "adjust", "adjust"]);
    await page.setViewportSize({ width: 1280, height: 800 });

    // GM session board: one-tap steps only (the amount controls live on the sheet).
    await page.goto("/campaigns/new");
    await page.getByRole("button", { name: `${systemName} 1.0.0` }).click();
    await page.getByLabel("Campaign title").fill(`Resource table ${uid()}`);
    await page.getByRole("button", { name: "Create campaign" }).click();
    await expect(page).toHaveURL(/\/campaigns\/[0-9a-f-]+/);
    const campaignUrl = page.url();
    await page.getByLabel("Character name").fill("Warden");
    await page.getByLabel("Entity definition").selectOption("character");
    await page.getByRole("button", { name: "New campaign character" }).click();
    await expect(page).toHaveURL(/\/characters\/[0-9a-f-]+$/);
    await page.goto(campaignUrl);
    await page.getByRole("tab", { name: "Session" }).click();
    await page.getByRole("button", { name: "Open Warden" }).click();
    await expect(page.getByText("10 / 10", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Amount for Health", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Set Health", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: /Decrease Health/ }).click();
    await expect(page.getByText("9 / 10", { exact: true })).toBeVisible();
  } finally {
    if (process.env.SWEETROLL_E2E_EPHEMERAL_DB !== "1") await page.request.delete(`/api/systems/${systemId}`);
  }
});
