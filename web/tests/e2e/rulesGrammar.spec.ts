import { expect, test } from "../fixtures/browserTest";
import { expectCreatorUsable, playAtEachViewport } from "../fixtures/guiChecks";
import { expectSheetSaved } from "../fixtures/sheetSaved";
import { d20Document } from "../../../src/systems/implementation/package/fixtures/d20.js";
import { uid } from "../offline/test-auth.js";

test("creator, player and GM use conditional rules from the same published version", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await page.getByTestId("dev-signin").click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  const systemName = `Conditional Checks ${uid()}`;
  const created = await page.request.post("/api/systems", {
    data: { source: { kind: "blank", name: systemName }, idempotencyKey: uid() },
  });
  expect(created.status()).toBe(201);
  const { workspace } = await created.json();
  const systemId = workspace.system.systemId;
  try {
    const document = structuredClone(d20Document);
    document.metadata.name = systemName;
    document.entities[0]!.fields.push({
      kind: "singleChoice", id: "class", label: "Class", default: "fighter", required: false,
      options: [{ id: "fighter", label: "Fighter" }],
    });
    const stored = await page.request.put(`/api/systems/${systemId}/draft`, {
      data: { expectedRevision: workspace.draft.revision, document },
    });
    expect(stored.status()).toBe(200);

    await page.goto(`/systems/${systemId}`);
    await page.getByTestId("document-editor-tab-dice").click();
    await page.getByTestId("dice-kind-check").selectOption("custom");
    const formula = 'd1 + if(fields.proficient, 2, 0) + if(fields.class == "fighter", 3, 0)';
    const saved = page.waitForResponse(response =>
      response.url().endsWith(`/api/systems/${systemId}/draft`) &&
      response.request().method() === "PUT" &&
      response.request().postDataJSON()?.document?.expressions?.some((entry: { source: string }) => entry.source === formula),
    );
    await page.getByTestId("expression-editor-source").fill(formula);
    expect((await saved).status()).toBe(200);
    await page.getByTestId("roll-action-try-check").click();
    await expect(page.getByTestId("roll-action-try-total-check")).toHaveText("1");

    await expectCreatorUsable(page, "conditional rules creator");
    await page.getByTestId("document-editor-publish").click();
    await page.getByTestId("publish-dialog-semver").fill("1.0.0");
    await page.getByTestId("publish-dialog-release-notes").fill("Conditional proficiency and class bonuses");
    await page.getByTestId("publish-dialog-submit").click();
    await expect(page.getByTestId("publish-dialog-success")).toBeVisible();

    await page.getByTestId("publish-dialog-create-character").click();
    await page.getByLabel("Entity", { exact: true }).selectOption("character");
    await page.getByLabel("Character name").fill("Proficient Fighter");
    await page.getByRole("button", { name: "Create character", exact: true }).click();
    await expect(page).toHaveURL(/\/characters\/[0-9a-f-]+$/);
    const completion = page.getByRole("heading", { name: "Complete Your Character" });
    const proficient = page.locator("section", { has: completion }).getByRole("checkbox", { name: "Proficient" });
    await expect(async () => {
      if (!(await proficient.isChecked())) await proficient.click();
      await expect(proficient).toBeChecked();
    }).toPass();
    await expectSheetSaved(page);
    await playAtEachViewport(page, "conditional roll on the sheet", page.getByRole("button", { name: "Check", exact: true }),
      () => expect(page.getByText("Result: 6", { exact: true })).toBeVisible());

    await page.goto("/campaigns/new");
    await page.getByRole("button", { name: `${systemName} 1.0.0` }).click();
    await page.getByLabel("Campaign title").fill(`Rules table ${uid()}`);
    await page.getByRole("button", { name: "Create campaign" }).click();
    await expect(page).toHaveURL(/\/campaigns\/[0-9a-f-]+/);
    const campaignUrl = page.url();
    await page.getByLabel("Character name").fill("GM Fighter");
    await page.getByLabel("Entity definition").selectOption("character");
    await page.getByRole("button", { name: "New campaign character" }).click();
    await expect(page).toHaveURL(/\/characters\/[0-9a-f-]+$/);
    await page.goto(campaignUrl);
    await page.getByRole("tab", { name: "Session" }).click();
    await page.getByRole("button", { name: "Open GM Fighter" }).click();
    const roll = page.getByRole("button", { name: "Roll Check" });
    await playAtEachViewport(page, "conditional roll on the GM board", roll,
      () => expect(roll.locator("..").getByRole("status")).toHaveText("4"));
  } finally {
    if (process.env.SWEETROLL_E2E_EPHEMERAL_DB !== "1") await page.request.delete(`/api/systems/${systemId}`);
  }
});
