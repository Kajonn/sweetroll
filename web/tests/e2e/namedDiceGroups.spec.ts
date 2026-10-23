import { expect, test } from "@playwright/test";
import {
  namedDicePoolDocument,
  namedPoolSource,
} from "../../../src/systems/implementation/package/fixtures/named-dice-pool.js";
import { uid } from "../offline/test-auth.js";

test("named groups survive guided authoring, publishing, both action sources and history reload", async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.goto("/");
  await page.getByTestId("dev-signin").click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  const cloned = await page.request.post("/api/systems", {
    data: {
      source: {
        kind: "clone",
        versionId: "c0000000-0000-5000-8000-000000000002",
      },
      idempotencyKey: uid(),
    },
  });
  expect(cloned.status()).toBe(201);
  const { workspace } = await cloned.json();
  const systemId = workspace.system.systemId;
  try {
    const doc = namedDicePoolDocument();
    doc.schemaVersion = "1.0";
    doc.expressions.find((e) => e.id === "pool_roll_expr")!.source =
      "countSuccesses(dice(fields.attribute + fields.skill + inputs.bonus_dice, 6), 6)";
    const saved = await page.request.put(`/api/systems/${systemId}/draft`, {
      data: { expectedRevision: workspace.draft.revision, document: doc },
    });
    expect(saved.status()).toBe(200);
    await page.goto(`/systems/${systemId}`);
    await page.getByTestId("document-editor-tab-dice").click();
    await page
      .getByRole("button", { name: "Named dice groups", exact: true })
      .click();
    await expect(page.getByTestId("expression-editor-source")).toHaveValue(
      doc.expressions.find((e) => e.id === "pool_roll_expr")!.source,
    );
    await page
      .getByRole("button", { name: "Replace with grouped pool", exact: true })
      .click();
    const groupPanel = page.getByRole("region", {
      name: "Named dice groups",
      exact: true,
    });
    let row = groupPanel.locator("fieldset").nth(0);
    await row.getByLabel("Group label", { exact: true }).fill("Attribute");
    await row
      .getByLabel("Number of dice", { exact: true })
      .selectOption("fields.attribute");
    await row
      .getByLabel("Additional dice", { exact: true })
      .selectOption("inputs.bonus_dice");
    await groupPanel
      .getByRole("button", { name: "Add group", exact: true })
      .click();
    row = groupPanel.locator("fieldset").nth(1);
    await row.getByLabel("Group label", { exact: true }).fill("Skill");
    await row
      .getByLabel("Number of dice", { exact: true })
      .selectOption("fields.skill");
    await row.getByLabel("Die type", { exact: true }).selectOption("8");
    await row.getByLabel("Success threshold", { exact: true }).fill("5");
    await groupPanel
      .getByRole("button", { name: "Add group", exact: true })
      .click();
    row = groupPanel.locator("fieldset").nth(2);
    await row.getByLabel("Group label", { exact: true }).fill("Gear");
    await row
      .getByLabel("Number of dice", { exact: true })
      .selectOption("fields.gear");
    await row.getByLabel("Die type", { exact: true }).selectOption("4");
    const finalSave = page.waitForResponse((r) => {
      if (
        r.request().method() !== "PUT" ||
        !r.url().endsWith(`/api/systems/${systemId}/draft`)
      )
        return false;
      const d = r.request().postDataJSON()?.document;
      return (
        d?.schemaVersion === "1.1" &&
        d.expressions.some((e: { source: string }) =>
          e.source.endsWith('group("group_3", "Gear", dice(fields.gear, 4))'),
        )
      );
    });
    await row.getByLabel("Calculation", { exact: true }).selectOption("sum");
    expect((await finalSave).status()).toBe(200);
    await page.reload();
    await page.getByTestId("document-editor-tab-dice").click();
    await page.getByTestId("roll-action-try-test_pool").click();
    await expect(page.getByTestId("roll-group-group_1")).toContainText(
      "Attribute",
    );
    await expect(page.getByTestId("roll-group-group_3")).toContainText(
      "Empty group",
    );
    // Add a system-authored granted action using the same versioned language.
    const opened = (
      await (await page.request.get(`/api/systems/${systemId}`)).json()
    ).workspace;
    const document = opened.draft.document;
    document.slots = [{ id: "gear_slot", label: "Gear", accepts: ["item"] }];
    document.templates = [
      {
        id: "tool",
        label: "Pool Tool",
        kind: "item",
        fields: [],
        grantedActions: [
          {
            kind: "roll",
            id: "gear_pool",
            label: "Gear Pool",
            expressionId: "gear_pool_expr",
            inputs: [
              {
                id: "bonus_dice",
                label: "Bonus Dice",
                valueType: "integer",
                required: false,
                default: 0,
              },
            ],
            outputTemplate: "Gear successes: {total}",
          },
        ],
      },
    ];
    document.expressions.push({
      id: "gear_pool_expr",
      context: "roll",
      resultType: "number",
      fallback: 0,
      source: namedPoolSource,
    });
    document.sheets[0].sections[1].elements.push({
      kind: "slot",
      id: "gear_slot_element",
      slotId: "gear_slot",
    });
    const withItem = await page.request.put(`/api/systems/${systemId}/draft`, {
      data: { expectedRevision: opened.draft.revision, document },
    });
    expect(withItem.status()).toBe(200);
    await page.reload();
    await page.getByTestId("document-editor-publish").click();
    await page.getByTestId("publish-dialog-semver").fill("1.0.0");
    await page
      .getByTestId("publish-dialog-release-notes")
      .fill("Named group acceptance");
    await page.getByTestId("publish-dialog-submit").click();
    await expect(page.getByTestId("publish-dialog-success")).toBeVisible();
    await page.getByTestId("publish-dialog-create-character").click();
    await page.getByLabel("Entity", { exact: true }).selectOption("character");
    await page.getByLabel("Character name").fill(`Grouped ${uid()}`);
    await page
      .getByRole("button", { name: "Create character", exact: true })
      .click();
    await expect(page).toHaveURL(/\/characters\/[0-9a-f-]+$/);
    const characterId = page.url().split("/").pop()!;
    await page.getByRole("button", { name: "Test Pool", exact: true }).click();
    await expect(page.getByTestId("roll-group-group_1")).toContainText("1d6");
    await expect(page.getByTestId("roll-group-group_2")).toContainText(
      "Successes ≥ 5",
    );
    await page.getByTestId("slot-add-gear_slot").click();
    await page
      .getByTestId("slot-template-picker-gear_slot")
      .selectOption("tool");
    await page.getByTestId("slot-add-confirm-gear_slot").click();
    await page.getByRole("button", { name: "Gear Pool", exact: true }).click();
    await expect(page.getByTestId("roll-group-attribute")).toBeVisible();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    for (const width of [320, 360, 768, 1280])
      for (const colorScheme of ["light", "dark"] as const) {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        ).toBe(true);
      }
    await page.reload();
    await page.getByRole("button", { name: "Activity", exact: true }).click();
    await expect(page.getByTestId("roll-group-attribute")).toBeVisible();
    const activity = await page.request.get(
      `/api/characters/${characterId}/activity`,
    );
    expect(activity.status()).toBe(200);
    expect(
      (await activity.json()).events.filter(
        (e: { roll?: unknown }) => e.roll !== undefined,
      ),
    ).toHaveLength(2);
  } finally {
    if (process.env.SWEETROLL_E2E_EPHEMERAL_DB !== "1")
      await page.request.delete(`/api/systems/${systemId}`);
  }
});
