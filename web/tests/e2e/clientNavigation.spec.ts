import { test, expect, type Page } from "@playwright/test";

async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("dev-signin-code").fill("code-test-a");
  await page.getByTestId("dev-signin").click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 30_000 });
}

test("client navigation: header hops keep the document alive", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  await page.goto("/characters");
  await expect(page.getByRole("heading", { name: "Your library" })).toBeVisible({ timeout: 30_000 });
  // Boot marker: a full reload wipes window state, client nav preserves it.
  await page.evaluate(() => { (window as { __navAlive?: boolean }).__navAlive = true; });
  await page.locator('header nav a:has-text("Campaigns")').click();
  await expect(page).toHaveURL(/\/campaigns/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Campaigns" })).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => (window as { __navAlive?: boolean }).__navAlive)).toBe(true);
  await page.locator('header nav a:has-text("Activity")').click();
  await expect(page).toHaveURL(/\/activity/, { timeout: 30_000 });
  expect(await page.evaluate(() => (window as { __navAlive?: boolean }).__navAlive)).toBe(true);
  await page.locator('header nav a:has-text("Characters")').click();
  await expect(page).toHaveURL(/\/characters$/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Your library" })).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => (window as { __navAlive?: boolean }).__navAlive)).toBe(true);
  // The sign-in panel never appears for the signed-in actor mid-navigation.
  expect(await page.getByTestId("dev-signin-panel").count()).toBe(0);
});
