import { expect, test } from "../fixtures/browserTest";
import { expectCreatorUsable, expectReadableInDarkAndLargeText, playAtEachViewport } from "../fixtures/guiChecks";
import { movesDocument } from "../../../src/systems/implementation/package/fixtures/outcome-systems.js";
import { uid } from "../offline/test-auth.js";

// Rules coverage R5: outcome bands in the creator, on the player sheet and in the GM session.
test("Hearthbound names move outcomes in the creator, player sheet and GM session", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await page.getByTestId("dev-signin").click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  const document = movesDocument();
  const systemName = `Hearthbound ${uid()}`;
  document.metadata.name = systemName;
  const created = await page.request.post("/api/systems", {
    data: { source: { kind: "blank", name: systemName }, idempotencyKey: uid() },
  });
  expect(created.status()).toBe(201);
  const { workspace } = await created.json();
  const systemId = workspace.system.systemId;
  const outcome = /^(Strong hit|Weak hit|Miss)$/;
  try {
    const stored = await page.request.put(`/api/systems/${systemId}/draft`, {
      data: { expectedRevision: workspace.draft.revision, document },
    });
    expect(stored.status(), await stored.text()).toBe(200);
    await page.goto(`/systems/${systemId}`);
    await page.getByTestId("document-editor-tab-dice").click();

    // The bands are listed in order, and a detail can be added in the creator.
    await expect(page.getByTestId("roll-action-outcome-make_move-strong_hit-label")).toHaveValue("Strong hit");
    await expect(page.getByTestId("roll-action-outcome-make_move-strong_hit-formula")).toHaveValue("roll.total >= 10");
    await expect(page.getByRole("button", { name: "Move Strong hit up" })).toBeDisabled();
    await page.getByTestId("roll-action-detail-add-make_move").click();
    await page.getByTestId("roll-action-detail-make_move-detail_1-label").fill("Margin");
    const value = page.getByTestId("roll-action-detail-make_move-detail_1-formula");
    await value.fill("roll.total - 7");
    await value.blur();
    const output = page.getByTestId("roll-action-output-make_move");
    await output.fill("{outcome} ({total}, margin {detail.detail_1})");
    await output.blur();

    await expectCreatorUsable(page, "outcome bands creator");
    await page.getByTestId("document-editor-publish").click();
    await page.getByTestId("publish-dialog-semver").fill("1.0.0");
    await page.getByTestId("publish-dialog-release-notes").fill("Hearthbound moves");
    await page.getByTestId("publish-dialog-submit").click();
    await expect(page.getByTestId("publish-dialog-success")).toBeVisible();

    await page.getByTestId("publish-dialog-create-character").click();
    await page.getByLabel("Entity", { exact: true }).selectOption("character");
    await page.getByLabel("Character name").fill("Wren");
    await page.getByRole("button", { name: "Create character", exact: true }).click();
    await expect(page).toHaveURL(/\/characters\/[0-9a-f-]+$/);
    await playAtEachViewport(page, "outcome roll on the sheet", page.getByRole("button", { name: "Make Move", exact: true }),
      () => expect(page.getByTestId("roll-outcome")).toHaveText(outcome));
    await expect(page.getByText("Margin", { exact: true })).toBeVisible();
    await expectReadableInDarkAndLargeText(page, "roll result with outcome and details");
    await expect(page.getByText(/^(Strong hit|Weak hit|Miss) \(\d+, margin -?\d+\)$/)).toBeVisible();

    await page.goto("/campaigns/new");
    await page.getByRole("button", { name: `${systemName} 1.0.0` }).click();
    await page.getByLabel("Campaign title").fill(`Hearthbound table ${uid()}`);
    await page.getByRole("button", { name: "Create campaign" }).click();
    await expect(page).toHaveURL(/\/campaigns\/[0-9a-f-]+/);
    const campaignUrl = page.url();
    await page.getByLabel("Character name").fill("Elder");
    await page.getByLabel("Entity definition").selectOption("character");
    await page.getByRole("button", { name: "New campaign character" }).click();
    await expect(page).toHaveURL(/\/characters\/[0-9a-f-]+$/);
    await page.goto(campaignUrl);
    await page.getByRole("tab", { name: "Session" }).click();
    await page.getByRole("button", { name: "Open Elder" }).click();
    await playAtEachViewport(page, "outcome roll on the GM board", page.getByRole("button", { name: "Roll Make Move", exact: true }),
      () => expect(page.getByRole("status").filter({ hasText: /^\d+ — (Strong hit|Weak hit|Miss)$/ })).toBeVisible());
  } finally {
    if (process.env.SWEETROLL_E2E_EPHEMERAL_DB !== "1") await page.request.delete(`/api/systems/${systemId}`);
  }
});
