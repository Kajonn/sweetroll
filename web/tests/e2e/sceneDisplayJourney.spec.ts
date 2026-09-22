import { randomUUID } from "node:crypto";

import { test, expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";

import { publishOwnedClone, uid } from "../offline/test-auth.js";

/**
 * I7b Task 8 exit demonstration (dev-server E2E): GM composes a scene
 * (fog conceal-then-reveal, one visible + one hidden token) and pairs a
 * restricted display; the display shows only the revealed region + the
 * visible token, follows token moves + scene changes on poll, and blanks
 * on revocation — with no original bytes, hidden tokens, or GM endpoints
 * ever reaching the display context.
 *
 * Needs a live backend per web/playwright.config.ts (migrate + dev:http and
 * web:dev, with DATABASE_URL pointing at Postgres). No scene/image DELETE
 * endpoints exist, so campaign/scene names carry a per-run stamp. Scene
 * seeding (campaign, image upload, scene rows) goes through real HTTP as
 * the GM actor (code-test-a in an isolated context): this slice ships no
 * scene-create or image-upload UI, only the viewport + fog toolbar + token
 * tray + display pairing. Fog edits, token placement, pairing, and
 * revocation run through the real GM UI; the display side runs entirely
 * through /display in a second, never-signed-in context navigated with an
 * explicit ?sceneId= (no picker UI exists in this slice — the empty state
 * otherwise).
 */

const D20_VERSION_ID = "a0000000-0000-5000-8000-000000000002";
const STEP_TIMEOUT = 15_000;
// The display polls every 5s; follow/blank assertions allow several polls.
const POLL_TIMEOUT = 60_000;

// 1x1 transparent PNG fixture (same bytes as the backend integration tests).
const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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

async function postJson(request: APIRequestContext, path: string, data: unknown, expected = [200, 201]) {
  const response = await request.post(path, { data });
  if (!expected.includes(response.status())) {
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

async function patchJson(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.patch(path, { data });
  if (response.status() !== 200) {
    throw new Error(`PATCH ${path} failed: ${response.status()} ${await response.text()}`);
  }
  return (await response.json()) as Record<string, any>;
}

async function signInViaPanel(page: Page, code: string) {
  await page.goto("/");
  await page.getByTestId("dev-signin-code").fill(code);
  await page.getByTestId("dev-signin").click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: STEP_TIMEOUT });
}

/** Commit one fog stroke (mode + single dab), retrying once on 409. */
async function commitFogStroke(page: Page, mode: "Conceal" | "Reveal", x: string, y: string, r: string) {
  const fog = page.getByRole("region", { name: "Fog of war" });
  await fog.getByLabel(/fog mode/i).selectOption(mode === "Conceal" ? "conceal" : "reveal");
  await fog.getByLabel(/x \(0–1\)/i).fill(x);
  await fog.getByLabel(/y \(0–1\)/i).fill(y);
  await fog.getByLabel(/radius \(0–1\)/i).fill(r);
  await fog.getByRole("button", { name: "Add fog dab" }).click();
  await fog.getByRole("button", { name: "Commit fog edit" }).click();
  const committed = fog.getByText("Fog edit committed.");
  const conflict = fog.getByText(/latest version was reloaded/);
  await expect(committed.or(conflict)).toBeVisible({ timeout: STEP_TIMEOUT });
  if (await conflict.isVisible()) {
    await fog.getByRole("button", { name: "Retry fog edit" }).click();
    await expect(committed).toBeVisible({ timeout: STEP_TIMEOUT });
  }
}

/** Place one token through the tray, retrying once on 409. */
async function placeToken(page: Page, label: string, x: string, y: string, visible: boolean) {
  const tray = page.getByRole("region", { name: "Tokens" });
  await tray.getByLabel(/token label/i).fill(label);
  await tray.getByLabel(/x \(0–1\)/i).fill(x);
  await tray.getByLabel(/y \(0–1\)/i).fill(y);
  const box = tray.getByLabel(/visible to the display/i);
  if ((await box.isChecked()) !== visible) {
    await box.click();
  }
  await tray.getByRole("button", { name: "Place token", exact: true }).click();
  const placed = tray.getByText("Token placed.");
  const conflict = tray.getByText(/latest version was reloaded/);
  await expect(placed.or(conflict)).toBeVisible({ timeout: STEP_TIMEOUT });
  if (await conflict.isVisible()) {
    await tray.getByRole("button", { name: "Retry placing token" }).click();
    await expect(placed).toBeVisible({ timeout: STEP_TIMEOUT });
  }
}

test("I7b exit: restricted scene display shows only revealed areas and visible tokens, follows, then blanks", async ({
  page,
  browser,
}: {
  page: Page;
  browser: Browser;
}) => {
  test.setTimeout(120_000);
  const stamp = uid();
  const campaignTitle = `I7b Scene Campaign ${stamp}`;

  // 1. GM seeding (isolated context as code-test-a): owned d20 clone, then
  // the campaign, one uploaded background, and the first scene. No
  // scene-create/upload UI exists in this slice, so these rows go through
  // real HTTP; everything composable in the UI (fog, tokens, pairing,
  // revoke) runs through the UI below.
  await page.goto("/");
  const origin = new URL(page.url()).origin;
  const gmContext = await browser.newContext({ baseURL: origin });
  let campaignId = "";
  let sceneId = "";
  let backgroundFileId = "";
  try {
    const gmUserId = await signInAs(gmContext.request, "code-test-a");
    expect(gmUserId).toMatch(/.+/);
    const ownedVersionId = await publishOwnedClone(gmContext.request, D20_VERSION_ID);

    const created = await postJson(gmContext.request, "/api/campaigns", {
      systemVersionId: ownedVersionId,
      title: campaignTitle,
      description: `I7b exit fixture ${stamp}`,
      idempotencyKey: randomUUID(),
    });
    campaignId = created.campaign.campaignId as string;
    expect(campaignId).toMatch(/[0-9a-f-]{36}/);

    const uploaded = await postJson(gmContext.request, `/api/campaigns/${campaignId}/images`, {
      name: `I7b backdrop ${stamp}`,
      contentType: "image/png",
      dataBase64: ONE_BY_ONE_PNG_BASE64,
      idempotencyKey: randomUUID(),
    });
    backgroundFileId = uploaded.image.fileId as string;
    expect(backgroundFileId).toMatch(/.+/);

    const scene = await postJson(gmContext.request, `/api/campaigns/${campaignId}/scenes`, {
      backgroundFileId,
      idempotencyKey: randomUUID(),
    });
    sceneId = scene.scene.sceneId as string;
    expect(sceneId).toMatch(/[0-9a-f-]{36}/);

    // 2. GM scene UI as code-test-a: conceal one region, then reveal a
    // region covering the visible token's home (0.25,0.5) and move target
    // (0.55,0.5) — scenes start fully fogged, so only revealed points ever
    // reach the display. Fresh loads between mutations keep the revision
    // guard fed without guessing.
    await signInViaPanel(page, "code-test-a");
    const sceneUrl = `/campaigns/${campaignId}/scenes?sceneId=${encodeURIComponent(sceneId)}`;
    await page.goto(sceneUrl);
    await expect(page.getByRole("img", { name: "Scene background" })).toBeVisible({ timeout: STEP_TIMEOUT });

    await commitFogStroke(page, "Conceal", "0.7", "0.7", "0.15");
    await page.reload();
    await expect(page.getByRole("img", { name: "Scene background" })).toBeVisible({ timeout: STEP_TIMEOUT });
    await commitFogStroke(page, "Reveal", "0.3", "0.5", "0.35");
    await page.reload();
    await expect(page.getByRole("img", { name: "Scene background" })).toBeVisible({ timeout: STEP_TIMEOUT });

    await placeToken(page, "Alpha", "0.25", "0.5", true);
    await page.reload();
    await expect(page.getByRole("img", { name: "Scene background" })).toBeVisible({ timeout: STEP_TIMEOUT });
    await placeToken(page, "Ghost", "0.75", "0.25", false);

    // 3. GM pairs a display through Campaign settings (Settings tab): the
    // code dialog shows the single-use code once; Dismiss closes it.
    await page.goto(`/campaigns/${campaignId}`);
    await expect(page.getByRole("heading", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });
    await page.getByRole("tab", { name: "Settings" }).click({ timeout: STEP_TIMEOUT });
    await page.getByRole("button", { name: "Pair display", exact: true }).click({ timeout: STEP_TIMEOUT });
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Share this display code now")).toBeVisible({ timeout: STEP_TIMEOUT });
    const pairCode = ((await dialog.locator("strong").last().textContent()) ?? "").trim();
    expect(pairCode).toMatch(/^[A-Z0-9]{6}$/);
    await dialog.getByRole("button", { name: "Done" }).click({ timeout: STEP_TIMEOUT });

    // 4. Display side in a second, never-signed-in context with an explicit
    // ?sceneId=: redeem the code, assert the display shows the revealed
    // region + the visible token only.
    const displayContext = await browser.newContext({ baseURL: origin });
    const seenRequests: string[] = [];
    const seenResponses: { url: string; status: number }[] = [];
    const projectionTextReads: Promise<string>[] = [];
    try {
      const displayPage = await displayContext.newPage();
      displayPage.on("request", (request) => {
        if (request.url().startsWith(origin)) seenRequests.push(request.url());
      });
      displayPage.on("response", (response) => {
        if (!response.url().startsWith(origin)) return;
        seenResponses.push({ url: response.url(), status: response.status() });
        if (response.url().includes("/projection")) {
          projectionTextReads.push(response.text());
        }
      });

      await displayPage.goto(`/display?sceneId=${encodeURIComponent(sceneId)}`);
      // No GM shell on the restricted route: no app header anywhere.
      await expect(displayPage.getByRole("heading", { name: "Connect this display" })).toBeVisible({
        timeout: STEP_TIMEOUT,
      });
      expect(await displayPage.getByTestId("app-header").count()).toBe(0);
      await displayPage.getByLabel(/display code/i).fill(pairCode);
      await displayPage.getByRole("button", { name: "Connect display" }).click({ timeout: STEP_TIMEOUT });

      const displayImage = displayPage.getByRole("img", { name: "Display image" });
      await expect(displayImage).toBeVisible({ timeout: STEP_TIMEOUT });
      const displayTokens = displayPage.getByRole("list", { name: "Display tokens" });
      await expect(displayTokens.getByText("Alpha")).toBeVisible({ timeout: STEP_TIMEOUT });
      await expect(displayTokens.getByText("Alpha")).toHaveAttribute("style", /left:\s*25%/);
      await expect(displayPage.getByText("Ghost")).toHaveCount(0);

      // 5. Isolation: no GM endpoints, no original bytes, no hidden token,
      // no GM data in storage, no cached entries.
      const gmPaths = ["/api/campaigns", "/api/scenes/", "/api/content", "/api/characters", "/api/invitations", "/api/systems"];
      for (const path of gmPaths) {
        expect(seenRequests.filter((url) => url.includes(path)), `display fetched GM path ${path}`).toEqual([]);
      }
      // Await the settled response texts before asserting: the handler
      // above only queues the reads, so asserting on the array directly
      // would race the body promises.
      const projectionBodies = await Promise.all(projectionTextReads);
      expect(projectionBodies.length).toBeGreaterThan(0);
      for (const body of projectionBodies) {
        expect(body).not.toContain("Ghost");
        expect(body).not.toContain("storage_key");
        expect(body).not.toContain(ONE_BY_ONE_PNG_BASE64);
      }
      // Deep link: the GM original is unreachable from the display context
      // (no GM session, display credentials buy nothing there — the
      // credential-authed exemption covers /displays/ routes only, so an
      // anonymous display reads 401 with no bytes either way).
      const original = await displayContext.request.get(`/api/campaigns/${campaignId}/images/${backgroundFileId}/original`);
      expect(original.status()).toBe(401);
      expect(original.headers()["content-type"] ?? "").not.toContain("image/");
      const storage = (await displayPage.evaluate(() => ({
        localKeys: Object.keys(window.localStorage),
        sessionKeys: Object.keys(window.sessionStorage),
        sessionCredential: window.sessionStorage.getItem("sweetroll:display-credential"),
        caches: (window as unknown as { caches?: { keys(): Promise<string[]> } }).caches === undefined ? [] : null,
      }))) as { localKeys: string[]; sessionKeys: string[]; sessionCredential: string | null; caches: unknown };
      expect(storage.localKeys).toEqual([]);
      expect(storage.sessionKeys).toEqual(["sweetroll:display-credential"]);
      expect(storage.sessionCredential ?? "").toContain("displayId");
      expect(storage.sessionCredential ?? "").not.toContain(campaignTitle);
      const cacheKeys: string[] = await displayPage.evaluate(() =>
        (window as unknown as { caches: { keys(): Promise<string[]> } }).caches.keys(),
      );
      expect(cacheKeys).toEqual([]);

      // 6. The display follows a token move on poll (explicit position
      // change 25% -> 55% left; the target stays inside the revealed
      // region so the token remains visible).
      const sceneBefore = await getJson(gmContext.request, `/api/scenes/${sceneId}`);
      const alphaId = (sceneBefore.scene.tokens as { tokenId: string; label: string }[]).find(
        (token) => token.label === "Alpha",
      )?.tokenId;
      expect(alphaId).toMatch(/[0-9a-f-]{36}/);
      await patchJson(gmContext.request, `/api/scenes/${sceneId}/tokens/${alphaId}`, {
        expectedSceneRevision: sceneBefore.scene.revision as number,
        x: 0.55,
        y: 0.5,
        idempotencyKey: randomUUID(),
      });
      await expect(displayTokens.getByText("Alpha")).toHaveAttribute("style", /left:\s*55%/, { timeout: POLL_TIMEOUT });

      // 7. The display follows a scene change: a second scene renders with
      // no stale tokens once navigated to with its own ?sceneId=.
      const uploadedB = await postJson(gmContext.request, `/api/campaigns/${campaignId}/images`, {
        name: `I7b backdrop B ${stamp}`,
        contentType: "image/png",
        dataBase64: ONE_BY_ONE_PNG_BASE64,
        idempotencyKey: randomUUID(),
      });
      const sceneB = await postJson(gmContext.request, `/api/campaigns/${campaignId}/scenes`, {
        backgroundFileId: uploadedB.image.fileId as string,
        idempotencyKey: randomUUID(),
      });
      const sceneIdB = sceneB.scene.sceneId as string;
      await displayPage.goto(`/display?sceneId=${encodeURIComponent(sceneIdB)}`);
      await expect(displayPage.getByRole("img", { name: "Display image" })).toBeVisible({ timeout: STEP_TIMEOUT });
      await expect(displayPage.getByText("Alpha")).toHaveCount(0);
      const imageSrcB = (await displayPage.getByRole("img", { name: "Display image" }).getAttribute("src")) ?? "";
      expect(imageSrcB).toContain(sceneIdB);

      // Back on scene A the moved token is where the poll left it.
      await displayPage.goto(`/display?sceneId=${encodeURIComponent(sceneId)}`);
      await expect(displayTokens.getByText("Alpha")).toHaveAttribute("style", /left:\s*55%/, { timeout: STEP_TIMEOUT });

      // 8. GM revokes the credential through the settings UI; the display
      // blanks on poll (no frozen frame) with a disconnect affordance.
      await page.goto(`/campaigns/${campaignId}`);
      await expect(page.getByRole("heading", { name: campaignTitle })).toBeVisible({ timeout: STEP_TIMEOUT });
      await page.getByRole("tab", { name: "Settings" }).click({ timeout: STEP_TIMEOUT });
      await page.getByRole("button", { name: "Revoke", exact: true }).click({ timeout: STEP_TIMEOUT });
      await expect(page.getByText("Display revoked.")).toBeVisible({ timeout: STEP_TIMEOUT });

      await expect(displayPage.getByText("This display is unavailable.")).toBeVisible({ timeout: POLL_TIMEOUT });
      await expect(displayPage.getByRole("img", { name: "Display image" })).toHaveCount(0);
      await expect(displayPage.getByRole("button", { name: "Enter a different code" })).toBeVisible({
        timeout: STEP_TIMEOUT,
      });
    } finally {
      await displayContext.close();
    }
  } finally {
    await gmContext.close();
  }
});
