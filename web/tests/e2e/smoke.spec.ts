import { test, expect } from "../fixtures/browserTest";

test("smoke: app shell renders", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("app-header")).toBeVisible();
});
