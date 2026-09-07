import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "@playwright/test";

/**
 * Task 11 character responsive/a11y cases (dev-server E2E): every reference
 * system sheet works by keyboard at 360 and 1280 px, passes axe, and never
 * overflows horizontally. Full offline/tab/privacy acceptance lives in
 * `tests/offline/` against the production build.
 *
 * Scope note (Task 11 I5): parameterized over REFERENCE_SYSTEMS (d20, PbtA
 * 2d6, d6 success pool) × widths — no scope reduction.
 */
const REFERENCE_SHEETS = [
  {
    key: "d20",
    versionId: "a0000000-0000-5000-8000-000000000002",
    bumpButton: "Decrease Health",
  },
  {
    key: "pbta",
    versionId: "b0000000-0000-5000-8000-000000000002",
    bumpButton: "Increase Harm",
  },
  {
    key: "pool",
    versionId: "c0000000-0000-5000-8000-000000000002",
    bumpButton: "Increase Stress",
  },
] as const;

test.describe("character sheet responsive and keyboard", () => {
  for (const system of REFERENCE_SHEETS) {
    for (const width of [360, 1280]) {
      test(`sheet ${system.key} at ${width}px: keyboard bump, axe, no overflow`, async ({ page }) => {
        test.setTimeout(120_000);
        await page.setViewportSize({ width, height: 800 });
        await page.goto("/");
        await page.getByTestId("dev-signin").click();
        await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 30_000 });

        const characterName = `E2E ${system.key} ${width} ${Date.now().toString(36)}`;
        await page.goto(`/characters/new?systemVersionId=${system.versionId}`);
        await page.getByLabel("System version ID").fill(system.versionId);
        await page.getByRole("button", { name: "Look up version" }).click();
        await page.getByLabel("Entity").selectOption("character");
        await page.getByLabel("Character name").fill(characterName);
        await page.getByRole("button", { name: "Create character", exact: true }).click();
        await expect(page).toHaveURL(/\/characters\/[0-9a-f-]+/, { timeout: 30_000 });
        await expect(page.getByRole("heading", { name: characterName })).toBeVisible({
          timeout: 30_000,
        });

        // Keyboard flow: tab to the resource control and activate by keyboard.
        const bump = page.getByRole("button", { name: system.bumpButton });
        await bump.focus();
        await expect(bump).toBeFocused();
        await page.keyboard.press("Enter");
        // On fast connections the bump can reach Saved before the pending
        // state is observable; either visible state proves the keyboard
        // commit was accepted, and Saved below proves it applied.
        await expect(
          page.getByText("Changes pending").or(page.getByText("Saved", { exact: true })),
        ).toBeVisible({ timeout: 30_000 });
        await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 60_000 });

        // No horizontal overflow at this width.
        const overflow = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        }));
        expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth + 1);

        // Durable evidence (the dev server has no production build ID, so the
        // filename carries system, width and run timestamp instead of going
        // to the cleared results dir). The committed journey PNGs under
        // tests/offline/evidence/ remain the production-build durable set.
        await page.screenshot({
          path: `tests/e2e/evidence/e2e-character-${system.key}-${width}-${Date.now()}.png`,
        });
        const results = await new AxeBuilder({ page }).analyze();
        expect(
          results.violations.filter(v => v.impact === "serious" || v.impact === "critical"),
        ).toEqual([]);
      });
    }
  }
});
