import AxeBuilder from "@axe-core/playwright";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";

import {
  D20_REFERENCE_SYSTEM,
  REFERENCE_SYSTEMS,
  TEST_USER_A,
  apiBump,
  apiSetField,
  expectNoHorizontalOverflow,
  expectOfflineAvailable,
  expectSheetReady,
  exportCharacter,
  newSignedInContext,
  publishCompletionVariant,
  readActivity,
  readCharacter,
  testSignIn,
  uid,
  type ReferenceSystem,
} from "./test-auth.js";

/**
 * Task 8 full production journey (real built app + preview + real backend):
 * for every reference system at 360px — UI creation, required-field
 * completion, online edit/bump, UI roll with authoritative details,
 * offline-ready, several ordered offline edits, close/reopen of the same deep
 * link while offline, reconnect, an explicit server-conflict review, and a UI
 * export of the final confirmed state. Final revision/resource/activity/roll
 * counts are asserted against the server, and the captured download is
 * compared with the authoritative export document. Pending edits block
 * export. d20 completes its native `Proficient` field; pbta/pool complete a
 * minimal authorized clone variant that unbinds one required field (their
 * reference sheets bind every required field, so editing an already-complete
 * field would not prove completion).
 *
 * Evidence (screenshots, axe) for 360px and 1280px goes to
 * `tests/offline/evidence/` with build-ID filenames — never to the cleared
 * `test-results/` directory.
 */

const EVIDENCE_DIR = "tests/offline/evidence";

async function buildId(page: Page): Promise<string> {
  const id = await page.evaluate(
    () => document.querySelector('meta[name="offline-build-id"]')?.getAttribute("content"),
  );
  return id ?? "unknown-build";
}

async function createThroughUI(page: Page, versionId: string, name: string): Promise<string> {
  await page.goto(`/characters/new?systemVersionId=${versionId}`);
  await page.getByLabel("System version ID").fill(versionId);
  await page.getByRole("button", { name: "Look up version" }).click();
  await page.getByLabel("Entity").selectOption("character");
  await page.getByLabel("Character name").fill(name);
  await page.getByRole("button", { name: "Create character", exact: true }).click();
  await expect(page).toHaveURL(/\/characters\/[0-9a-f-]+/, { timeout: 30_000 });
  const match = page.url().match(/\/characters\/([0-9a-f-]+)/);
  if (!match) throw new Error("creation did not navigate to a character deep link");
  return match[1]!;
}

async function expectSaved(page: Page) {
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 60_000 });
}

/**
 * Complete a required field through the real completion section. The commit
 * right after navigation can race session startup, so retry the control
 * until the checked/value state sticks, then wait for Saved.
 */
async function completeRequiredField(page: Page, system: ReferenceSystem) {
  const completionHeading = page.getByRole("heading", { name: "Complete Your Character" });
  await expect(completionHeading).toBeVisible({ timeout: 30_000 });
  const completionScope = page.locator("section", { has: completionHeading });
  if (system.completionKind === "checkbox") {
    const box = completionScope.getByRole("checkbox", { name: system.completionLabel });
    await expect(async () => {
      if (!(await box.isChecked())) await box.click();
      expect(await box.isChecked()).toBe(true);
    }).toPass({ timeout: 30_000 });
  } else {
    const input = completionScope.getByLabel(system.completionLabel);
    await input.fill("3");
    await input.press("Enter");
  }
  await expectSaved(page);
}

test.describe("full production UI journey per system", () => {
  for (const system of REFERENCE_SYSTEMS) {
    test(`journey at 360px (${system.key}): create, complete, roll, offline edits, conflict, export`, async ({
      browser,
    }) => {
      test.setTimeout(420_000);
      const { context } = await newSignedInContext(browser, TEST_USER_A.code);
      try {
        await runJourney(context, system);
      } finally {
        await context.close();
      }
    });
  }

  test("production UI exposes no dev sign-in", async ({ browser }) => {
    const { context } = await newSignedInContext(browser, TEST_USER_A.code);
    try {
      const page = await context.newPage();
      await page.goto("/");
      await expect(page.getByTestId("app-header")).toBeVisible();
      await expect(page.getByTestId("dev-signin")).toHaveCount(0);
      await expect(page.getByTestId("dev-signin-panel")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("creation picker: versionless /characters/new reaches entity selection through the picker", async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const system = D20_REFERENCE_SYSTEM;
    const { context } = await newSignedInContext(browser, TEST_USER_A.code);
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width: 360, height: 740 });
      // No search input: the picker alone must offer the seeded versions.
      await page.goto("/characters/new");
      await expect(
        page.getByRole("heading", { name: "Choose a system version" }),
      ).toBeVisible({ timeout: 30_000 });
      // Button label contract is `{systemName} {semanticVersion}`; the
      // reference seed publishes "Template: d20" at 1.0.0.
      await page.getByRole("button", { name: "Template: d20 1.0.0" }).click();
      await page.getByLabel("Entity").selectOption("character");
      // The picker fills the manual box with the chosen reference version,
      // so the unchanged lookup/create path below runs on the d20 seed.
      await expect(page.getByLabel("System version ID")).toHaveValue(system.systemVersionId);
      const characterName = `Picker ${uid()}`;
      await page.getByLabel("Character name").fill(characterName);
      await page.getByRole("button", { name: "Create character", exact: true }).click();
      await expect(page).toHaveURL(/\/characters\/[0-9a-f-]+/, { timeout: 30_000 });
      await expectSheetReady(page, characterName);
      const build = await buildId(page);
      await page.screenshot({ path: `${EVIDENCE_DIR}/creation-picker-360-${build}.png` });
    } finally {
      await context.close();
    }
  });
});

async function runJourney(context: BrowserContext, system: ReferenceSystem) {
  // Publish the minimal completion variant through the real System Builder
  // API where the reference sheet binds every required field. The fixture
  // only publishes systems; every character action below runs in the page.
  const setup = await context.newPage();
  await testSignIn(setup.request, TEST_USER_A.code);
  const versionId =
    system.variantDropsElement === null
      ? system.systemVersionId
      : await publishCompletionVariant(setup.request, system.systemVersionId, system.variantDropsElement);
  await setup.close();
  for (const p of context.pages()) await p.close();

  const page = await context.newPage();
  await page.setViewportSize({ width: 360, height: 740 });
  const characterName = `Journey ${system.key} ${uid()}`;

  // 1. UI creation (never the API helper): the page navigates to the deep link.
  const characterId = await createThroughUI(page, versionId, characterName);
  await expectSheetReady(page, characterName);
  await expect(page.getByTestId("dev-signin")).toHaveCount(0);
  let server = await readCharacter(page.request, characterId);
  const revisionAfterCreate = server.character.revision;

  // 2. Required-field completion through the real completion section. The
  // section must exist: an already-complete edit would not prove this.
  await completeRequiredField(page, system);
  server = await readCharacter(page.request, characterId);
  expect(server.character.revision).toBe(revisionAfterCreate + 1);

  // 3. Online edit + resource bump through sheet controls.
  const editBox = page.getByLabel(system.editFieldLabel);
  await editBox.fill(system.editFieldValue);
  await editBox.press("Enter");
  await expectSaved(page);
  const bumpDown = system.key === "d20";
  await page.getByRole("button", { name: bumpDown ? system.decreaseButton : system.increaseButton }).click();
  await expectSaved(page);
  const onlineState = await readCharacter(page.request, characterId);
  const revisionOnline = onlineState.character.revision;
  expect(revisionOnline).toBe(revisionAfterCreate + 3);

  // 4. Authoritative roll through the UI action (online-only by design).
  await page.getByRole("button", { name: system.actionLabel, exact: true }).click();
  await expect(page.getByRole("heading", { name: "Roll result" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Expression", { exact: true })).toBeVisible();
  await expect(page.getByText("Total", { exact: true })).toBeVisible();
  await expect(page.getByText("Owner only")).toBeVisible();
  await page.getByRole("button", { name: "Show roll details" }).click();
  const details = (await page.locator("section", { has: page.getByRole("heading", { name: "Roll result" }) }).textContent()) ?? "";
  expect(details).toMatch(/d\d+=/);
  await expectSaved(page);
  const afterRoll = await readCharacter(page.request, characterId);
  const revisionAfterRoll = afterRoll.character.revision;
  // Rolls record roll rows + activity but do not advance the character revision.
  expect(revisionAfterRoll).toBe(revisionOnline);
  const activityAfterRoll = await readActivity(page.request, characterId);
  expect(activityAfterRoll.events.filter(e => e.kind === "character_action_executed")).toHaveLength(1);

  // 5. Offline-ready, then evidence at 360px (screenshot/axe/no-overflow).
  await expectOfflineAvailable(page);
  await expectNoHorizontalOverflow(page);
  const build = await buildId(page);
  await page.screenshot({ path: `${EVIDENCE_DIR}/journey-${system.key}-360-online-${build}.png` });
  const axe360 = await new AxeBuilder({ page }).analyze();
  expect(axe360.violations.filter(v => v.impact === "serious" || v.impact === "critical")).toEqual([]);

  // 6. Pending edits block export: queue one edit offline and assert the
  // Export tool control stays disabled until the queue drains.
  const resourceBefore = resourceCurrent(afterRoll, system.resourceId);
  await context.setOffline(true);
  try {
    await page.getByRole("button", { name: bumpDown ? system.decreaseButton : system.increaseButton }).click();
    await expect(page.getByText("Changes pending")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Export" })).toBeDisabled();

    // 7. Queue multiple ordered edits (bump, field set, bump).
    const secondEditValue = system.key === "pool" ? "5" : system.key === "pbta" ? "3" : "12";
    const editBoxOffline = page.getByLabel(system.editFieldLabel);
    await editBoxOffline.fill(secondEditValue);
    await editBoxOffline.press("Enter");
    await page.getByRole("button", { name: bumpDown ? system.decreaseButton : system.increaseButton }).click();
    await expect(page.getByText("Changes pending")).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: `${EVIDENCE_DIR}/journey-${system.key}-360-pending-${build}.png` });

    // 8. Close and reopen the same deep link while offline: the durable
    // queue and confirmed state must survive in this browser profile.
    const url = page.url();
    await page.close();
    const reopened = await context.newPage();
    try {
      await reopened.setViewportSize({ width: 360, height: 740 });
      await reopened.goto(url);
      await expectSheetReady(reopened, characterName);
      await expect(reopened.getByText("Changes pending")).toBeVisible({ timeout: 30_000 });
      await expect(reopened.getByText("Available offline", { exact: true })).toBeVisible({ timeout: 30_000 });

      // 9. Independent writer advances the server while we reconnect, so the
      // queued prefix conflicts and requires explicit review (never silent
      // merge). The writer only seeds server state; the browser resolves it.
      const writerRevision = await apiSetField(
        reopened.request,
        characterId,
        system.key === "d20" ? "modifier" : system.key === "pbta" ? "description" : "condition",
        system.key === "d20" ? 1 : system.key === "pbta" ? "writer note" : "focused",
        revisionAfterRoll,
      );
      expect(writerRevision).toBe(revisionAfterRoll + 1);

      await context.setOffline(false);
      await expect(reopened.getByRole("heading", { name: "Review conflicts" })).toBeVisible({
        timeout: 60_000,
      });
      // Explicit review: select every queued intention and reapply in order.
      for (const checkbox of await reopened.getByRole("checkbox").all()) {
        await checkbox.check();
      }
      await reopened.getByRole("button", { name: "Reapply", exact: true }).click();
      await reopened.getByRole("button", { name: "Confirm reapply" }).click();
      await expect(reopened.getByText("Saved", { exact: true })).toBeVisible({ timeout: 60_000 });

      // 10. Final server/DB assertions: revision, resource, activity + rolls.
      const final = await readCharacter(reopened.request, characterId);
      // Writer +1, then the three queued intentions reapplied with new keys.
      expect(final.character.revision).toBe(revisionAfterRoll + 4);
      const step = bumpDown ? -1 : 1;
      expect(resourceCurrent(final, system.resourceId)).toBe(resourceBefore + 2 * step);
      const activity = await readActivity(reopened.request, characterId);
      const kinds = activity.events.map(e => e.kind);
      expect(kinds.filter(k => k === "character_resource_bumped")).toHaveLength(3);
      expect(kinds.filter(k => k === "character_action_executed")).toHaveLength(1);

      // 11. UI export of the final confirmed state: capture the download and
      // compare its parsed content with the authoritative server export.
      await reopened.getByRole("button", { name: "Export" }).click();
      const downloadPromise = reopened.waitForEvent("download", { timeout: 30_000 });
      await reopened.getByRole("button", { name: "Download export" }).click();
      const download = await downloadPromise;
      const downloadPath = await download.path();
      if (!downloadPath) throw new Error("export download produced no file");
      const { readFile } = await import("node:fs/promises");
      const downloaded = JSON.parse(await readFile(downloadPath, "utf8")) as unknown;
      expect(downloaded).toEqual(await exportCharacter(reopened.request, characterId));

      // 12. 1280px evidence on the same real page: keyboard bump, axe,
      // no-overflow, durable screenshot.
      await reopened.setViewportSize({ width: 1280, height: 800 });
      await expectNoHorizontalOverflow(reopened);
      const wideBump = reopened.getByRole("button", {
        name: bumpDown ? system.increaseButton : system.decreaseButton,
      });
      await wideBump.focus();
      await expect(wideBump).toBeFocused();
      await reopened.keyboard.press("Enter");
      await expect(reopened.getByText("Saved", { exact: true })).toBeVisible({ timeout: 60_000 });
      const wideBuild = await buildId(reopened);
      await reopened.screenshot({ path: `${EVIDENCE_DIR}/journey-${system.key}-1280-final-${wideBuild}.png` });
      const axe1280 = await new AxeBuilder({ page: reopened }).analyze();
      expect(axe1280.violations.filter(v => v.impact === "serious" || v.impact === "critical")).toEqual([]);
    } finally {
      await reopened.close().catch(() => {});
    }
  } finally {
    await context.setOffline(false).catch(() => {});
  }
}

function resourceCurrent(
  envelope: { character: { state: { values: Record<string, unknown> } } },
  resourceId: string,
): number {
  const raw = envelope.character.state.values[resourceId] as { current?: unknown } | undefined;
  if (typeof raw?.current !== "number") {
    throw new Error(`resource ${resourceId} has no numeric current value`);
  }
  return raw.current;
}
