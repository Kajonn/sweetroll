import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";
import { REFERENCE_SYSTEMS } from "../offline/test-auth.js";
const key = () => randomUUID();
async function http(page: Page, method: string, path: string, data?: unknown) {
  return page.evaluate(async ({ method, path, data }) => {
    const r = await fetch(path, { method, cache:"no-store", ...(data === undefined ? {} : { headers:{"content-type":"application/json"}, body:JSON.stringify(data) }) });
    const type = r.headers.get("content-type") ?? "";
    return {status:r.status,body:type.includes("json") ? await r.json() : null};
  }, {method,path,data});
}
async function json(page: Page, method: string, path: string, data?: unknown) {
  const r = await http(page,method,path,data); expect(r.status,`${method} ${path}`).toBeGreaterThanOrEqual(200); expect(r.status).toBeLessThan(300); return r.body;
}
for (const system of REFERENCE_SYSTEMS) test(`${system.key}: durable offline conflict review, export and account isolation`, async ({ browser, baseURL }) => {
  if (!baseURL) throw Error("Explicit target required");
  test.setTimeout(120_000);
  const owner = await browser.newContext({baseURL,viewport:{width:360,height:900}});
  const writer = await browser.newContext({baseURL});
  const page = await owner.newPage(), wp = await writer.newPage();
  page.setDefaultTimeout(15_000); wp.setDefaultTimeout(15_000);
  const name = `G9 ${system.key} private recovery ${key().slice(0,8)}`;
  let cid = "";
  try {
    for (const p of [page,wp]) {
      await p.goto("/"); await json(p,"POST","/dev/signin",{code:"code-journey-p4",redirectUri:new URL("/cb",baseURL).href}); await p.reload();
    }
    const created = (await json(page,"POST","/api/characters",{systemVersionId:system.systemVersionId,entityDefinitionId:"character",name,idempotencyKey:key()})).character;
    cid = created.characterId;
    await page.goto(`/characters/${cid}`);
    await expect(page.getByRole("heading",{name,exact:true})).toBeVisible();
    await expect(page.getByText("Available offline",{exact:true})).toBeVisible({timeout:60_000});
    await expect(page.getByText("Editing in this tab.",{exact:true})).toBeVisible();
    await expect(page.getByText("Saved",{exact:true})).toBeVisible();
    const before = (await json(wp,"GET",`/api/characters/${cid}`)).character;
    const fieldId = {d20:"ability_score",pbta:"move_stat",pool:"attribute"}[system.key];
    const editable = page.getByLabel(system.editFieldLabel,{exact:true});
    // Resolve the actual definition ID from the owned fixture's bound input.
    const inputId = await editable.getAttribute("id");
    await owner.setOffline(true);
    await editable.fill(system.editFieldValue); await editable.press("Enter");
    await expect(page.getByText("Changes pending",{exact:true})).toBeVisible();
    await expect(page.getByRole("button",{name:"Export",exact:true})).toBeDisabled();
    await page.reload();
    await expect(page.getByRole("heading",{name,exact:true})).toBeVisible();
    await expect(page.getByText("Changes pending",{exact:true})).toBeVisible();
    const otherField = system.key === "d20" ? "modifier" : system.key === "pbta" ? "description" : "condition";
    const writerValue = system.key === "d20" ? 1 : system.key === "pool" ? "focused" : "G9 independent writer";
    await json(wp,"POST",`/api/characters/${cid}/fields/${otherField}/set`,{value:writerValue,expectedRevision:before.revision,idempotencyKey:key()});
    await owner.setOffline(false);
    await expect(page.getByRole("heading",{name:"Review conflicts",exact:true})).toBeVisible({timeout:60_000});
    const review = page.locator("section").filter({has:page.getByRole("heading",{name:"Review conflicts",exact:true})}).last();
    for (const box of await review.getByRole("checkbox").all()) await box.check();
    await page.getByRole("button",{name:"Reapply",exact:true}).click();
    await page.getByRole("button",{name:"Confirm reapply",exact:true}).click();
    await expect(page.getByText("Saved",{exact:true})).toBeVisible({timeout:60_000});
    await expect(page.getByLabel(system.editFieldLabel,{exact:true})).toHaveValue(system.editFieldValue);
    const final = (await json(wp,"GET",`/api/characters/${cid}`)).character;
    expect(final.revision).toBe(before.revision+2);
    expect(final.state.values[otherField]).toBe(writerValue);
    await page.getByRole("button",{name:"Export",exact:true}).click();
    const downloadPromise=page.waitForEvent("download");
    await page.getByRole("button",{name:"Download export",exact:true}).click();
    const download=await downloadPromise, path=await download.path();
    if (!path) throw Error("No export file");
    expect(JSON.parse(await readFile(path,"utf8"))).toEqual(await json(wp,"POST",`/api/characters/${cid}/exports`));
    await page.goto(`/characters/${cid}`);
    await expect(page.getByRole("heading",{name,exact:true})).toBeVisible();
    await test.info().attach(`recovered-${system.key}-phone`,{body:await page.screenshot({fullPage:true}),contentType:"image/png"});
    // Sign out through the UI, then use B in the same browser profile.
    page.once("dialog",d=>void d.accept());
    await page.getByRole("button",{name:"Sign out",exact:true}).first().click();
    await expect(page.getByRole("heading",{name,exact:true})).toHaveCount(0);
    await expect.poll(async()=> (await http(page,"GET","/api/me")).body?.state).toBe("anonymous");
    await json(page,"POST","/dev/signin",{code:"code-journey-p5",redirectUri:new URL("/cb",baseURL).href});
    await page.goto(`/characters/${cid}`);
    await expect(page.getByText("This character is unavailable.",{exact:true})).toBeVisible();
    expect((await http(page,"GET",`/api/characters/${cid}`)).status).toBe(404);
    await owner.setOffline(true); await page.reload();
    await expect(page.getByRole("heading",{name,exact:true})).toHaveCount(0);
    await expect(page.getByLabel(system.editFieldLabel,{exact:true})).toHaveCount(0);
    await test.info().attach("recovery-evidence",{body:JSON.stringify({system:system.key,characterId:cid,inputId,fieldId,initialRevision:before.revision,finalRevision:final.revision,checks:["durable offline reload","explicit conflict reapply","independent writer preserved","exact export","UI signout","same-profile B denial","offline B no private sheet"]},null,2),contentType:"application/json"});
  } finally {
    await owner.setOffline(false);
    if (cid) {
      const c=(await json(wp,"GET",`/api/characters/${cid}`)).character;
      await json(wp,"PATCH",`/api/characters/${cid}`,{command:"archive",expectedRevision:c.revision,idempotencyKey:key()});
      expect((await json(wp,"GET",`/api/characters/${cid}`)).character.lifecycle).toBe("archived");
    }
    await owner.close(); await writer.close();
  }
});
