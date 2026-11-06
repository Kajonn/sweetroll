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
async function pixels(page: Page) {
  const image = page.getByRole("img", { name: "Display image", exact: true });
  await expect(image).toBeVisible({ timeout: 20_000 });
  const bytes = await image.evaluate(async i => Array.from(new Uint8Array(await (await fetch((i as HTMLImageElement).src)).arrayBuffer())));
  const raw = await sharp(Buffer.from(bytes)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return [.25,.5,.75].map(x => { const offset = (Math.floor(raw.info.height * .5) * raw.info.width + Math.floor(raw.info.width * x)) * 4; return Array.from(raw.data.subarray(offset,offset+4)); });
}

test("V4 combined: image tokens, gestures, fog, recovery and restricted display", async ({ browser, baseURL }, info) => {
  test.setTimeout(240_000);
  if (!baseURL) throw Error("Test target required");
  const hosted = process.env.SCENE_VISUAL_HOSTED === "1";
  const options = { baseURL, ignoreHTTPSErrors: hosted, ...(hosted && process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY } } : {}) };
  const context = await browser.newContext({ ...options, hasTouch: true, viewport: { width: 768, height: 1024 } });
  const displayContext = await browser.newContext({ ...options, viewport: { width: 768, height: 1024 } });
  const gm = await context.newPage(), dp = await displayContext.newPage();
  gm.setDefaultTimeout(15_000); dp.setDefaultTimeout(15_000);
  gm.setDefaultNavigationTimeout(45_000); dp.setDefaultNavigationTimeout(45_000);
  let campaignId: string | undefined, displayId: string | undefined, primaryError: unknown;
  const black = [0,0,0,255], blue = [35,84,119,255];
  try {
    await gm.goto("/");
    await json(gm, "POST", "/dev/signin", { code: "code-journey-gm", redirectUri: new URL("/cb", baseURL).href });
    campaignId = (await json(gm, "POST", "/api/campaigns", { title: `V4 combined ${randomUUID().slice(0,8)}`, systemVersionId: "a0000000-0000-5000-8000-000000000002", idempotencyKey: randomUUID() })).campaign.campaignId;
    await gm.goto(`/campaigns/${campaignId}/scenes`);
    const backgrounds = gm.getByRole("region", { name: "Scene backgrounds", exact: true });
    async function upload(name: string, color: string) {
      const png = await sharp({ create: { width: 800, height: 500, channels: 3, background: color } }).png().toBuffer();
      await backgrounds.getByLabel("Image file", { exact: true }).setInputFiles({ name: `${name}.png`, mimeType: "image/png", buffer: png });
      await backgrounds.getByLabel("Image description").fill(name);
      await backgrounds.getByRole("button", { name: "Upload background", exact: true }).click();
      await expect(backgrounds.getByRole("img", { name, exact: true })).toBeVisible();
    }
    await upload("Hall", "#235477");
    await backgrounds.getByRole("button", { name: "Create scene", exact: true }).click();
    await expect(gm).toHaveURL(/sceneId=[a-f0-9-]{36}/);
    const sceneId = new URL(gm.url()).searchParams.get("sceneId")!;
    const state = async () => (await json(gm, "GET", `/api/scenes/${sceneId}`)).scene;
    const fogPath = `/api/scenes/${sceneId}/fog-edits`, changes: any[] = [];
    gm.on("request", r => { if (r.url().endsWith(fogPath)) changes.push(r.postDataJSON()); });
    const scene = gm.getByRole("region", { name: "Scene", exact: true });
    const fog = gm.getByRole("region", { name: "Fog of war", exact: true });
    const draft = gm.getByTestId("fog-draft-overlay").locator("circle");
    async function commit() {
      await fog.getByRole("button", { name: "Commit fog edit", exact: true }).click();
      await expect(fog.getByText("Fog edit committed.", { exact: true })).toBeVisible();
      await expect(draft).toHaveCount(0);
    }
    async function stroke(touch = false, cancel?: "escape" | "touch") {
      await scene.getByRole("button", { name: "Paint fog", exact: true }).click();
      const start = await point(gm,.25,.5), end = await point(gm,.75,.5);
      if (touch) {
        const cdp = await context.newCDPSession(gm);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...start,id:1 }] });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...end,id:1 }] });
        await expect(gm.getByTestId("fog-stroke-preview")).toBeVisible();
        await cdp.send("Input.dispatchTouchEvent", { type: cancel === "touch" ? "touchCancel" : "touchEnd", touchPoints: [] });
        await cdp.detach();
      } else {
        await gm.mouse.move(start.x,start.y); await gm.mouse.down(); await gm.mouse.move(end.x,end.y,{steps:8});
        await expect(gm.getByTestId("fog-brush-radius")).toHaveAttribute("r","0.1");
        if (cancel === "escape") await gm.keyboard.press("Escape");
        await gm.mouse.up();
      }
    }
    // Upload once and explicitly select existing art for the second, hidden token.
    const tray = gm.getByRole("region", { name: "Tokens", exact: true });
    await tray.getByText("Token artwork", { exact: true }).click();
    const art = tray.getByRole("region", { name: "Token images", exact: true });
    const tokenBytes = await sharp({ create: { width: 60, height: 100, channels: 4, background: "#e53753cc" } }).png().toBuffer();
    await art.getByLabel("Token image file").setInputFiles({ name: "wren.png", mimeType: "image/png", buffer: tokenBytes });
    await art.getByLabel("Image description").fill("Wren art");
    await art.getByRole("button", { name: "Upload token image", exact: true }).click();
    await expect(tray.getByText("Campaign image selected for this token.")).toBeVisible();
    for (const [label, visible] of [["Wren", true], ["Secret", false]] as const) {
      if (!visible) await tray.getByRole("button", {name:"Use label only",exact:true}).click();
      if (!visible) await art.locator("li").filter({ has: gm.getByRole("img", { name: "Wren art", exact: true }) }).getByRole("button", { name: "Select token image", exact: true }).click();
      await tray.getByLabel("Token label").fill(label);
      await tray.getByLabel(/visible to the display/i).setChecked(visible);
      await tray.getByRole("button", { name: "Place on scene", exact: true }).click();
      const p = await point(gm, visible ? .4 : .25, .5); await gm.touchscreen.tap(p.x, p.y);
      await expect(gm.getByText("Token placed.", { exact: true })).toBeVisible();
      await expect(scene.getByRole("button", { name: `Token ${label}`, exact: true })).toBeVisible();
    }
    const initial = await state(), tokenId = initial.tokens.find((t: any) => t.label === "Wren").tokenId;
    const secretId = initial.tokens.find((t: any) => t.label === "Secret").tokenId;
    const movePath = `/api/scenes/${sceneId}/tokens/${tokenId}`, moves: any[] = [];
    gm.on("request", r => { if (r.url().endsWith(movePath)) moves.push(r.postDataJSON()); });
    const marker = scene.getByRole("button", { name: "Token Wren", exact: true });
    async function savedAt(x: number, y: number) {
      await expect.poll(async () => { const t = (await state()).tokens.find((t: any) => t.tokenId === tokenId); return [t.x,t.y]; }).toEqual([x,y]);
      await expect(gm.getByText("Token moved.", { exact: true })).toBeVisible();
    }
    // Pair an independent credential-only display while the whole image is concealed.
    await gm.goto(`/campaigns/${campaignId}`); await gm.getByRole("tab", { name:"Settings",exact:true }).click();
    await gm.getByRole("button", { name:"Pair display",exact:true }).click();
    const dialog = gm.getByRole("dialog"), code = (await dialog.locator("strong").last().textContent())!.trim();
    await dialog.getByRole("button", { name:"Done",exact:true }).click();
    const displayPaths: string[] = [];
    dp.on("request", r => { if (r.url().startsWith(baseURL)) displayPaths.push(new URL(r.url()).pathname); });
    await dp.goto(`/display?sceneId=${sceneId}`); await dp.getByLabel(/display code/i).fill(code); await dp.getByRole("button", { name:"Connect display",exact:true }).click();
    expect(await pixels(dp)).toEqual([black,black,black]);
    displayId = await dp.evaluate(() => JSON.parse(sessionStorage.getItem("sweetroll:display-credential")!).displayId);
    await gm.goto(`/campaigns/${campaignId}/scenes?sceneId=${sceneId}`);
    const imageStatus = (id: string, revision: number) => dp.evaluate(async ({sceneId,id,revision}) => {
      const c = JSON.parse(sessionStorage.getItem("sweetroll:display-credential")!);
      return (await fetch(`/api/displays/${c.displayId}/scenes/${sceneId}/tokens/${id}/image?rev=${revision}`, { credentials:"omit",headers:{"x-display-secret":c.secret} })).status;
    }, {sceneId,id,revision});
    // Hidden and visible-but-fogged image endpoints both deny bytes.
    expect(await imageStatus(secretId,initial.revision)).toBe(404);
    expect(await imageStatus(tokenId,initial.revision)).toBe(404);
    for (const width of [360,768,1280]) {
      await gm.setViewportSize({width,height:1024});
      await scene.getByRole("button",{name:"Zoom in",exact:true}).click();
      await scene.getByRole("button",{name:"Pan scene",exact:true}).click();
      const pan = await point(gm,.5,.5), before = moves.length;
      await gm.mouse.move(pan.x,pan.y); await gm.mouse.down(); await gm.mouse.move(pan.x+8,pan.y+5,{steps:3}); await gm.mouse.up();
      expect(moves).toHaveLength(before);
      await scene.getByRole("button",{name:"Select / move tokens",exact:true}).click();
      await marker.click(); const tap = await point(gm,.65,.65); await gm.touchscreen.tap(tap.x,tap.y); await savedAt(.65,.65);
      const start = await point(gm,.65,.65), end = await point(gm,.6,.5);
      await gm.mouse.move(start.x,start.y); await gm.mouse.down(); await gm.mouse.move(end.x,end.y,{steps:8});
      expect(moves).toHaveLength(before+1); await gm.mouse.up(); await savedAt(.6,.5);
      const cdp = await context.newCDPSession(gm), origin = await point(gm,.6,.5), destination = await point(gm,.4,.5);
      await cdp.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{...origin,id:1}]});
      await cdp.send("Input.dispatchTouchEvent",{type:"touchMove",touchPoints:[{...destination,id:1}]});
      expect(moves).toHaveLength(before+2);
      await cdp.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]}); await cdp.detach(); await savedAt(.4,.5);
      expect(moves).toHaveLength(before+3);
      await scene.screenshot({path:info.outputPath(`combined-token-${width}.png`)});
      await scene.getByRole("button",{name:"Reset view",exact:true}).click();
    }
    const retained = await state(); await gm.reload();
    await expect(marker.locator("img")).toBeVisible(); expect((await state()).tokens).toEqual(retained.tokens);
    // Cancellation and keyboard alternatives after the transform/resize/reopen sequence.
    await scene.getByRole("button",{name:"Select / move tokens",exact:true}).click();
    const start = await point(gm,.4,.5), end = await point(gm,.7,.3), beforeCancel = moves.length;
    await gm.mouse.move(start.x,start.y); await gm.mouse.down(); await gm.mouse.move(end.x,end.y,{steps:4}); await gm.keyboard.press("Escape"); await gm.mouse.up();
    expect(moves).toHaveLength(beforeCancel); expect((await state()).revision).toBe(retained.revision);
    await tray.getByText("Position · Wren",{exact:true}).click();
    await tray.getByLabel("X for Wren",{exact:true}).focus(); await gm.keyboard.press("ControlOrMeta+A"); await gm.keyboard.type("0.45");
    await tray.getByRole("button",{name:"Move Wren",exact:true}).focus(); await gm.keyboard.press("Enter"); await savedAt(.45,.5);
    const staleToken = await state();
    await json(gm,"PATCH",movePath,{x:.35,y:.5,expectedSceneRevision:staleToken.revision,idempotencyKey:randomUUID()});
    await marker.click(); const target = await point(gm,.7,.3); await gm.mouse.click(target.x,target.y);
    await expect(gm.getByRole("button",{name:"Retry moving Wren",exact:true})).toBeEnabled();
    expect((await state()).tokens.find((t:any)=>t.tokenId===tokenId).x).toBe(.35);
    await gm.getByRole("button",{name:"Retry moving Wren",exact:true}).click(); await savedAt(.7,.3);
    // Lost move response: retry exactly, with no second revision.
    let moveDropped = false, moveStatus = 0;
    await gm.route(`**${movePath}`,async route=>{moveStatus=(await route.fetch({timeout:15_000})).status();await route.abort("failed");moveDropped=true;},{times:1});
    await marker.click(); const next = await point(gm,.45,.5); await gm.mouse.click(next.x,next.y);
    await expect.poll(()=>moveDropped).toBe(true); expect(moveStatus).toBe(200);
    await expect(gm.getByRole("button",{name:"Retry token recovery",exact:true})).toBeEnabled();
    const uncertainMove = moves.at(-1), moveRevision = (await state()).revision;
    await gm.getByRole("button",{name:"Retry token recovery",exact:true}).click(); await savedAt(.45,.5);
    expect(moves.at(-1)).toEqual(uncertainMove); expect((await state()).revision).toBe(moveRevision);
    // Now paint in the same scene, retaining both token records.
    for (const width of [360,768,1280]) {
      await gm.setViewportSize({ width,height:1024 });
      await scene.getByRole("button", { name:"Zoom in",exact:true }).click();
      await scene.getByRole("button", { name:"Pan scene",exact:true }).click();
      const origin = await point(gm,.5,.5);
      await gm.mouse.move(origin.x,origin.y); await gm.mouse.down(); await gm.mouse.move(origin.x+8,origin.y+5,{steps:3}); await gm.mouse.up();
      for (const touch of [false,true]) {
        await stroke(touch);
        const dabs = await draft.evaluateAll(nodes => nodes.map(n => ({ x:Number(n.getAttribute("cx")),y:Number(n.getAttribute("cy")),r:Number(n.getAttribute("r")) })));
        expect(dabs.length).toBeGreaterThan(2); expect(dabs.length).toBeLessThanOrEqual(512);
        expect(dabs[0]!.x).toBeCloseTo(.25,2); expect(dabs.at(-1)!.x).toBeCloseTo(.75,2);
        expect(dabs.every(d => Math.abs(d.y-.5)<.01 && d.r===.1)).toBe(true);
        expect(changes).toHaveLength(0); expect((await state()).fog).toEqual([]);
        expect(await pixels(dp)).toEqual([black,black,black]);
        await scene.screenshot({ path:info.outputPath(`fog-${width}-${touch?"touch":"mouse"}.png`) });
        await fog.getByRole("button", { name:"Undo fog stroke",exact:true }).click(); await expect(draft).toHaveCount(0);
      }
      expect(await gm.evaluate(() => document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
      await scene.getByRole("button", { name:"Reset view",exact:true }).click();
    }
    await stroke(false,"escape"); await expect(draft).toHaveCount(0);
    await stroke(true,"touch"); await expect(draft).toHaveCount(0); expect(changes).toHaveLength(0);
    await stroke(); expect(await pixels(dp)).toEqual([black,black,black]); await commit();
    expect(changes).toHaveLength(1); expect(changes[0].op.mode).toBe("reveal");
    await expect.poll(() => pixels(dp), { timeout:20_000 }).toEqual([blue,blue,blue]);
    await expect(dp.getByText("Wren",{exact:true}).locator("..").locator("img")).toBeVisible({timeout:20_000});
    await expect(dp.getByText("Secret",{exact:true})).toHaveCount(0);
    expect(await imageStatus(secretId,(await state()).revision)).toBe(404);
    expect(await imageStatus(tokenId,(await state()).revision)).toBe(200);
    // Proportional geometry and exact decoded RGBA art on the permitted display.
    const displayedArt = dp.getByText("Wren",{exact:true}).locator("..").locator("img");
    const decoded = async (b:Buffer)=>{const r=await sharp(b).ensureAlpha().raw().toBuffer({resolveWithObject:true});return {info:r.info,data:Array.from(r.data)};};
    const displayBytes = await displayedArt.evaluate(async i=>Array.from(new Uint8Array(await(await fetch((i as HTMLImageElement).src)).arrayBuffer())));
    expect(await decoded(Buffer.from(displayBytes))).toEqual(await decoded(tokenBytes));
    for (const width of [360,768,1280]) {
      await gm.setViewportSize({width,height:1024}); await dp.setViewportSize({width,height:1024});
      for(const page of [gm,dp]) {
        const bg=page.getByRole("img",{name:page===gm?"Scene background":"Display image",exact:true});
        await bg.evaluate(i=>(i as HTMLImageElement).decode()); const b=(await bg.boundingBox())!;
        const a=(await(page===gm?marker.locator("img"):displayedArt).boundingBox())!;
        expect(a.width/b.width).toBeCloseTo(initial.tokens[0].size,2);
        expect((a.x+a.width/2-b.x)/b.width).toBeCloseTo(.45,2);
        expect((a.y+a.height/2-b.y)/b.height).toBeCloseTo(.5,2);
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
      }
      await dp.screenshot({path:info.outputPath(`combined-display-${width}.png`),fullPage:true});
    }
    await fog.getByLabel(/fog mode/i).selectOption("conceal");
    await stroke(true); expect(await pixels(dp)).toEqual([blue,blue,blue]); await commit();
    await expect.poll(() => pixels(dp), { timeout:20_000 }).toEqual([black,black,black]);
    await expect(dp.getByText("Wren",{exact:true})).toHaveCount(0,{timeout:20_000});
    expect(await imageStatus(tokenId,(await state()).revision)).toBe(404);
    expect(await imageStatus(secretId,(await state()).revision)).toBe(404);
    // Freeze the draft's starting revision, preserve it on a real conflicting command, then explicitly retry.
    await fog.getByLabel(/fog mode/i).selectOption("reveal"); await stroke();
    const stale = await state();
    await json(gm,"POST",fogPath,{ expectedSceneRevision:stale.revision,idempotencyKey:randomUUID(),op:{mode:"reveal",runs:[{x:.1,y:.1,r:.01}]} });
    await fog.getByRole("button", { name:"Commit fog edit",exact:true }).click();
    await expect(fog.getByRole("button", { name:"Retry fog edit",exact:true })).toBeEnabled();
    expect(await draft.count()).toBeGreaterThan(2); expect((await state()).fog).toHaveLength(3);
    const conflict = changes.at(-1);
    await fog.getByRole("button", { name:"Retry fog edit",exact:true }).click();
    await expect(fog.getByText("Fog edit committed.",{exact:true})).toBeVisible();
    expect(changes.at(-1).idempotencyKey).not.toBe(conflict.idempotencyKey); expect(changes.at(-1).op).toEqual(conflict.op);
    expect(changes.at(-1).expectedSceneRevision).toBe(stale.revision+1);
    // Unknown response outcome retries the identical command, never a second fog operation.
    await fog.getByLabel(/fog mode/i).selectOption("conceal"); await stroke();
    let dropped = false, committedStatus = 0;
    await gm.route(`**${fogPath}`, async route => { committedStatus=(await route.fetch({timeout:15_000})).status(); await route.abort("failed"); dropped=true; }, {times:1});
    await fog.getByRole("button", {name:"Commit fog edit",exact:true}).click();
    await expect.poll(()=>dropped,{timeout:20_000}).toBe(true); expect(committedStatus).toBe(200);
    await expect(fog.getByRole("button",{name:"Retry fog recovery",exact:true})).toBeEnabled(); const uncertain = changes.at(-1);
    const savedRevision = (await state()).revision;
    await fog.getByRole("button",{name:"Retry fog recovery",exact:true}).click();
    await expect(fog.getByText("Fog edit committed.",{exact:true})).toBeVisible();
    expect(changes.at(-1)).toEqual(uncertain); expect((await state()).revision).toBe(savedRevision);
    // Keyboard-only precision controls use the same local draft and command owner.
    await fog.getByText("Precise fog position",{exact:true}).click();
    await fog.getByLabel(/fog mode/i).selectOption("reveal");
    await fog.getByLabel(/x \(0–1\)/i).focus(); await gm.keyboard.press("ControlOrMeta+A"); await gm.keyboard.type("0.25");
    await fog.getByRole("button",{name:"Add fog dab",exact:true}).focus(); await gm.keyboard.press("Enter"); await commit();
    const saved = await state(); await gm.reload(); await expect(gm.getByTestId("fog-committed-mask").locator("circle")).toHaveCount(saved.fog.flatMap((o:any)=>o.runs).length);
    expect((await state()).fog).toEqual(saved.fog);
    await expect.poll(()=>pixels(dp),{timeout:20_000}).toEqual([blue,black,black]);
    expect(displayPaths.filter(p=>/^\/api\/(campaigns|characters|systems|scenes)/.test(p))).toEqual([]);
    const denied = await dp.evaluate(async path => { const c=JSON.parse(sessionStorage.getItem("sweetroll:display-credential")!); return (await fetch(path,{credentials:"omit",headers:{"x-display-secret":c.secret}})).status; }, `/api/campaigns/${campaignId}/images/${saved.backgroundFileId}/original`);
    expect(denied).toBe(401);
    expect((await new AxeBuilder({page:gm}).analyze()).violations).toEqual([]);
    await stroke(); await context.setOffline(true);
    await expect(gm.getByText("You are offline. Reconnect to change this scene.")).toBeVisible(); await expect(gm.getByTestId("fog-draft-overlay")).toHaveCount(0);
    await context.setOffline(false); await expect(draft).toHaveCount(0); expect((await state()).revision).toBe(saved.revision);
    expect((await state()).tokens).toEqual(saved.tokens);
    await stroke(); await upload("Forest","#a9b85f");
    await backgrounds.locator("li").filter({has:gm.getByRole("img",{name:"Forest",exact:true})}).getByRole("button",{name:"Use as background",exact:true}).click();
    await gm.getByRole("dialog").getByRole("button",{name:"Replace and conceal",exact:true}).click(); await expect(gm.getByRole("dialog")).not.toBeVisible();
    await expect(draft).toHaveCount(0); expect((await state()).fog).toEqual([]); expect((await state()).tokens).toEqual([]);
    await expect.poll(()=>pixels(dp),{timeout:20_000}).toEqual([black,black,black]);
    await gm.goto(`/campaigns/${campaignId}`); await gm.getByRole("tab",{name:"Settings",exact:true}).click();
    const revokedCredential = await dp.evaluate(() => JSON.parse(sessionStorage.getItem("sweetroll:display-credential")!));
    const projectionPath = `/api/displays/${displayId}/scenes/${sceneId}/projection`;
    const readWithCredential = () => dp.evaluate(async ({path,secret}) => (await fetch(path,{headers:{"x-display-secret":secret},credentials:"omit"})).status,{path:projectionPath,secret:revokedCredential.secret});
    expect(await readWithCredential()).toBe(200);
    await gm.getByRole("button",{name:"Revoke",exact:true}).click(); await expect(gm.getByText("Display revoked.",{exact:true})).toBeVisible();
    displayId=undefined;
    await expect(dp.getByRole("img",{name:"Display image",exact:true})).toHaveCount(0,{timeout:20_000});
    expect(await readWithCredential()).toBe(404);
  } catch(error) { primaryError=error; throw error; } finally {
    await context.setOffline(false); await gm.unrouteAll({behavior:"ignoreErrors"});
    try {
      if(displayId&&campaignId) await json(gm,"POST",`/api/campaigns/${campaignId}/displays/${displayId}/revoke`,{});
      if(campaignId) { const c=(await json(gm,"GET",`/api/campaigns/${campaignId}`)).campaign; await json(gm,"POST",`/api/campaigns/${campaignId}/archive`,{expectedCampaignRevision:c.revision,idempotencyKey:randomUUID()}); expect((await json(gm,"GET",`/api/campaigns/${campaignId}`)).campaign.status).toBe("archived");
        await info.attach("fixture-cleanup", {body:JSON.stringify({campaignId,displayRevoked:true,campaignStatus:"archived"}),contentType:"application/json"}); }
    } catch(cleanupError) { if(!primaryError) throw cleanupError; } finally { await Promise.allSettled([context.close(),displayContext.close()]); }
  }
});
