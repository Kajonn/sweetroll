import { expect, type Page } from "@playwright/test";

/**
 * Looks up a system version on `/characters/new?systemVersionId=…` and waits
 * until the entity list is settled. The page already loads the version from
 * the URL, and every completed load resets the Entity selection; without
 * waiting, the URL load can finish after the test picks an entity and clear
 * it, leaving "Create character" disabled.
 */
export async function lookUpCreationVersion(page: Page, versionId: string): Promise<void> {
  // The URL prefill load has finished once the entity list is shown.
  await expect(page.getByLabel("Entity")).toBeVisible({ timeout: 30_000 });
  await page.getByLabel("System version ID").fill(versionId);
  const lookUp = page.getByRole("button", { name: "Look up version" });
  const lookedUp = page.waitForResponse(
    (response) => response.url().includes("/characters/creation-options"),
  );
  await lookUp.click();
  await lookedUp;
  await expect(lookUp).toBeEnabled();
}
