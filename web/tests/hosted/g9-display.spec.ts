import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import sharp from "sharp";
const key = () => randomUUID();
async function request(page: Page, method: string, path: string, data?: unknown) {
  return page.evaluate(async ({ method, path, data }) => {
    const r = await fetch(path, { method, cache: "no-store", ...(data === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(data) }) });
    const type = r.headers.get("content-type") ?? "";
    return { status: r.status, type, body: type.includes("json") ? await r.json() : null };
  }, { method, path, data });
}
async function json(page: Page, method: string, path: string, data?: unknown) {
  const r = await request(page, method, path, data);
  expect(r.status, `${method} ${path}`).toBeGreaterThanOrEqual(200);
  expect(r.status, `${method} ${path}`).toBeLessThan(300);
  expect(r.type).toContain("json"); return r.body;
}
test("hosted scene controls, redacted pixels, display reconnect and revocation", async ({ page, browser, baseURL }) => {
  if (!baseURL) throw Error("An explicit test target is required");
  page.setDefaultTimeout(15_000);
  await page.goto("/");
  await json(page, "POST", "/dev/signin", { code: "code-test-b", redirectUri: new URL("/cb", baseURL).href });
  await page.reload();
  const created = await json(page, "POST", "/api/systems", { source: { kind: "clone", versionId: "a0000000-0000-5000-8000-000000000002" }, idempotencyKey: key() });
  const systemId = created.workspace.system.systemId;
  const published = await json(page, "POST", `/api/systems/${systemId}/publish`, { expectedRevision: created.workspace.draft.revision, semanticVersion: "1.0.0", releaseNotes: "G9 display", acknowledgeBreaking: true, idempotencyKey: key() });
  const campaign = (await json(page, "POST", "/api/campaigns", { systemVersionId: published.version.versionId, title: `G9 Display ${key().slice(0,8)}`, idempotencyKey: key() })).campaign;
  const cid = campaign.campaignId;
  const display = await browser.newContext({ baseURL, viewport: { width: 768, height: 1024 } });
  const dp = await display.newPage();
  const images: Array<{fileId:string;revision:number}> = [];
  const evidence: Record<string, unknown> = { systemId, campaignId: cid };
  try {
    // A known red 64x64 source makes redaction verifiable at the pixel level.
    const original = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#e53753" } }).png().toBuffer();
    const uploaded = await json(page, "POST", `/api/campaigns/${cid}/images`, { name: "G9 red original", contentType: "image/png", dataBase64: original.toString("base64"), idempotencyKey: key() });
    const fileId = uploaded.image.fileId; images.push({ fileId, revision: uploaded.image.revision });
    const scene = (await json(page, "POST", `/api/campaigns/${cid}/scenes`, { backgroundFileId: fileId, idempotencyKey: key() })).scene;
    const sid = scene.sceneId; evidence.sceneId = sid;
    const sceneUrl = `/campaigns/${cid}/scenes?sceneId=${sid}`;
    await page.setViewportSize({ width: 360, height: 900 });
    await page.goto(sceneUrl);
    await expect(page.getByRole("img", { name: "Scene background" })).toBeVisible();
    const fog = page.getByRole("region", { name: "Fog of war" });
    if (!await fog.getByLabel(/x \(0–1\)/i).isVisible()) await fog.getByText("Precise fog position", { exact: true }).click();
    await fog.getByLabel(/fog mode/i).selectOption("reveal");
    for (const [label, value] of [[/x \(0–1\)/i,"0.25"],[/y \(0–1\)/i,"0.5"],[/radius \(0–1\)/i,"0.32"]] as const) await fog.getByLabel(label).fill(value);
    await fog.getByRole("button", { name: "Add fog dab" }).click();
    await fog.getByRole("button", { name: "Commit fog edit" }).click();
    await expect(fog.getByText("Fog edit committed.")).toBeVisible();
    await page.reload(); await expect(page.getByRole("img", { name: "Scene background" })).toBeVisible();
    for (const [label, visible, x] of [["Visible scout",true,"0.25"],["GM SECRET hidden assassin",false,"0.75"],["Fog-covered guard",true,"0.9"]] as const) {
      const tray = page.getByRole("region", { name: "Tokens" });
      await tray.getByLabel(/token label/i).fill(label);
      await tray.getByLabel(/x \(0–1\)/i).fill(x); await tray.getByLabel(/y \(0–1\)/i).fill("0.5");
      await tray.getByLabel(/visible to the display/i).setChecked(visible);
      await tray.getByRole("button", { name: "Place token", exact: true }).click();
      await expect(page.getByText("Token placed.")).toBeVisible();
      await page.reload(); await expect(page.getByRole("img", { name: "Scene background" })).toBeVisible();
    }
    await test.info().attach("gm-scene-phone", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    await page.goto(`/campaigns/${cid}`); await page.getByRole("tab", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Pair display", exact: true }).click();
    const dialog = page.getByRole("dialog"); await expect(dialog).toBeVisible();
    const code = (await dialog.locator("strong").last().innerText()).trim();
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    const seen: string[] = [], bodies: Promise<string>[] = [];
    dp.on("request", r => { if (r.url().startsWith(baseURL!)) seen.push(new URL(r.url()).pathname); });
    const recordProjection = (r: import("@playwright/test").Response) => { if (r.url().includes("/projection")) bodies.push(r.text()); };
    dp.on("response", recordProjection);
    await dp.goto(`/display?sceneId=${sid}`);
    await dp.getByLabel(/display code/i).fill(code); await dp.getByRole("button", { name: "Connect display", exact: true }).click();
    await expect(dp.getByRole("img", { name: "Display image" })).toBeVisible({timeout:15_000});
    await expect(dp.getByText("Visible scout", { exact: true })).toBeVisible();
    await expect(dp.getByText("GM SECRET hidden assassin", { exact: true })).toHaveCount(0);
    await expect(dp.getByText("Fog-covered guard", { exact: true })).toHaveCount(0);
    const imageUrl = await dp.getByRole("img", { name: "Display image" }).getAttribute("src");
    const rendered = await dp.evaluate(async url => Array.from(new Uint8Array(await (await fetch(url!)).arrayBuffer())), imageUrl);
    expect(Buffer.from(rendered).equals(original)).toBe(false);
    const decoded = await sharp(Buffer.from(rendered)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => Array.from(decoded.data.subarray((y * decoded.info.width + x) * 4, (y * decoded.info.width + x) * 4 + 4));
    expect(pixel(16,32).slice(0,3)).toEqual([229,55,83]);
    expect(pixel(60,32).slice(0,3)).not.toEqual([229,55,83]);
    evidence.pixels = { revealed: pixel(16,32), concealed: pixel(60,32) };
    expect(seen.filter(p => /^\/api\/(campaigns|scenes|characters|content|systems)/.test(p))).toEqual([]);
    for (const path of [`/api/campaigns/${cid}/images/${fileId}/original`, `/api/campaigns/${cid}`, `/api/scenes/${sid}`]) expect((await request(dp,"GET",path)).status).toBe(401);
    const storage = await dp.evaluate(async () => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage), caches: await caches.keys() }));
    expect(storage.local).toEqual([]);
    expect(storage.session).toEqual(["sweetroll:display-credential"]);
    // Public shell assets may be cached by the production worker; private
    // payloads, projections and images must never enter CacheStorage.
    const cachePaths = await dp.evaluate(async () => {
      const paths:string[]=[];
      for (const name of await caches.keys()) for (const req of await (await caches.open(name)).keys()) paths.push(new URL(req.url).pathname);
      return paths;
    });
    for (const path of cachePaths) expect(path).toMatch(/^\/(?:index\.html|assets\/[^/]+)$/);
    expect(cachePaths.some(path=>path.startsWith("/api/"))).toBe(false);
    expect(seen.filter(p => /^\/api\/(campaigns|scenes|characters|content|systems)/.test(p))).toEqual(expect.arrayContaining([`/api/campaigns/${cid}`, `/api/scenes/${sid}`])); // only explicit denial probes above
    dp.off("response", recordProjection);
    const projections = await Promise.all(bodies);
    expect(projections.length).toBeGreaterThan(0);
    for (const body of projections) { expect(body).not.toContain("GM SECRET"); expect(body).not.toContain("Fog-covered guard"); expect(body).not.toContain(original.toString("base64")); }
    await test.info().attach("restricted-display-tablet", { body: await dp.screenshot({ fullPage: true }), contentType: "image/png" });
    // Real network outage: safe blank state, then authorized reconnect.
    await display.setOffline(true);
    await expect(dp.getByRole("img", { name: "Display image" })).toHaveCount(0, { timeout: 20_000 });
    await display.setOffline(false);
    await expect(dp.getByRole("img", { name: "Display image" })).toBeVisible({ timeout: 20_000 });
    await dp.reload(); await expect(dp.getByText("Visible scout", { exact: true })).toBeVisible();
    const current = (await json(page,"GET",`/api/scenes/${sid}`)).scene;
    const token = current.tokens.find((t: any) => t.label === "Visible scout");
    await json(page,"PATCH",`/api/scenes/${sid}/tokens/${token.tokenId}`, { expectedSceneRevision: current.revision, x:0.4, y:0.5, idempotencyKey:key() });
    await expect(dp.getByText("Visible scout", { exact:true })).toHaveAttribute("style", /left:\s*40%/, { timeout:20_000 });
    const second = (await json(page,"POST",`/api/campaigns/${cid}/scenes`, { backgroundFileId:fileId,idempotencyKey:key() })).scene;
    await dp.goto(`/display?sceneId=${second.sceneId}`); await expect(dp.getByRole("img",{name:"Display image"})).toBeVisible();
    await expect(dp.getByText("Visible scout",{exact:true})).toHaveCount(0);
    await dp.goto(`/display?sceneId=${sid}`); await expect(dp.getByText("Visible scout",{exact:true})).toBeVisible();
    // Conceal and reveal the moved scout through the GM's keyboard controls.
    await page.goto(sceneUrl);
    for (const mode of ["conceal", "reveal"]) {
      const toolbar = page.getByRole("region", {name:"Fog of war"});
      await toolbar.getByLabel(/fog mode/i).selectOption(mode);
      await toolbar.getByLabel(/x \(0–1\)/i).fill("0.4");
      await toolbar.getByLabel(/y \(0–1\)/i).fill("0.5");
      await toolbar.getByLabel(/radius \(0–1\)/i).fill("0.15");
      await toolbar.getByRole("button",{name:"Add fog dab",exact:true}).click();
      await toolbar.getByRole("button",{name:"Commit fog edit",exact:true}).click();
      await expect(toolbar.getByText("Fog edit committed.")).toBeVisible();
      await expect(dp.getByText("Visible scout",{exact:true})).toHaveCount(mode === "conceal" ? 0 : 1,{timeout:20_000});
      await page.reload(); await expect(page.getByRole("img",{name:"Scene background"})).toBeVisible();
    }
    await page.goto(`/campaigns/${cid}`); await page.getByRole("tab",{name:"Settings",exact:true}).click();
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(page.getByText("Display revoked.")).toBeVisible();
    await expect(dp.getByText("This display is unavailable.")).toBeVisible({ timeout:20_000 });
    await expect(dp.getByRole("img", { name: "Display image" })).toHaveCount(0);
    const revokedRead = await dp.evaluate(async sid => {
      const credential=JSON.parse(sessionStorage.getItem("sweetroll:display-credential")!);
      const r=await fetch(`/api/displays/${credential.displayId}/scenes/${sid}/projection`,{headers:{"x-display-secret":credential.secret},cache:"no-store"});
      return {status:r.status,type:r.headers.get("content-type")};
    },sid);
    expect(revokedRead.status).toBe(404);
    await dp.reload(); await expect(dp.getByRole("img", { name: "Display image" })).toHaveCount(0);
    evidence.checks = "fog/tokens, pixel redaction, direct denial, storage, outage/reconnect, reload, token move, scene change, revoke/reload";
  } catch (error) {
    console.log("DISPLAY_PRIMARY_FAILURE", error instanceof Error ? error.stack : String(error)); throw error;
  } finally {
    await display.setOffline(false); await display.close();
    await page.goto("/");
    const credentials = (await json(page,"GET",`/api/campaigns/${cid}/display-credentials`)).displays;
    for (const credential of credentials) if (credential.revokedAt === null) await json(page,"POST",`/api/campaigns/${cid}/displays/${credential.displayId}/revoke`,{});
    // Image deletion is scoped to this run; archived campaign stays for readback.
    for (const image of images) await json(page,"DELETE",`/api/campaigns/${cid}/images/${image.fileId}`, { expectedRevision: image.revision ?? 1, idempotencyKey:key() });
    const c = (await json(page,"GET",`/api/campaigns/${cid}`)).campaign;
    await json(page,"POST",`/api/campaigns/${cid}/archive`, { expectedCampaignRevision:c.revision,idempotencyKey:key() });
    expect((await json(page,"GET",`/api/campaigns/${cid}`)).campaign.status).toBe("archived");
    await json(page,"PATCH",`/api/systems/${systemId}`, { lifecycle:"archived",access:"private" });
    expect((await json(page,"GET",`/api/systems/${systemId}`)).workspace.system).toMatchObject({lifecycle:"archived",access:"private"});
    evidence.cleanup = "run image deleted; campaign archived and independently read back; system private/archived";
    await test.info().attach("g9-display-evidence", { body:JSON.stringify(evidence,null,2), contentType:"application/json" });
  }
});
