import { test, expect, type Page } from "@playwright/test";

/**
 * G5 exit demonstration (Task 6): blank → simple system without writing an
 * expression → order sheet → preview → save → reopen → publish → create a
 * character from the published version. Plus the reference-preservation
 * companion: editing a cloned reference system keeps advanced definitions.
 *
 * Needs a live backend per web/playwright.config.ts:17-47
 * (`npm run migrate && npm run dev:http` + `npm run web:dev`).
 */

// Systems created/cloned by these tests are deleted in test.afterEach so a
// failing assertion cannot leave residue in the shared DB (deterministic
// library baselines). page.request shares the browser context's sign-in
// cookie. Created characters have no DELETE endpoint, matching
// character-sheet.spec.ts precedent (unique names per run).
const createdSystemIds: string[] = [];
test.afterEach(async ({ page }) => {
  for (const id of createdSystemIds.splice(0)) {
    await page.request.delete(`/api/systems/${id}`).catch(() => {});
  }
});

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByTestId("dev-signin").click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 30_000 });
}

function waitForDraftPut(page: Page, snippet?: string) {
  return page.waitForResponse(
    (r) => {
      if (
        !(
          r.request().method() === "PUT" &&
          r.url().includes("/api/systems/") &&
          r.url().endsWith("/draft")
        )
      ) {
        return false;
      }
      if (snippet === undefined) return true;
      try {
        const body = r.request().postDataJSON() as { document?: unknown } | null;
        return JSON.stringify(body?.document ?? null).includes(snippet);
      } catch {
        return false;
      }
    },
    { timeout: 20_000 },
  );
}

async function expectNoPageOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth + 1);
}

test("G5 exit: blank → simple system without expression → order sheet → preview → save → reopen → publish → create character", async ({
  page,
}) => {
  test.setTimeout(180_000);

  // 1. Create blank draft via library UI (name only), expect /systems/:id.
  await signIn(page);
  await page.getByTestId("library-new-system").click();
  await page.getByTestId("create-draft-name").fill("G5 Exit Demo");
  await page.getByTestId("create-draft-submit").click();
  await expect(page).toHaveURL(/\/systems\/[0-9a-f-]+/);
  const systemId = page.url().split("/").pop() ?? "";
  createdSystemIds.push(systemId);
  await expect(page.getByTestId("document-editor-header")).toBeVisible();
  await expect(page.getByTestId("document-editor-lifecycle")).toHaveText(/Draft/);

  // 2. Basics tab (default): set description + default dice. MetadataEditor
  // buffers keystrokes locally and flushes on blur, so Tab out before
  // waiting for the save; the waiter matches the PUT carrying our edit.
  await page.getByTestId("metadata-description").fill("A tiny system built without expressions.");
  await page.getByTestId("metadata-default-dice").fill("d6");
  const basicsSaved = waitForDraftPut(page, "A tiny system built without expressions.");
  await page.keyboard.press("Tab");
  await basicsSaved;

  // Attributes tab: add an entity with 2 scalar fields (integer + text).
  await page.getByTestId("document-editor-tab-attributes").click();
  await page.getByTestId("entity-list-add").click();
  const entityRow = page.locator('li[data-testid^="entity-row-"]').last();
  const entityId =
    (await entityRow.getAttribute("data-testid"))?.replace("entity-row-", "") ?? "";
  expect(entityId).not.toBe("");
  await page.getByTestId(`entity-label-input-${entityId}`).fill("Hero");
  await page.getByTestId(`entity-field-kind-picker-${entityId}`).selectOption("integer");
  await page.getByTestId(`entity-add-field-${entityId}`).click();
  await page.getByTestId(`entity-field-kind-picker-${entityId}`).selectOption("text");
  await page.getByTestId(`entity-add-field-${entityId}`).click();
  await page.getByTestId("scalar-field-label-field").fill("Might");
  await page.getByTestId("scalar-field-label-field_1").fill("Name");
  await waitForDraftPut(page, "Might");

  // Dice tab: add a guided roll (dice-kind picker only — no expression typed).
  await page.getByTestId("document-editor-tab-dice").click();
  await page.getByTestId("actions-add-roll").click();
  const rollSection = page.locator('[data-testid^="roll-action-"]').first();
  const actionId =
    (await rollSection.getAttribute("data-testid"))?.replace("roll-action-", "") ?? "";
  expect(actionId).not.toBe("");
  await expect(page.getByTestId(`dice-kind-${actionId}`)).toBeVisible();
  await page.getByTestId(`dice-kind-${actionId}`).selectOption("d6");
  await waitForDraftPut(page, actionId);

  // 3. Sections tab: add a sheet with two sections, bind the two fields, then
  // move the second section up with the keyboard (Alt+ArrowUp on the handle).
  await page.getByTestId("document-editor-tab-sections").click();
  await page.getByTestId("sheet-add-button").click();
  await page.getByTestId("sheet-add-section").click();
  await page.getByTestId("sheet-add-section").click();
  await page.getByTestId("section-label-section_1").fill("Alpha");
  await page.getByTestId("section-label-section_2").fill("Beta");
  await page.getByTestId("section-add-element-field-section_1").click();
  await page.getByTestId("section-add-element-field-section_2").click();
  await page
    .getByTestId("section-row-section_1")
    .locator('[data-testid^="element-binding-"]')
    .getByTestId("definition-id-input")
    .fill("field");
  await page
    .getByTestId("section-row-section_2")
    .locator('[data-testid^="element-binding-"]')
    .getByTestId("definition-id-input")
    .fill("field_1");
  await page.getByTestId("section-row-section_2-handle").click();
  await page.keyboard.press("Alt+ArrowUp");
  await expect(page.getByTestId("section-row-section_2-position")).toHaveText("1");
  await expect(page.getByTestId("section-row-section_1-position")).toHaveText("2");
  await waitForDraftPut(page, "section_2");

  // 4. Toggle preview at desktop width, expect the moved order in preview and
  // no page-level horizontal scroll; repeat the scroll check at phone width.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByTestId("document-editor-preview-toggle").click();
  const frame = page.getByTestId("preview-frame");
  await expect(frame).toHaveAttribute("data-width", "360");
  await page.getByTestId("preview-frame-toggle").click();
  await expect(frame).toHaveAttribute("data-width", "1280");
  const previewOrder = await page
    .getByTestId("document-editor-preview")
    .locator('[data-testid^="preview-section-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  expect(previewOrder).toEqual(["preview-section-section_2", "preview-section-section_1"]);
  await expectNoPageOverflow(page);
  await page.setViewportSize({ width: 360, height: 800 });
  await expectNoPageOverflow(page);
  // Editor/preview switch (phone): both views reachable by button.
  await page.getByTestId("document-editor-preview-view-editor").click();
  await expect(page.getByTestId("document-editor-preview-view-editor")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByTestId("document-editor-preview-view-preview").click();
  await expect(page.getByTestId("document-editor-preview-view-preview")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.setViewportSize({ width: 1280, height: 800 });

  // 5. Wait for Saved, reload (reopen), expect draft values retained.
  await expect(page.getByTestId("document-editor-autosave")).toContainText("Saved", {
    timeout: 30_000,
  });
  await page.reload();
  await expect(page.getByTestId("document-editor-header")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("metadata-description")).toHaveValue(
    "A tiny system built without expressions.",
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("metadata-default-dice")).toHaveValue("d6");
  await expect(page.getByTestId("document-editor-lifecycle")).toHaveText(/Draft/);

  // 6. Publish 1.0.0 with release notes, expect success with version/checksum
  // and the post-publish Create-test-character CTA.
  await page.getByTestId("document-editor-publish").click();
  await expect(page.getByTestId("publish-dialog")).toBeVisible();
  await page.getByTestId("publish-dialog-semver").fill("1.0.0");
  await page.getByTestId("publish-dialog-release-notes").fill("G5 exit demo release.");
  await page.getByTestId("publish-dialog-submit").click();
  await expect(page.getByTestId("publish-dialog-success")).toBeVisible();
  const cta = page.getByTestId("publish-dialog-create-character");
  await expect(cta).toBeVisible();
  const href = await cta.getAttribute("href");
  expect(href).toMatch(/\/characters\/new\?systemVersionId=[0-9a-f-]+/);
  const versionId = href?.split("systemVersionId=")[1] ?? "";
  expect(versionId).not.toBe("");

  // 7. Click Create test character, complete creation WITHOUT entering a
  // version ID (deep link prefills it), expect the character sheet.
  await cta.click();
  await expect(page).toHaveURL(new RegExp(`/characters/new\\?systemVersionId=${versionId}`));
  await expect(page.getByLabel("System version ID")).not.toHaveValue("");
  const entitySelect = page.getByLabel("Entity");
  await expect(entitySelect).toBeVisible({ timeout: 30_000 });
  await entitySelect.selectOption(entityId);
  await page.getByLabel("Character name").fill("G5 Test Hero");
  await page.getByRole("button", { name: "Create character", exact: true }).click();
  await expect(page).toHaveURL(/\/characters\/[0-9a-f-]+/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "G5 Test Hero" })).toBeVisible({
    timeout: 30_000,
  });

  // 8. Back in the editor, the version history shows the 1.0.0 row.
  await page.goto(`/systems/${systemId}`);
  await expect(page.getByTestId("document-editor-header")).toBeVisible();
  await page.getByTestId("document-editor-version-history-toggle").click();
  await expect(page.getByTestId("document-editor-version-history")).toContainText("1.0.0");
});

test("editing a published reference system preserves its advanced definitions", async ({
  page,
}) => {
  test.setTimeout(120_000);

  // Clone the d20 reference fixture; snapshot the draft's advanced
  // definitions via the existing open surface (GET /systems/:id).
  await signIn(page);
  await page.getByTestId("clone-from-template-d20").click();
  await expect(page).toHaveURL(/\/systems\/[0-9a-f-]+/);
  const systemId = page.url().split("/").pop() ?? "";
  createdSystemIds.push(systemId);
  await expect(page.getByTestId("document-editor-header")).toBeVisible();

  const openBefore = await (await page.request.get(`/api/systems/${systemId}`)).json();
  const docBefore = openBefore.workspace.draft.document;
  expect(docBefore.actions.length).toBeGreaterThan(0);
  expect(docBefore.expressions.length).toBeGreaterThan(0);
  expect(docBefore.validations.length).toBeGreaterThan(0);

  // Export diff: publish the clone, then export the OWNED version and expect
  // its expression ids to match the cloned draft's. (The template seed
  // itself is link-only with owner NULL, so exporting the seed version id is
  // a 404 by design — exportVersion requires ownership.)
  await page.getByTestId("document-editor-publish").click();
  await expect(page.getByTestId("publish-dialog")).toBeVisible();
  await page.getByTestId("publish-dialog-semver").fill("1.0.0");
  await page.getByTestId("publish-dialog-release-notes").fill("Reference preservation probe.");
  await page.getByTestId("publish-dialog-submit").click();
  await expect(page.getByTestId("publish-dialog-success")).toBeVisible();
  await page.getByTestId("publish-dialog-close").click();

  const versionsBody = await (await page.request.get(`/api/systems/${systemId}/versions`)).json();
  const publishedVersionId = versionsBody.versions[0].versionId as string;
  expect(publishedVersionId).not.toBe("");
  const exportRes = await page.request.get(`/api/system-versions/${publishedVersionId}/export`);
  expect(exportRes.ok()).toBe(true);
  const exportJson = await exportRes.json();
  expect(exportJson.package.expressions.map((e: { id: string }) => e.id)).toEqual(
    docBefore.expressions.map((e: { id: string }) => e.id),
  );

  const before = {
    actions: JSON.stringify(docBefore.actions),
    expressions: JSON.stringify(docBefore.expressions),
    validations: JSON.stringify(docBefore.validations),
  };

  // Change only the system description (Tab out to flush the buffered
  // metadata form), then save.
  const probeText = `G5 preservation probe ${Date.now()}`;
  const saved = waitForDraftPut(page, probeText);
  await page.getByTestId("metadata-description").fill(probeText);
  await page.keyboard.press("Tab");
  await saved;
  await expect(page.getByTestId("document-editor-autosave")).toContainText("Saved", {
    timeout: 30_000,
  });

  // The advanced definitions are byte-identical; only metadata changed.
  const openAfter = await (await page.request.get(`/api/systems/${systemId}`)).json();
  const docAfter = openAfter.workspace.draft.document;
  expect(JSON.stringify(docAfter.actions)).toBe(before.actions);
  expect(JSON.stringify(docAfter.expressions)).toBe(before.expressions);
  expect(JSON.stringify(docAfter.validations)).toBe(before.validations);
  expect(docAfter.metadata.description).toContain(probeText);
});
