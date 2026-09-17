import { test, expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";

import { publishOwnedClone, uid } from "../offline/test-auth.js";

/**
 * Preview-as-player two-user proof (dev-server E2E): owner (code-test-a)
 * creates a campaign with a GM-only note and an all-player note through the
 * Content tab UI, invites code-test-b, and the member accepts in a second
 * context (never two tabs sharing one query cache).
 *
 * - The member's own Content view shows exactly the all-player note.
 * - The owner enters "Preview as" for the member: the preview list renders
 *   the identical visible set (same rows, same audience marks) as the
 *   member's own view, plus the persistent read-only banner, with no
 *   authoring control (create/edit/hide/recover/grants) mounted.
 * - Exit restores the full GM view (picker, create editor, per-note
 *   edit controls, both notes).
 * - Removed-target path (spec §UI): with the preview still mounted, the
 *   owner removes the member from a second owner page; the next preview
 *   fetch (opening a note) surfaces the "Preview could not be loaded."
 *   error state. The picker only ever offers active members, so a removed
 *   target cannot be re-entered by construction.
 *
 * Needs a live backend per web/playwright.config.ts (migrate + dev:http and
 * web:dev, with DATABASE_URL pointing at Postgres). No campaign/character
 * DELETE endpoints exist, so every name is unique per run. Only the owned
 * d20 clone is seeded through the real System Builder API as code-test-a in
 * an isolated context; everything else runs through the UI.
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

/** Raw row texts of the "Campaign content" list (same component on both sides). */
async function contentRowTexts(page: Page): Promise<string[]> {
  const list = page.getByRole("list", { name: "Campaign content" });
  await expect(list).toBeVisible({ timeout: STEP_TIMEOUT });
  return list.locator("li").allTextContents();
}

test("preview-as-player: member parity, read-only banner, exit restores, removed-target error", async ({
  page,
  browser,
}: {
  page: Page;
  browser: Browser;
}) => {
  test.setTimeout(420_000);
  const stamp = uid();
  const campaignTitle = `Preview Campaign ${stamp}`;
  const gmNoteTitle = `Preview GM Briefing ${stamp}`;
  const gmNoteBody = `GM-only briefing body ${stamp}`;
  const playerNoteTitle = `Preview Player Handout ${stamp}`;
  const playerNoteBody = `All-player handout body ${stamp}`;

  // 1. GM seeding (isolated context as code-test-a): publish the owned d20
  // clone through the real System Builder API. Nothing else is provisioned
  // over HTTP; the campaign and notes are created through the UI.
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
    // cookie stays intact); used to target the preview picker option.
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

    // 3. Owner authors two content notes through the Content tab: one
    // GM-only, one for all players (first Title/Body/Audience/Save on the
    // page belong to the create editor).
    await page.getByRole("tab", { name: "Content" }).click({ timeout: STEP_TIMEOUT });
    await page.getByLabel("Title").first().fill(gmNoteTitle);
    await page.getByLabel("Body").first().fill(gmNoteBody);
    await page.getByLabel("Audience").first().selectOption("gm_only");
    await page.getByRole("button", { name: "Save note" }).first().click({ timeout: STEP_TIMEOUT });
    await expect(page.getByText("Note saved.").first()).toBeVisible({ timeout: STEP_TIMEOUT });
    await expect(page.getByRole("button", { name: `Open ${gmNoteTitle}` })).toBeVisible({ timeout: STEP_TIMEOUT });

    await page.getByLabel("Title").first().fill(playerNoteTitle);
    await page.getByLabel("Body").first().fill(playerNoteBody);
    await page.getByLabel("Audience").first().selectOption("all_players");
    await page.getByRole("button", { name: "Save note" }).first().click({ timeout: STEP_TIMEOUT });
    await expect(page.getByText("Note saved.").first()).toBeVisible({ timeout: STEP_TIMEOUT });
    const contentList = page.getByRole("list", { name: "Campaign content" });
    await expect(contentList.getByText("Game Master only")).toBeVisible({ timeout: STEP_TIMEOUT });
    await expect(contentList.getByText("All players")).toBeVisible({ timeout: STEP_TIMEOUT });

    // 4. Owner issues a fresh invitation; code-test-b accepts in a second
    // context (never two tabs sharing one query cache).
    await page.getByRole("tab", { name: "Members" }).click({ timeout: STEP_TIMEOUT });
    await expect(page.getByRole("heading", { name: "Invitations" })).toBeVisible({ timeout: STEP_TIMEOUT });
    await page.getByRole("button", { name: "Issue invitation" }).click({ timeout: STEP_TIMEOUT });
    const inviteToken = await readShownToken(page);
    await dismissShownToken(page, inviteToken);

    const memberContext = await browser.newContext({ baseURL: origin });
    try {
      const memberPage = await memberContext.newPage();
      await signInViaPanel(memberPage, "code-test-b");
      await memberPage.goto(`/invitations?token=${encodeURIComponent(inviteToken)}`);
      await expect(memberPage.getByRole("heading", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });
      await expect(memberPage.getByText(inviteToken)).toHaveCount(0);
      await memberPage.getByRole("button", { name: "Accept", exact: true }).click({ timeout: STEP_TIMEOUT });
      await expect(memberPage.getByText(`Welcome to ${campaignTitle}.`)).toBeVisible({ timeout: STEP_TIMEOUT });

      // 5. The member's own Content view shows exactly the all-player note:
      // the GM-only title and its audience mark are absent.
      await memberPage.goto(campaignUrl);
      await expect(memberPage.getByRole("heading", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });
      await memberPage.getByRole("tab", { name: "Content" }).click({ timeout: STEP_TIMEOUT });
      const memberList = memberPage.getByRole("list", { name: "Campaign content" });
      await expect(memberList.getByText("All players")).toBeVisible({ timeout: STEP_TIMEOUT });
      await expect(memberPage.getByRole("button", { name: `Open ${playerNoteTitle}` })).toBeVisible({
        timeout: STEP_TIMEOUT,
      });
      await expect(memberPage.getByText(gmNoteTitle)).toHaveCount(0);
      await expect(memberPage.getByText("Game Master only")).toHaveCount(0);
      const memberRows = await contentRowTexts(memberPage);

      // 6. Owner enters preview-as-member: the preview list renders the
      // identical visible set (same rows, same audience marks) as the
      // member's own view, plus the persistent read-only banner, with no
      // authoring control mounted.
      await page.goto(campaignUrl);
      await expect(page.getByRole("heading", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });
      await page.getByRole("tab", { name: "Content" }).click({ timeout: STEP_TIMEOUT });
      await expect(page.getByLabel("Preview as")).toBeVisible({ timeout: STEP_TIMEOUT });
      await page.getByLabel("Preview as").selectOption(inviteeUserId!);
      const banner = `Previewing as ${inviteeUserId!} — read-only`;
      await expect(page.getByText(banner)).toBeVisible({ timeout: STEP_TIMEOUT });
      await expect(page.getByRole("button", { name: "Exit preview" })).toBeVisible({ timeout: STEP_TIMEOUT });
      const previewRows = await contentRowTexts(page);
      expect(previewRows).toEqual(memberRows);
      // No authoring affordance in preview: no create editor, no per-note
      // edit/delete, no picker (replaced by the banner + exit).
      await expect(page.getByRole("button", { name: "Save note" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: `Edit ${playerNoteTitle}` })).toHaveCount(0);
      await expect(page.getByLabel("Preview as")).toHaveCount(0);
      await expect(page.getByText(playerNoteBody)).toHaveCount(0);

      // 7. The preview reader shows the shared note body through the
      // preview projection, then returns to the preview list.
      await page.getByRole("button", { name: `Open ${playerNoteTitle}` }).click({ timeout: STEP_TIMEOUT });
      await expect(page.getByText(playerNoteBody)).toBeVisible({ timeout: STEP_TIMEOUT });
      await expect(page.getByText("All players")).toBeVisible({ timeout: STEP_TIMEOUT });
      await expect(page.getByText(banner)).toBeVisible({ timeout: STEP_TIMEOUT });
      await page.getByRole("button", { name: "Back to content" }).click({ timeout: STEP_TIMEOUT });
      await expect(page.getByRole("button", { name: `Open ${playerNoteTitle}` })).toBeVisible({
        timeout: STEP_TIMEOUT,
      });

      // 8. Exit restores the full GM view: picker, create editor, per-note
      // edit controls, and both notes with their audience marks.
      await page.getByRole("button", { name: "Exit preview" }).click({ timeout: STEP_TIMEOUT });
      await expect(page.getByText(banner)).toHaveCount(0);
      await expect(page.getByLabel("Preview as")).toBeVisible({ timeout: STEP_TIMEOUT });
      await expect(page.getByRole("button", { name: "Save note" }).first()).toBeVisible({ timeout: STEP_TIMEOUT });
      await expect(page.getByRole("button", { name: `Edit ${gmNoteTitle}` })).toBeVisible({ timeout: STEP_TIMEOUT });
      await expect(page.getByRole("button", { name: `Edit ${playerNoteTitle}` })).toBeVisible({
        timeout: STEP_TIMEOUT,
      });
      await expect(page.getByRole("button", { name: `Open ${gmNoteTitle}` })).toBeVisible({ timeout: STEP_TIMEOUT });
      await expect(page.getByRole("button", { name: `Open ${playerNoteTitle}` })).toBeVisible({
        timeout: STEP_TIMEOUT,
      });

      // 9. Removed-target error path: re-enter preview, then remove the
      // member from a second owner page (same account, separate context so
      // the mounted preview is untouched). The next preview fetch — opening
      // a note — surfaces the preview error state.
      await page.getByLabel("Preview as").selectOption(inviteeUserId!);
      await expect(page.getByText(banner)).toBeVisible({ timeout: STEP_TIMEOUT });
      await expect(page.getByRole("button", { name: `Open ${playerNoteTitle}` })).toBeVisible({
        timeout: STEP_TIMEOUT,
      });

      const ownerSecondContext = await browser.newContext({ baseURL: origin });
      try {
        const ownerSecond = await ownerSecondContext.newPage();
        await signInViaPanel(ownerSecond, "code-test-a");
        await ownerSecond.goto(campaignUrl);
        await expect(ownerSecond.getByRole("heading", { name: campaignTitle })).toBeVisible({
          timeout: STEP_TIMEOUT,
        });
        await ownerSecond.getByRole("tab", { name: "Members" }).click({ timeout: STEP_TIMEOUT });
        const removalRow = ownerSecond.locator("li", { hasText: inviteeUserId! });
        await expect(removalRow).toBeVisible({ timeout: STEP_TIMEOUT });
        await removalRow.getByRole("button", { name: `Remove ${inviteeUserId!}` }).click({ timeout: STEP_TIMEOUT });
        await expect(ownerSecond.getByRole("dialog")).toBeVisible({ timeout: STEP_TIMEOUT });
        await ownerSecond.getByRole("dialog").getByRole("button", { name: "Confirm removal" }).click({
          timeout: STEP_TIMEOUT,
        });
        await expect(ownerSecond.getByText(inviteeUserId!)).toHaveCount(0);
        await ownerSecond.close();
      } finally {
        await ownerSecondContext.close();
      }

      await page.getByRole("button", { name: `Open ${playerNoteTitle}` }).click({ timeout: STEP_TIMEOUT });
      await expect(page.getByText("Preview could not be loaded.")).toBeVisible({ timeout: STEP_TIMEOUT });
      // The banner persists beside the error; the failed projection leaves
      // no note body behind.
      await expect(page.getByText(banner)).toBeVisible({ timeout: STEP_TIMEOUT });
      await expect(page.getByText(playerNoteBody)).toHaveCount(0);

      await memberPage.close();
    } finally {
      await memberContext.close();
    }
  } finally {
    await gmContext.close();
  }
});
