import { test, expect, type Browser, type Page } from "@playwright/test";

import { readActivity, uid } from "../offline/test-auth.js";

/**
 * Task 8 exit demonstration (dynamic sheet objects): creator authors item
 * templates + an inventory slot through the editor UI -> publishes 1.0.0 ->
 * a fresh player context creates a character -> templated add grants the
 * attack, custom entries stay data-only, granted roll resolves, removal
 * revokes the attack while history stays append-only, offline add replays
 * exactly once -> removing a template trips the breaking gate over the API
 * until acknowledged.
 *
 * Testid sources (invented nothing):
 * - creator chrome: web/tests/e2e/creatorToCharacter.spec.ts
 *   (library-new-system, create-draft-*, document-editor-tab-*,
 *   entity-list-add, entity-row-*, entity-label-input-*, scalar-field-label-*,
 *   sheet-add-button, sheet-add-section, section-label-*, publish-dialog-*,
 *   publish-dialog-create-character).
 * - templates/slots authoring: web/src/editor/TemplatesTab.test.tsx
 *   (templates-add-button, template-row-*, template-label-*, template-kind-*,
 *   template-add-roll-*, roll-action-*, roll-action-label-*, dice-kind-*,
 *   template-action-nominal-*, slots-add-button, slot-row-*, slot-label-*)
 *   plus web/src/editor/sheet/SheetEditor.test.tsx
 *   (section-add-element-slot-*, element-binding-*, definition-id-input,
 *   sheet-place-definition-*).
 * - sheet slot loop: web/src/characters/SlotListControl.test.tsx
 *   (slot-list-*, slot-add-*, slot-template-picker-*, slot-add-confirm-*,
 *   slot-custom-name-*, slot-entry-remove-*, slot-entry-remove-confirm-*,
 *   granted roll button by name).
 * - offline replay assertions mirror web/tests/offline/character.spec.ts
 *   (Changes pending -> Saved, single activity row, no dupes).
 * - breaking publish payload mirrors publishOwnedClone in
 *   web/tests/offline/test-auth.ts (clone/save/publish with
 *   acknowledgeBreaking).
 *
 * Needs a live backend per web/playwright.config.ts. Systems created by this
 * test are deleted in test.afterEach on direct runs; canonical runs discard
 * their ephemeral shard database.
 */
const createdSystemIds: string[] = [];
test.afterEach(async ({ page }) => {
  const ids = createdSystemIds.splice(0);
  if (process.env.SWEETROLL_E2E_EPHEMERAL_DB === "1") return;
  for (const id of ids) {
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

async function expectSaved(page: Page) {
  await expect(page.getByTestId("document-editor-autosave")).toContainText("Saved", {
    timeout: 30_000,
  });
}

async function expectSheetSaved(page: Page) {
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 60_000 });
}

/** Last data-testid suffix for a row prefix whose children share no row prefix. */
async function lastRowId(page: Page, selector: string, prefix: string): Promise<string> {
  const attr = await page.locator(selector).last().getAttribute("data-testid");
  expect(attr?.startsWith(prefix)).toBe(true);
  return (attr ?? "").slice(prefix.length);
}

test("dynamic objects: creator templates+slot -> player entries+granted roll -> breaking gate", async ({
  page,
  browser,
}: {
  page: Page;
  browser: Browser;
}) => {
  test.setTimeout(240_000);
  const stamp = uid();

  // ---- Leg 1: creator authoring (UI). ----
  await signIn(page);
  await page.getByTestId("library-new-system").click();
  await page.getByTestId("create-draft-name").fill(`Dynamic Objects ${stamp}`);
  await page.getByTestId("create-draft-submit").click();
  await expect(page).toHaveURL(/\/systems\/[0-9a-f-]+/);
  const systemId = page.url().split("/").pop() ?? "";
  createdSystemIds.push(systemId);
  await expect(page.getByTestId("document-editor-header")).toBeVisible();

  // Entity so characters can be created from the published version (mirrors
  // creatorToCharacter.spec.ts: integer + text scalar fields).
  await page.getByTestId("document-editor-tab-attributes").click();
  await page.getByTestId("entity-list-add").click();
  const entityId = await lastRowId(page, 'li[data-testid^="entity-row-"]', "entity-row-");
  expect(entityId).not.toBe("");
  await page.getByTestId(`entity-label-input-${entityId}`).fill("Hero");
  await page.getByTestId(`entity-field-kind-picker-${entityId}`).selectOption("integer");
  await page.getByTestId(`entity-add-field-${entityId}`).click();
  await page.getByTestId(`entity-field-kind-picker-${entityId}`).selectOption("text");
  await page.getByTestId(`entity-add-field-${entityId}`).click();
  await page.getByTestId("scalar-field-label-field").fill("Might");
  await page.getByTestId("scalar-field-label-field_1").fill("Name");
  await waitForDraftPut(page, "Might");

  // Templates tab: torch (nominal Raise Torch) + longsword (granted attack).
  await page.getByTestId("document-editor-tab-templates").click();
  await expect(page.getByTestId("templates-tab")).toBeVisible();

  await page.getByTestId("templates-add-button").click();
  const torchId = await lastRowId(page, 'div[data-testid^="template-row-"]', "template-row-");
  await page.getByTestId(`template-label-${torchId}`).fill("Torch");
  await page.getByTestId(`template-add-roll-${torchId}`).click();
  const torchActionAttr = await page
    .getByTestId(`template-row-${torchId}`)
    .locator('section[data-testid^="roll-action-"]')
    .getAttribute("data-testid");
  const torchActionId = (torchActionAttr ?? "").replace("roll-action-", "");
  expect(torchActionId).not.toBe("");
  await page.getByTestId(`roll-action-label-${torchActionId}`).fill("Raise Torch");
  await page.getByTestId(`template-action-nominal-${torchActionId}`).check();
  await waitForDraftPut(page, "Raise Torch");

  await page.getByTestId("templates-add-button").click();
  const swordId = await lastRowId(page, 'div[data-testid^="template-row-"]', "template-row-");
  expect(swordId).not.toBe(torchId);
  await page.getByTestId(`template-label-${swordId}`).fill("Longsword");
  await page.getByTestId(`template-add-roll-${swordId}`).click();
  const swordActionAttr = await page
    .getByTestId(`template-row-${swordId}`)
    .locator('section[data-testid^="roll-action-"]')
    .getAttribute("data-testid");
  const swordActionId = (swordActionAttr ?? "").replace("roll-action-", "");
  expect(swordActionId).not.toBe("");
  await page.getByTestId(`roll-action-label-${swordActionId}`).fill("Longsword Attack");
  const swordPut = waitForDraftPut(page, "Longsword Attack");
  // Default guided dice stays d20; the nominal torch keeps its {total} hint.
  await expect(page.getByTestId(`dice-kind-${swordActionId}`)).toHaveValue("d20");
  await swordPut;

  // Slot definition: Inventory accepting item (the addSlot default).
  await page.getByTestId("slots-add-button").click();
  const slotId = await lastRowId(page, 'div[data-testid^="slot-row-"]', "slot-row-");
  expect(slotId).not.toBe("");
  await page.getByTestId(`slot-label-${slotId}`).fill("Inventory");
  await waitForDraftPut(page, "Inventory");
  await expectSaved(page);

  // Authoring proof over the API surface: torch is nominal, longsword is a
  // live roll, the slot accepts item.
  const openRes = await page.request.get(`/api/systems/${systemId}`);
  expect(openRes.ok()).toBe(true);
  const draftDoc = ((await openRes.json()) as { workspace: { draft: { document: Record<string, unknown> } } })
    .workspace.draft.document as {
    templates: Array<{ id: string; label: string; kind: string; grantedActions: Array<{ id: string; label: string; nominal?: boolean }> }>;
    slots: Array<{ id: string; label: string; accepts: string[] }>;
  };
  const torch = draftDoc.templates.find((t) => t.label === "Torch");
  expect(torch?.kind).toBe("item");
  expect(torch?.grantedActions).toHaveLength(1);
  expect(torch?.grantedActions[0]).toMatchObject({ label: "Raise Torch", nominal: true });
  const sword = draftDoc.templates.find((t) => t.label === "Longsword");
  expect(sword?.kind).toBe("item");
  expect(sword?.grantedActions).toHaveLength(1);
  expect(sword?.grantedActions[0]?.label).toBe("Longsword Attack");
  expect(sword?.grantedActions[0]?.nominal).toBeUndefined();
  expect(draftDoc.slots.find((s) => s.id === slotId)).toMatchObject({
    label: "Inventory",
    accepts: ["item"],
  });

  // Sections tab: sheet section with a slot element bound to Inventory.
  await page.getByTestId("document-editor-tab-sections").click();
  await page.getByTestId("sheet-add-button").click();
  await page.getByTestId("sheet-add-section").click();
  const sectionAttr = await page.locator('input[data-testid^="section-label-"]').last().getAttribute("data-testid");
  const sectionId = (sectionAttr ?? "").replace("section-label-", "");
  expect(sectionId).not.toBe("");
  await page.getByTestId(`section-label-${sectionId}`).fill("Gear");
  await page.getByTestId(`section-add-element-slot-${sectionId}`).click();
  const binding = page
    .getByTestId(`section-row-${sectionId}`)
    .locator('[data-testid^="element-binding-"]')
    .getByTestId("definition-id-input");
  await binding.fill(slotId);
  const renameConfirm = page.getByTestId("definition-id-rename-confirm-submit");
  if (await renameConfirm.isVisible().catch(() => false)) {
    await renameConfirm.click();
  }
  await waitForDraftPut(page, slotId);
  await expectSaved(page);

  // Publish 1.0.0 and capture the version id from the post-publish CTA.
  await page.getByTestId("document-editor-publish").click();
  await expect(page.getByTestId("publish-dialog")).toBeVisible();
  await page.getByTestId("publish-dialog-semver").fill("1.0.0");
  await page.getByTestId("publish-dialog-release-notes").fill("Dynamic objects debut.");
  await page.getByTestId("publish-dialog-submit").click();
  await expect(page.getByTestId("publish-dialog-success")).toBeVisible();
  const cta = page.getByTestId("publish-dialog-create-character");
  await expect(cta).toBeVisible();
  const href = await cta.getAttribute("href");
  const versionId = href?.split("systemVersionId=")[1] ?? "";
  expect(versionId).toMatch(/[0-9a-f-]{36}/);

  // ---- Leg 2: player loop in a fresh context (same owner, clean session). ----
  const origin = new URL(page.url()).origin;
  const playerContext = await browser.newContext({ baseURL: origin });
  const player = await playerContext.newPage();
  try {
    await signIn(player);
    await player.goto(`/characters/new?systemVersionId=${versionId}`);
    await expect(player.getByLabel("System version ID")).not.toHaveValue("");
    await player.getByLabel("Entity").selectOption(entityId);
    const heroName = `Dynamic Hero ${stamp}`;
    await player.getByLabel("Character name").fill(heroName);
    await player.getByRole("button", { name: "Create character", exact: true }).click();
    await expect(player).toHaveURL(/\/characters\/[0-9a-f-]+/, { timeout: 30_000 });
    const characterId = player.url().split("/").pop() ?? "";
    expect(characterId).toMatch(/[0-9a-f-]{36}/);
    await expect(player.getByRole("heading", { name: heroName })).toBeVisible({ timeout: 30_000 });
    await expect(player.getByTestId(`slot-list-${slotId}`)).toBeVisible({ timeout: 30_000 });

    // Add longsword: the granted attack appears.
    await player.getByTestId(`slot-add-${slotId}`).click();
    await player.getByTestId(`slot-template-picker-${slotId}`).selectOption({ label: "Longsword" });
    await player.getByTestId(`slot-add-confirm-${slotId}`).click();
    await expectSheetSaved(player);
    await expect(player.getByRole("button", { name: "Longsword Attack" })).toBeVisible();

    // Add custom Lucky Stone: data-only, no granted actions.
    await player.getByTestId(`slot-add-${slotId}`).click();
    await player.getByTestId(`slot-template-picker-${slotId}`).selectOption({ label: "Custom entry" });
    await player.getByTestId(`slot-custom-name-${slotId}`).fill("Lucky Stone");
    await player.getByTestId(`slot-add-confirm-${slotId}`).click();
    await expectSheetSaved(player);
    const stoneLi = player.locator('li[data-testid^="slot-entry-"]', { hasText: "Lucky Stone" });
    await expect(stoneLi).toBeVisible();
    await expect(stoneLi.locator('form[data-testid^="slot-granted-"]')).toHaveCount(0);
    await expect(player.getByRole("button", { name: "Longsword Attack" })).toHaveCount(1);

    // Roll the granted attack (mirrors offline character.spec.ts assertions).
    await player.getByRole("button", { name: "Longsword Attack" }).click();
    await expect(player.getByRole("heading", { name: "Roll result" })).toBeVisible({ timeout: 60_000 });
    await expect(player.getByText("Total", { exact: true })).toBeVisible();
    await expectSheetSaved(player);
    const activityAfterRoll = await readActivity(player.request, characterId);
    expect(activityAfterRoll.events.filter((e) => e.kind === "character_action_executed")).toHaveLength(1);

    // Remove longsword: the attack vanishes, prior activity stays intact.
    const swordLi = player.locator('li[data-testid^="slot-entry-"]', {
      has: player.getByRole("button", { name: "Longsword Attack" }),
    });
    const swordEntryId = ((await swordLi.getAttribute("data-testid")) ?? "").replace("slot-entry-", "");
    expect(swordEntryId).toMatch(/.+/);
    await player.getByTestId(`slot-entry-remove-${swordEntryId}`).click();
    await player.getByTestId(`slot-entry-remove-confirm-${swordEntryId}`).click();
    await expectSheetSaved(player);
    await expect(player.getByRole("button", { name: "Longsword Attack" })).toHaveCount(0);
    await expect(
      player.locator('li[data-testid^="slot-entry-"]', { hasText: "Lucky Stone" }),
    ).toBeVisible();
    const activityAfterRemove = await readActivity(player.request, characterId);
    expect(activityAfterRemove.events.filter((e) => e.kind === "character_action_executed")).toHaveLength(1);
    expect(activityAfterRemove.events.filter((e) => e.kind === "entry_removed")).toHaveLength(1);

    // Offline leg: add torch while offline, reconnect, single replayed row.
    await playerContext.setOffline(true);
    try {
      await player.getByTestId(`slot-add-${slotId}`).click();
      await player.getByTestId(`slot-template-picker-${slotId}`).selectOption({ label: "Torch" });
      await player.getByTestId(`slot-add-confirm-${slotId}`).click();
      await expect(player.getByText("Changes pending")).toBeVisible({ timeout: 30_000 });
    } finally {
      await playerContext.setOffline(false);
    }
    await expectSheetSaved(player);
    await expect(player.locator('li[data-testid^="slot-entry-"]', { hasText: "Torch" })).toBeVisible();
    const activityAfterSync = await readActivity(player.request, characterId);
    // One add per entry (longsword, stone, torch): the offline add replayed
    // exactly once with no duplicate.
    expect(activityAfterSync.events.filter((e) => e.kind === "entry_added")).toHaveLength(3);

    // ---- Leg 3: breaking-change proof over the API. ----
    const cloneRes = await player.request.post("/api/systems", {
      data: { source: { kind: "clone", versionId }, idempotencyKey: `dynobj-clone-${stamp}` },
    });
    expect(cloneRes.ok()).toBe(true);
    const cloneWorkspace = ((await cloneRes.json()) as {
      workspace: { system: { systemId: string }; draft: { revision: number; document: Record<string, unknown> } };
    }).workspace;
    const cloneId = cloneWorkspace.system.systemId;
    createdSystemIds.push(cloneId);
    const cloneDoc = cloneWorkspace.draft.document as {
      templates: Array<{ id: string; label: string }>;
    };
    expect(cloneDoc.templates.some((t) => t.label === "Longsword")).toBe(true);

    // A fresh clone carries no version history, so the breaking gate needs a
    // baseline: publish the clone unchanged as 1.0.0 first (mirrors
    // publishOwnedClone in test-auth.ts).
    const baseline = await player.request.post(`/api/systems/${cloneId}/publish`, {
      data: {
        expectedRevision: cloneWorkspace.draft.revision,
        semanticVersion: "1.0.0",
        releaseNotes: "Dynamic objects breaking-gate baseline.",
        idempotencyKey: `dynobj-publish-base-${stamp}`,
        acknowledgeBreaking: true,
      },
    });
    expect(baseline.ok()).toBe(true);

    cloneDoc.templates = cloneDoc.templates.filter((t) => t.label !== "Longsword");
    const cloneSave = await player.request.put(`/api/systems/${cloneId}/draft`, {
      data: { expectedRevision: cloneWorkspace.draft.revision, document: cloneDoc },
    });
    expect(cloneSave.ok()).toBe(true);
    const cloneRevision = ((await cloneSave.json()) as { workspace: { draft: { revision: number } } }).workspace
      .draft.revision;

    const denied = await player.request.post(`/api/systems/${cloneId}/publish`, {
      data: {
        expectedRevision: cloneRevision,
        semanticVersion: "2.0.0",
        releaseNotes: "Remove longsword without ack.",
        idempotencyKey: `dynobj-publish-deny-${stamp}`,
        acknowledgeBreaking: false,
      },
    });
    expect(denied.ok()).toBe(false);
    expect(denied.status()).toBe(422);
    expect(JSON.stringify(await denied.json())).toContain("template_removed");

    const allowed = await player.request.post(`/api/systems/${cloneId}/publish`, {
      data: {
        expectedRevision: cloneRevision,
        semanticVersion: "2.0.0",
        releaseNotes: "Remove longsword with ack.",
        idempotencyKey: `dynobj-publish-ack-${stamp}`,
        acknowledgeBreaking: true,
      },
    });
    expect(allowed.ok()).toBe(true);
    const ackVersionId = ((await allowed.json()) as { version: { versionId: string } }).version.versionId;
    expect(ackVersionId).toMatch(/[0-9a-f-]{36}/);
  } finally {
    await playerContext.close();
  }
});
