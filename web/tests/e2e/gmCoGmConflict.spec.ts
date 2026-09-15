import { test, expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";

import { publishOwnedClone, uid } from "../offline/test-auth.js";

/**
 * I7 hardening: co-GM two-user conflict proof (dev-server E2E). Same-account
 * two-device conflict is proven by gmSessionJourney (peer flow); this spec
 * closes the gap for two USERs sharing one campaign through the UI — owner
 * (code-test-a) creates a campaign and a content note, invites code-test-b,
 * promotes them to co-GM behind the confirm dialog (gmSetupJourney
 * selectors), then:
 *
 * - Shared edit: both users open the same content note editor (same
 *   revision R, two contexts so no query cache is shared). The owner commits
 *   a body edit first; the co-GM commits a title edit against stale R and
 *   the server answers 409. The editor surfaces its explicit conflict notice
 *   (never "Merge"); the co-GM re-reads (fresh editor at R+1) and retries
 *   with a fresh idempotency key. Both commits' effects survive: no
 *   acknowledged update is clobbered.
 * - Independent operation: owner and co-GM concurrently bump two DIFFERENT
 *   characters' Health and both apply with no conflict.
 *
 * Needs a live backend per web/playwright.config.ts (migrate + dev:http and
 * web:dev, with DATABASE_URL pointing at Postgres). No campaign/character
 * DELETE endpoints exist, so every name is unique per run. Only the owned
 * d20 clone is seeded through the real System Builder API as code-test-a in
 * an isolated context; everything else runs through the UI.
 *
 * Wire note: content updates carry `expectedContentRevision` (not the
 * `expectedRevision` of the character-bump path ContentEditor.tsx:135-138),
 * so the retry assertions below pin that field; the shape mirrors the
 * gmSessionJourney fresh-key retry assertions.
 */

const D20_VERSION_ID = "a0000000-0000-5000-8000-000000000002";
const STEP_TIMEOUT = 30_000;

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

/** Read the display-once invitation token off the GM's token panel. */
async function readShownToken(page: Page): Promise<string> {
  await expect(page.getByText("Share this invitation link token now")).toBeVisible({ timeout: STEP_TIMEOUT });
  const raw = await page.locator("code").first().textContent();
  const token = (raw ?? "").trim();
  expect(token.length).toBeGreaterThan(0);
  return token;
}

async function dismissShownToken(page: Page, token: string) {
  await page.getByRole("button", { name: "Done" }).click({ timeout: STEP_TIMEOUT });
  await expect(page.getByText("Share this invitation link token now")).toHaveCount(0);
  // Display-once: the token value lingers nowhere on the screen.
  await expect(page.getByText(token)).toHaveCount(0);
}

async function createCampaignCharacter(
  page: Page,
  campaignTitle: string,
  campaignUrl: string,
  characterName: string,
  ownedVersionId: string,
) {
  // Fresh detail load first so the revision-guarded create cannot 409 on
  // earlier mutations (gmSessionJourney step 8 discipline).
  await page.goto(campaignUrl);
  await expect(page.getByRole("heading", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });
  await page.getByLabel("Character name").fill(characterName);
  await page.getByLabel("System version ID").fill(ownedVersionId);
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.getByRole("button", { name: "Load entity options" }).click({ timeout: STEP_TIMEOUT });
    try {
      await expect(page.locator('select option[value="character"]')).toHaveCount(1, { timeout: 10_000 });
      break;
    } catch (err) {
      if (attempt === 2) throw err;
    }
  }
  await page.getByLabel("Entity definition").selectOption("character", { timeout: STEP_TIMEOUT });
  await page.getByRole("button", { name: "New campaign character" }).click({ timeout: STEP_TIMEOUT });
  // Success opens the new sheet through the onOpenCharacter seam.
  await expect(page).toHaveURL(/\/characters\/[0-9a-f-]{36}/, { timeout: STEP_TIMEOUT });
  await expect(page.getByRole("heading", { name: characterName })).toBeVisible({ timeout: STEP_TIMEOUT });
}

test("I7 exit: co-GM shared-edit conflict and independent operation", async ({
  page,
  browser,
}: {
  page: Page;
  browser: Browser;
}) => {
  test.setTimeout(420_000);
  const stamp = uid();
  const campaignTitle = `G7 CoGM Conflict ${stamp}`;
  const noteTitle = `G7 CoGM Note ${stamp}`;
  const noteBody = `G7 co-GM briefing body ${stamp}`;
  const ownerBody = `G7 owner revision ${stamp}`;
  const coGmTitle = `${noteTitle} CoGM`;
  const heroA = `G7 CoGM Hero A ${stamp}`;
  const heroB = `G7 CoGM Hero B ${stamp}`;

  // 1. GM seeding (isolated context as code-test-a): publish the owned d20
  // clone through the real System Builder API. Nothing else is provisioned
  // over HTTP; the campaign, note, and characters are created through the UI.
  await page.goto("/");
  const origin = new URL(page.url()).origin;
  const gmContext = await browser.newContext({ baseURL: origin });
  let ownedVersionId: string;
  let inviteeUserId: string;
  try {
    const gmUserId = await signInAs(gmContext.request, "code-test-a");
    expect(gmUserId).toMatch(/.+/);
    ownedVersionId = await publishOwnedClone(gmContext.request, D20_VERSION_ID);
    expect(ownedVersionId).toMatch(/[0-9a-f-]{36}/);

    // Invitee identity up front (separate probe context so the GM session
    // cookie stays intact); used to target the roster row by user id.
    const probeContext = await browser.newContext({ baseURL: origin });
    try {
      inviteeUserId = await signInAs(probeContext.request, "code-test-b");
    } finally {
      await probeContext.close();
    }
    expect(inviteeUserId!).toMatch(/.+/);

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

    // 2. Owner creates the campaign entirely through the UI.
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

    // 3. Owner authors a content note through the Content tab (first
    // Title/Body/Audience/Save on the page belong to the create editor).
    await page.getByRole("tab", { name: "Content" }).click({ timeout: STEP_TIMEOUT });
    await page.getByLabel("Title").first().fill(noteTitle);
    await page.getByLabel("Body").first().fill(noteBody);
    await page.getByLabel("Audience").first().selectOption("all_players");
    await page.getByRole("button", { name: "Save note" }).first().click({ timeout: STEP_TIMEOUT });
    await expect(page.getByText("Note saved.").first()).toBeVisible({ timeout: STEP_TIMEOUT });
    const contentList = page.getByRole("list", { name: "Campaign content" });
    await expect(contentList.getByText("All players")).toBeVisible({ timeout: STEP_TIMEOUT });

    // 4. Owner issues a fresh invitation; code-test-b accepts in a second
    // context (never two tabs sharing one query cache).
    await page.getByRole("tab", { name: "Members" }).click({ timeout: STEP_TIMEOUT });
    await expect(page.getByRole("heading", { name: "Invitations" })).toBeVisible({ timeout: STEP_TIMEOUT });
    await page.getByRole("button", { name: "Issue invitation" }).click({ timeout: STEP_TIMEOUT });
    const inviteToken = await readShownToken(page);
    await dismissShownToken(page, inviteToken);

    const coGmContext = await browser.newContext({ baseURL: origin });
    try {
      const coGmPage = await coGmContext.newPage();
      await signInViaPanel(coGmPage, "code-test-b");
      await coGmPage.goto(`/invitations?token=${encodeURIComponent(inviteToken)}`);
      await expect(coGmPage.getByRole("heading", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });
      await expect(coGmPage.getByText(inviteToken)).toHaveCount(0);
      await coGmPage.getByRole("button", { name: "Accept", exact: true }).click({ timeout: STEP_TIMEOUT });
      await expect(coGmPage.getByText(`Welcome to ${campaignTitle}.`)).toBeVisible({ timeout: STEP_TIMEOUT });

      // 5. Owner promotes the member to co-GM behind the confirm dialog.
      // Fresh load: the invitee accept bumped the campaign revision, so the
      // owner re-reads before the revision-guarded role change.
      await page.goto(campaignUrl);
      await expect(page.getByRole("heading", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });
      await page.getByRole("tab", { name: "Members" }).click({ timeout: STEP_TIMEOUT });
      const memberRow = page.locator("li", { hasText: inviteeUserId! });
      await expect(memberRow).toBeVisible({ timeout: STEP_TIMEOUT });
      await memberRow.locator("select").selectOption("co_gm");
      await memberRow.getByRole("button", { name: "Change role" }).click({ timeout: STEP_TIMEOUT });
      await expect(page.getByRole("dialog")).toBeVisible({ timeout: STEP_TIMEOUT });
      await page.getByRole("dialog").getByRole("button", { name: "Confirm role change" }).click({ timeout: STEP_TIMEOUT });
      await expect(memberRow.locator("span", { hasText: "Co-GM" }).first()).toBeVisible({ timeout: STEP_TIMEOUT });

      // 6. Shared edit: both users open the same note editor, so both hold
      // revision R. The owner commits a body edit first; the co-GM's title
      // edit then goes out stale. Deterministic, not timing luck: the stale
      // editor was mounted before the owner's save landed.
      await page.goto(campaignUrl);
      await expect(page.getByRole("heading", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });
      await page.getByRole("tab", { name: "Content" }).click({ timeout: STEP_TIMEOUT });
      await page.getByRole("button", { name: `Edit ${noteTitle}` }).click({ timeout: STEP_TIMEOUT });
      await coGmPage.goto(campaignUrl);
      await expect(coGmPage.getByRole("heading", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });
      await coGmPage.getByRole("tab", { name: "Content" }).click({ timeout: STEP_TIMEOUT });
      await coGmPage.getByRole("button", { name: `Edit ${noteTitle}` }).click({ timeout: STEP_TIMEOUT });
      await coGmPage.getByLabel("Title").nth(1).fill(coGmTitle);

      await page.getByLabel("Body").nth(1).fill(ownerBody);
      const ownerPatchResponse = page.waitForResponse(
        (response) => response.url().includes("/content/") && response.request().method() === "PATCH",
        { timeout: STEP_TIMEOUT },
      );
      await page.getByRole("button", { name: "Save note" }).nth(1).click({ timeout: STEP_TIMEOUT });
      expect((await ownerPatchResponse).status()).toBe(200);

      // 7. Co-GM commits stale: the server answers 409 and the editor shows
      // its explicit conflict notice — never a "Merge" affordance.
      const stalePatchRequest = coGmPage.waitForRequest(
        (request) => request.url().includes("/content/") && request.method() === "PATCH",
        { timeout: STEP_TIMEOUT },
      );
      const stalePatchResponse = coGmPage.waitForResponse(
        (response) => response.url().includes("/content/") && response.request().method() === "PATCH",
        { timeout: STEP_TIMEOUT },
      );
      await coGmPage.getByRole("button", { name: "Save note" }).nth(1).click({ timeout: STEP_TIMEOUT });
      const firstBody = (await stalePatchRequest).postDataJSON() as Record<string, unknown>;
      expect((await stalePatchResponse).status()).toBe(409);
      await expect(
        coGmPage.getByText("This note changed. The list was reloaded — review and retry."),
      ).toBeVisible({ timeout: STEP_TIMEOUT });
      await expect(coGmPage.getByText(/Merge/)).toHaveCount(0);

      // 8. Co-GM re-reads (fresh editor at the advanced revision) and retries
      // with a fresh idempotency key. Different fields per author (owner:
      // body, co-GM: title) so both commits' effects must survive.
      await coGmPage.goto(campaignUrl);
      await expect(coGmPage.getByRole("heading", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });
      await coGmPage.getByRole("tab", { name: "Content" }).click({ timeout: STEP_TIMEOUT });
      await coGmPage.getByRole("button", { name: `Edit ${noteTitle}` }).click({ timeout: STEP_TIMEOUT });
      await coGmPage.getByLabel("Title").nth(1).fill(coGmTitle);
      const retryPatchRequest = coGmPage.waitForRequest(
        (request) => request.url().includes("/content/") && request.method() === "PATCH",
        { timeout: STEP_TIMEOUT },
      );
      const retryPatchResponse = coGmPage.waitForResponse(
        (response) => response.url().includes("/content/") && response.request().method() === "PATCH",
        { timeout: STEP_TIMEOUT },
      );
      await coGmPage.getByRole("button", { name: "Save note" }).nth(1).click({ timeout: STEP_TIMEOUT });
      const retryBody = (await retryPatchRequest).postDataJSON() as Record<string, unknown>;
      expect((await retryPatchResponse).status()).toBe(200);
      expect(retryBody.expectedContentRevision).not.toBe(firstBody.expectedContentRevision);
      expect(retryBody.idempotencyKey).not.toBe(firstBody.idempotencyKey);

      // 9. Both commits' effects present: the co-GM title survived and the
      // acknowledged owner body was not clobbered by the retry.
      await page.goto(campaignUrl);
      await expect(page.getByRole("heading", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });
      await page.getByRole("tab", { name: "Content" }).click({ timeout: STEP_TIMEOUT });
      await expect(page.getByRole("button", { name: `Edit ${coGmTitle}` })).toBeVisible({ timeout: STEP_TIMEOUT });
      await page.getByRole("button", { name: `Open ${coGmTitle}` }).click({ timeout: STEP_TIMEOUT });
      await expect(page.getByText(ownerBody)).toBeVisible({ timeout: STEP_TIMEOUT });

      // 10. Independent operation: two campaign characters through the UI,
      // then owner and co-GM concurrently bump DIFFERENT characters'
      // Health. Both apply with no conflict on either side.
      await createCampaignCharacter(page, campaignTitle, campaignUrl, heroA, ownedVersionId);
      await createCampaignCharacter(page, campaignTitle, campaignUrl, heroB, ownedVersionId);
      await page.goto(campaignUrl);
      await expect(page.getByRole("heading", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });
      await page.getByRole("tab", { name: "Session" }).click({ timeout: STEP_TIMEOUT });
      await page.getByRole("button", { name: `Open ${heroA}` }).click({ timeout: STEP_TIMEOUT });
      await expect(page.getByRole("button", { name: "Decrease Health" })).toBeVisible({ timeout: STEP_TIMEOUT });
      await coGmPage.goto(campaignUrl);
      await expect(coGmPage.getByRole("heading", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });
      await coGmPage.getByRole("tab", { name: "Session" }).click({ timeout: STEP_TIMEOUT });
      await coGmPage.getByRole("button", { name: `Open ${heroB}` }).click({ timeout: STEP_TIMEOUT });
      await expect(coGmPage.getByRole("button", { name: "Decrease Health" })).toBeVisible({ timeout: STEP_TIMEOUT });

      const ownerBumpRequest = page.waitForRequest(
        (request) => request.url().includes("/resources/health/bump") && request.method() === "POST",
        { timeout: STEP_TIMEOUT },
      );
      const coGmBumpRequest = coGmPage.waitForRequest(
        (request) => request.url().includes("/resources/health/bump") && request.method() === "POST",
        { timeout: STEP_TIMEOUT },
      );
      await Promise.all([
        page.getByRole("button", { name: "Decrease Health" }).click({ timeout: STEP_TIMEOUT }),
        coGmPage.getByRole("button", { name: "Decrease Health" }).click({ timeout: STEP_TIMEOUT }),
      ]);
      const ownerBumpBody = (await ownerBumpRequest).postDataJSON() as Record<string, unknown>;
      const coGmBumpBody = (await coGmBumpRequest).postDataJSON() as Record<string, unknown>;
      expect(coGmBumpBody.idempotencyKey).not.toBe(ownerBumpBody.idempotencyKey);
      await expect(page.getByText("9 / 10")).toBeVisible({ timeout: STEP_TIMEOUT });
      await expect(coGmPage.getByText("9 / 10")).toBeVisible({ timeout: STEP_TIMEOUT });
      await expect(page.getByText(/retry the bump/)).toHaveCount(0);
      await expect(coGmPage.getByText(/retry the bump/)).toHaveCount(0);
      await coGmPage.close();
    } finally {
      await coGmContext.close();
    }
  } finally {
    await gmContext.close();
  }
});
