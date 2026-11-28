import { test, expect } from "../fixtures/browserTest";
import { expectSheetSaved } from "../fixtures/sheetSaved";
import {
  D20_REFERENCE_SYSTEM,
  TEST_USER_A,
  createCharacter,
  expectOfflineAvailable,
  expectSheetReady,
  newSignedInContext,
  readActivity,
  readCharacter,
  uid,
} from "./test-auth.js";

test.use({ actionTimeout: 30_000, navigationTimeout: 30_000 });

// Rules coverage R1: amount and direct-input commands queue offline like one-step bumps.
test("resource amount and direct input queue offline and apply once each on reconnect", async ({ browser }) => {
  test.setTimeout(180_000);
  const { context } = await newSignedInContext(browser, TEST_USER_A.code);
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 360, height: 740 });
    const name = `Offline resource ${uid()}`;
    const { characterId, revision } = await createCharacter(page.request, {
      systemVersionId: D20_REFERENCE_SYSTEM.systemVersionId, name,
    });
    await page.goto(`/characters/${characterId}`);
    await expectSheetReady(page, name);
    await expect(page.getByText("10 / 10", { exact: true })).toBeVisible();
    await expectOfflineAvailable(page);

    await context.setOffline(true);
    const amount = page.getByLabel("Amount for Health", { exact: true });
    await amount.fill("7");
    await page.getByRole("button", { name: "Subtract from Health", exact: true }).click();
    await expect(page.getByText("3 / 10", { exact: true })).toBeVisible();
    await expect(page.getByText("Changes pending")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Set Health", exact: true }).click();
    await page.getByLabel("Maximum Health", { exact: true }).fill("20");
    await page.getByLabel("Current Health", { exact: true }).fill("12");
    await page.getByRole("button", { name: "Save Health", exact: true }).click();
    // The estimate follows the queued commands in order.
    await expect(page.getByText("12 / 20", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Check", exact: true })).toBeDisabled();
    // Nothing reached the server while offline.
    expect((await readCharacter(context.request, characterId)).character.revision).toBe(revision);

    await context.setOffline(false);
    await expectSheetSaved(page);
    await expect(page.getByText("12 / 20", { exact: true })).toBeVisible();
    const server = await readCharacter(page.request, characterId);
    expect(server.character.revision).toBe(revision + 2);
    expect(server.character.state.values.health).toEqual({ current: 12, max: 20 });
    const kinds = (await readActivity(page.request, characterId)).events.map(event => event.kind);
    expect(kinds.filter(kind => kind === "character_resource_adjusted")).toHaveLength(1);
    expect(kinds.filter(kind => kind === "character_resource_set")).toHaveLength(1);
  } finally {
    await context.setOffline(false).catch(() => {});
    await context.close();
  }
});
