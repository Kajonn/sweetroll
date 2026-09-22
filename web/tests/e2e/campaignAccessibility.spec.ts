import { randomUUID } from "node:crypto";

import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";

import { uid } from "../offline/test-auth.js";

/**
 * I7 hardening Task 1: campaign/GM axe accessibility spec (dev-server E2E).
 *
 * Covers the campaign/GM/display routes that had no axe/keyboard/overflow
 * browser coverage (library + character sheets already had it): the
 * /campaigns list, the campaign detail Characters / Content / Session /
 * Members / Settings tabs, the campaign settings display-pairing section, and the
 * /display code-entry — each at 360 and 1280 px width in light mode, plus
 * one 360 px dark-mode pass. Per surface: no horizontal overflow, zero
 * serious/critical axe violations, and one primary control driven by
 * keyboard (focus + Enter produces the visible committed state).
 *
 * Each test seeds its own campaign through the UI (clone d20 via
 * clone-from-template-d20, publish the unchanged draft, create the campaign,
 * author notes) so tests stay self-contained; scenes/characters have no
 * create UI in this slice, so those rows go through real HTTP like the
 * scene-display journey does. Cloned systems are cleaned up in afterEach
 * (DELETE /api/systems/:id); campaigns/notes/scenes carry unique names per
 * run since those endpoints have no DELETE. Canonical runs discard their
 * ephemeral shard database instead of issuing best-effort system deletes.
 */

const STEP_TIMEOUT = 15_000;

// 1x1 transparent PNG fixture (same bytes as the backend integration tests).
const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// Track systems cloned by these tests so test.afterEach can delete them
// even when an assertion fails before the in-test cleanup line runs.
// page.request shares the browser context's cookies (dev sign-in), so the
// deletes are authorized for direct runs with a caller-managed database.
const createdSystemIds: string[] = [];
test.afterEach(async ({ page }) => {
  const ids = createdSystemIds.splice(0);
  if (process.env.SWEETROLL_E2E_EPHEMERAL_DB === "1") return;
  for (const id of ids) {
    await page.request.delete(`/api/systems/${id}`).catch(() => {});
  }
});

async function signInViaPanel(page: Page, code: string) {
  await page.goto("/");
  await page.getByTestId("dev-signin-code").fill(code);
  await page.getByTestId("dev-signin").click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: STEP_TIMEOUT });
}

/**
 * Clone d20 through the real UI, then publish the unchanged draft through
 * the real System Builder API (no publish UI is exercised here) so the
 * campaign-create version catalog offers it. Returns the catalog label +
 * index among same-label buttons (prior runs leave same-named clones).
 */
async function cloneD20ViaUi(page: Page): Promise<{ versionLabel: string; versionIndex: number }> {
  await page.goto("/");
  await page.getByTestId("clone-from-template-d20").click();
  await expect(page.getByTestId("document-editor-header")).toBeVisible({ timeout: STEP_TIMEOUT });
  await expect(page.getByTestId("document-editor-autosave")).toHaveText("Saved", { timeout: STEP_TIMEOUT });
  const systemId = page.url().split("/").pop() ?? "";
  expect(systemId).toMatch(/[0-9a-f-]{36}/);
  createdSystemIds.push(systemId);

  const openRes = await page.request.get(`/api/systems/${systemId}`);
  expect(openRes.ok()).toBeTruthy();
  const workspace = (
    (await openRes.json()) as {
      workspace: { draft: { revision: number; document: unknown } };
    }
  ).workspace;
  // The editor autosave may land between the GET and the PUT; retry once
  // with the fresh revision rather than guessing timing.
  let saved = await page.request.put(`/api/systems/${systemId}/draft`, {
    data: { expectedRevision: workspace.draft.revision, document: workspace.draft.document },
  });
  let nextRevision: number | undefined;
  if (saved.status() === 409) {
    const reopened = await page.request.get(`/api/systems/${systemId}`);
    expect(reopened.ok()).toBeTruthy();
    const fresh = (
      (await reopened.json()) as {
        workspace: { draft: { revision: number; document: unknown } };
      }
    ).workspace;
    saved = await page.request.put(`/api/systems/${systemId}/draft`, {
      data: { expectedRevision: fresh.draft.revision, document: fresh.draft.document },
    });
  }
  expect(saved.ok()).toBeTruthy();
  nextRevision = ((await saved.json()) as { workspace: { draft: { revision: number } } }).workspace.draft
    .revision;
  const published = await page.request.post(`/api/systems/${systemId}/publish`, {
    data: {
      expectedRevision: nextRevision,
      semanticVersion: "1.0.0",
      releaseNotes: "campaign a11y fixture",
      idempotencyKey: `campaign-a11y-publish-${uid()}`,
      acknowledgeBreaking: true,
    },
  });
  expect(published.ok()).toBeTruthy();
  const ownedVersionId = ((await published.json()) as { version: { versionId: string } }).version.versionId;
  expect(ownedVersionId).toMatch(/[0-9a-f-]{36}/);

  const catalogRes = await page.request.get("/api/characters/creation-versions?limit=25");
  expect(catalogRes.ok()).toBeTruthy();
  const catalog = (await catalogRes.json()) as {
    data: { versions: Array<Record<string, unknown>> };
  };
  const versions = catalog.data.versions;
  const owned = versions.find((entry) => entry.versionId === ownedVersionId);
  expect(owned).toBeDefined();
  const versionLabel = `${owned!.systemName} ${owned!.semanticVersion}`;
  const versionIndex = versions
    .filter((entry) => `${entry.systemName} ${entry.semanticVersion}` === versionLabel)
    .findIndex((entry) => entry.versionId === ownedVersionId);
  expect(versionIndex).toBeGreaterThanOrEqual(0);
  return { versionLabel, versionIndex };
}

/** Create the campaign entirely through the UI; returns the campaign id. */
async function createCampaignViaUi(
  page: Page,
  versionLabel: string,
  versionIndex: number,
  campaignTitle: string,
): Promise<string> {
  await page.goto("/campaigns/new");
  await expect(page.getByRole("heading", { name: "New campaign" })).toBeVisible({ timeout: STEP_TIMEOUT });
  await page.getByRole("button", { name: versionLabel }).nth(versionIndex).click({ timeout: STEP_TIMEOUT });
  await page.getByLabel("Campaign title").fill(campaignTitle);
  await page.getByRole("button", { name: "Create campaign" }).click({ timeout: STEP_TIMEOUT });
  await expect(page).toHaveURL(/\/campaigns\/[0-9a-f-]{36}/, { timeout: STEP_TIMEOUT });
  const campaignId = new URL(page.url()).pathname.split("/").pop()!;
  expect(campaignId).toMatch(/[0-9a-f-]{36}/);
  await expect(page.getByRole("heading", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });
  return campaignId;
}

/**
 * Author one note through the Content-tab create editor (the tab must
 * already be active). The first Title/Body/Audience/Save on the page belong
 * to the create editor.
 */
async function authorNoteViaUi(page: Page, title: string, body: string, audience: string) {
  await page.getByLabel("Title").first().fill(title);
  await page.getByLabel("Body").first().fill(body);
  await page.getByLabel("Audience").first().selectOption(audience);
  await page.getByRole("button", { name: "Save note" }).first().click({ timeout: STEP_TIMEOUT });
  await expect(page.getByText("Note saved.").first()).toBeVisible({ timeout: STEP_TIMEOUT });
}

/** Scene rows have no create UI in this slice: upload + scene via real HTTP. */
async function seedSceneViaApi(page: Page, campaignId: string, stamp: string): Promise<string> {
  const uploaded = await page.request.post(`/api/campaigns/${campaignId}/images`, {
    data: {
      name: `A11y backdrop ${stamp}`,
      contentType: "image/png",
      dataBase64: ONE_BY_ONE_PNG_BASE64,
      idempotencyKey: randomUUID(),
    },
  });
  expect(uploaded.ok()).toBeTruthy();
  const backgroundFileId = ((await uploaded.json()) as { image: { fileId: string } }).image.fileId;
  const scene = await page.request.post(`/api/campaigns/${campaignId}/scenes`, {
    data: { backgroundFileId, idempotencyKey: randomUUID() },
  });
  expect(scene.ok()).toBeTruthy();
  const sceneId = ((await scene.json()) as { scene: { sceneId: string } }).scene.sceneId;
  expect(sceneId).toMatch(/[0-9a-f-]{36}/);
  return sceneId;
}

/** Character rows seed via real HTTP (revision-guarded create). */
async function seedCharacterViaApi(page: Page, campaignId: string, name: string): Promise<string> {
  const detail = await page.request.get(`/api/campaigns/${campaignId}`);
  expect(detail.ok()).toBeTruthy();
  const revision = ((await detail.json()) as { campaign: { revision: number } }).campaign.revision;
  const created = await page.request.post(`/api/campaigns/${campaignId}/characters`, {
    data: {
      name,
      entityDefinitionId: "character",
      expectedCampaignRevision: revision,
      idempotencyKey: randomUUID(),
    },
  });
  expect(created.ok()).toBeTruthy();
  const characterId = ((await created.json()) as { character: { characterId: string } }).character
    .characterId;
  expect(characterId).toMatch(/[0-9a-f-]{36}/);
  return characterId;
}

/** Pair a display through the Settings-tab settings UI; returns the code. */
async function pairDisplayViaUi(page: Page, campaignTitle: string): Promise<string> {
  await page.getByRole("tab", { name: "Settings" }).click({ timeout: STEP_TIMEOUT });
  await page.getByRole("button", { name: "Pair display", exact: true }).click({ timeout: STEP_TIMEOUT });
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Share this display code now")).toBeVisible({ timeout: STEP_TIMEOUT });
  const code = ((await dialog.locator("strong").last().textContent()) ?? "").trim();
  expect(code).toMatch(/^[A-Z0-9]{6}$/);
  await dialog.getByRole("button", { name: "Done" }).click({ timeout: STEP_TIMEOUT });
  await expect(dialog).toHaveCount(0, { timeout: STEP_TIMEOUT });
  await expect(page.getByRole("heading", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });
  return code;
}

async function expectNoPageHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(
    true,
  );
}

async function expectAxeClean(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual(
    [],
  );
}

async function prepare(page: Page, width: number, dark = false) {
  test.setTimeout(120_000);
  await page.setViewportSize({ width, height: 800 });
  if (dark) {
    await page.emulateMedia({ colorScheme: "dark" });
  }
  await signInViaPanel(page, "code-test-a");
}

test.describe("campaign accessibility", () => {
  for (const width of [360, 1280]) {
    test(`campaigns list at ${width}px: axe, keyboard, no overflow`, async ({ page }) => {
      await prepare(page, width);
      const stamp = uid();
      const campaignTitle = `A11y Campaign ${stamp}`;
      const { versionLabel, versionIndex } = await cloneD20ViaUi(page);
      await createCampaignViaUi(page, versionLabel, versionIndex, campaignTitle);

      await page.goto("/campaigns");
      await expect(page.getByRole("heading", { name: "Campaigns" })).toBeVisible({
        timeout: STEP_TIMEOUT,
      });
      const campaignLink = page.getByRole("link", { name: campaignTitle });
      await expect(campaignLink).toBeVisible({ timeout: STEP_TIMEOUT });

      await expectNoPageHorizontalOverflow(page);
      await expectAxeClean(page);

      // Keyboard flow: focus the campaign link and open it with Enter.
      await campaignLink.focus();
      await expect(campaignLink).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/campaigns\/[0-9a-f-]{36}/, { timeout: STEP_TIMEOUT });
      await expect(page.getByRole("heading", { name: campaignTitle })).toBeVisible({
        timeout: STEP_TIMEOUT,
      });
    });

    test(`campaign characters tab at ${width}px: axe, keyboard, no overflow`, async ({ page }) => {
      await prepare(page, width);
      const stamp = uid();
      const campaignTitle = `A11y Campaign ${stamp}`;
      const heroName = `A11y Hero ${stamp}`;
      const { versionLabel, versionIndex } = await cloneD20ViaUi(page);
      const campaignId = await createCampaignViaUi(page, versionLabel, versionIndex, campaignTitle);
      void campaignId;

      // Characters is the default tab on the detail page.
      await expect(page.getByLabel("Character name")).toBeVisible({ timeout: STEP_TIMEOUT });

      await expectNoPageHorizontalOverflow(page);
      await expectAxeClean(page);

      // The campaign's pinned version loads entity choices automatically.
      await expect(page.locator('select option[value="character"]')).toHaveCount(1, {
        timeout: STEP_TIMEOUT,
      });
      await expect(page.getByLabel("System version ID")).toHaveCount(0);
      // Keyboard flow: type the name and choose the entity without a loader.
      const nameInput = page.getByLabel("Character name");
      await nameInput.focus();
      await expect(nameInput).toBeFocused();
      await page.keyboard.type(heroName);
      const entity = page.getByLabel("Entity definition");
      await entity.focus();
      await expect(entity).toBeFocused();
      await entity.selectOption("character");
      await expect(entity).toHaveValue("character");
    });

    test(`campaign content tab at ${width}px: axe, keyboard, no overflow`, async ({ page }) => {
      await prepare(page, width);
      const stamp = uid();
      const campaignTitle = `A11y Campaign ${stamp}`;
      const gmNoteTitle = `A11y GM Note ${stamp}`;
      const gmNoteBody = `A11y GM-only body ${stamp}`;
      const playerNoteTitle = `A11y Player Note ${stamp}`;
      const playerNoteBody = `A11y all-player body ${stamp}`;
      const { versionLabel, versionIndex } = await cloneD20ViaUi(page);
      await createCampaignViaUi(page, versionLabel, versionIndex, campaignTitle);

      await page.getByRole("tab", { name: "Content" }).click({ timeout: STEP_TIMEOUT });
      await authorNoteViaUi(page, gmNoteTitle, gmNoteBody, "gm_only");
      await authorNoteViaUi(page, playerNoteTitle, playerNoteBody, "all_players");
      const contentList = page.getByRole("list", { name: "Campaign content" });
      await expect(contentList.getByText("Game Master only")).toBeVisible({ timeout: STEP_TIMEOUT });
      await expect(contentList.getByText("All players")).toBeVisible({ timeout: STEP_TIMEOUT });

      await expectNoPageHorizontalOverflow(page);
      await expectAxeClean(page);

      // Keyboard flow: open the all-players note with Enter and read it.
      const openNote = contentList.getByRole("button", { name: `Open ${playerNoteTitle}` });
      await openNote.focus();
      await expect(openNote).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.getByText(playerNoteBody, { exact: true })).toBeVisible({
        timeout: STEP_TIMEOUT,
      });
      const back = page.getByRole("button", { name: "Back to content" });
      await back.focus();
      await expect(back).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(contentList.getByText("All players")).toBeVisible({ timeout: STEP_TIMEOUT });
    });

    test(`campaign session tab at ${width}px: axe, keyboard, no overflow`, async ({ page }) => {
      await prepare(page, width);
      const stamp = uid();
      const campaignTitle = `A11y Campaign ${stamp}`;
      const noteTitle = `A11y Session Note ${stamp}`;
      const characterName = `A11y Session Hero ${stamp}`;
      const { versionLabel, versionIndex } = await cloneD20ViaUi(page);
      const campaignId = await createCampaignViaUi(page, versionLabel, versionIndex, campaignTitle);

      await page.getByRole("tab", { name: "Content" }).click({ timeout: STEP_TIMEOUT });
      await authorNoteViaUi(page, noteTitle, `A11y session body ${stamp}`, "all_players");
      await seedCharacterViaApi(page, campaignId, characterName);

      await page.getByRole("tab", { name: "Session" }).click({ timeout: STEP_TIMEOUT });
      await expect(page.getByRole("heading", { name: "Session", exact: true })).toBeVisible({
        timeout: STEP_TIMEOUT,
      });
      await expect(page.getByRole("heading", { name: "Latest content" })).toBeVisible({
        timeout: STEP_TIMEOUT,
      });
      await expect(page.getByText(noteTitle)).toBeVisible({ timeout: STEP_TIMEOUT });
      const openHero = page.getByRole("button", { name: `Open ${characterName}` });
      await expect(openHero).toBeVisible({ timeout: STEP_TIMEOUT });

      await expectNoPageHorizontalOverflow(page);
      await expectAxeClean(page);

      // Keyboard flow: expand the hero with Enter and see the sheet bump.
      await openHero.focus();
      await expect(openHero).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("button", { name: "Decrease Health" })).toBeVisible({
        timeout: STEP_TIMEOUT,
      });
    });

    test(`campaign members tab at ${width}px: axe, keyboard, no overflow`, async ({ page }) => {
      await prepare(page, width);
      const stamp = uid();
      const campaignTitle = `A11y Campaign ${stamp}`;
      const { versionLabel, versionIndex } = await cloneD20ViaUi(page);
      await createCampaignViaUi(page, versionLabel, versionIndex, campaignTitle);

      await page.getByRole("tab", { name: "Members" }).click({ timeout: STEP_TIMEOUT });
      await expect(page.getByRole("button", { name: "Issue invitation" })).toBeVisible({
        timeout: STEP_TIMEOUT,
      });

      await expectNoPageHorizontalOverflow(page);
      await expectAxeClean(page);

      // Keyboard flow: issue an invitation with Enter; the token panel is
      // the visible committed state.
      const issue = page.getByRole("button", { name: "Issue invitation" });
      await issue.focus();
      await expect(issue).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.getByText("Share this invitation link token now")).toBeVisible({
        timeout: STEP_TIMEOUT,
      });
      const done = page.getByRole("button", { name: "Done" });
      await done.focus();
      await expect(done).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.getByText("Share this invitation link token now")).toHaveCount(0, {
        timeout: STEP_TIMEOUT,
      });
    });

    test(`campaign display pairing at ${width}px: axe, keyboard, no overflow`, async ({ page }) => {
      await prepare(page, width);
      const stamp = uid();
      const campaignTitle = `A11y Campaign ${stamp}`;
      const { versionLabel, versionIndex } = await cloneD20ViaUi(page);
      await createCampaignViaUi(page, versionLabel, versionIndex, campaignTitle);

      await page.getByRole("tab", { name: "Settings" }).click({ timeout: STEP_TIMEOUT });
      const pair = page.getByRole("button", { name: "Pair display", exact: true });
      await expect(pair).toBeVisible({ timeout: STEP_TIMEOUT });

      await expectNoPageHorizontalOverflow(page);
      await expectAxeClean(page);

      // Keyboard flow: pair with Enter; the single-use code dialog is the
      // visible committed state.
      await pair.focus();
      await expect(pair).toBeFocused();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByText("Share this display code now")).toBeVisible({
        timeout: STEP_TIMEOUT,
      });
      const code = ((await dialog.locator("strong").last().textContent()) ?? "").trim();
      expect(code).toMatch(/^[A-Z0-9]{6}$/);
      const done = dialog.getByRole("button", { name: "Done" });
      await done.focus();
      await expect(done).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(dialog).toHaveCount(0, { timeout: STEP_TIMEOUT });
    });

    test(`display code entry at ${width}px: axe, keyboard, no overflow`, async ({ page }) => {
      await prepare(page, width);
      const stamp = uid();
      const campaignTitle = `A11y Campaign ${stamp}`;
      const { versionLabel, versionIndex } = await cloneD20ViaUi(page);
      const campaignId = await createCampaignViaUi(page, versionLabel, versionIndex, campaignTitle);
      const sceneId = await seedSceneViaApi(page, campaignId, stamp);
      const pairCode = await pairDisplayViaUi(page, campaignTitle);

      await page.goto(`/display?sceneId=${encodeURIComponent(sceneId)}`);
      await expect(page.getByRole("heading", { name: "Connect this display" })).toBeVisible({
        timeout: STEP_TIMEOUT,
      });
      const codeInput = page.getByLabel(/display code/i);
      await expect(codeInput).toBeVisible({ timeout: STEP_TIMEOUT });

      await expectNoPageHorizontalOverflow(page);
      await expectAxeClean(page);

      // Keyboard flow: focus the code input, type the paired code, and
      // submit with Enter; the projection image is the committed state.
      await codeInput.focus();
      await expect(codeInput).toBeFocused();
      await page.keyboard.type(pairCode);
      await page.keyboard.press("Enter");
      await expect(page.getByRole("img", { name: "Display image" })).toBeVisible({
        timeout: STEP_TIMEOUT,
      });
    });
  }

  test("campaign content tab at 360px dark mode: axe, keyboard, no overflow", async ({ page }) => {
    await prepare(page, 360, true);
    const stamp = uid();
    const campaignTitle = `A11y Dark Campaign ${stamp}`;
    const gmNoteTitle = `A11y Dark GM Note ${stamp}`;
    const playerNoteTitle = `A11y Dark Player Note ${stamp}`;
    const playerNoteBody = `A11y dark all-player body ${stamp}`;
    const { versionLabel, versionIndex } = await cloneD20ViaUi(page);
    await createCampaignViaUi(page, versionLabel, versionIndex, campaignTitle);

    await page.getByRole("tab", { name: "Content" }).click({ timeout: STEP_TIMEOUT });
    await authorNoteViaUi(page, gmNoteTitle, `A11y dark GM-only body ${stamp}`, "gm_only");
    await authorNoteViaUi(page, playerNoteTitle, playerNoteBody, "all_players");
    const contentList = page.getByRole("list", { name: "Campaign content" });
    await expect(contentList.getByText("Game Master only")).toBeVisible({ timeout: STEP_TIMEOUT });
    await expect(contentList.getByText("All players")).toBeVisible({ timeout: STEP_TIMEOUT });

    await expectNoPageHorizontalOverflow(page);
    await expectAxeClean(page);

    const openNote = contentList.getByRole("button", { name: `Open ${playerNoteTitle}` });
    await openNote.focus();
    await expect(openNote).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByText(playerNoteBody, { exact: true })).toBeVisible({
      timeout: STEP_TIMEOUT,
    });
  });
});
