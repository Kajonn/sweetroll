import { test, expect } from "@playwright/test";

/**
 * Production smoke test: the asset worker takes control of the page and a
 * character deep link reloads from cached assets with no network.
 */
test("worker controls the page and deep links reload fully offline", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.getByTestId("app-header")).toBeVisible();

  // The worker registers on first load but only controls after reload.
  await page.waitForFunction(() => "serviceWorker" in navigator && navigator.serviceWorker.controller !== null, null, {
    timeout: 20_000,
  });

  // Cached worker cache readiness for the current build.
  const status = await page.evaluate(
    () =>
      new Promise<{ ready: boolean; buildId: string | null }>(resolve => {
        const done = (value: { ready: boolean; buildId: string | null }) => resolve(value);
        try {
          const channel = new MessageChannel();
          const timer = setTimeout(() => done({ ready: false, buildId: null }), 5000);
          channel.port1.onmessage = (event: MessageEvent) => {
            clearTimeout(timer);
            done({ ready: event.data?.ready === true, buildId: event.data?.buildId ?? null });
          };
          navigator.serviceWorker.controller?.postMessage({ type: "sweetroll:offline-status" }, [channel.port2]);
        } catch {
          done({ ready: false, buildId: null });
        }
      }),
  );
  expect(status.ready).toBe(true);
  expect(status.buildId).not.toBeNull();

  // Deep-link reload with the network cut: shell + assets come from cache.
  await page.goto("/characters/new");
  await expect(page.getByTestId("app-header")).toBeVisible();
  await context.setOffline(true);
  try {
    await page.reload();
    await expect(page.getByTestId("app-header")).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});
