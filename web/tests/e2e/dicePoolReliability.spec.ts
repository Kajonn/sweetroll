import { expect, test, type Page } from "@playwright/test";
import type { SystemDocumentV1 } from "../../../src/systems/implementation/package/schema/index.js";
import { uid } from "../offline/test-auth.js";

const poolSource = "countSuccesses(dice(fields.attribute + fields.skill + inputs.bonus_dice, 6), 6)";

async function saved(page: Page) {
  await expect(page.getByTestId("document-editor-autosave")).toContainText("Saved");
}

async function discardRejectedRoll(page: Page) {
  const review = page.getByRole("heading", { name: "Review conflicts" }).locator("..");
  await review.getByRole("checkbox").first().check();
  await review.getByRole("button", { name: "Discard", exact: true }).click();
  await page.getByRole("button", { name: "Confirm discard", exact: true }).click();
  await expect(page.getByRole("button", { name: "Test Pool", exact: true })).toBeEnabled();
}

test("pool authoring, failed-roll review, zero pools and granted-action parity", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await page.getByTestId("dev-signin").click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  const cloned = await page.request.post("/api/systems", { data: {
    source: { kind: "clone", versionId: "c0000000-0000-5000-8000-000000000002" },
    idempotencyKey: uid(),
  } });
  expect(cloned.status()).toBe(201);
  const { workspace } = await cloned.json();
  const systemId = workspace.system.systemId as string;
  try {
    const draftDocument = workspace.draft.document as SystemDocumentV1;
    draftDocument.slots = [{ id: "gear", label: "Gear", accepts: ["item"] }];
    draftDocument.templates = [{ id: "pool_tool", label: "Pool Tool", kind: "item", fields: [], grantedActions: [{
      kind: "roll", id: "gear_pool", label: "Gear Pool", expressionId: "gear_pool_expr",
      inputs: [{ id: "gear_dice", label: "Gear Dice", valueType: "integer", required: false, default: 0 }],
      outputTemplate: "Gear successes: {total}",
    }] }];
    draftDocument.expressions.push({ id: "gear_pool_expr", context: "roll", resultType: "number", fallback: 0,
      source: "countSuccesses(dice(fields.attribute + fields.skill + inputs.gear_dice, 6), 6)",
    });
    draftDocument.sheets[0]!.sections[1]!.elements.push({ kind: "slot", id: "gear_element", slotId: "gear" });
    const save = await page.request.put(`/api/systems/${systemId}/draft`, { data: { expectedRevision: workspace.draft.revision, document: draftDocument } });
    expect(save.status()).toBe(200);

    await page.goto(`/systems/${systemId}`);
    await page.getByTestId("document-editor-tab-dice").click();
    await expect(page.getByTestId("expression-editor-source")).toHaveValue(poolSource);
    await expect(page.getByTestId("roll-field-modifier-test_pool")).toHaveCount(0);
    // A supported-looking but unevaluable operand must fail real server assessment.
    await page.getByTestId("expression-editor-source").fill("countSuccesses(5, 6)");
    await saved(page);
    const rejectedAssessment = await page.request.post(`/api/systems/${systemId}/preview`);
    expect(rejectedAssessment.status()).toBe(422);
    expect((await rejectedAssessment.json()).error.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "invalid_expression", path: "pool_roll_expr" }),
    ]));
    await page.getByTestId("expression-editor-source").fill(poolSource);
    await saved(page);
    await page.reload();
    await page.getByTestId("document-editor-tab-dice").click();
    await expect(page.getByTestId("expression-editor-source")).toHaveValue(poolSource);
    await page.getByTestId("roll-action-try-test_pool").click();
    await expect(page.getByTestId("roll-action-try-total-test_pool")).toHaveText("0");
    await expect(page.getByTestId("roll-action-try-modifiers-test_pool")).toHaveCount(0);
    await expect(page.getByTestId("roll-action-try-bindings-test_pool")).toContainText("Attribute: 0");
    // The same editor must preserve item-granted pool formulas.
    await page.getByTestId("document-editor-tab-templates").click();
    await expect(page.getByTestId("roll-field-modifier-gear_pool")).toHaveCount(0);
    await expect(page.getByTestId("expression-editor-source")).toHaveValue(draftDocument.expressions.find(e => e.id === "gear_pool_expr")!.source);

    await page.getByTestId("document-editor-publish").click();
    await page.getByTestId("publish-dialog-semver").fill("1.0.0");
    await page.getByTestId("publish-dialog-release-notes").fill("Pool reliability acceptance");
    await page.getByTestId("publish-dialog-submit").click();
    await expect(page.getByTestId("publish-dialog-success")).toBeVisible();
    await page.getByTestId("publish-dialog-create-character").click();
    await page.getByLabel("Entity", { exact: true }).selectOption("character");
    await page.getByLabel("Character name").fill(`Pool reliability ${uid()}`);
    await page.getByRole("button", { name: "Create character", exact: true }).click();
    await expect(page).toHaveURL(/\/characters\/[0-9a-f-]+$/);
    const characterId = page.url().split("/").pop()!;
    const character = (await (await page.request.get(`/api/characters/${characterId}`)).json()).character;
    await page.getByLabel("Bonus Dice", { exact: true }).fill("-3");
    await page.getByRole("button", { name: "Test Pool", exact: true }).click();
    await expect(page.getByText(/Roll could not be evaluated:/).first()).toBeVisible();
    await expect(page.getByLabel("Bonus Dice", { exact: true })).toHaveValue("-3");
    const afterFailure = (await (await page.request.get(`/api/characters/${characterId}`)).json()).character;
    expect(afterFailure.revision).toBe(character.revision);
    expect(afterFailure.state).toEqual(character.state);
    await discardRejectedRoll(page);
    await page.getByLabel("Bonus Dice", { exact: true }).fill("-2");
    await page.getByRole("button", { name: "Test Pool", exact: true }).click();
    await expect(page.getByText("Successes: 0", { exact: true })).toBeVisible();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await page.getByLabel("Bonus Dice", { exact: true }).fill("0");
    await page.getByRole("button", { name: "Test Pool", exact: true }).click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();

    // Add the system-authored item through the sheet, then use its action.
    await page.getByTestId("slot-add-gear").click();
    await page.getByTestId("slot-template-picker-gear").selectOption("pool_tool");
    await page.getByTestId("slot-add-confirm-gear").click();
    await expect(page.getByRole("button", { name: "Gear Pool", exact: true })).toBeVisible();
    await page.getByLabel("Gear Dice", { exact: true }).fill("-3");
    await page.getByRole("button", { name: "Gear Pool", exact: true }).click();
    await expect(page.getByText(/Roll could not be evaluated:/).first()).toBeVisible();
    await discardRejectedRoll(page);
    await page.getByLabel("Gear Dice", { exact: true }).fill("0");
    await page.getByRole("button", { name: "Gear Pool", exact: true }).click();
    await expect(page.getByText(/Gear successes:/).first()).toBeVisible();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    for (const width of [320, 360, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      }
    }
    await page.reload();
    await expect(page.getByRole("button", { name: "Gear Pool", exact: true })).toBeVisible();
  } finally {
    if (process.env.SWEETROLL_E2E_EPHEMERAL_DB !== "1") await page.request.delete(`/api/systems/${systemId}`);
  }
});
