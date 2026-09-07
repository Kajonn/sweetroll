import { execSync } from "node:child_process";

import { test, expect } from "@playwright/test";

import {
  D20_REFERENCE_SYSTEM,
  TEST_USER_A,
  createCharacter,
  expectNoHorizontalOverflow,
  expectOfflineAvailable,
  expectSheetReady,
  newSignedInContext,
  readCharacter,
} from "./test-auth.js";

/**
 * Task 11 worker update: with a queued offline edit, an actual second
 * production build installs to `waiting` (never forced), no sensitive URLs
 * sit in CacheStorage, and the pending edit survives activation with exactly
 * one persisted effect.
 */
test.describe("service worker update with pending edits", () => {
  test("real second build waits, caches stay asset-only, queue drains once", async ({
    browser,
  }) => {
    test.setTimeout(420_000);
    const system = D20_REFERENCE_SYSTEM;
    const { context } = await newSignedInContext(browser, TEST_USER_A.code);
    try {
      const setup = await context.newPage();
      const characterName = `Update ${Date.now().toString(36)}`;
      const { characterId } = await createCharacter(setup.request, {
        systemVersionId: system.systemVersionId,
        name: characterName,
      });
      await setup.close();

      const page = await context.newPage();
      await page.setViewportSize({ width: 360, height: 740 });
      await page.goto(`/characters/${characterId}`);
      await expectSheetReady(page, characterName);
      await expectOfflineAvailable(page);
      const before = await readCharacter(page.request, characterId);
      const initialHealth = (before.character.state.values.health as { current: number }).current;
      const pageBuildId = await page.evaluate(
        () =>
          document.querySelector('meta[name="offline-build-id"]')?.getAttribute("content") ?? null,
      );
      expect(pageBuildId).not.toBeNull();

      // Sensitive URLs are absent from CacheStorage on the first build.
      await expectAssetOnlyCaches(page);

      // Queue one offline edit, then hold the queue while the new build
      // installs: abort bump sync attempts so the frozen request stays put.
      await context.setOffline(true);
      await page.getByRole("button", { name: system.decreaseButton }).click();
      await expect(page.getByText("Changes pending")).toBeVisible({ timeout: 15_000 });
      await context.setOffline(false);
      await page.route("**/characters/*/resources/*/bump", route => void route.abort("failed"));
      await expect(page.getByText("Changes pending")).toBeVisible({ timeout: 15_000 });

      // Produce an actual second production build (new versioned worker).
      const nextBuildId = `acceptance-update-${Date.now().toString(36)}`;
      // Tests execute with the web package as the working directory.
      execSync("npm run build", {
        env: { ...process.env, OFFLINE_BUILD_ID: nextBuildId },
        timeout: 300_000,
        stdio: "pipe",
      });

      // A real update check installs the second build into `waiting`; the
      // open page must stay on the coherent old build (no forced swap).
      const update = await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        await registration?.update();
        const started = Date.now();
        while (Date.now() - started < 60_000) {
          const current = await navigator.serviceWorker.getRegistration();
          if (current?.waiting) return true;
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        return false;
      });
      expect(update).toBe(true);
      const waitingBuildId = await page.evaluate(
        () =>
          new Promise<string | null>(resolve => {
            const done = (value: string | null) => resolve(value);
            void (async () => {
              try {
                const registration = await navigator.serviceWorker.getRegistration();
                const waiting = registration?.waiting;
                if (!waiting) {
                  done(null);
                  return;
                }
                const channel = new MessageChannel();
                const timer = setTimeout(() => done(null), 10_000);
                channel.port1.onmessage = (event: MessageEvent) => {
                  clearTimeout(timer);
                  done(typeof event.data?.buildId === "string" ? event.data.buildId : null);
                };
                waiting.postMessage({ type: "sweetroll:offline-status" }, [channel.port2]);
              } catch {
                done(null);
              }
            })();
          }),
      );
      expect(waitingBuildId).toBe(nextBuildId);
      // The controlling worker still serves the old build: no skipWaiting.
      const controllerBuildId = await page.evaluate(
        () =>
          new Promise<string | null>(resolve => {
            const done = (value: string | null) => resolve(value);
            try {
              const channel = new MessageChannel();
              const timer = setTimeout(() => done(null), 10_000);
              channel.port1.onmessage = (event: MessageEvent) => {
                clearTimeout(timer);
                done(typeof event.data?.buildId === "string" ? event.data.buildId : null);
              };
              navigator.serviceWorker.controller?.postMessage(
                { type: "sweetroll:offline-status" },
                [channel.port2],
              );
              if (!navigator.serviceWorker.controller) {
                clearTimeout(timer);
                done(null);
              }
            } catch {
              done(null);
            }
          }),
      );
      expect(controllerBuildId).toBe(pageBuildId);
      // Pending edits are untouched by the waiting build.
      await expect(page.getByText("Changes pending")).toBeVisible();
      await expectAssetOnlyCaches(page);
      await page.screenshot({ path: "test-results/offline-update-360-waiting.png" });

      // Activate by closing old clients: the new build takes control, keeps
      // the durable queue, and the edit still applies exactly once. Hold the
      // queue with a context-level abort so the pending state is stable
      // across activation instead of racing the first sync.
      await page.unrouteAll({ behavior: "wait" }).catch(() => {});
      await context.route("**/characters/*/resources/*/bump", route => void route.abort("failed"));
      const url = page.url();
      await page.close();
      const migrated = await context.newPage();
      try {
        await migrated.setViewportSize({ width: 1280, height: 800 });
        await migrated.goto(url);
        await expectSheetReady(migrated, characterName);
        const activeBuildId = await migrated.evaluate(
          () =>
            document.querySelector('meta[name="offline-build-id"]')?.getAttribute("content") ??
            null,
        );
        expect(activeBuildId).toBe(nextBuildId);
        await expect(migrated.getByText("Changes pending")).toBeVisible({ timeout: 60_000 });
        await context.unrouteAll({ behavior: "wait" }).catch(() => {});
        await expect(migrated.getByText("Saved", { exact: true })).toBeVisible({
          timeout: 120_000,
        });
        const after = await readCharacter(migrated.request, characterId);
        const appliedBumpCount = before.character.revision + 1 === after.character.revision ? 1 : 0;
        expect(appliedBumpCount).toBe(1);
        expect((after.character.state.values.health as { current: number }).current).toBe(
          initialHealth - 1,
        );
        await expectAssetOnlyCaches(migrated);
        await expectNoHorizontalOverflow(migrated);
        await migrated.screenshot({ path: "test-results/offline-update-1280-active.png" });
      } finally {
        await migrated.close().catch(() => {});
      }
    } finally {
      await context.setOffline(false).catch(() => {});
      await context.close();
    }
  });
});

async function expectAssetOnlyCaches(page: import("@playwright/test").Page) {
  const cachedRequests: string[] = await page.evaluate(async () => {
    const names = await caches.keys();
    const urls: string[] = [];
    for (const name of names) {
      const cache = await caches.open(name);
      const requests = await cache.keys();
      for (const request of requests) urls.push(request.url);
    }
    return urls;
  });
  expect(cachedRequests.length).toBeGreaterThan(0);
  expect(cachedRequests.every(url => !new URL(url).pathname.startsWith("/api/"))).toBe(true);
  expect(cachedRequests.every(url => !new URL(url).pathname.startsWith("/dev/"))).toBe(true);
}
