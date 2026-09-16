import { test, expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";

import { publishOwnedClone, uid } from "../offline/test-auth.js";

/**
 * I7 GM Phase 1 exit demonstration (dev-server E2E): GM campaign setup
 * entirely through the UI — create from the version catalog, Members tab
 * (roster + GM-gated settings/invitations), invitation issue → rotate →
 * revoke, fresh invite → invitee accept → promote to co-GM → remove →
 * unavailable — plus the /campaigns list check for the newly created
 * campaign (fire-and-forget list-invalidation convention from Task 3).
 *
 * Needs a live backend per web/playwright.config.ts (migrate + dev:http and
 * web:dev, with DATABASE_URL pointing at Postgres). No campaign/character
 * DELETE endpoints exist, so every name is unique per run. Only the owned
 * d20 clone is seeded through the real System Builder API (clone → save
 * draft unchanged → publish 1.0.0) as the GM actor (code-test-a in an
 * isolated context), because the seeded reference templates are
 * link-access/unlisted (OD-01) and versionless enumeration never offers
 * them; all campaign setup itself runs through the UI — no direct campaign
 * HTTP provisioning. The dev sign-in panel stays (dev server), so no
 * SWEETROLL_TEST_AUTH escape hatch is needed here. Invitation tokens travel
 * in POST bodies only: the e2e reads each token off the GM's display-once
 * token panel (the sanctioned UI surface, never a URL transport).
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

test("I7 exit: GM setup through UI, invitations, accept, promote, remove, unavailable", async ({
  page,
  browser,
}: {
  page: Page;
  browser: Browser;
}) => {
  test.setTimeout(420_000);
  const stamp = uid();
  const campaignTitle = `G7 GM Setup ${stamp}`;

  // 1. GM seeding (isolated context as code-test-a): publish the owned d20
  // clone through the real System Builder API. Nothing else is provisioned
  // over HTTP; the campaign itself is created through the UI below.
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
    // cookie stays intact); used to target roster rows by user id.
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

    // 3. /campaigns lists the newly created campaign (fire-and-forget
    // list-invalidation from Task 3); open it back up.
    await page.goto("/campaigns");
    await expect(page.getByRole("link", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });
    await page.getByRole("link", { name: campaignTitle }).click({ timeout: STEP_TIMEOUT });
    await expect(page).toHaveURL(`/campaigns/${campaignId}`);
    await expect(page.getByRole("heading", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });

    // 4. Members tab as the owner: roster plus GM-gated invitation
    // management; settings live in the GM-only Settings tab.
    await page.getByRole("tab", { name: "Members" }).click({ timeout: STEP_TIMEOUT });
    await expect(page.getByRole("heading", { name: "Invitations" })).toBeVisible({ timeout: STEP_TIMEOUT });
    await expect(page.getByText("Campaign settings")).toHaveCount(0);
    await page.getByRole("tab", { name: "Settings" }).click({ timeout: STEP_TIMEOUT });
    await expect(page.getByText("Campaign settings")).toBeVisible({ timeout: STEP_TIMEOUT });
    await expect(page.getByText("Pinned system version")).toBeVisible({ timeout: STEP_TIMEOUT });
    await expect(page.getByText(ownedVersionId)).toBeVisible({ timeout: STEP_TIMEOUT });
    await page.getByRole("tab", { name: "Members" }).click({ timeout: STEP_TIMEOUT });

    // 5. Issue a player invitation: token shown once, then gone.
    await page.getByRole("button", { name: "Issue invitation" }).click({ timeout: STEP_TIMEOUT });
    const firstToken = await readShownToken(page);
    await dismissShownToken(page, firstToken);

    // 6. Rotate it: a new token is shown; revoke the rotated invitation.
    await page.getByRole("button", { name: "Rotate" }).click({ timeout: STEP_TIMEOUT });
    const rotatedToken = await readShownToken(page);
    expect(rotatedToken).not.toBe(firstToken);
    await dismissShownToken(page, rotatedToken);
    await page.getByRole("button", { name: "Revoke" }).click({ timeout: STEP_TIMEOUT });
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: STEP_TIMEOUT });
    await page.getByRole("dialog").getByRole("button", { name: "Revoke invitation" }).click({ timeout: STEP_TIMEOUT });
    // Revoked rows stay listed with their status (no status filter on the
    // list endpoint); the revoked link can take no new joins.
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText("revoked", { exact: true })).toBeVisible({ timeout: STEP_TIMEOUT });

    // 7. Fresh player invitation for the invitee flow.
    await page.getByRole("button", { name: "Issue invitation" }).click({ timeout: STEP_TIMEOUT });
    const inviteToken = await readShownToken(page);
    await dismissShownToken(page, inviteToken);

    // 8. Invitee UI flow as code-test-b (separate context): review by
    // token (never echoed back to the page), accept.
    const inviteeContext = await browser.newContext({ baseURL: origin });
    try {
      const inviteePage = await inviteeContext.newPage();
      await signInViaPanel(inviteePage, "code-test-b");
      await inviteePage.goto(`/invitations?token=${encodeURIComponent(inviteToken)}`);
      await expect(inviteePage.getByRole("heading", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });
      await expect(inviteePage.getByText(inviteToken)).toHaveCount(0);
      await inviteePage.getByRole("button", { name: "Accept", exact: true }).click({ timeout: STEP_TIMEOUT });
      await expect(inviteePage.getByText(`Welcome to ${campaignTitle}.`)).toBeVisible({ timeout: STEP_TIMEOUT });

      // 9. Invitee opens the campaign from /campaigns; as a player the
      // Members tab shows the roster without management sections.
      await inviteePage.goto("/campaigns");
      await expect(inviteePage.getByRole("link", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });
      await inviteePage.getByRole("link", { name: campaignTitle }).click({ timeout: STEP_TIMEOUT });
      await expect(inviteePage).toHaveURL(`/campaigns/${campaignId}`);
      await inviteePage.getByRole("tab", { name: "Members" }).click({ timeout: STEP_TIMEOUT });
      await expect(inviteePage.getByText(inviteeUserId!)).toBeVisible({ timeout: STEP_TIMEOUT });
      await expect(inviteePage.getByText("Campaign settings")).toHaveCount(0);
      await expect(inviteePage.getByRole("tab", { name: "Settings" })).toHaveCount(0);
      await expect(inviteePage.getByRole("heading", { name: "Invitations" })).toHaveCount(0);

      // 10. GM promotes the member to co-GM behind the confirm dialog.
      // Fresh load: the invitee accept bumped the campaign revision, so
      // the GM re-reads before the revision-guarded role change.
      await page.goto(`/campaigns/${campaignId}`);
      await expect(page.getByRole("heading", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });
      await page.getByRole("tab", { name: "Members" }).click({ timeout: STEP_TIMEOUT });
      const memberRow = page.locator("li", { hasText: inviteeUserId! });
      await expect(memberRow).toBeVisible({ timeout: STEP_TIMEOUT });
      await memberRow.locator("select").selectOption("co_gm");
      await memberRow.getByRole("button", { name: "Change role" }).click({ timeout: STEP_TIMEOUT });
      await expect(page.getByRole("dialog")).toBeVisible({ timeout: STEP_TIMEOUT });
      await page.getByRole("dialog").getByRole("button", { name: "Confirm role change" }).click({ timeout: STEP_TIMEOUT });
      await expect(memberRow.locator("span", { hasText: "Co-GM" }).first()).toBeVisible({ timeout: STEP_TIMEOUT });

      // 11. GM removes the member behind the confirm dialog; the roster
      // updates. Fresh load again: the promotion bumped the revision.
      await page.goto(`/campaigns/${campaignId}`);
      await expect(page.getByRole("heading", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });
      await page.getByRole("tab", { name: "Members" }).click({ timeout: STEP_TIMEOUT });
      const removalRow = page.locator("li", { hasText: inviteeUserId! });
      await expect(removalRow).toBeVisible({ timeout: STEP_TIMEOUT });
      await removalRow.getByRole("button", { name: `Remove ${inviteeUserId!}` }).click({ timeout: STEP_TIMEOUT });
      await expect(page.getByRole("dialog")).toBeVisible({ timeout: STEP_TIMEOUT });
      await page.getByRole("dialog").getByRole("button", { name: "Confirm removal" }).click({ timeout: STEP_TIMEOUT });
      await expect(page.getByText(inviteeUserId!)).toHaveCount(0);

      // 12. Removed invitee: direct detail shows unavailable with the
      // access-changed notice (revocation purge); the list stays clean.
      await inviteePage.goto(`/campaigns/${campaignId}`);
      await expect(inviteePage.getByText("This campaign is unavailable.")).toBeVisible({ timeout: STEP_TIMEOUT });
      await expect(inviteePage.getByText("Access to this campaign changed.")).toBeVisible();
      await inviteePage.goto("/campaigns");
      await expect(inviteePage.getByText(campaignTitle)).toHaveCount(0);
    } finally {
      await inviteeContext.close();
    }
  } finally {
    await gmContext.close();
  }
});
