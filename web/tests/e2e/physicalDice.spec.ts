import { expect, test } from "../fixtures/browserTest.js";
import { json, key, publish, pushDocument, signIn, workspace } from "../fixtures/configurablePush.js";

test("shares a physical throw from a roller who hides the 3D overlay", async ({ page, browser, baseURL }) => {
  test.skip(
    process.env.SWEETROLL_PHYSICAL_DICE !== "true",
    "Requires the physical dice server configuration",
  );
  if (!baseURL) throw Error("Missing test URL");
  const gm = await signIn(page, "code-journey-gm");
  const player = await browser.newContext({
    baseURL,
    viewport: { width: 360, height: 640 },
    extraHTTPHeaders: { Origin: baseURL },
  });
  try {
    const viewer = await player.newPage();
    await signIn(viewer, "code-journey-p1");
    const rules = pushDocument();
    rules.metadata.name = `Physical dice ${key()}`;
    const { id } = await workspace(page.request, rules);
    const version = await publish(page.request, id);
    const { campaign } = await json(page.request, "POST", "/api/campaigns", {
      systemVersionId: version,
      title: rules.metadata.name,
      idempotencyKey: key(),
    });
    const path = `/api/campaigns/${campaign.campaignId}`;
    const revision = async () => (await json(page.request, "GET", path)).campaign.revision;
    const { invitation } = await json(page.request, "POST", `${path}/invitations`, {
      intendedRole: "player",
      expectedCampaignRevision: await revision(),
      idempotencyKey: key(),
    });
    const { review } = await json(viewer.request, "POST", "/api/invitations/review", {
      token: invitation.token,
    });
    await json(viewer.request, "POST", "/api/invitations/accept", {
      campaignId: campaign.campaignId,
      token: invitation.token,
      expectedInvitationRevision: review.invitationRevision,
      reviewedAccessRevision: review.reviewedAccessRevision ?? review.accessRevision,
      idempotencyKey: key(),
    });
    const { character } = await json(page.request, "POST", `${path}/characters`, {
      name: "Thrower",
      entityDefinitionId: "character",
      controllerUserIds: [gm],
      expectedCampaignRevision: await revision(),
      idempotencyKey: key(),
    });

    await page.goto("/account");
    const preference = page.getByLabel("Show 3D dice");
    await expect(preference).toBeChecked();
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith("/me/preferences") &&
        response.request().method() === "PATCH" &&
        response.ok(),
    );
    await preference.uncheck();
    expect((await (await saved).json()).show_3d_dice).toBe(false);
    const colorResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/me/preferences") &&
        response.request().method() === "PATCH" &&
        response.ok(),
    );
    await page.getByLabel("My dice color").fill("#ce5482");
    await page.getByRole("button", { name: "Save dice color" }).click();
    expect((await (await colorResponse).json()).dice_color).toBe("#ce5482");

    const connecting = viewer.waitForResponse(
      (response) => response.ok() && response.url().endsWith("/physical-rolls/events"),
    );
    const coldFeed = viewer.waitForResponse(
      (response) => response.ok() && new URL(response.url()).pathname === `${path}/activity`,
    );
    await viewer.goto(`/campaigns/${campaign.campaignId}`);
    await Promise.all([connecting, coldFeed]);
    await page.goto(`/characters/${character.characterId}`);
    const prepared = page.waitForResponse(
      (response) =>
        response.ok() && response.url().endsWith("/physical-rolls") && response.request().method() === "POST",
    );
    const completed = page.waitForResponse(
      (response) =>
        response.ok() && response.url().includes("/physical-rolls/") && response.url().endsWith("/complete"),
    );
    await page.getByRole("button", { name: "Test Pool", exact: true }).click();
    expect((await (await prepared).json()).attempt.color).toBe("#ce5482");
    const canvas = viewer.locator('[data-testid="physical-dice-canvas"][data-dice-ready="true"]');
    await expect(canvas).toBeVisible({ timeout: 10000 });
    await viewer.setViewportSize({ width: 640, height: 360 });
    const official = (await (await completed).json()).result.roll;
    expect(official.dice.length).toBeGreaterThan(0);
    await expect(page.getByTestId("physical-dice-canvas")).toHaveCount(0);
    await expect(page.getByTestId("play-events").getByRole("listitem")).toHaveCount(1);
    await expect(viewer.getByTestId("play-events").getByRole("listitem")).toHaveCount(1, { timeout: 6500 });
    await expect(canvas).toHaveCount(0, { timeout: 5000 });
  } finally {
    await player.close();
  }
});
