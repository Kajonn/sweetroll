import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
test("a device previously used by a GM drops its session and private offline sheets before pairing", async ({page}) => {
  test.setTimeout(90_000);
  await page.goto("/");
  const api = async (method:string,path:string,data?:unknown) => page.evaluate(async ({method,path,data})=>{
    const r=await fetch(path,{method,cache:"no-store",...(data===undefined?{}:{headers:{"content-type":"application/json"},body:JSON.stringify(data)})});
    const type=r.headers.get("content-type")??"";return {status:r.status,body:type.includes("json")?await r.json():null};
  },{method,path,data});
  await api("POST","/dev/signin",{code:"code-journey-p5",redirectUri:new URL("/cb",page.url()).href});await page.reload();
  const created=await api("POST","/api/characters",{systemVersionId:"a0000000-0000-5000-8000-000000000002",entityDefinitionId:"character",name:"G9 private handoff sheet",idempotencyKey:randomUUID()});
  expect(created.status).toBe(201);const id=created.body.character.characterId;
  try {
    await page.goto(`/characters/${id}`);
    await expect(page.getByText("Available offline",{exact:true})).toBeVisible({timeout:60_000});
    await page.goto("/display");await expect(page.getByRole("heading",{name:"Connect this display",exact:true})).toBeVisible();
    expect((await api("GET","/api/me")).body.state).toBe("anonymous");
    expect((await api("GET",`/api/characters/${id}`)).status).toBe(401);
    const retained=await page.evaluate(id=>new Promise<number>((resolve,reject)=>{
      const r=indexedDB.open("sweetroll-characters");r.onerror=()=>reject(r.error);
      r.onsuccess=()=>{const db=r.result;const tx=db.transaction(db.objectStoreNames,"readonly");let count=0;
        for(const name of Array.from(db.objectStoreNames)){const all=tx.objectStore(name).getAll();all.onsuccess=()=>{count+=all.result.filter(v=>JSON.stringify(v).includes(id)).length;};}
        tx.oncomplete=()=>{db.close();resolve(count);};tx.onerror=()=>{db.close();reject(tx.error);};};
    }),id);
    expect(retained).toBe(0);
    await page.goBack();await expect(page.getByRole("heading",{name:"G9 private handoff sheet",exact:true})).toHaveCount(0);
    await page.reload();await expect(page.getByRole("heading",{name:"G9 private handoff sheet",exact:true})).toHaveCount(0);
  } finally {
    await page.context().setOffline(false);await page.goto("/");
    await api("POST","/dev/signin",{code:"code-journey-p5",redirectUri:new URL("/cb",page.url()).href});
    const c=(await api("GET",`/api/characters/${id}`)).body.character;
    await api("PATCH",`/api/characters/${id}`,{command:"archive",expectedRevision:c.revision,idempotencyKey:randomUUID()});
    expect((await api("GET",`/api/characters/${id}`)).body.character.lifecycle).toBe("archived");
  }
});
