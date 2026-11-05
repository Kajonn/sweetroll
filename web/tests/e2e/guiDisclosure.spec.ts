import { test, expect } from "@playwright/test";

for (const width of [360, 1280]) {
  test(`technical information is opt-in and preserves creator values at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await page.getByTestId("dev-signin").click();
    await expect(page.getByTestId("system-library")).toBeAttached();
    await expect(page.getByTestId("request-id")).toHaveCount(0);
    await page.getByRole("button", { name: "Clone d20", exact: true }).click();
    await page.waitForURL(/\/systems\/[^/]+$/);
    const systemUrl = page.url();
    const systemId = new URL(systemUrl).pathname.split("/").at(-1)!;
    try {
      await expect(page.getByTestId("metadata-name")).toHaveValue("D20 System");
      await expect(page.getByLabel("System colors", { exact: true })).toBeHidden();
      await page.getByTestId("document-editor-tab-sections").click();
      await expect(page.getByText("ID: character_sheet", { exact: true })).toHaveCount(0);
      await expect(page.getByTestId("sheet-target-entity")).toHaveValue("character");

      await page.goto("/account");
      await expect(page.getByText("User ID", { exact: true })).toHaveCount(0);
      await page.getByText("Developer tools", { exact: true }).click();
      await page.getByRole("checkbox", { name: "Show debug information", exact: true }).check();
      await expect(page.getByText("User ID", { exact: true })).toBeVisible();
      await expect(page.getByTestId("request-id")).toContainText("Browser trace");
      await page.goto(systemUrl);
      await page.getByTestId("document-editor-tab-sections").click();
      await expect(page.getByText("ID: character_sheet", { exact: true })).toBeVisible();
      await expect(page.getByText("ID: basics", { exact: true })).toHaveCount(1);

      await page.goto("/account");
      await page.getByText("Developer tools", { exact: true }).click();
      await page.getByRole("checkbox", { name: "Show debug information", exact: true }).uncheck();
      await page.goto(systemUrl);
      await expect(page.getByTestId("metadata-name")).toHaveValue("D20 System");
      await expect(page.getByTestId("request-id")).toHaveCount(0);
      await page.getByTestId("document-editor-tab-attributes").click();
      const score = page.getByTestId("scalar-field-default-ability_score");
      await expect(score).toHaveValue("10");
      const field = page.getByTestId("scalar-field-ability_score");
      await expect(field.getByTestId("definition-id-input")).toBeHidden();
      await field.getByText("Identifier", { exact: true }).click();
      await expect(field.getByTestId("definition-id-input")).toHaveValue("ability_score");
    } finally {
      if (process.env.SWEETROLL_E2E_EPHEMERAL_DB !== "1") await page.request.delete(`/api/systems/${systemId}`);
    }
  });
}
