import AxeBuilder from "@axe-core/playwright";
import { test, expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";

import { uid } from "../offline/test-auth.js";

/**
 * Task 4 exit demonstration (dev-server E2E): the creator-designated
 * playable/npc entity kind flows into a client-side campaign NPC section.
 * Seeds an owned d20 clone through the real System Builder API (clone → save
 * draft with an appended `kind: "npc"` entity → publish 1.0.0) as
 * `code-test-a` in an isolated context — the d20 template carries a single
 * entity, so the NPC entity is appended rather than patched — then creates a
 * campaign plus one NPC-kind and one playable-kind character entirely through
 * the UI (name + automatically loaded entity options + New
 * campaign character, mirroring gmSessionJourney step 8). Asserts the
 * `Monsters & NPCs` section lists the NPC row only, the name search narrows
 * to an empty state and back, and opening the NPC row lands on the character
 * sheet route.
 *
 * Needs a live backend per web/playwright.config.ts (migrate + dev:http and
 * web:dev, with DATABASE_URL pointing at Postgres). No campaign DELETE
 * endpoint exists, so the campaign name is unique per run. Only the cloned
 * system is cleaned up (DELETE /api/systems/:systemId in afterEach, the
 * visual.spec.ts pattern).
 */

const D20_VERSION_ID = "a0000000-0000-5000-8000-000000000002";
const STEP_TIMEOUT = 30_000;

// Track systems cloned by this test so test.afterEach can delete them even
// when an assertion fails before the in-test cleanup line runs.
// page.request shares the browser context's cookies (dev sign-in), so the
// deletes are authorized.
const createdSystemIds: string[] = [];
test.afterEach(async ({ page }) => {
  for (const id of createdSystemIds.splice(0)) {
    await page.request.delete(`/api/systems/${id}`).catch(() => {});
  }
});

async function signInAs(request: APIRequestContext, code: string): Promise<string> {
  const response = await request.post("/dev/signin", {
    data: { code, redirectUri: "http://localhost/cb" },
  });
  if (response.status() !== 200) {
    throw new Error(`seed sign-in (${code}) failed: ${response.status()} ${await response.text()}`);
  }
  const body = (await response.json()) as { userId: string };
  return body.userId;
}

async function getJson(request: APIRequestContext, path: string) {
  const response = await request.get(path);
  if (response.status() !== 200) {
    throw new Error(`GET ${path} failed: ${response.status()} ${await response.text()}`);
  }
  return (await response.json()) as Record<string, any>;
}

async function signInViaPanel(page: Page, code: string) {
  await page.goto("/");
  await page.getByTestId("dev-signin-code").fill(code);
  await page.getByTestId("dev-signin").click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: STEP_TIMEOUT });
}

type DraftDocument = {
  entities: Array<{ id: string; label: string; kind?: string; fields: unknown[] }>;
  sheets: Array<{ id: string; label: string; targetEntityId: string; sections: unknown[] }>;
};

/**
 * Owned clone with an appended NPC entity: clone the reference d20 template
 * through the real System Builder API, append a `kind: "npc"` goblin entity
 * (plus a minimal heading-only sheet so the NPC row opens a real sheet
 * route), save, and publish 1.0.0. Returns the published version id, the
 * owning system id (for afterEach cleanup), and the entity ids to create
 * characters against.
 */
async function publishNpcClone(
  request: APIRequestContext,
  sourceVersionId: string,
): Promise<{
  systemId: string;
  versionId: string;
  playableEntityId: string;
  npcEntityId: string;
}> {
  const created = await request.post("/api/systems", {
    data: { source: { kind: "clone", versionId: sourceVersionId }, idempotencyKey: `npc-clone-${uid()}` },
  });
  if (created.status() !== 201) {
    throw new Error(`clone system failed: ${created.status()} ${await created.text()}`);
  }
  const workspace = ((await created.json()) as {
    workspace: { system: { systemId: string }; draft: { revision: number; document: unknown } | null };
  }).workspace;
  const systemId = workspace.system.systemId;
  const draft = workspace.draft;
  if (draft === null) throw new Error("clone produced no draft");
  const document = draft.document as DraftDocument;
  const playable = document.entities[0];
  if (playable === undefined) throw new Error("clone draft has no entities");
  const existingSecond = document.entities.find((entity) => entity.id !== playable.id);
  let npcEntityId: string;
  if (existingSecond !== undefined) {
    existingSecond.kind = "npc";
    npcEntityId = existingSecond.id;
  } else {
    npcEntityId = "goblin";
    document.entities.push({ id: npcEntityId, label: "Goblin", kind: "npc", fields: [] });
    document.sheets.push({
      id: "goblin_sheet",
      label: "Goblin",
      targetEntityId: npcEntityId,
      sections: [
        {
          id: "goblin_basics",
          label: "Basics",
          elements: [{ kind: "heading", id: "goblin_basics_heading", text: "Goblin", level: 2 }],
        },
      ],
    });
  }
  const saved = await request.put(`/api/systems/${systemId}/draft`, {
    data: { expectedRevision: draft.revision, document },
  });
  if (saved.status() !== 200) {
    throw new Error(`save npc draft failed: ${saved.status()} ${await saved.text()}`);
  }
  const nextRevision = (
    (await saved.json()) as {
      workspace: { draft: { revision: number } | null };
    }
  ).workspace.draft?.revision;
  if (typeof nextRevision !== "number") throw new Error("saved draft has no revision");
  const published = await request.post(`/api/systems/${systemId}/publish`, {
    data: {
      expectedRevision: nextRevision,
      semanticVersion: "1.0.0",
      releaseNotes: "npc list clone",
      idempotencyKey: `npc-clone-publish-${uid()}`,
      acknowledgeBreaking: true,
    },
  });
  if (published.status() !== 200) {
    throw new Error(`publish npc clone failed: ${published.status()} ${await published.text()}`);
  }
  const body = (await published.json()) as { version: { versionId: string } };
  return { systemId, versionId: body.version.versionId, playableEntityId: playable.id, npcEntityId };
}

async function createCampaignCharacter(
  page: Page,
  campaignUrl: string,
  campaignTitle: string,
  input: { name: string; entityId: string },
) {
  await page.goto(campaignUrl);
  await expect(page.getByRole("heading", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });
  await page.getByLabel("Character name").fill(input.name);
  await expect(page.getByLabel("System version ID")).toHaveCount(0);
  await expect(page.locator(`select option[value="${input.entityId}"]`)).toHaveCount(1, { timeout: STEP_TIMEOUT });
  await page.getByLabel("Entity definition").selectOption(input.entityId, { timeout: STEP_TIMEOUT });
  await page.getByRole("button", { name: "New campaign character" }).click({ timeout: STEP_TIMEOUT });
  // Success opens the new sheet through the onOpenCharacter seam.
  await expect(page).toHaveURL(/\/characters\/[0-9a-f-]{36}/, { timeout: STEP_TIMEOUT });
  await expect(page.getByRole("heading", { name: input.name })).toBeVisible({ timeout: STEP_TIMEOUT });
}

test("NPC list: npc-kind rows filter into a searchable Monsters & NPCs section", async ({
  page,
  browser,
}: {
  page: Page;
  browser: Browser;
}) => {
  test.setTimeout(420_000);
  const stamp = uid();
  const campaignTitle = `NPC List ${stamp}`;
  const goblinName = `Goblin ${stamp}`;
  const heroName = `Hero ${stamp}`;

  // 1. Seed as code-test-a via real HTTP: clone d20, save the draft with the
  // npc entity, publish 1.0.0.
  await page.goto("/");
  const origin = new URL(page.url()).origin;
  const gmContext = await browser.newContext({ baseURL: origin });
  try {
    const gmUserId = await signInAs(gmContext.request, "code-test-a");
    expect(gmUserId).toMatch(/.+/);
    const seed = await publishNpcClone(gmContext.request, D20_VERSION_ID);
    expect(seed.versionId).toMatch(/[0-9a-f-]{36}/);
    createdSystemIds.push(seed.systemId);

    // Locate the seeded version in the same version catalog the UI reads
    // (limit 25, same as CampaignCreate): display label plus its index
    // among same-label buttons (prior runs leave same-named clones).
    const catalog = await getJson(gmContext.request, "/api/characters/creation-versions?limit=25");
    const versions = catalog.data.versions as Array<Record<string, unknown>>;
    const owned = versions.find((entry) => entry.versionId === seed.versionId);
    expect(owned).toBeDefined();
    const versionLabel = `${owned!.systemName} ${owned!.semanticVersion}`;
    const versionIndex = versions
      .filter((entry) => `${entry.systemName} ${entry.semanticVersion}` === versionLabel)
      .findIndex((entry) => entry.versionId === seed.versionId);
    expect(versionIndex).toBeGreaterThanOrEqual(0);

    // 2. Dev-sign-in, create campaign through /campaigns/new, open detail.
    await signInViaPanel(page, "code-test-a");
    await page.goto("/campaigns/new");
    await expect(page.getByRole("heading", { name: "New campaign" })).toBeVisible({ timeout: STEP_TIMEOUT });
    await page.getByRole("button", { name: versionLabel }).nth(versionIndex).click({ timeout: STEP_TIMEOUT });
    await page.getByLabel("Campaign title").fill(campaignTitle);
    await page.getByRole("button", { name: "Create campaign" }).click({ timeout: STEP_TIMEOUT });
    await expect(page).toHaveURL(/\/campaigns\/[0-9a-f-]{36}/, { timeout: STEP_TIMEOUT });
    const campaignId = new URL(page.url()).pathname.split("/").pop()!;
    expect(campaignId).toMatch(/[0-9a-f-]{36}/);
    await expect(page.getByRole("heading", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });
    const campaignUrl = `/campaigns/${campaignId}`;

    // 3. Create Goblin on the npc entity + Hero on the playable entity
    // through the create panel. Each create opens its sheet; the helper
    // asserts the sheet heading before returning.
    await createCampaignCharacter(page, campaignUrl, campaignTitle, {
      name: goblinName,
      entityId: seed.npcEntityId,
    });
    await createCampaignCharacter(page, campaignUrl, campaignTitle, {
      name: heroName,
      entityId: seed.playableEntityId,
    });

    // 4. The Monsters & NPCs section lists Goblin and not Hero; Hero's Open
    // appears exactly once, in the main list.
    await page.goto(campaignUrl);
    await expect(page.getByRole("heading", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });
    await expect(page.getByRole("heading", { name: "Monsters & NPCs" })).toBeVisible({ timeout: STEP_TIMEOUT });
    const npcSection = page.getByRole("region", { name: "Monsters & NPCs" });
    await expect(npcSection.getByRole("button", { name: `Open ${goblinName}`, exact: true })).toBeVisible({
      timeout: STEP_TIMEOUT,
    });
    await expect(npcSection.getByRole("button", { name: `Open ${heroName}`, exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: `Open ${heroName}`, exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: `Open ${goblinName}`, exact: true })).toHaveCount(1);

    // 5. Search narrows the section: "gob" keeps Goblin, "zzz" shows the
    // empty state, clearing restores Goblin.
    const search = page.getByLabel(/search monsters & npcs/i);
    await search.fill("gob");
    await expect(npcSection.getByRole("button", { name: `Open ${goblinName}`, exact: true })).toBeVisible({
      timeout: STEP_TIMEOUT,
    });
    await search.fill("zzz");
    await expect(page.getByText("No monsters or NPCs match.")).toBeVisible({ timeout: STEP_TIMEOUT });
    await expect(npcSection.getByRole("button", { name: `Open ${goblinName}`, exact: true })).toHaveCount(0);
    await search.fill("");
    await expect(npcSection.getByRole("button", { name: `Open ${goblinName}`, exact: true })).toBeVisible({
      timeout: STEP_TIMEOUT,
    });

    // 6. Open Goblin → the character sheet route renders, then back to the
    // campaign detail with the section intact.
    await npcSection.getByRole("button", { name: `Open ${goblinName}`, exact: true }).click({ timeout: STEP_TIMEOUT });
    await expect(page).toHaveURL(/\/characters\/[0-9a-f-]{36}/, { timeout: STEP_TIMEOUT });
    await expect(page.getByRole("heading", { name: goblinName })).toBeVisible({ timeout: STEP_TIMEOUT });
    await page.goto(campaignUrl);
    await expect(page.getByRole("heading", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });
    await expect(page.getByRole("heading", { name: "Monsters & NPCs" })).toBeVisible({ timeout: STEP_TIMEOUT });

    // 7. Axe on the Characters tab at desktop width (1280): zero
    // serious/critical violations (spec §4: axe-covered at 360 + 1280 px).
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(campaignUrl);
    await expect(page.getByRole("heading", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });
    await expect(page.getByRole("heading", { name: "Monsters & NPCs" })).toBeVisible({ timeout: STEP_TIMEOUT });
    const desktopAxe = await new AxeBuilder({ page }).analyze();
    expect(desktopAxe.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual(
      [],
    );

    // 8. Keyboard check: the search input takes focus and keyboard typing
    // narrows the list.
    const keyboardSearch = page.getByLabel(/search monsters & npcs/i);
    await keyboardSearch.fill("");
    await keyboardSearch.focus();
    await expect(keyboardSearch).toBeFocused();
    await page.keyboard.type("gob");
    await expect(npcSection.getByRole("button", { name: `Open ${goblinName}`, exact: true })).toBeVisible({
      timeout: STEP_TIMEOUT,
    });
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Backspace");
    await expect(npcSection.getByRole("button", { name: `Open ${goblinName}`, exact: true })).toBeVisible({
      timeout: STEP_TIMEOUT,
    });

    // 9. 360px-width pass: reload the detail narrow, assert no page
    // horizontal overflow, the NPC section + search visible and usable
    // (type in search, assert narrowing), and axe-clean at 360.
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(campaignUrl);
    await expect(page.getByRole("heading", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });
    await expect(page.getByRole("heading", { name: "Monsters & NPCs" })).toBeVisible({ timeout: STEP_TIMEOUT });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(
      true,
    );
    const narrowSection = page.getByRole("region", { name: "Monsters & NPCs" });
    const narrowSearch = page.getByLabel(/search monsters & npcs/i);
    await expect(narrowSearch).toBeVisible({ timeout: STEP_TIMEOUT });
    await narrowSearch.fill("gob");
    await expect(narrowSection.getByRole("button", { name: `Open ${goblinName}`, exact: true })).toBeVisible({
      timeout: STEP_TIMEOUT,
    });
    await narrowSearch.fill("zzz");
    await expect(page.getByText("No monsters or NPCs match.")).toBeVisible({ timeout: STEP_TIMEOUT });
    await expect(narrowSection.getByRole("button", { name: `Open ${goblinName}`, exact: true })).toHaveCount(0);
    await narrowSearch.fill("");
    await expect(narrowSection.getByRole("button", { name: `Open ${goblinName}`, exact: true })).toBeVisible({
      timeout: STEP_TIMEOUT,
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(
      true,
    );
    const narrowAxe = await new AxeBuilder({ page }).analyze();
    expect(narrowAxe.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual(
      [],
    );
  } finally {
    await gmContext.close();
  }
});
