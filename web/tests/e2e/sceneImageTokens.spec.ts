import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const retainedFixture = process.env.SCENE_TOKEN_FIXTURE;
async function json(page: Page, method: string, path: string, data?: unknown) {
  return page.evaluate(async ({ method, path, data }) => {
    const response = await fetch(path, { method, ...(data === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(data) }) });
    if (!response.ok) throw Error(`${method} ${path}: ${response.status}`);
    return response.json();
  }, { method, path, data });
}

test("V1 image tokens: GUI upload/select, relative size, retained art and restricted image access", async ({ browser, baseURL }, info) => {
  test.setTimeout(240_000);
  if (!baseURL) throw Error("Test target required");
  const proxy = process.env.SCENE_TOKEN_HOSTED && process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;
  const gmContext = await browser.newContext({ baseURL, ignoreHTTPSErrors: Boolean(process.env.SCENE_TOKEN_HOSTED), ...(proxy ? {proxy} : {}), viewport: { width: 360, height: 1000 } });
  const displayContext = await browser.newContext({ baseURL, ignoreHTTPSErrors: Boolean(process.env.SCENE_TOKEN_HOSTED), ...(proxy ? {proxy} : {}), viewport: { width: 768, height: 1024 } });
  const gm = await gmContext.newPage(), dp = await displayContext.newPage();
  gm.setDefaultTimeout(15_000); dp.setDefaultTimeout(15_000);
  gm.setDefaultNavigationTimeout(45_000); dp.setDefaultNavigationTimeout(45_000);
  let campaignId: string | undefined, displayId: string | undefined, keep = false;
  const seen: string[] = [];
  dp.on("request", r => { if (r.url().startsWith(baseURL)) seen.push(new URL(r.url()).pathname); });
  try {
    await gm.goto("/");
    await json(gm, "POST", "/dev/signin", { code: "code-journey-gm", redirectUri: new URL("/cb", baseURL).href });
    let sceneId: string;
    if (process.env.SCENE_TOKEN_PHASE === "verify") {
      if (!retainedFixture) throw Error("Fixture path required");
      const prior = JSON.parse(await readFile(retainedFixture, "utf8"));
      campaignId = prior.campaignId; sceneId = prior.sceneId;
      const state = (await json(gm, "GET", `/api/scenes/${sceneId}`)).scene;
      expect(state.tokens).toEqual(prior.tokens);
      await gm.goto(`/campaigns/${campaignId}/scenes?sceneId=${sceneId}`);
    } else {
      campaignId = (await json(gm, "POST", "/api/campaigns", { title: `V1 tokens ${randomUUID().slice(0, 8)}`, systemVersionId: "a0000000-0000-5000-8000-000000000002", idempotencyKey: randomUUID() })).campaign.campaignId;
      await gm.goto(`/campaigns/${campaignId}/scenes`);
      const backgrounds = gm.getByRole("region", { name: "Scene backgrounds", exact: true });
      const png = await sharp({ create: { width: 160, height: 100, channels: 3, background: "#235477" } }).png().toBuffer();
      await backgrounds.getByLabel("Image file", { exact: true }).setInputFiles({ name: "cave.png", mimeType: "image/png", buffer: png });
      await backgrounds.getByLabel("Image description").fill("Cave");
      await backgrounds.getByRole("button", { name: "Upload background", exact: true }).click();
      await backgrounds.getByRole("button", { name: "Create scene", exact: true }).click();
      await expect(gm).toHaveURL(/sceneId=[a-f0-9-]{36}/);
      sceneId = new URL(gm.url()).searchParams.get("sceneId")!;
      const fog = gm.getByRole("region", { name: "Fog of war", exact: true });
      if (!await fog.getByLabel(/x \(0–1\)/i).isVisible()) await fog.getByText("Precise fog position", { exact: true }).click();
      await fog.getByLabel(/fog mode/i).selectOption("reveal");
      await fog.getByLabel(/x \(0–1\)/i).fill("0.25"); await fog.getByLabel(/y \(0–1\)/i).fill("0.5"); await fog.getByLabel(/radius/i).fill("0.2");
      await fog.getByRole("button", { name: "Add fog dab" }).click(); await fog.getByRole("button", { name: "Commit fog edit" }).click();
      await expect(fog.getByText("Fog edit committed.")).toBeVisible();
      const tray = gm.getByRole("region", { name: "Tokens", exact: true });
      await tray.getByText("Token artwork", { exact: true }).click();
      const art = tray.getByRole("region", { name: "Token images", exact: true });
      const portrait = await sharp({ create: { width: 60, height: 100, channels: 3, background: "#e53753" } }).png().toBuffer();
      await art.getByLabel("Token image file").setInputFiles({ name: "wren.png", mimeType: "image/png", buffer: portrait });
      await art.getByLabel("Image description").fill("Wren art");
      await art.getByRole("button", { name: "Upload token image" }).click();
      await expect(tray.getByText("Campaign image selected for this token.")).toBeVisible();
      await tray.getByText("Position and size", { exact: true }).click();
      for (const [label, x, visible] of [["Wren", ".25", true], ["Secret", ".25", false], ["Fogged", ".85", true]] as const) {
        await tray.getByLabel("Token label").fill(label); await tray.getByLabel(/^x \(0–1\)/i).fill(x); await tray.getByLabel(/^y \(0–1\)/i).fill(".5");
        await tray.getByLabel(/size \(fraction/i).fill(".12"); await tray.getByLabel(/visible to the display/i).setChecked(visible);
        const response = gm.waitForResponse(r => r.url().endsWith(`/scenes/${sceneId}/tokens`) && r.request().method() === "POST");
        await tray.getByRole("button", { name: "Place token", exact: true }).click(); expect((await response).ok()).toBe(true);
        await expect(gm.getByRole("button", { name: `Token ${label}`, exact: true })).toBeVisible();
      }
      await tray.getByRole("button", { name: "Use label only", exact: true }).click();
      await tray.getByLabel("Token label").fill("Label marker"); await tray.getByLabel(/^x \(0–1\)/i).fill(".4");
      const response = gm.waitForResponse(r => r.url().endsWith(`/scenes/${sceneId}/tokens`) && r.request().method() === "POST");
      await tray.getByRole("button", { name: "Place token", exact: true }).click(); expect((await response).ok()).toBe(true);
      await gm.reload();
    }
    const viewport = gm.getByRole("region", { name: "Scene", exact: true });
    await expect(viewport.getByRole("button", { name: "Token Wren", exact: true }).locator("img")).toBeVisible();
    const state = (await json(gm, "GET", `/api/scenes/${sceneId}`)).scene;
    expect(state.tokens.find((t: any) => t.label === "Wren")).toMatchObject({ x: .25, y: .5, size: .12, imageFileId: expect.any(String) });
    const imageFileId = state.tokens.find((t: any) => t.label === "Wren").imageFileId;
    const artBytes = await gm.evaluate(async path => Array.from(new Uint8Array(await (await fetch(path)).arrayBuffer())), `/api/campaigns/${campaignId}/images/${imageFileId}/original`);
    const artChecksum = createHash("sha256").update(Buffer.from(artBytes)).digest("hex");
    if (process.env.SCENE_TOKEN_PHASE === "verify" && retainedFixture) expect(artChecksum).toBe(JSON.parse(await readFile(retainedFixture, "utf8")).artChecksum);
    const images = (await json(gm, "GET", `/api/campaigns/${campaignId}/images`)).images;
    const artFile = images.find((f: any) => f.fileId === imageFileId);
    const deniedDelete = await gm.evaluate(async ({ campaignId, artFile }) => (await fetch(`/api/campaigns/${campaignId}/images/${artFile.fileId}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: artFile.revision, idempotencyKey: crypto.randomUUID() }) })).status, { campaignId, artFile });
    expect(deniedDelete).toBe(409);
    // Explicit existing-art selection cannot replace the background or reset the tokens.
    const tray = gm.getByRole("region", { name: "Tokens", exact: true });
    await tray.getByText("Token artwork", { exact: true }).click();
    const artRow = tray.locator("li").filter({ has: gm.getByRole("img", { name: "Wren art", exact: true }) });
    await artRow.getByRole("button", { name: "Select token image" }).click();
    expect((await json(gm, "GET", `/api/scenes/${sceneId}`)).scene).toEqual(state);
    await gm.goto(`/campaigns/${campaignId}`); await gm.getByRole("tab", { name: "Settings", exact: true }).click();
    await gm.getByRole("button", { name: "Pair display", exact: true }).click();
    const dialog = gm.getByRole("dialog"), code = (await dialog.locator("strong").last().textContent())!.trim();
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await dp.goto(`/display?sceneId=${sceneId}`); await dp.getByLabel(/display code/i).fill(code); await dp.getByRole("button", { name: "Connect display", exact: true }).click();
    await expect.poll(() => dp.evaluate(() => Boolean(sessionStorage.getItem("sweetroll:display-credential")))).toBe(true);
    displayId = await dp.evaluate(() => JSON.parse(sessionStorage.getItem("sweetroll:display-credential")!).displayId);
    await expect(dp.getByRole("img", { name: "Display image", exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(dp.getByText("Wren", {exact:true}).locator("..").locator("img")).toBeVisible({ timeout: 20_000 });
    await expect(dp.getByText("Secret", { exact: true })).toHaveCount(0); await expect(dp.getByText("Fogged", { exact: true })).toHaveCount(0);
    await expect(dp.getByText("Label marker", { exact: true })).toBeVisible();
    displayId = await dp.evaluate(() => JSON.parse(sessionStorage.getItem("sweetroll:display-credential")!).displayId);
    for (const token of state.tokens.filter((t: any) => ["Secret", "Fogged"].includes(t.label))) {
      const status = await dp.evaluate(async ({ sceneId, tokenId, revision }) => { const c = JSON.parse(sessionStorage.getItem("sweetroll:display-credential")!); return (await fetch(`/api/displays/${c.displayId}/scenes/${sceneId}/tokens/${tokenId}/image?rev=${revision}`, { credentials: "omit", headers: { "x-display-secret": c.secret } })).status; }, { sceneId, tokenId: token.tokenId, revision: state.revision });
      expect(status).toBe(404);
    }
    expect(seen.filter(path => /^\/api\/(campaigns|characters|systems|scenes)\//.test(path))).toEqual([]);
    const deniedOriginal = await dp.evaluate(async path => { const c = JSON.parse(sessionStorage.getItem("sweetroll:display-credential")!); return (await fetch(path, {credentials:"omit",headers:{"x-display-secret":c.secret}})).status; }, `/api/campaigns/${campaignId}/images/${imageFileId}/original`);
    expect(deniedOriginal).toBe(401);
    await gm.goto(`/campaigns/${campaignId}/scenes?sceneId=${sceneId}`);
    for (const width of [360, 768, 1280]) {
      await gm.setViewportSize({ width, height: 1000 }); await displayContext.pages()[0]!.setViewportSize({ width, height: 1000 });
      for (const [page, role] of [[gm, "Scene background"], [dp, "Display image"]] as const) {
        const backgroundImage = page.getByRole("img", { name: role, exact: true });
        await expect(backgroundImage).toBeVisible({ timeout: 20_000 });
        await backgroundImage.evaluate(image => (image as HTMLImageElement).decode());
        const background = await backgroundImage.boundingBox();
        const art = await (page === gm ? page.getByRole("button", { name: "Token Wren", exact: true }).locator("img") : page.getByText("Wren", {exact:true}).locator("..").locator("img")).boundingBox();
        expect(art!.width / background!.width).toBeCloseTo(.12, 2);
        expect((art!.x + art!.width / 2 - background!.x) / background!.width).toBeCloseTo(.25, 2);
        expect((art!.y + art!.height / 2 - background!.y) / background!.height).toBeCloseTo(.5, 2);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      }
      await gm.screenshot({ path: info.outputPath(`gm-tokens-${width}.png`), fullPage: true }); await dp.screenshot({ path: info.outputPath(`display-tokens-${width}.png`), fullPage: true });
    }
    expect((await new AxeBuilder({ page: gm }).analyze()).violations).toEqual([]);
    await displayContext.setOffline(true); await expect(dp.locator("img")).toHaveCount(0); await displayContext.setOffline(false);
    await expect(dp.getByRole("img", { name: "Display image", exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(dp.getByText("Wren", {exact:true}).locator("..").locator("img")).toBeVisible({ timeout: 20_000 });
    await json(gm, "POST", `/api/campaigns/${campaignId}/displays/${displayId}/revoke`, {}); displayId = undefined;
    await expect(dp.locator("img")).toHaveCount(0, { timeout: 20_000 });
    if (retainedFixture && process.env.SCENE_TOKEN_PHASE !== "verify") { await writeFile(retainedFixture, JSON.stringify({ campaignId, sceneId, tokens: state.tokens, artChecksum })); keep = true; }
  } finally {
    if (displayId && campaignId) await json(gm, "POST", `/api/campaigns/${campaignId}/displays/${displayId}/revoke`, {});
    if (campaignId && !keep) { const c = (await json(gm, "GET", `/api/campaigns/${campaignId}`)).campaign; await json(gm, "POST", `/api/campaigns/${campaignId}/archive`, { expectedCampaignRevision: c.revision, idempotencyKey: randomUUID() }); }
    await gmContext.close(); await displayContext.close();
  }
});
