import { test, expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";

import { publishOwnedClone, uid } from "../offline/test-auth.js";

/**
 * I7 GM Phase 2 exit demonstration (dev-server E2E): GM content + session
 * entirely through the UI — create from the version catalog, Content tab
 * (author an all-players note → narrow it to selected_players with a grant
 * → hide it → recover it from the retained deleted view), Characters tab
 * (create a campaign character through the UI), Session tab (latest content
 * + recent activity + character directory → expand the character → bump
 * Health through a 409 conflict with a fresh-key retry → roll Check with
 * the campaign audience) — plus the /campaigns list check for the newly
 * created campaign (Phase 1 Task 3 follow-up confirmation).
 *
 * Needs a live backend per web/playwright.config.ts (migrate + dev:http and
 * web:dev, with DATABASE_URL pointing at Postgres). No campaign/character
 * DELETE endpoints exist, so every name is unique per run. Only the owned
 * d20 clone is seeded through the real System Builder API (clone → save
 * draft unchanged → publish 1.0.0) as the GM actor (code-test-a in an
 * isolated context), because the seeded reference templates are
 * link-access/unlisted (OD-01) and versionless enumeration never offers
 * them; all campaign setup, content authoring, character creation, bumps,
 * and rolls run through the UI — no direct campaign/character HTTP
 * provisioning. The dev sign-in panel stays (dev server), so no
 * SWEETROLL_TEST_AUTH escape hatch is needed here.
 *
 * The bump conflict is deterministic, not timing luck: after expanding the
 * character (sheet at revision R) a deferred route gate holds the character
 * GET, while a second GM page advances the sheet through its UI; the first
 * page's next bump still carries the stale expectedRevision R and the server
 * answers 409. The board shows its refreshing state with disabled controls,
 * releases the GET, renders the updated value, then surfaces the conflict
 * notice. The explicit retry uses the fresh revision with a fresh
 * idempotency key.
 */

const D20_VERSION_ID = "a0000000-0000-5000-8000-000000000002";
const STEP_TIMEOUT = 15_000;

const VIEWPORTS = [
  { width: 360, height: 640 },
  { width: 1280, height: 800 },
];

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

async function runJourney(page: Page, browser: Browser, viewport: { width: number; height: number }) {
  test.setTimeout(120_000);
  await page.setViewportSize(viewport);
  const stamp = uid();
  const campaignTitle = `G7 GM Session ${stamp}`;
  const noteTitle = `G7 Session Note ${stamp}`;
  const noteBody = `G7 session briefing body ${stamp}`;
  const characterName = `G7 Session Hero ${stamp}`;

  // 1. GM seeding (isolated context as code-test-a): publish the owned d20
  // clone through the real System Builder API. Nothing else is provisioned
  // over HTTP; the campaign, note, and character are created through the UI.
  await page.goto("/");
  const origin = new URL(page.url()).origin;
  const gmContext = await browser.newContext({ baseURL: origin });
  let ownedVersionId: string;
  let gmUserId: string;
  try {
    gmUserId = await signInAs(gmContext.request, "code-test-a");
    expect(gmUserId).toMatch(/.+/);
    ownedVersionId = await publishOwnedClone(gmContext.request, D20_VERSION_ID);
    expect(ownedVersionId).toMatch(/[0-9a-f-]{36}/);

    // Locate the seeded version in the same version catalog the UI reads
    // (limit 25, same as CampaignCreate): display label plus its index
    // among same-label buttons (prior runs leave same-named clones).
    const catalog = await getJson(gmContext.request, "/api/characters/creation-versions?limit=25");
    const versions = catalog.data.versions as Array<Record<string, unknown>>;
    const owned = versions.find((entry) => entry.versionId === ownedVersionId);
    expect(owned).toBeDefined();
    const versionLabel = `${owned!.systemName} ${owned!.semanticVersion}`;
    const versionIndex = versions
      .filter((entry) => `${entry.systemName} ${entry.semanticVersion}` === versionLabel)
      .findIndex((entry) => entry.versionId === ownedVersionId);
    expect(versionIndex).toBeGreaterThanOrEqual(0);

    // 2. GM creates the campaign entirely through the UI: pick the seeded
    // clone version, name it, create.
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

    // 3. /campaigns lists the newly created campaign (fire-and-forget
    // list-invalidation from Phase 1 Task 3); open it back up.
    await page.goto("/campaigns");
    await expect(page.getByRole("link", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });
    await page.getByRole("link", { name: campaignTitle }).click({ timeout: STEP_TIMEOUT });
    await expect(page).toHaveURL(campaignUrl);
    await expect(page.getByRole("heading", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });

    // 4. Content tab as the owner: author a note with the all_players
    // audience through the GM create form (first Title/Body/Audience/Save
    // on the page belong to the create editor; the edit editor mounts only
    // after step 5 opens it).
    await page.getByRole("tab", { name: "Content" }).click({ timeout: STEP_TIMEOUT });
    await page.getByLabel("Title").first().fill(noteTitle);
    await page.getByLabel("Body").first().fill(noteBody);
    await page.getByLabel("Audience").first().selectOption("all_players");
    await page.getByRole("button", { name: "Save note" }).first().click({ timeout: STEP_TIMEOUT });
    await expect(page.getByText("Note saved.").first()).toBeVisible({ timeout: STEP_TIMEOUT });
    // Scope audience marks to the content list: the Audience selects carry
    // the same option labels as hidden <option> elements.
    const contentList = page.getByRole("list", { name: "Campaign content" });
    await expect(contentList.getByText("All players")).toBeVisible({ timeout: STEP_TIMEOUT });

    // 5. Narrow the note to selected_players with a grant to the GM's own
    // roster row (the roster carries userIds only; the checkbox label is
    // the short id prefix). The second Title/Audience/Save on the page now
    // belong to the edit editor.
    await page.getByRole("button", { name: `Edit ${noteTitle}` }).click({ timeout: STEP_TIMEOUT });
    await page.getByLabel("Audience").nth(1).selectOption("selected_players");
    await expect(page.getByText("Share with (selected players)")).toBeVisible({ timeout: STEP_TIMEOUT });
    await page.getByRole("checkbox", { name: gmUserId.slice(0, 8) }).check({ timeout: STEP_TIMEOUT });
    await page.getByRole("button", { name: "Save note" }).nth(1).click({ timeout: STEP_TIMEOUT });
    await expect(contentList.getByText("Selected players")).toBeVisible({ timeout: STEP_TIMEOUT });

    // 6. Hide the note from a freshly opened edit editor: the editor above
    // still holds the pre-save revision, so a revision-guarded Hide from it
    // would (correctly) 409. Fresh detail load first — the same re-read
    // discipline the Phase 1 e2e uses before revision-guarded mutations.
    // The editor stays mounted on the deleted view with its working
    // Recover button (Task 2 deleted-view retention).
    await page.goto(campaignUrl);
    await expect(page.getByRole("heading", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });
    await page.getByRole("tab", { name: "Content" }).click({ timeout: STEP_TIMEOUT });
    await expect(contentList.getByText("Selected players")).toBeVisible({ timeout: STEP_TIMEOUT });
    await page.getByRole("button", { name: `Edit ${noteTitle}` }).click({ timeout: STEP_TIMEOUT });
    await page.getByRole("button", { name: `Hide ${noteTitle}` }).first().click({ timeout: STEP_TIMEOUT });
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: STEP_TIMEOUT });
    await page.getByRole("dialog").getByRole("button", { name: "Confirm hiding" }).click({ timeout: STEP_TIMEOUT });
    await expect(page.getByRole("button", { name: `Recover ${noteTitle}` })).toBeVisible({ timeout: STEP_TIMEOUT });

    // 7. Recover the note behind the confirm dialog; the save lands.
    await page.getByRole("button", { name: `Recover ${noteTitle}` }).click({ timeout: STEP_TIMEOUT });
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: STEP_TIMEOUT });
    await page.getByRole("dialog").getByRole("button", { name: "Confirm recovery" }).click({ timeout: STEP_TIMEOUT });
    // Recovery reports through the parent, not a saved flag: the dialog
    // closes and the list shows the restored note again.
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: STEP_TIMEOUT });
    await expect(contentList.getByText("Selected players")).toBeVisible({ timeout: STEP_TIMEOUT });

    // 7b. Durable Hidden recovery: hide again, reload (no retained editor),
    // find the note in the Hidden view, recover, and read it in Active.
    await page.getByRole("button", { name: `Edit ${noteTitle}` }).click({ timeout: STEP_TIMEOUT });
    await page.getByRole("button", { name: `Hide ${noteTitle}` }).first().click({ timeout: STEP_TIMEOUT });
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: STEP_TIMEOUT });
    await page.getByRole("dialog").getByRole("button", { name: "Confirm hiding" }).click({ timeout: STEP_TIMEOUT });
    await page.goto(campaignUrl);
    await expect(page.getByRole("heading", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });
    await page.getByRole("tab", { name: "Content" }).click({ timeout: STEP_TIMEOUT });
    await page.getByRole("button", { name: "Hidden", exact: true }).click({ timeout: STEP_TIMEOUT });
    await expect(page.getByText(noteTitle, { exact: true }).first()).toBeVisible({ timeout: STEP_TIMEOUT });
    await page.getByRole("button", { name: `Recover ${noteTitle}` }).click({ timeout: STEP_TIMEOUT });
    await expect(page.getByText(`${noteTitle} was recovered.`)).toBeVisible({ timeout: STEP_TIMEOUT });
    await page.getByRole("button", { name: "Active", exact: true }).click({ timeout: STEP_TIMEOUT });
    await expect(page.getByRole("list", { name: "Campaign content" }).getByText("Selected players")).toBeVisible({
      timeout: STEP_TIMEOUT,
    });

    // 8. Characters tab: create a campaign character through the UI. Fresh
    // detail load first so the revision-guarded create cannot 409 on the
    // content mutations above.
    await page.goto(campaignUrl);
    await expect(page.getByRole("heading", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });
    await page.getByLabel("Character name").fill(characterName);
    // The campaign's pinned version loads the entity options automatically.
    await expect(page.getByLabel("System version ID")).toHaveCount(0);
    await expect(page.locator('select option[value="character"]')).toHaveCount(1, { timeout: STEP_TIMEOUT });
    await page.getByLabel("Entity definition").selectOption("character", { timeout: STEP_TIMEOUT });
    await page.getByRole("button", { name: "New campaign character" }).click({ timeout: STEP_TIMEOUT });
    // Success opens the new sheet through the onOpenCharacter seam; head
    // back to the campaign detail for the Session tab.
    await expect(page).toHaveURL(/\/characters\/[0-9a-f-]{36}/, { timeout: STEP_TIMEOUT });
    await expect(page.getByRole("heading", { name: characterName })).toBeVisible({ timeout: STEP_TIMEOUT });
    await page.goto(campaignUrl);
    await expect(page.getByRole("heading", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });

    // Resolve the placed character id through the real list endpoint (the
    // directory row carries no id) for the bump-conflict route delay below.
    const directory = await getJson(gmContext.request, `/api/campaigns/${campaignId}/characters`);
    const placed = (directory.characters as Array<Record<string, unknown>>).find(
      (entry) => entry.name === characterName,
    );
    expect(placed).toBeDefined();
    const placedCharacterId = placed!.characterId as string;
    expect(placedCharacterId).toMatch(/[0-9a-f-]{36}/);

    // 9. Session tab (GM-only): latest content shows the recovered note,
    // recent activity shows the authoring events, and the character
    // directory lists the new hero.
    await page.getByRole("tab", { name: "Session" }).click({ timeout: STEP_TIMEOUT });
    // Exact match: the campaign title heading ("G7 GM Session …") contains
    // "Session" as a substring and would otherwise collide in strict mode.
    await expect(page.getByRole("heading", { name: "Session", exact: true })).toBeVisible({ timeout: STEP_TIMEOUT });
    await expect(page.getByRole("heading", { name: "Latest content" })).toBeVisible({ timeout: STEP_TIMEOUT });
    await expect(page.getByText(noteTitle)).toBeVisible({ timeout: STEP_TIMEOUT });
    await expect(page.getByRole("heading", { name: "Recent activity" })).toBeVisible({ timeout: STEP_TIMEOUT });
    await expect(page.getByText("Content created")).toBeVisible({ timeout: STEP_TIMEOUT });
    await expect(page.getByRole("heading", { name: "Characters" })).toBeVisible({ timeout: STEP_TIMEOUT });
    // The hero name renders twice per row (name span + Open button), so
    // assert the button: it also drives the expand step below.
    await expect(page.getByRole("button", { name: `Open ${characterName}` })).toBeVisible({ timeout: STEP_TIMEOUT });

    // 10. Expand the hero: the sheet loads Health (10/10) plus the Check
    // roll action (its only input is optional, so the board offers Execute
    // rather than the open-sheet path).
    await page.getByRole("button", { name: `Open ${characterName}` }).click({ timeout: STEP_TIMEOUT });
    await expect(page.getByRole("button", { name: "Decrease Health" })).toBeVisible({ timeout: STEP_TIMEOUT });
    await expect(page.getByText("10 / 10")).toBeVisible({ timeout: STEP_TIMEOUT });

    // 11. Bump Health through a genuine cross-page conflict: a second GM page
    // advances the sheet through its UI, so the first page's next bump
    // carries a stale revision and the server answers 409. The board gates
    // mutation controls on refresh readiness with a deferred GET (no sleep).
    // Decreases, not increases: Health starts at its 10/10 bound and bumping
    // up 422s server-side.
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    await page.route(`**/api/characters/${placedCharacterId}`, async (route) => {
      if (route.request().method() === "GET") {
        await refreshGate;
      }
      await route.continue();
    });
    const bumpUrl = `/api/characters/${placedCharacterId}/resources/health/bump`;
    const peerContext = await browser.newContext({ baseURL: origin });
    try {
      const peerPage = await peerContext.newPage();
      await peerPage.setViewportSize(viewport);
      await signInViaPanel(peerPage, "code-test-a");
      await peerPage.goto(campaignUrl);
      await expect(peerPage.getByRole("heading", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });
      await peerPage.getByRole("tab", { name: "Session" }).click({ timeout: STEP_TIMEOUT });
      await peerPage.getByRole("button", { name: `Open ${characterName}` }).click({ timeout: STEP_TIMEOUT });
      await expect(peerPage.getByRole("button", { name: "Decrease Health" })).toBeVisible({ timeout: STEP_TIMEOUT });
      await peerPage.getByRole("button", { name: "Decrease Health" }).click({ timeout: STEP_TIMEOUT });
      await expect(peerPage.getByText("9 / 10")).toBeVisible({ timeout: STEP_TIMEOUT });
      await peerPage.close();
    } finally {
      await peerContext.close();
    }
    const firstBumpRequest = page.waitForRequest(
      (request) => request.url().includes(bumpUrl) && request.method() === "POST",
      { timeout: STEP_TIMEOUT },
    );
    await page.getByRole("button", { name: "Decrease Health" }).click({ timeout: STEP_TIMEOUT });
    const firstBody = (await firstBumpRequest).postDataJSON() as Record<string, unknown>;
    await expect(page.getByText("Refreshing character…")).toBeVisible({ timeout: STEP_TIMEOUT });
    await expect(page.getByRole("button", { name: "Decrease Health" })).toBeDisabled();
    await expect(page.getByText("Health changed. Reloaded — retry the bump.")).toHaveCount(0);
    const refreshed = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/characters/${placedCharacterId}`) &&
        response.request().method() === "GET" &&
        response.status() === 200,
      { timeout: STEP_TIMEOUT },
    );
    releaseRefresh();
    await refreshed;
    await expect(page.getByText("9 / 10")).toBeVisible({ timeout: STEP_TIMEOUT });
    await expect(page.getByText("Health changed. Reloaded — retry the bump.")).toBeVisible({
      timeout: STEP_TIMEOUT,
    });
    await expect(page.getByRole("button", { name: "Decrease Health" })).toBeEnabled();
    await page.unroute(`**/api/characters/${placedCharacterId}`);
    // Explicit retry with the fresh revision and a fresh key: 10 → 9 (peer
    // page) → 8 (retry).
    const retryRequest = page.waitForRequest(
      (request) => request.url().includes(bumpUrl) && request.method() === "POST",
      { timeout: STEP_TIMEOUT },
    );
    await page.getByRole("button", { name: "Decrease Health" }).click({ timeout: STEP_TIMEOUT });
    const retryBody = (await retryRequest).postDataJSON() as Record<string, unknown>;
    expect(retryBody.expectedRevision).not.toBe(firstBody.expectedRevision);
    expect(retryBody.idempotencyKey).not.toBe(firstBody.idempotencyKey);
    await expect(page.getByText("8 / 10")).toBeVisible({ timeout: STEP_TIMEOUT });

    // 12. Roll Check with the default campaign audience. The board renders
    // roll results kind-agnostically (never assuming the payload shape), so
    // a structured roll object surfaces the generic uncertain-outcome
    // notice rather than fabricated result text; the wire assertion pins
    // the campaign audience on the executed request.
    await expect(page.getByRole("button", { name: "Roll Check" })).toBeVisible({ timeout: STEP_TIMEOUT });
    const rollRequest = page.waitForRequest(
      (request) =>
        request.url().includes(`/api/characters/${placedCharacterId}/actions/check`) &&
        request.method() === "POST",
      { timeout: STEP_TIMEOUT },
    );
    await page.getByRole("button", { name: "Roll Check" }).click({ timeout: STEP_TIMEOUT });
    expect((await rollRequest).postDataJSON()).toMatchObject({ audience: "campaign" });
    await expect(page.getByText("The roll may have applied.")).toBeVisible({ timeout: STEP_TIMEOUT });
  } finally {
    await gmContext.close();
  }
}

for (const viewport of VIEWPORTS) {
  test(`I7 exit: GM content and session through UI @ ${viewport.width}x${viewport.height}`, async ({
    page,
    browser,
  }: {
    page: Page;
    browser: Browser;
  }) => {
    await runJourney(page, browser, viewport);
  });
}
