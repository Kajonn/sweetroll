import AxeBuilder from "@axe-core/playwright";

import { expect, test, type Browser, type Page } from "../fixtures/browserTest";
import { armProfileFaults } from "../fixtures/faultyProfile";
import { lookUpCreationVersion } from "../fixtures/lookUpCreationVersion";
import { expectSheetSaved } from "../fixtures/sheetSaved";

/**
 * Character session read-path plan, S4: a sheet that this browser cannot save
 * or edit names the reason, and both read-only states pass axe (serious or
 * critical findings, including colour contrast) in light and dark at 360, 768
 * and 1280px with no horizontal scroll.
 */
const D20_VERSION = "a0000000-0000-5000-8000-000000000002";
const STORAGE = "Can't save this character in this browser, so it is read-only.";
const LOCKS = "Read-only in this browser.";

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByTestId("dev-signin").click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 30_000 });
}

async function expectAccessible(page: Page, label: string) {
  for (const width of [360, 768, 1280]) {
    for (const colorScheme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme });
      await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label} ${width}px ${colorScheme}: horizontal scroll`).toBe(true);
      const results = await new AxeBuilder({ page }).analyze();
      const serious = results.violations
        .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
        .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`);
      expect(serious, `${label} ${width}px ${colorScheme}`).toEqual([]);
    }
  }
}

type StorageState = Awaited<ReturnType<ReturnType<Page["context"]>["storageState"]>>;

/**
 * Opens the sheet in a new profile that keeps the sign-in cookie and the
 * dismissed welcome (cookies and localStorage only, no IndexedDB copy), with
 * the given fault armed before the app loads.
 */
async function openWithFault(browser: Browser, baseURL: string, storageState: StorageState, path: string, fault: "storage" | "locks") {
  const context = await browser.newContext({ baseURL, storageState });
  await armProfileFaults(context, [fault]);
  const page = await context.newPage();
  await page.goto(path);
  return { context, page };
}

test("read-only sheets name the storage or lock reason and pass axe", async ({ browser, page, baseURL }) => {
  test.setTimeout(240_000);
  if (!baseURL) throw new Error("Browser base URL required");
  await signIn(page);
  const characterName = `S4 messages ${Date.now().toString(36)}`;
  await page.goto(`/characters/new?systemVersionId=${D20_VERSION}`);
  await lookUpCreationVersion(page, D20_VERSION);
  await page.getByLabel("Entity").selectOption("character");
  await page.getByLabel("Character name").fill(characterName);
  await page.getByRole("button", { name: "Create character", exact: true }).click();
  await expect(page).toHaveURL(/\/characters\/[0-9a-f-]+/, { timeout: 30_000 });
  await expectSheetSaved(page);
  const path = new URL(page.url()).pathname;
  const state = await page.context().storageState();
  await page.close();

  const storage = await openWithFault(browser, baseURL, state, path, "storage");
  try {
    await expect(storage.page.getByRole("heading", { name: characterName })).toBeVisible({ timeout: 30_000 });
    await expect(storage.page.getByText(STORAGE)).toBeVisible({ timeout: 30_000 });
    await expect(storage.page.getByRole("button", { name: "Try saving again" })).toBeVisible();
    await expect(storage.page.getByText("This character is unavailable.")).toHaveCount(0);
    await expectAccessible(storage.page, "storage unavailable");
  } finally { await storage.context.close(); }

  const locks = await openWithFault(browser, baseURL, state, path, "locks");
  try {
    await expect(locks.page.getByRole("heading", { name: characterName })).toBeVisible({ timeout: 30_000 });
    await expect(locks.page.getByText(LOCKS, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(locks.page.getByText(STORAGE)).toHaveCount(0);
    await expect(locks.page.getByText("This character is unavailable.")).toHaveCount(0);
    await expectAccessible(locks.page, "no Web Locks");
  } finally { await locks.context.close(); }
});
