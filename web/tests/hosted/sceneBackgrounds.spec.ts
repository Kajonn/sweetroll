import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
const key = () => randomUUID();
const fixture = process.env.SCENE_BACKGROUND_FIXTURE ?? "/workspace/scratch/pr30-evidence/scene-background-fixture.json";
async function request(page: Page, method: string, path: string, data?: unknown) {
  return page.evaluate(async ({ method, path, data }) => { const r = await fetch(path, { method, cache: "no-store", ...(data === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(data) }) }); return { status: r.status, body: (r.headers.get("content-type") ?? "").includes("json") ? await r.json() : null }; }, { method, path, data });
}
async function json(page: Page, method: string, path: string, data?: unknown) { const r = await request(page, method, path, data); expect(r.status, `${method} ${path}: ${r.body?.error?.message ?? ""}`).toBeGreaterThanOrEqual(200); expect(r.status, `${method} ${path}: ${r.body?.error?.message ?? ""}`).toBeLessThan(300); return r.body; }
async function fog(page: Page) {
  const panel = page.getByRole("region", { name: "Fog of war", exact: true });
  await panel.getByLabel(/fog mode/i).selectOption("reveal");
  for (const [label, value] of [[/x \(0–1\)/i, "0.25"], [/y \(0–1\)/i, "0.5"], [/radius \(0–1\)/i, "0.2"]] as const) await panel.getByLabel(label).fill(value);
  await panel.getByRole("button", { name: "Add fog dab", exact: true }).click(); await panel.getByRole("button", { name: "Commit fog edit", exact: true }).click(); await expect(panel.getByText("Fog edit committed.")).toBeVisible();
}
async function pixels(page: Page) {
  const img = page.getByRole("img", { name: "Display image", exact: true }); await expect(img).toBeVisible({ timeout: 20_000 });
  const src = await img.getAttribute("src"); const bytes = await page.evaluate(async url => Array.from(new Uint8Array(await (await fetch(url!)).arrayBuffer())), src);
  const raw = await sharp(Buffer.from(bytes)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixel = (x: number, y: number) => Array.from(raw.data.subarray((y * raw.info.width + x) * 4, (y * raw.info.width + x) * 4 + 4));
  return { revealed: pixel(16, 32), concealed: pixel(60, 32) };
}
test("M3 GUI background upload, confirmed safe replacement and restricted display durability", async ({ browser, baseURL }, info) => {
  test.setTimeout(360_000); if (!baseURL) throw Error("Hosted URL required");
  const contextOptions = { baseURL, ignoreHTTPSErrors: true, ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY } } : {}) };
  const gmContext = await browser.newContext({ ...contextOptions, viewport: { width: 360, height: 1000 } }), displayContext = await browser.newContext({ ...contextOptions, viewport: { width: 768, height: 1024 } });
  const gm = await gmContext.newPage(), dp = await displayContext.newPage(); let campaignId: string | undefined, displayId: string | undefined, saved = false;
  async function pair(sceneId: string) {
    const code = (await json(gm, "POST", `/api/campaigns/${campaignId}/display-codes`, {})).code;
    await dp.goto(`/display?sceneId=${sceneId}`); await dp.getByLabel(/display code/i).fill(code); await dp.getByRole("button", { name: "Connect display", exact: true }).click();
    await expect(dp.getByRole("img", { name: "Display image", exact: true })).toBeVisible({ timeout: 20_000 });
    displayId = await dp.evaluate(() => JSON.parse(sessionStorage.getItem("sweetroll:display-credential")!).displayId);
  }
  try {
    await gm.goto("/"); await json(gm, "POST", "/dev/signin", { code: "code-journey-gm", redirectUri: new URL("/cb", gm.url()).href });
    if (process.env.SCENE_BACKGROUND_PHASE === "verify") {
      const prior = JSON.parse(await readFile(fixture, "utf8")); campaignId = prior.campaignId;
      const bytes = await gm.evaluate(async path => Array.from(new Uint8Array(await (await fetch(path)).arrayBuffer())), `/api/campaigns/${campaignId}/images/${prior.fileId}/original`);
      expect(createHash("sha256").update(Buffer.from(bytes)).digest("hex")).toBe(prior.checksum);
      const state = (await json(gm, "GET", `/api/scenes/${prior.sceneId}`)).scene; expect(state.backgroundFileId).toBe(prior.fileId); expect(state.tokens).toEqual([]);
      await pair(prior.sceneId); expect(await pixels(dp)).toEqual({ revealed: [35, 84, 119, 255], concealed: [0, 0, 0, 255] });
      await info.attach("post-redeploy-background", { body: JSON.stringify({ campaignId, sceneId: prior.sceneId, checksum: prior.checksum, pixels: await pixels(dp) }), contentType: "application/json" });
      return;
    }
    campaignId = (await json(gm, "POST", "/api/campaigns", { title: `M3 background ${key().slice(0, 8)}`, systemVersionId: "a0000000-0000-5000-8000-000000000002", idempotencyKey: key() })).campaign.campaignId;
    await gm.goto(`/campaigns/${campaignId}`); await gm.getByRole("button", { name: "Scene", exact: true }).click();
    const upload = async (name: string, color: string) => {
      const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: color } }).png().withMetadata({ exif: { IFD0: { Artist: "Private scene fixture" } } }).toBuffer();
      await gm.getByLabel("Image file", { exact: true }).setInputFiles({ name: `${name}.png`, mimeType: "image/png", buffer: png });
      await gm.getByLabel("Image description", { exact: true }).fill(name); await gm.getByRole("button", { name: "Upload background", exact: true }).click();
      await expect(gm.getByRole("img", { name, exact: true })).toBeVisible();
    };
    await upload("Cave", "#e53753");
    const row = (name: string) => gm.locator("li").filter({ has: gm.getByRole("img", { name, exact: true }) });
    await row("Cave").getByRole("button", { name: "Create scene", exact: true }).click(); await expect(gm).toHaveURL(/sceneId=[0-9a-f-]{36}(?:&|$)/);
    const sceneId = new URL(gm.url()).searchParams.get("sceneId")!; await expect(gm.getByRole("img", { name: "Scene background", exact: true })).toBeVisible();
    await fog(gm);
    for (const [label, visible] of [["Visible explorer", true], ["Hidden GM marker", false]] as const) {
      const tray = gm.getByRole("region", { name: "Tokens", exact: true }); await tray.getByLabel(/token label/i).fill(label); await tray.getByLabel(/x \(0–1\)/i).fill("0.25"); await tray.getByLabel(/y \(0–1\)/i).fill("0.5"); await tray.getByLabel(/visible to the display/i).setChecked(visible); await tray.getByRole("button", { name: "Place token", exact: true }).click(); await expect(gm.getByText("Token placed.")).toBeVisible();
      await gm.reload(); await expect(gm.getByRole("img", { name: "Scene background", exact: true })).toBeVisible();
    }
    const seen: string[] = []; dp.on("request", r => { if (r.url().startsWith(baseURL)) seen.push(new URL(r.url()).pathname); });
    await pair(sceneId); await expect(dp.getByText("Visible explorer", { exact: true })).toBeVisible(); expect(await pixels(dp)).toEqual({ revealed: [229, 55, 83, 255], concealed: [0, 0, 0, 255] }); expect(seen.filter(path => /^\/api\/(campaigns|characters|systems|scenes)/.test(path))).toEqual([]);
    await upload("Forest", "#235477");
    const before = (await json(gm, "GET", `/api/scenes/${sceneId}`)).scene;
    const toolbar = gm.getByRole("region", { name: "Fog of war", exact: true }); await toolbar.getByRole("button", { name: "Add fog dab", exact: true }).click();
    await row("Forest").getByRole("button", { name: "Use as background", exact: true }).click(); await expect(gm.getByRole("dialog")).toContainText("conceals the whole image and removes all tokens");
    await json(gm, "POST", `/api/scenes/${sceneId}/fog-edits`, { expectedSceneRevision: before.revision, op: { mode: "reveal", runs: [{ x: .1, y: .1, r: .01 }] }, idempotencyKey: key() });
    await gm.getByRole("button", { name: "Replace and conceal", exact: true }).click(); await expect(gm.getByRole("button", { name: "Refresh scene", exact: true })).toBeVisible();
    const conflicted = (await json(gm, "GET", `/api/scenes/${sceneId}`)).scene; expect(conflicted.backgroundFileId).toBe(before.backgroundFileId); expect(conflicted.tokens).toEqual(before.tokens); expect(conflicted.fog).toHaveLength(before.fog.length + 1);
    await gm.getByRole("button", { name: "Refresh scene", exact: true }).click(); await expect(gm.getByRole("dialog")).not.toBeVisible();
    await row("Forest").getByRole("button", { name: "Use as background", exact: true }).click();
    const bodies: string[] = []; let committed = 0;
    await gm.route(`**/api/scenes/${sceneId}`, async route => { if (route.request().method() !== "PATCH") return route.continue(); bodies.push(route.request().postData()!); if (bodies.length === 1) { try { committed = (await route.fetch({ timeout: 30_000 })).status(); } catch { committed = -1; } await route.abort("failed").catch(() => {}); } else await route.continue(); });
    await gm.getByRole("button", { name: "Replace and conceal", exact: true }).click(); await expect(gm.getByRole("button", { name: "Retry exact request", exact: true })).toBeEnabled({ timeout: 60_000 }); expect(committed).toBe(200);
    await gm.getByRole("button", { name: "Retry exact request", exact: true }).click(); await expect(gm.getByRole("dialog")).not.toBeVisible(); expect(bodies).toHaveLength(2); expect(bodies[0]).toBe(bodies[1]); await gm.unrouteAll({ behavior: "ignoreErrors" });
    await expect(toolbar.getByRole("button", { name: "Commit fog edit", exact: true })).toBeDisabled();
    const concealed = (await json(gm, "GET", `/api/scenes/${sceneId}`)).scene; expect(concealed.fog).toEqual([]); expect(concealed.tokens).toEqual([]);
    await expect(dp.getByText("Visible explorer", { exact: true })).toHaveCount(0, { timeout: 20_000 }); await expect.poll(async () => (await pixels(dp)).revealed).toEqual([0, 0, 0, 255]);
    expect(await pixels(dp)).toEqual({ revealed: [0, 0, 0, 255], concealed: [0, 0, 0, 255] });
    const forest = (await json(gm, "GET", `/api/campaigns/${campaignId}/images`)).images.find((image: any) => image.name === "Forest");
    expect((await request(gm, "DELETE", `/api/campaigns/${campaignId}/images/${forest.fileId}`, { expectedRevision: forest.revision, idempotencyKey: key() })).status).toBe(409);
    await row("Cave").getByRole("button", { name: "Delete image", exact: true }).click(); await gm.getByRole("dialog").getByRole("button", { name: "Delete image", exact: true }).click(); await expect(gm.getByRole("dialog")).not.toBeVisible(); await expect(gm.getByRole("img", { name: "Cave", exact: true })).toHaveCount(0);
    await fog(gm); await expect.poll(async () => (await pixels(dp)).revealed).toEqual([35, 84, 119, 255]); expect((await pixels(dp)).concealed).toEqual([0, 0, 0, 255]);
    for (const path of [`/api/campaigns/${campaignId}/images/${forest.fileId}/original`, `/api/campaigns/${campaignId}/images/${forest.fileId}/thumbnail`, `/api/characters/${key()}/portrait`, `/api/campaigns/${campaignId}/item-templates/${key()}/image`]) {
      const denied = await dp.evaluate(async path => { const credential = JSON.parse(sessionStorage.getItem("sweetroll:display-credential")!); return (await fetch(path, { credentials: "omit", headers: { "x-display-secret": credential.secret } })).status; }, path); expect(denied).toBe(401);
    }
    expect((await new AxeBuilder({ page: gm }).analyze()).violations).toEqual([]);
    const layout = await gm.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth, scrollX, active: document.activeElement?.outerHTML.slice(0, 300), overflowing: Array.from(document.querySelectorAll<HTMLElement>("body *")).map(el => ({ tag: el.tagName, className: el.className, right: el.getBoundingClientRect().right + scrollX, width: el.getBoundingClientRect().width })).filter(el => el.right > innerWidth) }));
    await gm.screenshot({ path: info.outputPath("scene-layout-360.png"), fullPage: true });
    expect(layout.width, JSON.stringify(layout)).toBeLessThanOrEqual(layout.viewport + 1);
    await gm.screenshot({ path: info.outputPath("scene-gm-360.png"), fullPage: true }); await dp.screenshot({ path: info.outputPath("scene-display-768.png"), fullPage: true });
    await displayContext.setOffline(true); await expect(dp.getByRole("img", { name: "Display image", exact: true })).toHaveCount(0, { timeout: 20_000 }); await displayContext.setOffline(false); await expect(dp.getByRole("img", { name: "Display image", exact: true })).toBeVisible({ timeout: 20_000 });
    await dp.reload(); expect(await pixels(dp)).toEqual({ revealed: [35, 84, 119, 255], concealed: [0, 0, 0, 255] });
    await json(gm, "POST", `/api/campaigns/${campaignId}/displays/${displayId}/revoke`, {}); displayId = undefined; await expect(dp.getByRole("img", { name: "Display image", exact: true })).toHaveCount(0, { timeout: 20_000 });
    await writeFile(fixture, JSON.stringify({ campaignId, sceneId, fileId: forest.fileId, checksum: forest.checksum }), { mode: 0o600 }); saved = true;
  } catch (cause) { console.error("M3 journey failure:", cause); throw cause; }
  finally {
    await gm.unrouteAll({ behavior: "ignoreErrors" }); await displayContext.setOffline(false);
    if (displayId && campaignId) await json(gm, "POST", `/api/campaigns/${campaignId}/displays/${displayId}/revoke`, {});
    if (campaignId && (!saved || process.env.SCENE_BACKGROUND_PHASE === "verify")) { const c = (await json(gm, "GET", `/api/campaigns/${campaignId}`)).campaign; await json(gm, "POST", `/api/campaigns/${campaignId}/archive`, { expectedCampaignRevision: c.revision, idempotencyKey: key() }); }
    await gmContext.close(); await displayContext.close();
  }
});
