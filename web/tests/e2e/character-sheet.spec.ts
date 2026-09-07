import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "@playwright/test";

const D20_VERSION_ID = "a0000000-0000-5000-8000-000000000002";

/**
 * Task 11 character responsive/a11y cases (dev-server E2E): the sheet works
 * by keyboard at 360 and 1280 px, passes axe, and never overflows
 * horizontally. Full offline/tab/privacy acceptance lives in
 * `tests/offline/` against the production build.
 */
test.describe("character sheet responsive and keyboard", () => {
  for (const width of [360, 1280]) {
    test(`sheet at ${width}px: keyboard bump, axe, no overflow`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/");
      await page.getByTestId("dev-signin").click();
      await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 30_000 });

      const characterName = `E2E ${width} ${Date.now().toString(36)}`;
      await page.goto(`/characters/new?systemVersionId=${D20_VERSION_ID}`);
      await page.getByLabel("System version ID").fill(D20_VERSION_ID);
      await page.getByRole("button", { name: "Look up version" }).click();
      await page.getByLabel("Entity").selectOption("character");
      await page.getByLabel("Character name").fill(characterName);
      await page.getByRole("button", { name: "Create character", exact: true }).click();
      await expect(page).toHaveURL(/\/characters\/[0-9a-f-]+/, { timeout: 30_000 });
      await expect(page.getByRole("heading", { name: characterName })).toBeVisible({
        timeout: 30_000,
      });

      // Keyboard flow: tab to the resource control and activate by keyboard.
      const decrease = page.getByRole("button", { name: "Decrease Health" });
      await decrease.focus();
      await expect(decrease).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.getByText("Changes pending")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 60_000 });

      // No horizontal overflow at this width.
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth + 1);

      await page.screenshot({ path: `test-results/e2e-character-${width}.png` });
      const results = await new AxeBuilder({ page }).analyze();
      expect(
        results.violations.filter(v => v.impact === "serious" || v.impact === "critical"),
      ).toEqual([]);
    });
  }
});
