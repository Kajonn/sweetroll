import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

test("combined deployed artifact: readiness, routing, exact assets and manifests", async ({page}) => {
  await page.goto("/");
  const rows: unknown[]=[];
  for (const [path,status,type] of [["/health/live",200,"json"],["/health/ready",200,"json"],["/api/me",200,"json"],["/api/g9-unknown-route",404,"json"],["/characters/new",200,"text/html"],["/cb",200,"text/html"]] as const) {
    const result=await page.evaluate(async path=>{const r=await fetch(path,{cache:"no-store"});return {status:r.status,type:r.headers.get("content-type")};},path);
    expect(result.status,path).toBe(status);expect(result.type,path).toContain(type);rows.push({path,...result});
  }
  const root=resolve(import.meta.dirname,"../../dist");
  const manifest=JSON.parse(await readFile(resolve(root,"offline-manifest.json"),"utf8")) as {buildId:string;assets:string[]};
  const paths=[...manifest.assets,"/sw.js","/offline-manifest.json","/manifest.webmanifest"];
  for (const path of paths) {
    const served=await page.evaluate(async path=>{const r=await fetch(path,{cache:"no-store"});return {status:r.status,bytes:Array.from(new Uint8Array(await r.arrayBuffer()))};},path);
    expect(served.status,path).toBe(200);
    const local=await readFile(resolve(root,path.slice(1)));
    expect(Buffer.from(served.bytes).equals(local),`${path}: rebuild with deployed OFFLINE_BUILD_ID=${manifest.buildId}`).toBe(true);
    rows.push({path,sha256:createHash("sha256").update(local).digest("hex"),bytes:local.length});
  }
  await test.info().attach("g9-artifact-evidence",{body:JSON.stringify({buildId:manifest.buildId,rows},null,2),contentType:"application/json"});
});
