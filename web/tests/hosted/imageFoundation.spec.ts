import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { test, expect, type Page } from "@playwright/test";

const file = process.env.IMAGE_FOUNDATION_FIXTURE ?? "/tmp/sweetroll-image-foundation.json";
const key = () => randomUUID();
async function request(page: Page, method: string, path: string, data?: unknown) {
  return page.evaluate(async ({ method, path, data }) => {
    const r = await fetch(path, { method, cache: "no-store", ...(data === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(data) }) });
    return { status: r.status, cache: r.headers.get("cache-control"), body: await r.json() };
  }, { method, path, data });
}
async function json(page: Page, method: string, path: string, data?: unknown) {
  const r = await request(page, method, path, data);
  expect(r.status, JSON.stringify(r.body)).toBeGreaterThanOrEqual(200); expect(r.status).toBeLessThan(300); return r.body;
}
async function image(page: Page, campaignId: string, fileId: string) {
  const r = await page.evaluate(async path => { const r = await fetch(path, { cache: "no-store" }); return { status: r.status, cache: r.headers.get("cache-control"), bytes: Array.from(new Uint8Array(await r.arrayBuffer())) }; }, `/api/campaigns/${campaignId}/images/${fileId}/original`);
  expect(r.status).toBe(200); expect(r.cache).toContain("no-store"); return Buffer.from(r.bytes);
}
test("M0 real scanner and durable authorized storage", async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000);
  if (!baseURL) throw new Error("A hosted test URL is required.");
  await page.goto("/"); await json(page, "POST", "/dev/signin", { code: "code-test-a", redirectUri: new URL("/cb", page.url()).href });
  if (process.env.IMAGE_FOUNDATION_PHASE === "verify") {
    const saved = JSON.parse(await readFile(file, "utf8"));
    const bytes = await image(page, saved.campaignId, saved.image.fileId);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(saved.image.checksum);
    expect(await json(page, "POST", `/api/campaigns/${saved.campaignId}/images`, saved.input)).toHaveProperty("image", saved.image);
    const c = (await json(page, "GET", `/api/campaigns/${saved.campaignId}`)).campaign;
    await json(page, "POST", `/api/campaigns/${saved.campaignId}/archive`, { expectedCampaignRevision: c.revision, idempotencyKey: key() });
    expect((await json(page, "GET", `/api/campaigns/${saved.campaignId}`)).campaign.status).toBe("archived");
    await test.info().attach("post-redeploy-media", { body: JSON.stringify({ fileId: saved.image.fileId, checksum: saved.image.checksum, bytes: bytes.length, archived: true }), contentType: "application/json" });
    return;
  }
  const campaign = (await json(page, "POST", "/api/campaigns", { title: `M0 storage ${key().slice(0, 8)}`, systemVersionId: "a0000000-0000-5000-8000-000000000002", idempotencyKey: key() })).campaign;
  const png = await sharp({ create: { width: 32, height: 16, channels: 3, background: "#235477" } }).png().withMetadata({ exif: { IFD0: { Artist: "Private scanner fixture" } } }).toBuffer();
  const input = { name: "M0 landscape", contentType: "image/png", dataBase64: png.toString("base64"), idempotencyKey: key() };
  const uploaded = (await json(page, "POST", `/api/campaigns/${campaign.campaignId}/images`, input)).image;
  const bytes = await image(page, campaign.campaignId, uploaded.fileId);
  expect((await sharp(bytes).metadata()).exif).toBeUndefined();
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(uploaded.checksum);
  expect((await json(page, "POST", `/api/campaigns/${campaign.campaignId}/images`, input)).image).toEqual(uploaded);
  const context = await browser.newContext({ baseURL, ignoreHTTPSErrors: true });
  try {
    const other = await context.newPage(); await other.goto("/");
    await json(other, "POST", "/dev/signin", { code: "code-test-b", redirectUri: new URL("/cb", other.url()).href });
    const denied = await other.evaluate(async path => (await fetch(path)).status, `/api/campaigns/${campaign.campaignId}/images/${uploaded.fileId}/original`);
    expect(denied).toBe(404);
  } finally { await context.close(); }
  // Harmless standard AV test file inside a ZIP appended to the PNG.
  const avTest = Buffer.from("UEsDBBQAAAAAAKpQZF08z1FoRAAAAEQAAAAJAAAAZWljYXIudHh0WDVPIVAlQEFQWzRcUFpYNTQoUF4pN0NDKTd9JEVJQ0FSLVNUQU5EQVJELUFOVElWSVJVUy1URVNULUZJTEUhJEgrSCpQSwECFAMUAAAAAACqUGRdPM9RaEQAAABEAAAACQAAAAAAAAAAAAAAgAEAAAAAZWljYXIudHh0UEsFBgAAAAABAAEANwAAAGsAAAAAAA==", "base64");
  const rejected = await request(page, "POST", `/api/campaigns/${campaign.campaignId}/images`, { ...input, name: "M0 AV test", dataBase64: Buffer.concat([png, avTest]).toString("base64"), idempotencyKey: key() });
  expect(rejected.status).toBe(422); expect(rejected.body.error.message).toContain("safety scan");
  await writeFile(file, JSON.stringify({ campaignId: campaign.campaignId, image: uploaded, input }), { mode: 0o600 });
  await test.info().attach("pre-redeploy-media", { body: JSON.stringify({ campaignId: campaign.campaignId, image: uploaded, checks: ["real clean scan", "real AV rejection", "stripped EXIF", "opaque private read", "outsider denied", "exact replay"] }), contentType: "application/json" });
});
