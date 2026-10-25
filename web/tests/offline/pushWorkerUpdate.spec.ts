import { execSync } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import { signIn, workspace, publish, createCharacter, cleanup, resultOf, assertChild, cachedPushState, json } from "../fixtures/configurablePush.js";
import { expectOfflineAvailable } from "./test-auth.js";

async function workerBuild(page: Page, which: "controller" | "waiting") {
  return page.evaluate(async which => {
    const registration = await navigator.serviceWorker.getRegistration();
    const worker = which === "waiting" ? registration?.waiting : navigator.serviceWorker.controller;
    if (!worker) return null;
    return new Promise<string | null>(resolve => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => resolve(null), 10_000);
      channel.port1.onmessage = e => { clearTimeout(timer); resolve(e.data?.buildId ?? null); };
      worker.postMessage({ type: "sweetroll:offline-status" }, [channel.port2]);
    });
  }, which);
}

test("a waiting production worker preserves a committed unseen push, activates without dropping it, and clears private results on sign-out", async ({ page, context, browser }, info) => {
  test.setTimeout(420_000);
  const actorId = await signIn(page), system = await workspace(page.request), ids: string[] = [];
  const evidence: Record<string, unknown> = { systemId: system.id };
  const pattern = "**/api/characters/*/rolls/*/push";
  try {
    const character = await createCharacter(page.request, await publish(page.request, system.id)), id = character.characterId;
    ids.push(id);
    await page.goto(`/characters/${id}`);
    await expectOfflineAvailable(page);
    const originalBuild = await workerBuild(page, "controller");
    expect(originalBuild).not.toBeNull();
    const root = (await resultOf(page, () => page.getByRole("button", { name: "Test Pool", exact: true }).click(), "/actions/test_pool")).result.roll;
    let child: any = null, first = true;
    await context.route(pattern, async route => {
      if (first) {
        first = false;
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        child = (await response.json()).result.roll;
      }
      await route.abort("failed");
    });
    await expect(page.getByRole("button", { name: "Push saved roll" })).toBeEnabled();
    await page.getByRole("button", { name: "Push saved roll" }).click();
    await expect.poll(() => child).not.toBeNull();
    assertChild(root, child);
    await expect.poll(async () => (await cachedPushState(page, actorId, id)).attempts.length).toBe(1);
    const frozen = (await cachedPushState(page, actorId, id)).attempts;
    const nextBuild = process.env.PUSH_UPDATE_CONTROL_URL ? "acceptance-push-b" : `push-update-${Date.now().toString(36)}`;
    if (process.env.PUSH_UPDATE_CONTROL_URL) {
      expect((await page.request.post(process.env.PUSH_UPDATE_CONTROL_URL)).ok()).toBe(true);
    } else {
      execSync("npm run build", { env: { ...process.env, OFFLINE_BUILD_ID: nextBuild }, timeout: 300_000, stdio: "pipe" });
    }
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())?.update(); });
    await expect.poll(() => workerBuild(page, "waiting"), { timeout: 60_000 }).toBe(nextBuild);
    expect(await workerBuild(page, "controller")).toBe(originalBuild);
    expect((await cachedPushState(page, actorId, id)).attempts).toEqual(frozen);
    const url = page.url();
    await page.close();
    page = await context.newPage();
    await page.goto(url);
    await expectOfflineAvailable(page);
    await expect.poll(() => workerBuild(page, "controller"), { timeout: 60_000 }).toBe(nextBuild);
    expect((await cachedPushState(page, actorId, id)).attempts).toEqual(frozen);
    await context.unroute(pattern);
    await expect(page.getByTestId("push-result")).toHaveAttribute("data-roll-id", child.push.rollId, { timeout: 60_000 });
    await expect.poll(async () => (await cachedPushState(page, actorId, id)).attempts.length).toBe(0);
    const history = await json(page.request, "GET", `/api/characters/${id}/activity`);
    expect(history.events.filter((event: any) => event.roll?.push)).toHaveLength(2);
    const cachedUrls = await page.evaluate(async () => {
      const urls: string[] = [];
      for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) urls.push(request.url);
      return urls;
    });
    expect(cachedUrls.some(url => /\/(api|dev)(\/|$)/.test(new URL(url).pathname))).toBe(false);
    page.once("dialog", dialog => void dialog.accept());
    const [signedOut] = await Promise.all([
      page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/api/signout")),
      page.getByRole("button", { name: "Sign out", exact: true }).click(),
    ]);
    expect(signedOut.status()).toBe(204);
    await expect(page.getByText("Signed out.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toHaveCount(0);
    expect((await cachedPushState(page, actorId, id)).rollId).toBeNull();
    await signIn(page, "code-test-b");
    await page.goto(`/characters/${id}`);
    expect((await page.request.get(`/api/characters/${id}`)).status()).toBe(404);
    await expect(page.getByTestId("push-result")).toHaveCount(0);
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByTestId("push-result")).toHaveCount(0);
    Object.assign(evidence, { characterId: id, root, child, originalBuild, nextBuild, exactRequestPreserved: true, historyRolls: 2, assetOnlyCaches: true, signOutErasedPrivateResult: true, otherAccountOfflineDenied: true });
  } finally {
    await context.setOffline(false);
    await context.unroute(pattern);
    // The page's account switch can still have identity work in flight.
    // Cleanup owns an independent cookie jar and never reuses that lifetime.
    const owner = await browser.newContext({ baseURL: new URL(page.url()).origin, ignoreHTTPSErrors: true });
    try {
      const signed = await json(owner.request, "POST", "/dev/signin", { code: "code-test-a", redirectUri: new URL("/cb", page.url()).href });
      expect(signed.userId).toBe(actorId);
      evidence.cleanup = await cleanup(owner.request, system.id, ids);
    } finally {
      await owner.close();
    }
    await info.attach("push-worker-update-evidence", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
  }
});
