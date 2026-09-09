import { test, expect, type Page } from "@playwright/test";

/**
 * G6 Task 2 player library (dev-server E2E): create from the library seam,
 * list, search, recent, duplicate, archive and recover.
 *
 * Needs a live backend per web/playwright.config.ts (migrate + dev:http and
 * web:dev, with DATABASE_URL pointing at Postgres). Created characters have
 * no DELETE endpoint (character-sheet.spec.ts precedent); unique names per
 * run keep the shared DB tidy.
 */

const D20_VERSION_ID = "a0000000-0000-5000-8000-000000000002";

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByTestId("dev-signin").click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 30_000 });
}

async function createCharacter(page: Page, name: string): Promise<string> {
  await page.goto(`/characters/new?systemVersionId=${D20_VERSION_ID}`);
  await page.getByLabel("System version ID").fill(D20_VERSION_ID);
  await page.getByRole("button", { name: "Look up version" }).click();
  await page.getByLabel("Entity").selectOption("character");
  await page.getByLabel("Character name").fill(name);
  await page.getByRole("button", { name: "Create character", exact: true }).click();
  await expect(page).toHaveURL(/\/characters\/[0-9a-f-]+/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name })).toBeVisible({ timeout: 30_000 });
  return page.url().split("/").pop() ?? "";
}

test("player library: list, search, recent, create, duplicate, archive, recover", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signIn(page);
  const name = `Library Hero ${Date.now().toString(36)}`;
  const characterId = await createCharacter(page, name);

  // List: the new character appears with a detail link and a create link.
  await page.goto("/characters");
  await expect(page.getByRole("heading", { name: "Characters" })).toBeVisible({ timeout: 30_000 });
  const row = page.getByTestId(`library-row-${characterId}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.getByRole("link", { name: `Open ${name}` })).toHaveAttribute(
    "href",
    `/characters/${characterId}`,
  );
  await expect(page.getByTestId("character-library-create")).toHaveAttribute("href", "/characters/new");

  // Recent: the freshly created character leads the server-ordered rail.
  await expect(
    page.getByRole("list", { name: "Recently opened" }).getByRole("link", { name }),
  ).toBeVisible();

  // Search: a name fragment matches; nonsense shows the no-match state.
  await page.getByTestId("character-library-search").fill(name.slice(0, 8));
  await expect(page.getByTestId(`library-row-${characterId}`)).toBeVisible();
  await page.getByTestId("character-library-search").fill("no-such-character-zzz");
  await expect(page.getByText("No loaded characters match this search.")).toBeVisible();
  await page.getByTestId("character-library-search").fill("");

  // Duplicate: a second row with the same name appears via the API seam.
  await page.getByRole("button", { name: `Duplicate ${name}` }).click();
  await expect(page.locator(`[data-testid^="library-row-"]`, { hasText: name })).toHaveCount(2, {
    timeout: 30_000,
  });

  // Archive through the existing detail-page tools, then filter archived.
  await row.getByRole("link", { name: `Open ${name}` }).click();
  await expect(page).toHaveURL(`/characters/${characterId}`);
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await page.getByRole("button", { name: "Confirm archive" }).click();
  await expect(page.getByRole("button", { name: "Recover", exact: true })).toBeEnabled({
    timeout: 30_000,
  });

  await page.goto("/characters");
  await expect(page.getByTestId(`library-row-${characterId}`)).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("character-library-lifecycle").selectOption("archived");
  await expect(page.getByTestId(`library-row-${characterId}`)).toContainText("Archived");

  // Recover through the existing tools; the row reads active again.
  await page.getByTestId(`library-row-${characterId}`).getByRole("link", { name: `Open ${name}` }).click();
  await expect(page).toHaveURL(`/characters/${characterId}`);
  await page.getByRole("button", { name: "Recover", exact: true }).click();
  await page.getByRole("button", { name: "Confirm recover" }).click();
  await expect(page.getByRole("button", { name: "Archive", exact: true })).toBeEnabled({
    timeout: 30_000,
  });

  await page.goto("/characters");
  await page.getByTestId("character-library-lifecycle").selectOption("active");
  await expect(page.getByTestId(`library-row-${characterId}`)).toContainText("Active");
});
