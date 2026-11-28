import { test, expect } from "../fixtures/browserTest";
import { createCatalogCampaign } from "../fixtures/campaignTemplates.js";

for (const width of [320, 360, 768, 1280]) {
  test(`compact Systems navigation at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await page.getByTestId("dev-signin").click();
    await expect(page.getByTestId("system-library")).toBeAttached();
    const header = page.getByTestId("app-header");
    const nav = header.getByRole("navigation", { name: "Primary" });
    const trigger = header.getByRole("button", { name: "Navigation menu" });
    expect((await header.boundingBox())!.height).toBeLessThanOrEqual(60);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (width < 1024) {
      await expect(nav).toBeHidden();
      const menu = (await trigger.boundingBox())!;
      const logo = (await header.getByText("Sweetroll", { exact: true }).boundingBox())!;
      expect(menu.x - logo.x - logo.width).toBeGreaterThanOrEqual(7);
      expect(menu.x - logo.x - logo.width).toBeLessThanOrEqual(9);
      await trigger.click();
      await expect(nav).toBeVisible();
      const popup = (await nav.boundingBox())!;
      expect(popup.x).toBeGreaterThanOrEqual(0);
      expect(popup.x + popup.width).toBeLessThanOrEqual(width);
      expect((await trigger.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await nav.getByRole("link", { name: "Account" }).focus();
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      await expect(nav).toBeHidden();
      await trigger.click();
    } else await expect(trigger).toBeHidden();
    await expect(nav.getByRole("link", { name: "Systems", exact: true })).toHaveAttribute("href", "/");
    await expect(nav.getByRole("link", { name: "Home", exact: true })).toHaveCount(0);
    await page.evaluate(() => { (window as any).__compactNavigation = true; });
    await nav.getByRole("link", { name: "Account" }).click();
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as any).__compactNavigation)).toBe(true);
    if (width < 1024) {
      await expect(nav).toBeHidden();
      await trigger.click();
    }
    await nav.getByRole("link", { name: "Systems", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("system-library")).toBeAttached();
    await page.screenshot({ path: test.info().outputPath(`systems-${width}.png`) });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}

test("campaign tabs stay in one row and keyboard navigation reveals the last tab", async ({ browser, baseURL }) => {
  if (!baseURL) throw new Error("A browser base URL is required");
  const gm = await browser.newContext({ baseURL });
  const co = await browser.newContext({ baseURL });
  const player = await browser.newContext({ baseURL });
  let fixture: Awaited<ReturnType<typeof createCatalogCampaign>> | undefined;
  try {
    fixture = await createCatalogCampaign(gm.request, co.request, player.request);
    const page = await gm.newPage();
    await page.goto(`/campaigns/${fixture.campaignId}`);
    const tabs = page.getByRole("tablist", { name: "Campaign tabs" });
    // GM-only tabs appear once the member roster loads; wait for them so
    // "End" targets the final tab list rather than the pre-roster one.
    await expect(tabs.getByRole("tab", { name: "Settings" })).toBeVisible({ timeout: 30_000 });
    for (const width of [320, 360, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      expect((await tabs.boundingBox())!.height).toBeLessThanOrEqual(48);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await tabs.getByRole("tab").first().focus();
      await page.keyboard.press("End");
      const last = tabs.getByRole("tab").last();
      await expect(last).toBeFocused();
      await expect(last).toHaveAttribute("aria-selected", "true");
      const strip = (await tabs.boundingBox())!, target = (await last.boundingBox())!;
      expect(target.x).toBeGreaterThanOrEqual(strip.x - 1);
      expect(target.x + target.width).toBeLessThanOrEqual(strip.x + strip.width + 1);
      expect(target.height).toBeGreaterThanOrEqual(44);
      await page.screenshot({ path: test.info().outputPath(`campaign-tabs-${width}.png`) });
    }
  } finally {
    if (fixture) {
      const current = (await (await gm.request.get(`/api/campaigns/${fixture.campaignId}`)).json()).campaign;
      await gm.request.post(`/api/campaigns/${fixture.campaignId}/archive`, { data: {
        expectedCampaignRevision: current.revision, idempotencyKey: crypto.randomUUID(),
      } });
      await gm.request.patch(`/api/systems/${fixture.systemId}`, { data: { lifecycle: "archived", access: "private" } });
    }
    await Promise.all([gm.close(), co.close(), player.close()]);
  }
});
