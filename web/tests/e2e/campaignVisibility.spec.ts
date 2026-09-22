import { test, expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";

import { publishOwnedClone, uid } from "../offline/test-auth.js";

/**
 * Acceptance Task 1 (R8): campaign visibility proved with actual player
 * accounts — no GM-as-recipient stand-in.
 *
 * code-test-a owns two campaigns; code-test-b joins the first as an ordinary
 * `player` (never co_gm). The matrix covers gm_only, all_players,
 * selected_players (granted, then narrowed away through the real GM UI),
 * owner_only in both directions, and cross-campaign denial — asserting both
 * HTTP response bodies and the rendered DOM. A reconnect (offline → online)
 * after narrowing must evict the cached reader; leaving with an open reader
 * must purge and land on the access-changed notice.
 *
 * Needs a live backend per web/playwright.config.ts. Every name is unique
 * per run; nothing is deleted (no campaign/content DELETE endpoints exist).
 * The owned-d20 clone goes through the real System Builder API because the
 * seeded reference templates are link-access/unlisted (OD-01).
 */

const D20_VERSION_ID = "a0000000-0000-5000-8000-000000000002";
const STEP_TIMEOUT = 15_000;

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

async function postJson(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  if (response.status() !== 200 && response.status() !== 201) {
    throw new Error(`POST ${path} failed: ${response.status()} ${await response.text()}`);
  }
  return (await response.json()) as Record<string, any>;
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

test("campaign visibility: ordinary-player matrix, narrowing eviction, leave purges", async ({
  page,
  browser,
}: {
  page: Page;
  browser: Browser;
}) => {
  test.setTimeout(120_000);
  const stamp = uid();
  const campaignTitle = `Visibility ${stamp}`;
  const otherTitle = `Faraway ${stamp}`;
  const gmTitle = `GMSealed ${stamp}`;
  const gmBody = `GM sealed body ${stamp}`;
  const allTitle = `Commons ${stamp}`;
  const allBody = `Commons body ${stamp}`;
  const selTitle = `Chosen ${stamp}`;
  const selBody = `Chosen body ${stamp}`;
  const ownATitle = `Keeper ${stamp}`;
  const ownABody = `Keeper body ${stamp}`;
  const ownBTitle = `Personal ${stamp}`;
  const ownBBody = `Personal body ${stamp}`;
  const farTitle = `Distant ${stamp}`;
  const farBody = `Distant body ${stamp}`;

  await page.goto("/");
  const origin = new URL(page.url()).origin;
  const gmContext = await browser.newContext({ baseURL: origin });
  try {
    const gmUserId = await signInAs(gmContext.request, "code-test-a");
    expect(gmUserId).toMatch(/.+/);

    // Invitee identity first: the selected_players grant names them.
    const probeContext = await browser.newContext({ baseURL: origin });
    let playerUserId: string;
    try {
      playerUserId = await signInAs(probeContext.request, "code-test-b");
    } finally {
      await probeContext.close();
    }
    expect(playerUserId).toMatch(/.+/);

    const ownedVersionId = await publishOwnedClone(gmContext.request, D20_VERSION_ID);

    async function createCampaign(title: string): Promise<string> {
      const created = await postJson(gmContext.request, "/api/campaigns", {
        systemVersionId: ownedVersionId,
        title,
        description: `visibility fixture ${stamp}`,
        idempotencyKey: `vis-campaign-${title}`,
      });
      const campaignId: string = created.campaign.campaignId;
      expect(campaignId).toMatch(/[0-9a-f-]{36}/);
      return campaignId;
    }

    async function createNote(
      campaignId: string,
      input: { title: string; body: string; audience?: string; grantedUserIds?: string[] },
    ): Promise<string> {
      const created = await postJson(gmContext.request, `/api/campaigns/${campaignId}/content`, {
        title: input.title,
        body: input.body,
        ...(input.audience === undefined ? {} : { audience: input.audience }),
        ...(input.grantedUserIds === undefined ? {} : { grantedUserIds: input.grantedUserIds }),
        idempotencyKey: `vis-content-${input.title}`,
      });
      const contentId: string = created.content.contentId;
      expect(contentId).toMatch(/[0-9a-f-]{36}/);
      return contentId;
    }

    const campaignId = await createCampaign(campaignTitle);
    const gmNoteId = await createNote(campaignId, { title: gmTitle, body: gmBody, audience: "gm_only" });
    await createNote(campaignId, { title: allTitle, body: allBody, audience: "all_players" });
    const ownANoteId = await createNote(campaignId, { title: ownATitle, body: ownABody, audience: "owner_only" });

    // Second campaign the player never joins: cross-campaign denial.
    const otherCampaignId = await createCampaign(otherTitle);
    const farNoteId = await createNote(otherCampaignId, { title: farTitle, body: farBody, audience: "all_players" });

    // Invite code-test-b as an ordinary player (not co_gm); they join through
    // the real review/accept commands before any grant can name them (grants
    // must target active members of the same campaign).
    const campaignRevision = (await getJson(gmContext.request, `/api/campaigns/${campaignId}`)).campaign
      .revision as number;
    const issued = await postJson(gmContext.request, `/api/campaigns/${campaignId}/invitations`, {
      intendedRole: "player",
      expectedCampaignRevision: campaignRevision,
      idempotencyKey: `vis-invitation-${stamp}`,
    });
    const token: string = issued.invitation.token;
    await signInViaPanel(page, "code-test-b");
    const reviewed = await postJson(page.request, "/api/invitations/review", { token });
    const accepted = await postJson(page.request, "/api/invitations/accept", {
      campaignId,
      token,
      expectedInvitationRevision: reviewed.review.invitationRevision,
      reviewedAccessRevision: reviewed.review.accessRevision,
      idempotencyKey: `vis-accept-${stamp}`,
    });
    expect(accepted.acceptance.membership.userId).toBe(playerUserId);

    const selNoteId = await createNote(campaignId, {
      title: selTitle,
      body: selBody,
      audience: "selected_players",
      grantedUserIds: [playerUserId],
    });

    // Player opens the campaign; the token never reaches the page.
    await page.goto("/campaigns");
    await expect(page.getByRole("link", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });
    await page.getByRole("link", { name: campaignTitle }).click({ timeout: STEP_TIMEOUT });
    await expect(page).toHaveURL(`/campaigns/${campaignId}`);
    await page.getByRole("tab", { name: "Content" }).click({ timeout: STEP_TIMEOUT });
    const contentList = page.getByRole("list", { name: "Campaign content" });

    // Visible rows: all-players + granted selected. Hidden rows: gm_only,
    // the owner's owner-only note. Audience marks persist on the rows.
    await expect(contentList.getByRole("button", { name: `Open ${allTitle}` })).toBeVisible({ timeout: STEP_TIMEOUT });
    await expect(contentList.getByRole("button", { name: `Open ${selTitle}` })).toBeVisible();
    await expect(contentList.getByRole("button", { name: `Open ${gmTitle}` })).toHaveCount(0);
    await expect(contentList.getByRole("button", { name: `Open ${ownATitle}` })).toHaveCount(0);
    await expect(contentList.getByText("All players", { exact: true })).toBeVisible();
    await expect(contentList.getByText("Selected players", { exact: true })).toBeVisible();

    // HTTP matrix as the player: denials are generic 404s whose bodies never
    // carry the secret text.
    for (const [noteId, secret] of [
      [gmNoteId, gmBody],
      [ownANoteId, ownABody],
      [farNoteId, farBody],
    ] as Array<[string, string]>) {
      const denied = await page.request.get(`/api/content/${noteId}`);
      expect(denied.status()).toBe(404);
      expect(await denied.text()).not.toContain(secret);
    }

    // The player reads what they may: all-players now; the granted note is
    // opened after the cross-campaign checks so its reader stays mounted
    // through the narrowing step below (navigations would unmount it).
    await contentList.getByRole("button", { name: `Open ${allTitle}` }).click({ timeout: STEP_TIMEOUT });
    await expect(page.getByText(allBody, { exact: true })).toBeVisible({ timeout: STEP_TIMEOUT });
    await page.getByRole("button", { name: "Back to content" }).click({ timeout: STEP_TIMEOUT });

    // The player's own owner-only note: the GM (not its creator) gets a
    // generic 404 with no body leak. Players may only create owner-only.
    const ownB = await postJson(page.request, `/api/campaigns/${campaignId}/content`, {
      title: ownBTitle,
      body: ownBBody,
      idempotencyKey: `vis-ownb-${stamp}`,
    });
    const ownBNoteId: string = ownB.content.contentId;
    expect(ownBNoteId).toMatch(/[0-9a-f-]{36}/);
    const gmDenied = await gmContext.request.get(`/api/content/${ownBNoteId}`);
    expect(gmDenied.status()).toBe(404);
    expect(await gmDenied.text()).not.toContain(ownBBody);

    // Cross-campaign UI: the unjoined campaign is absent from the list and
    // its detail reads unavailable.
    await page.goto("/campaigns");
    await expect(page.getByText(otherTitle)).toHaveCount(0);
    await page.goto(`/campaigns/${otherCampaignId}`);
    await expect(page.getByText("This campaign is unavailable.")).toBeVisible({ timeout: STEP_TIMEOUT });
    await page.goto(`/campaigns/${campaignId}`);
    await expect(page.getByRole("heading", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });

    // Open the granted note and keep its reader mounted: the narrowing step
    // must evict a live reader, not an already-closed list.
    await page.getByRole("tab", { name: "Content" }).click({ timeout: STEP_TIMEOUT });
    await contentList.getByRole("button", { name: `Open ${selTitle}` }).click({ timeout: STEP_TIMEOUT });
    await expect(page.getByText(selBody, { exact: true })).toBeVisible({ timeout: STEP_TIMEOUT });

    // GM removes the grant through the real edit UI.
    const gmPageContext = await browser.newContext({ baseURL: origin });
    try {
      const gmPage = await gmPageContext.newPage();
      await signInViaPanel(gmPage, "code-test-a");
      await gmPage.goto(`/campaigns/${campaignId}`);
      await expect(gmPage.getByRole("heading", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });
      await gmPage.getByRole("tab", { name: "Content" }).click({ timeout: STEP_TIMEOUT });
      await gmPage.getByRole("button", { name: `Edit ${selTitle}` }).click({ timeout: STEP_TIMEOUT });
      await gmPage.getByLabel("Audience").nth(1).selectOption("selected_players", { timeout: STEP_TIMEOUT });
      await expect(gmPage.getByText("Share with (selected players)")).toBeVisible({ timeout: STEP_TIMEOUT });
      await gmPage.getByRole("checkbox", { name: playerUserId.slice(0, 8) }).uncheck({ timeout: STEP_TIMEOUT });
      await gmPage.getByRole("button", { name: "Save note" }).nth(1).click({ timeout: STEP_TIMEOUT });
      const gmList = gmPage.getByRole("list", { name: "Campaign content" });
      await expect(gmList.getByText("Selected players", { exact: true })).toBeVisible({ timeout: STEP_TIMEOUT });
    } finally {
      await gmPageContext.close();
    }

    // The player's open reader revalidates on reconnect: the cached body and
    // title disappear (never a CSS-hidden remnant) and HTTP confirms 404.
    await page.context().setOffline(true);
    await page.waitForFunction(() => navigator.onLine === false, null, { timeout: STEP_TIMEOUT });
    await page.waitForTimeout(500);
    await page.context().setOffline(false);
    await page.waitForFunction(() => navigator.onLine === true, null, { timeout: STEP_TIMEOUT });
    await expect(page.getByText(selBody, { exact: true })).toHaveCount(0, { timeout: STEP_TIMEOUT });
    await expect(page.getByText(selTitle, { exact: true })).toHaveCount(0);
    const narrowed = await page.request.get(`/api/content/${selNoteId}`);
    expect(narrowed.status()).toBe(404);
    expect(await narrowed.text()).not.toContain(selBody);
    await page.getByRole("button", { name: "Back to content" }).click({ timeout: STEP_TIMEOUT });
    await expect(contentList.getByRole("button", { name: `Open ${selTitle}` })).toHaveCount(0);
    await expect(contentList.getByRole("button", { name: `Open ${allTitle}` })).toBeVisible();

    // Leaving with an open reader purges campaign state: the list loses the
    // campaign and a direct reload shows the access-changed notice.
    await contentList.getByRole("button", { name: `Open ${allTitle}` }).click({ timeout: STEP_TIMEOUT });
    await expect(page.getByText(allBody, { exact: true })).toBeVisible({ timeout: STEP_TIMEOUT });
    await page.getByRole("button", { name: "Leave campaign", exact: true }).click({ timeout: STEP_TIMEOUT });
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: STEP_TIMEOUT });
    await page.getByRole("dialog").getByRole("button", { name: "Leave campaign", exact: true }).click({ timeout: STEP_TIMEOUT });
    await expect(page).toHaveURL("/campaigns", { timeout: STEP_TIMEOUT });
    await expect(page.getByText(campaignTitle)).toHaveCount(0);
    await expect(page.getByText(allBody, { exact: true })).toHaveCount(0);
    await page.goto(`/campaigns/${campaignId}`);
    await expect(page.getByText("This campaign is unavailable.")).toBeVisible({ timeout: STEP_TIMEOUT });
    await expect(page.getByText("Access to this campaign changed.")).toBeVisible();
    await page.goto("/campaigns");
    await expect(page.getByText(campaignTitle)).toHaveCount(0);
  } finally {
    await gmContext.close();
  }
});
