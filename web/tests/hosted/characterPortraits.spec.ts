import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const key = () => randomUUID();
async function request(
  page: Page,
  method: string,
  path: string,
  data?: unknown,
) {
  return page.evaluate(
    async ({ method, path, data }) => {
      const r = await fetch(path, {
        method,
        cache: "no-store",
        ...(data === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(data),
            }),
      });
      return { status: r.status, body: await r.json() };
    },
    { method, path, data },
  );
}
async function json(page: Page, method: string, path: string, data?: unknown) {
  const r = await request(page, method, path, data);
  expect(
    r.status,
    `${method} ${path}: ${r.body.error?.message ?? ""}`,
  ).toBeGreaterThanOrEqual(200);
  expect(r.status).toBeLessThan(300);
  return r.body;
}
async function signIn(page: Page, code: string) {
  await page.goto("/");
  await json(page, "POST", "/dev/signin", {
    code,
    redirectUri: new URL("/cb", page.url()).href,
  });
}
test("M1 player portraits, GM disclosure, return and offline sheet play", async ({
  browser,
  baseURL,
}, info) => {
  test.setTimeout(300_000);
  if (!baseURL) throw new Error("A hosted test URL is required.");
  const ownerContext = await browser.newContext({
    baseURL,
    ignoreHTTPSErrors: true,
  });
  const gmContext = await browser.newContext({
    baseURL,
    ignoreHTTPSErrors: true,
  });
  const otherContext = await browser.newContext({
    baseURL,
    ignoreHTTPSErrors: true,
  });
  const owner = await ownerContext.newPage(),
    gm = await gmContext.newPage(),
    other = await otherContext.newPage();
  let characterId: string | null = null,
    campaignId: string | null = null;
  try {
    await signIn(owner, "code-journey-p1");
    await signIn(gm, "code-journey-gm");
    await signIn(other, "code-journey-p2");
    const ch = (
      await json(owner, "POST", "/api/characters", {
        name: `M1 explorer ${key().slice(0, 8)}`,
        systemVersionId: "a0000000-0000-5000-8000-000000000002",
        entityDefinitionId: "character",
        idempotencyKey: key(),
      })
    ).character;
    characterId = ch.characterId;
    const portraitPath = `/api/characters/${characterId}/portrait`;
    await owner.setViewportSize({ width: 360, height: 900 });
    await owner.goto(`/characters/${characterId}`);
    await expect(owner.getByText("No portrait", { exact: true })).toBeVisible();
    const png = await sharp({
      create: { width: 80, height: 120, channels: 3, background: "#3f596c" },
    })
      .png()
      .withMetadata({ exif: { IFD0: { Artist: "Private M1 fixture" } } })
      .toBuffer();
    await owner
      .getByLabel("Portrait file", { exact: true })
      .setInputFiles({
        name: "explorer.png",
        mimeType: "image/png",
        buffer: png,
      });
    await owner
      .getByLabel("Portrait description", { exact: true })
      .fill("Explorer wearing a blue cloak");
    const uploadBodies: string[] = [];
    const uploadRoute = `**/api/characters/${characterId}/portrait`;
    await owner.route(uploadRoute, async route => {
      if (route.request().method() !== "PUT") return route.continue();
      uploadBodies.push(route.request().postData()!);
      if (uploadBodies.length === 1) {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        // The server committed, but the browser never receives the result.
        await route.abort("failed");
      } else await route.continue();
    });
    await owner
      .getByRole("button", { name: "Upload portrait", exact: true })
      .click();
    await expect(owner.getByRole("button", { name: "Retry exact request" })).toBeEnabled();
    await owner.getByRole("button", { name: "Retry exact request" }).click();
    await expect(
      owner.getByAltText("Explorer wearing a blue cloak", { exact: true }),
    ).toBeVisible();
    expect(uploadBodies).toHaveLength(2);
    expect(uploadBodies[0]).toBe(uploadBodies[1]);
    await owner.unroute(uploadRoute);
    const first = await json(owner, "GET", portraitPath);
    const safeBytes = await owner.evaluate(async path => Array.from(new Uint8Array(await (await fetch(path)).arrayBuffer())), `${portraitPath}/${first.portrait.fileId}`);
    expect((await sharp(Buffer.from(safeBytes)).metadata()).exif).toBeUndefined();
    await expect.poll(() => owner.getByAltText("Explorer wearing a blue cloak", { exact: true }).evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await owner.reload();
    await expect(
      owner.getByAltText("Explorer wearing a blue cloak", { exact: true }),
    ).toBeVisible();
    await owner.getByRole("button", { name: "View larger portrait" }).click();
    await expect(owner.getByRole("dialog")).toBeVisible();
    await owner.getByRole("button", { name: "Close", exact: true }).click();
    expect(
      (await new AxeBuilder({ page: owner }).analyze()).violations,
    ).toEqual([]);
    await owner.screenshot({
      path: info.outputPath("portrait-player-360.png"),
      fullPage: true,
    });
    for (const user of [gm, other]) {
      expect((await request(user, "GET", portraitPath)).status).toBe(404);
      const denied = await user.evaluate(
        async (path) => (await fetch(path)).status,
        `${portraitPath}/${first.portrait.fileId}`,
      );
      expect(denied).toBe(404);
    }
    const campaign = (
      await json(gm, "POST", "/api/campaigns", {
        title: `M1 portrait adventure ${key().slice(0, 8)}`,
        systemVersionId: ch.systemVersionId,
        idempotencyKey: key(),
      })
    ).campaign;
    campaignId = campaign.campaignId;
    const invitation = (
      await json(gm, "POST", `/api/campaigns/${campaignId}/invitations`, {
        intendedRole: "player",
        expectedCampaignRevision: campaign.revision,
        idempotencyKey: key(),
      })
    ).invitation;
    const review = (
      await json(owner, "POST", "/api/invitations/review", {
        token: invitation.token,
      })
    ).review;
    await json(owner, "POST", "/api/invitations/accept", {
      campaignId,
      token: invitation.token,
      expectedInvitationRevision: review.invitationRevision,
      reviewedAccessRevision: review.accessRevision,
      idempotencyKey: key(),
    });
    const currentCampaign = (
      await json(gm, "GET", `/api/campaigns/${campaignId}`)
    ).campaign;
    await json(
      owner,
      "POST",
      `/api/campaigns/${campaignId}/characters/${characterId}/adopt`,
      {
        expectedCampaignRevision: currentCampaign.revision,
        expectedCharacterRevision: ch.revision,
        acknowledgedDisclosure: true,
        idempotencyKey: key(),
      },
    );
    await gm.goto(`/characters/${characterId}`);
    await expect(
      gm.getByAltText("Explorer wearing a blue cloak", { exact: true }),
    ).toBeVisible();
    expect((await request(other, "GET", portraitPath)).status).toBe(404);
    await gm.goto(`/campaigns/${campaignId}`);
    await expect(
      gm.getByAltText(`Portrait of ${ch.name}`, { exact: true }),
    ).toBeVisible();
    // Returning the character preserves the art, but removes the GM's route.
    const ownerIdentity = await json(owner, "GET", "/api/me");
    const campaignBeforeReturn = (
      await json(gm, "GET", `/api/campaigns/${campaignId}`)
    ).campaign;
    await json(
      gm,
      "DELETE",
      `/api/campaigns/${campaignId}/members/${ownerIdentity.userId}`,
      {
        expectedCampaignRevision: campaignBeforeReturn.revision,
        idempotencyKey: key(),
      },
    );
    expect((await request(gm, "GET", portraitPath)).status).toBe(404);
    await owner.goto(`/characters/${characterId}`);
    await expect(
      owner.getByAltText("Explorer wearing a blue cloak", { exact: true }),
    ).toBeVisible();
    await owner
      .getByLabel("Portrait file", { exact: true })
      .setInputFiles({
        name: "replacement.webp",
        mimeType: "image/webp",
        buffer: await sharp(png).webp().toBuffer(),
      });
    await owner
      .getByLabel("Portrait description", { exact: true })
      .fill("Explorer with a grey cloak");
    await owner
      .getByRole("button", { name: "Replace portrait", exact: true })
      .click();
    await expect(
      owner.getByAltText("Explorer with a grey cloak", { exact: true }),
    ).toBeVisible();
    expect(
      await owner.evaluate(
        async (path) => (await fetch(path)).status,
        `${portraitPath}/${first.portrait.fileId}`,
      ),
    ).toBe(404);
    await expect(
      owner.getByText("Available offline", { exact: true }),
    ).toBeVisible({ timeout: 60_000 });
    await ownerContext.setOffline(true);
    await owner.reload();
    await expect(
      owner.getByText("Portrait unavailable offline", { exact: true }),
    ).toBeVisible();
    await owner.getByLabel("Ability Score", { exact: true }).fill("15");
    await owner.getByLabel("Ability Score", { exact: true }).press("Tab");
    await ownerContext.setOffline(false);
    await expect
      .poll(
        async () =>
          (await json(owner, "GET", `/api/characters/${characterId}`)).character
            .state.values.ability,
      )
      .toBe(15);
    await owner.getByRole("button", { name: "Check", exact: true }).click();
    await expect(owner.getByText("Roll result", { exact: true })).toBeVisible();
    await owner
      .getByRole("button", { name: "Remove portrait", exact: true })
      .click();
    await expect(owner.getByText("No portrait", { exact: true })).toBeVisible();
    await owner.goto("/characters");
    expect(
      await owner.locator('img[src*="/portrait/"]').count(),
    ).toBeLessThanOrEqual(20);
  } finally {
    await ownerContext.setOffline(false);
    if (characterId) {
      const ch = (await json(owner, "GET", `/api/characters/${characterId}`))
        .character;
      await json(owner, "PATCH", `/api/characters/${characterId}`, {
        command: "archive",
        expectedRevision: ch.revision,
        idempotencyKey: key(),
      });
    }
    if (campaignId) {
      const c = (await json(gm, "GET", `/api/campaigns/${campaignId}`))
        .campaign;
      await json(gm, "POST", `/api/campaigns/${campaignId}/archive`, {
        expectedCampaignRevision: c.revision,
        idempotencyKey: key(),
      });
    }
    await ownerContext.close();
    await gmContext.close();
    await otherContext.close();
  }
});
