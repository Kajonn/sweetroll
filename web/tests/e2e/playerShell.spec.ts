import { test, expect, type Page } from "@playwright/test";

/**
 * G6 Task 3 player shell (dev-server E2E): phone bottom nav,
 * onboarding -> library, install prompt presence, and PWA checks.
 *
 * Needs a live backend per web/playwright.config.ts (migrate + dev:http and
 * web:dev, with DATABASE_URL pointing at Postgres).
 *
 * Real installability proof (beforeinstallprompt on a real device,
 * standalone display-mode, service-worker control) stays G9 device work:
 * this spec asserts manifest 200 + valid JSON + icons 200, records the
 * standalone matrix where supported, and drives the install banner with a
 * synthetic beforeinstallprompt event.
 */

const ONBOARDING_ANONYMOUS = "sweetroll:onboarding:anonymous";
const INSTALL_DISMISSED = "sweetroll:pwa-install-dismissed";

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByTestId("dev-signin").click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 30_000 });
}

test("phone bottom nav links Characters/Activity/Account; desktop keeps header", async ({ page }) => {
  await signIn(page);

  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/characters");
  const bottomNav = page.getByTestId("player-bottom-nav");
  await expect(bottomNav).toBeVisible();
  await expect(bottomNav.getByRole("link", { name: "Characters" })).toHaveAttribute("href", "/characters");
  await expect(bottomNav.getByRole("link", { name: "Activity" })).toHaveAttribute("href", "/activity");
  await expect(bottomNav.getByRole("link", { name: "Account" })).toHaveAttribute("href", "/account");

  // 44px touch targets on the phone nav.
  for (const name of ["Characters", "Activity", "Account"]) {
    const box = await bottomNav.getByRole("link", { name }).boundingBox();
    expect(box, name).not.toBeNull();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }

  await bottomNav.getByRole("link", { name: "Activity" }).click();
  await expect(page).toHaveURL("/activity");
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("player-bottom-nav").getByRole("link", { name: "Account" }).click();
  await expect(page).toHaveURL("/account");
  await expect(page.getByRole("heading", { name: "Account" })).toBeVisible({ timeout: 30_000 });

  // Desktop keeps the header chrome; the phone nav is hidden.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByTestId("player-bottom-nav")).toBeHidden();
  await expect(page.getByTestId("app-header")).toBeVisible();
  await expect(page.getByRole("link", { name: "Activity" }).first()).toBeVisible();
});

test("onboarding: anonymous first-run sees welcome, dismiss leads to library", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(key => window.localStorage.removeItem(key), ONBOARDING_ANONYMOUS);

  await page.goto("/characters");
  await expect(page.getByRole("heading", { name: /welcome/i })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("link", { name: /create.*first.*character/i })).toHaveAttribute(
    "href",
    "/characters/new",
  );

  // Dismissing persists the flag without blocking sign-in.
  await page.getByRole("button", { name: /continue/i }).click();
  await expect
    .poll(async () => page.evaluate(key => window.localStorage.getItem(key), ONBOARDING_ANONYMOUS))
    .toBe("1");
  await expect(page.getByTestId("dev-signin")).toBeVisible({ timeout: 30_000 });

  // Signing in after onboarding lands on the library.
  await page.getByTestId("dev-signin").click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 30_000 });
  await page.goto("/characters");
  await expect(page.getByRole("heading", { name: "Characters" })).toBeVisible({ timeout: 30_000 });
});

test("install prompt presence: banner appears on beforeinstallprompt and dismiss persists", async ({
  page,
}) => {
  await signIn(page);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/characters");
  await expect(page.getByRole("button", { name: "Install" })).toBeHidden();

  await page.evaluate(() => window.dispatchEvent(new Event("beforeinstallprompt")));
  await expect(page.getByRole("button", { name: "Install" })).toBeVisible();

  await page.getByRole("button", { name: "Not now" }).click();
  await expect
    .poll(async () => page.evaluate(key => window.localStorage.getItem(key), INSTALL_DISMISSED))
    .toBe("1");
  await expect(page.getByRole("button", { name: "Install" })).toBeHidden();
  await page.reload();
  await expect(page.getByRole("button", { name: "Install" })).toBeHidden();
});

test("PWA checks: manifest 200 + valid JSON + icons 200, standalone matrix recorded", async ({
  page,
}) => {
  await page.goto("/");

  const manifestResponse = await page.request.get("/manifest.webmanifest");
  expect(manifestResponse.status()).toBe(200);
  const manifest = (await manifestResponse.json()) as {
    name?: string;
    short_name?: string;
    start_url?: string;
    scope?: string;
    display?: string;
    icons?: Array<{ src?: string; sizes?: string }>;
  };
  expect(manifest.name).toBe("Sweetroll");
  expect(manifest.start_url).toBe("/characters");
  expect(manifest.scope).toBe("/");
  expect(manifest.display).toBe("standalone");
  expect(manifest.icons?.length ?? 0).toBeGreaterThanOrEqual(2);
  for (const icon of manifest.icons ?? []) {
    expect(icon.src).toBeTruthy();
    const iconResponse = await page.request.get(icon.src ?? "");
    expect(iconResponse.status(), icon.src).toBe(200);
  }

  // Matrix where supported: record service-worker API presence and the
  // standalone display-mode (dev-server pages are not worker-controlled and
  // run in a normal browser display, so these are informational here; real
  // installability proof stays G9 device work).
  const matrix = await page.evaluate(() => ({
    serviceWorkerInNavigator: "serviceWorker" in navigator,
    displayModeStandalone:
      typeof window.matchMedia === "function"
        ? window.matchMedia("(display-mode: standalone)").matches
        : "unsupported",
  }));
  expect(typeof matrix.serviceWorkerInNavigator).toBe("boolean");
  expect(matrix.serviceWorkerInNavigator).toBe(true);
  expect([true, false, "unsupported"]).toContain(matrix.displayModeStandalone);
});
