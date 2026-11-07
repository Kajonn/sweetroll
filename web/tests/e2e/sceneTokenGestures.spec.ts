import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function json(page: Page, method: string, path: string, data?: unknown) {
  return page.evaluate(async ({ method, path, data }) => {
    const response = await fetch(path, { method, ...(data === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(data) }) });
    if (!response.ok) throw Error(`${method} ${path}: ${response.status}`);
    return response.json();
  }, { method, path, data });
}
async function point(page: Page, x: number, y: number) {
  const image = page.getByRole("img", { name: "Scene background", exact: true });
  await image.scrollIntoViewIfNeeded(); await image.evaluate(i => (i as HTMLImageElement).decode());
  const rect = (await image.boundingBox())!;
  return { x: rect.x + x * rect.width, y: rect.y + y * rect.height };
}

test("V2 token gestures: mouse/touch, transformed coordinates, recovery, display and reopen", async ({ browser, baseURL }, info) => {
  test.setTimeout(240_000);
  if (!baseURL) throw Error("Test target required");
  const hosted = process.env.SCENE_TOKEN_HOSTED === "1";
  const options = { baseURL, ignoreHTTPSErrors: hosted, ...(hosted && process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY } } : {}) };
  const context = await browser.newContext({ ...options, hasTouch: true, viewport: { width: 768, height: 1024 } });
  const displayContext = await browser.newContext({ ...options, viewport: { width: 768, height: 1024 } });
  const gm = await context.newPage(), dp = await displayContext.newPage();
  gm.setDefaultTimeout(15_000); dp.setDefaultTimeout(15_000);
  gm.setDefaultNavigationTimeout(45_000); dp.setDefaultNavigationTimeout(45_000);
  let campaignId: string | undefined, displayId: string | undefined, primaryError: unknown;
  try {
    await gm.goto("/");
    await json(gm, "POST", "/dev/signin", { code: "code-journey-gm", redirectUri: new URL("/cb", baseURL!).href });
    campaignId = (await json(gm, "POST", "/api/campaigns", { title: `V2 gestures ${randomUUID().slice(0, 8)}`, systemVersionId: "a0000000-0000-5000-8000-000000000002", idempotencyKey: randomUUID() })).campaign.campaignId;
    await gm.goto(`/campaigns/${campaignId}/scenes`);
    const backgrounds = gm.getByRole("region", { name: "Scene backgrounds", exact: true });
    const png = await sharp({ create: { width: 800, height: 500, channels: 3, background: "#235477" } }).png().toBuffer();
    await backgrounds.getByLabel("Image file", { exact: true }).setInputFiles({ name: "hall.png", mimeType: "image/png", buffer: png });
    await backgrounds.getByLabel("Image description").fill("Hall");
    await backgrounds.getByRole("button", { name: "Upload background", exact: true }).click();
    await backgrounds.getByRole("button", { name: "Create scene", exact: true }).click();
    await expect(gm).toHaveURL(/sceneId=[a-f0-9-]{36}/);
    const sceneId = new URL(gm.url()).searchParams.get("sceneId")!;
    const state = async () => (await json(gm, "GET", `/api/scenes/${sceneId}`)).scene;
    const tray = gm.getByRole("region", { name: "Tokens", exact: true });
    const scene = gm.getByRole("region", { name: "Scene", exact: true });
    const fog = gm.getByRole("region", { name: "Fog of war", exact: true });
    if (!await fog.getByLabel(/x \(0–1\)/i).isVisible()) await fog.getByText("Precise fog position", { exact: true }).click();
    await fog.getByLabel(/radius/i).fill("1"); await fog.getByRole("button", { name: "Add fog dab" }).click(); await fog.getByRole("button", { name: "Commit fog edit" }).click();
    await expect(fog.getByText("Fog edit committed.")).toBeVisible();
    await tray.getByText("Token artwork", { exact: true }).click();
    const art = tray.getByRole("region", { name: "Token images", exact: true });
    const token = await sharp({ create: { width: 60, height: 100, channels: 4, background: "#e53753cc" } }).png().toBuffer();
    await art.getByLabel("Token image file").setInputFiles({ name: "wren.png", mimeType: "image/png", buffer: token }); await art.getByLabel("Image description").fill("Wren art");
    await art.getByRole("button", { name: "Upload token image" }).click();
    await expect(tray.getByText("Campaign image selected for this token.")).toBeVisible();
    // A definite validation failure must allow correction; it is not an uncertain save.
    await tray.getByLabel("Token label").fill("Invalid".repeat(50));
    await tray.getByRole("button", { name: "Place on scene", exact: true }).click();
    const rejectedPlacement = await point(gm, .4, .5); await gm.touchscreen.tap(rejectedPlacement.x, rejectedPlacement.y);
    await expect(gm.getByText(/server rejected this token change/i)).toBeVisible();
    expect((await state()).tokens).toEqual([]);
    await gm.getByRole("button", { name: "Discard token change", exact: true }).click();
    await expect(tray.getByLabel("Token label")).toBeEnabled();
    await tray.getByLabel("Token label").fill("Wren");
    await tray.getByRole("button", { name: "Place on scene", exact: true }).click();
    const placement = await point(gm, .4, .5); await gm.touchscreen.tap(placement.x, placement.y);
    await expect(gm.getByText("Token placed.")).toBeVisible();
    const saved = await state(), tokenId = saved.tokens[0].tokenId;
    expect(saved.tokens[0]).toMatchObject({ label: "Wren", x: .4, y: .5, imageFileId: expect.any(String) });
    const movePath = `/api/scenes/${sceneId}/tokens/${tokenId}`;
    const isMove = (url: string) => url.endsWith(movePath);
    const changes: unknown[] = [];
    gm.on("request", r => { if (isMove(r.url())) changes.push(r.postDataJSON()); });
    async function savedAt(x: number, y: number) {
      await expect.poll(async () => { const t = (await state()).tokens.find((t: any) => t.tokenId === tokenId); return [t.x, t.y]; }).toEqual([x, y]);
      await expect(gm.getByText("Token moved.")).toBeVisible();
    }
    for (const width of [360, 768, 1280]) {
      const before = changes.length;
      await gm.setViewportSize({ width, height: 1024 });
      await scene.getByRole("button", { name: "Zoom in", exact: true }).click();
      await scene.getByRole("button", { name: "Pan scene", exact: true }).click();
      const start = await point(gm, .5, .5);
      await gm.mouse.move(start.x, start.y); await gm.mouse.down(); await gm.mouse.move(start.x + 12, start.y + 8, { steps: 4 }); await gm.mouse.up();
      expect(changes.length).toBe(before);
      await scene.getByRole("button", { name: "Select / move tokens", exact: true }).click();
      const marker = scene.getByRole("button", { name: "Token Wren", exact: true });
      await marker.click();
      const tap = await point(gm, .65, .65); await gm.touchscreen.tap(tap.x, tap.y); await savedAt(.65, .65);
      const destination = await point(gm, .6, .5), box = (await marker.boundingBox())!;
      await gm.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await gm.mouse.down();
      await gm.mouse.move(destination.x, destination.y, { steps: 8 });
      expect(changes.length).toBe(before + 1); // Preview never writes.
      await gm.mouse.up(); await savedAt(.6, .5);
      const cdp = await context.newCDPSession(gm);
      const origin = await point(gm, .6, .5), end = await point(gm, .4, .5);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: origin.x, y: origin.y, id: 1 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: end.x, y: end.y, id: 1 }] });
      expect(changes.length).toBe(before + 2);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await savedAt(.4, .5);
      await cdp.detach();
      expect(changes.length).toBe(before + 3);
      await scene.screenshot({ path: info.outputPath(`gestures-${width}.png`) });
      expect(await gm.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await scene.getByRole("button", { name: "Reset view", exact: true }).click();
    }
    const cancelledTouch = await context.newCDPSession(gm), touchStart = await point(gm, .4, .5), touchEnd = await point(gm, .7, .3), beforeTouchCancel = changes.length;
    await cancelledTouch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...touchStart, id: 1 }] });
    await cancelledTouch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...touchEnd, id: 1 }] });
    await cancelledTouch.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] }); await cancelledTouch.detach();
    expect(changes.length).toBe(beforeTouchCancel); await savedAt(.4, .5);
    // Cancellation does not save; numeric controls remain a real keyboard path.
    const start = await point(gm, .4, .5), end = await point(gm, .7, .7), beforeCancel = changes.length;
    await gm.mouse.move(start.x, start.y); await gm.mouse.down(); await gm.mouse.move(end.x, end.y, { steps: 4 }); await gm.keyboard.press("Escape"); await gm.mouse.up();
    expect(changes.length).toBe(beforeCancel); await savedAt(.4, .5);
    await tray.getByText("Position · Wren", { exact: true }).click();
    const x = tray.getByLabel("X for Wren", { exact: true }); await x.focus(); await gm.keyboard.press("ControlOrMeta+A"); await gm.keyboard.type("0.45");
    await tray.getByRole("button", { name: "Move Wren", exact: true }).focus(); await gm.keyboard.press("Enter"); await savedAt(.45, .5);
    // Make the browser stale using a second actual command; only explicit retry overwrites it.
    const stale = await state(); await json(gm, "PATCH", movePath, { x: .35, y: .5, expectedSceneRevision: stale.revision, idempotencyKey: randomUUID() });
    const marker = scene.getByRole("button", { name: "Token Wren", exact: true }); await marker.click();
    const target = await point(gm, .7, .3); await gm.mouse.click(target.x, target.y);
    await expect(gm.getByText(/this scene changed/i)).toBeVisible();
    expect((await state()).tokens[0].x).toBe(.35);
    await gm.getByRole("button", { name: "Retry moving Wren", exact: true }).click(); await savedAt(.7, .3);
    // A lost response is a real committed server request, retried byte-for-byte.
    let dropped = false;
    await gm.route(`**${movePath}`, async route => { await route.fetch({ timeout: 15_000 }); await route.abort("failed"); dropped = true; }, { times: 1 });
    await marker.click(); const next = await point(gm, .55, .5); await gm.mouse.click(next.x, next.y);
    await expect.poll(() => dropped, { timeout: 15_000, message: "Actual committed response was dropped" }).toBe(true);
    await expect(gm.getByText(/save not confirmed/i)).toBeVisible(); const uncertain = changes.at(-1);
    await gm.getByRole("button", { name: "Retry token recovery", exact: true }).click(); await savedAt(.55, .5);
    expect(changes.at(-1)).toEqual(uncertain);
    await gm.reload(); await expect(scene.getByRole("button", { name: "Token Wren", exact: true })).toBeVisible(); expect((await state()).tokens[0]).toMatchObject({ x: .55, y: .5 });
    // Pair a separate restricted display through the GUI, then verify the committed center.
    await gm.goto(`/campaigns/${campaignId}`); await gm.getByRole("tab", { name: "Settings", exact: true }).click(); await gm.getByRole("button", { name: "Pair display", exact: true }).click();
    const dialog = gm.getByRole("dialog"), code = (await dialog.locator("strong").last().textContent())!.trim(); await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await dp.goto(`/display?sceneId=${sceneId}`); await dp.getByLabel(/display code/i).fill(code); await dp.getByRole("button", { name: "Connect display", exact: true }).click();
    await expect(dp.getByText("Wren", { exact: true })).toBeVisible({ timeout: 20_000 });
    displayId = await dp.evaluate(() => JSON.parse(sessionStorage.getItem("sweetroll:display-credential")!).displayId);
    const image = dp.getByText("Wren", { exact: true }).locator(".."); await expect(image).toHaveCSS("left", /.+/);
    expect(await image.evaluate(el => parseFloat((el as HTMLElement).style.left))).toBeCloseTo(55, 5);
    await gm.goto(`/campaigns/${campaignId}/scenes?sceneId=${sceneId}`);
    await expect(scene.getByRole("button", { name: "Token Wren", exact: true })).toBeVisible();
    expect((await new AxeBuilder({ page: gm }).analyze()).violations).toEqual([]);
    await context.setOffline(true); await expect(gm.getByText("You are offline. Reconnect to change this scene.")).toBeVisible();
    await context.setOffline(false); await expect(scene.getByRole("button", { name: "Token Wren", exact: true })).toBeVisible();
    await json(gm, "POST", `/api/campaigns/${campaignId}/displays/${displayId}/revoke`, {}); displayId = undefined;
    await expect(dp.locator("img")).toHaveCount(0, { timeout: 20_000 });
  } catch (error) { primaryError = error; throw error; } finally {
    await context.setOffline(false);
    try {
    if (displayId && campaignId) await json(gm, "POST", `/api/campaigns/${campaignId}/displays/${displayId}/revoke`, {});
    if (campaignId) { const c = (await json(gm, "GET", `/api/campaigns/${campaignId}`)).campaign; await json(gm, "POST", `/api/campaigns/${campaignId}/archive`, { expectedCampaignRevision: c.revision, idempotencyKey: randomUUID() }); expect((await json(gm, "GET", `/api/campaigns/${campaignId}`)).campaign.status).toBe("archived"); }
    } catch (cleanupError) { if (!primaryError) throw cleanupError; } finally {
      await Promise.allSettled([context.close(), displayContext.close()]);
    }
  }
});
