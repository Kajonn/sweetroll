import { test, expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";

import { publishOwnedClone, uid } from "../offline/test-auth.js";

/**
 * G7 Task 5 exit demonstration (dev-server E2E): invite → accept → list →
 * open → claim character → read permitted content → see activity → leave →
 * list no longer shows it + reload shows unavailable.
 *
 * Needs a live backend per web/playwright.config.ts (migrate + dev:http and
 * web:dev, with DATABASE_URL pointing at Postgres). No character/campaign
 * DELETE endpoints exist, so every name is unique per run. The campaign, its
 * permitted note, its character, the invitation, and the claim designation
 * are seeded through real HTTP as the GM actor (code-test-a in an isolated
 * context): the owned-d20 clone goes through the real System Builder API
 * because the seeded reference templates are link-access/unlisted (OD-01)
 * and versionless enumeration never offers them, and GM campaign
 * setup/content-authoring belongs to I7 (explicitly out of this plan). The
 * invitee journey itself — review, accept, list, open, claim, read,
 * activity, leave, unavailable — runs entirely through the UI as code-test-b.
 * The dev sign-in panel stays (dev server), so no SWEETROLL_TEST_AUTH escape
 * hatch is needed here.
 *
 * The invitee joins as player: claim discovery comes from the dedicated
 * claimable-characters read (never the GM roster), and the UI claim step
 * acts on the discovered row without pre-claim sheet access.
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

test("G7 exit: invitation accept, campaign list, claim, permitted content, activity, leave purges", async ({
  page,
  browser,
}: {
  page: Page;
  browser: Browser;
}) => {
  test.setTimeout(120_000);
  const stamp = uid();
  const campaignTitle = `G7 Campaign ${stamp}`;
  const noteTitle = `G7 Briefing ${stamp}`;
  const noteBody = `G7 permitted briefing body ${stamp}`;
  const characterName = `G7 Hero ${stamp}`;

  // 1. GM seeding (isolated context as code-test-a): owned d20 clone, then
  // the campaign, one all-players note, one character, and a co_gm
  // invitation issued through the real invitations endpoint.
  await page.goto("/");
  const origin = new URL(page.url()).origin;
  const gmContext = await browser.newContext({ baseURL: origin });
  try {
    const gmUserId = await signInAs(gmContext.request, "code-test-a");
    expect(gmUserId).toMatch(/.+/);
    const ownedVersionId = await publishOwnedClone(gmContext.request, D20_VERSION_ID);

    const created = await postJson(gmContext.request, "/api/campaigns", {
      systemVersionId: ownedVersionId,
      title: campaignTitle,
      description: `G7 exit fixture ${stamp}`,
      idempotencyKey: `g7-campaign-${stamp}`,
    });
    const campaignId: string = created.campaign.campaignId;
    expect(campaignId).toMatch(/[0-9a-f-]{36}/);

    await postJson(gmContext.request, `/api/campaigns/${campaignId}/content`, {
      title: noteTitle,
      body: noteBody,
      audience: "all_players",
      idempotencyKey: `g7-content-${stamp}`,
    });

    let campaignRevision = (await getJson(gmContext.request, `/api/campaigns/${campaignId}`)).campaign
      .revision as number;
    const createdCharacter = await postJson(gmContext.request, `/api/campaigns/${campaignId}/characters`, {
      name: characterName,
      entityDefinitionId: "character",
      expectedCampaignRevision: campaignRevision,
      idempotencyKey: `g7-character-${stamp}`,
    });
    const placedCharacterId: string = createdCharacter.character.characterId;
    expect(placedCharacterId).toMatch(/[0-9a-f-]{36}/);
    let placedCharacterRevision = createdCharacter.character.revision as number;

    // Content + character creation bumped the campaign revision since the
    // create response: re-read so the invite carries the latest revision.
    campaignRevision = (await getJson(gmContext.request, `/api/campaigns/${campaignId}`)).campaign
      .revision as number;
    const issued = await postJson(gmContext.request, `/api/campaigns/${campaignId}/invitations`, {
      intendedRole: "player",
      expectedCampaignRevision: campaignRevision,
      idempotencyKey: `g7-invitation-${stamp}`,
    });
    const token: string = issued.invitation.token;
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);

    // Invitee identity for the claim designation (separate probe context so
    // the GM session cookie stays intact).
    const probeContext = await browser.newContext({ baseURL: origin });
    let inviteeUserId: string;
    try {
      inviteeUserId = await signInAs(probeContext.request, "code-test-b");
    } finally {
      await probeContext.close();
    }
    expect(inviteeUserId).toMatch(/.+/);

    // 2. Invitee UI flow as code-test-b: review the invitation by token
    // (token never echoed back to the page), accept.
    await signInViaPanel(page, "code-test-b");
    await page.goto(`/invitations?token=${encodeURIComponent(token)}`);
    await expect(page.getByRole("heading", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });
    await expect(page.getByText(token)).toHaveCount(0);
    await page.getByRole("button", { name: "Accept", exact: true }).click({ timeout: STEP_TIMEOUT });
    await expect(page.getByText(`Welcome to ${campaignTitle}.`)).toBeVisible({ timeout: STEP_TIMEOUT });

    // 3. GM designates the invitee as claimant (backend acceptance
    // precedent); the invitee then discovers the sheet in the list UI.
    campaignRevision = (await getJson(gmContext.request, `/api/campaigns/${campaignId}`)).campaign
      .revision as number;
    const assigned = await postJson(
      gmContext.request,
      `/api/campaigns/${campaignId}/characters/${placedCharacterId}/assign`,
      {
        controllerUserIds: [],
        designateClaimants: [inviteeUserId],
        expectedCampaignRevision: campaignRevision,
        expectedCharacterRevision: placedCharacterRevision,
        idempotencyKey: `g7-designate-${stamp}`,
      },
    );
    placedCharacterRevision = assigned.character.revision as number;

    // 4. /campaigns lists the joined campaign; open it.
    await page.goto("/campaigns");
    await expect(page.getByRole("link", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });
    await page.getByRole("link", { name: campaignTitle }).click({ timeout: STEP_TIMEOUT });
    await expect(page).toHaveURL(`/campaigns/${campaignId}`);
    await expect(page.getByRole("heading", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });

    // 5. Characters tab (default): the designated sheet is discovered
    // through the claimable-characters read; the player has no pre-claim
    // sheet access and no roster Open button. Claim through the confirm
    // dialog with a caller-minted idempotency key.
    const preClaim = await page.request.get(`/api/characters/${placedCharacterId}`);
    expect(preClaim.status()).toBe(404);
    await expect(page.getByText("Available to claim")).toBeVisible({ timeout: STEP_TIMEOUT });
    await expect(page.getByRole("button", { name: `Open ${characterName}` })).toHaveCount(0);
    await page.getByRole("button", { name: `Claim ${characterName}` }).click({ timeout: STEP_TIMEOUT });
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: STEP_TIMEOUT });
    await page.getByRole("dialog").getByRole("button", { name: "Confirm claim" }).click({ timeout: STEP_TIMEOUT });
    // Success is the roster Open button: the discovery row leaves the
    // claimable list once its designation is consumed, so its transient
    // claimed text is not the stable signal.
    await expect(page.getByRole("button", { name: `Open ${characterName}` })).toBeVisible({ timeout: STEP_TIMEOUT });

    // 6. Content tab: persistent audience marking, open the permitted note,
    // read its body. Scope list and reader assertions separately: the
    // Audience selects carry the same labels as hidden <option> elements.
    await page.getByRole("tab", { name: "Content" }).click({ timeout: STEP_TIMEOUT });
    const contentList = page.getByRole("list", { name: "Campaign content" });
    await expect(contentList.getByText("All players", { exact: true })).toBeVisible({ timeout: STEP_TIMEOUT });
    await contentList.getByRole("button", { name: `Open ${noteTitle}` }).click({ timeout: STEP_TIMEOUT });
    await expect(page.getByText(noteBody, { exact: true })).toBeVisible({ timeout: STEP_TIMEOUT });
    await expect(page.locator("p").filter({ hasText: /^All players$/ })).toBeVisible();
    await page.getByRole("button", { name: "Back to content" }).click({ timeout: STEP_TIMEOUT });

    // 7. Activity tab: GM seeding events render (kind + actor + timestamp,
    // no secret payloads).
    await page.getByRole("tab", { name: "Activity" }).click({ timeout: STEP_TIMEOUT });
    await expect(page.getByText("Content created")).toBeVisible({ timeout: STEP_TIMEOUT });

    // 8. Leave: confirm, return to the list without the campaign; a direct
    // reload of the detail shows unavailable with the access-changed notice
    // (revocation purge), and the list stays clean.
    await page.getByRole("button", { name: "Leave campaign", exact: true }).click({ timeout: STEP_TIMEOUT });
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: STEP_TIMEOUT });
    await page.getByRole("dialog").getByRole("button", { name: "Leave campaign", exact: true }).click({ timeout: STEP_TIMEOUT });
    await expect(page).toHaveURL("/campaigns", { timeout: STEP_TIMEOUT });
    await expect(page.getByText(campaignTitle)).toHaveCount(0);
    await page.goto(`/campaigns/${campaignId}`);
    await expect(page.getByText("This campaign is unavailable.")).toBeVisible({ timeout: STEP_TIMEOUT });
    await expect(page.getByText("Access to this campaign changed.")).toBeVisible();
    await page.goto("/campaigns");
    await expect(page.getByText(campaignTitle)).toHaveCount(0);
  } finally {
    await gmContext.close();
  }
});
