import { test, expect } from "@playwright/test";

test("smoke: app shell renders", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("app-header")).toBeVisible();
});
