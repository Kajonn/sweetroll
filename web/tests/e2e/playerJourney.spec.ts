import { test, expect, type Page } from "@playwright/test";

import { exportCharacter, publishOwnedClone, readActivity } from "../offline/test-auth.js";

/**
 * G6 Task 7 exit demonstration (dev-server E2E): onboarding -> system select
 * -> create + play two characters -> recent find -> connection loss ->
 * export -> sign-out clears data.
 *
 * Needs a live backend per web/playwright.config.ts (migrate + dev:http and
 * web:dev, with DATABASE_URL pointing at Postgres). Created characters have
 * no DELETE endpoint (character-sheet.spec.ts precedent); unique names per
 * run keep the shared DB tidy. The owned-clone fixture goes through the real
 * System Builder API because the seeded reference templates are
 * link-access/unlisted (OD-01): versionless enumeration never offers them,
 * so the picker can only select an actor-owned system. Every character
 * action below runs in the page; the fixture only publishes the system.
 */

const D20_VERSION_ID = "a0000000-0000-5000-8000-000000000002";
const ONBOARDING_ANONYMOUS = "sweetroll:onboarding:anonymous";

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByTestId("dev-signin").click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 30_000 });
}

/** UI creation through the versionless picker without typing any version ID. */
async function createViaPicker(page: Page, versionId: string, name: string): Promise<string> {
  await page.goto("/characters/new");
  await expect(page.getByRole("heading", { name: "Choose a system version" })).toBeVisible({
    timeout: 30_000,
  });
  const choice = page.locator("li", { has: page.locator(`span[title="${versionId}"]`) }).getByRole("button");
  await expect(choice).toContainText("D20 System 1.0.0");
  await choice.click();
  // The picker fills the manual box with the chosen owned version, so the
  // unchanged lookup/create path below runs on the clone.
  await expect(page.getByLabel("System version ID", { exact: true })).toHaveValue(versionId);
  await page.getByLabel("Entity").selectOption("character");
  await page.getByLabel("Character name").fill(name);
  await page.getByRole("button", { name: "Create character", exact: true }).click();
  await expect(page).toHaveURL(/\/characters\/[0-9a-f-]+/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name })).toBeVisible({ timeout: 30_000 });
  return page.url().split("/").pop() ?? "";
}

async function expectSaved(page: Page) {
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 60_000 });
}

/** Complete d20's native required `Proficient` field through the completion section. */
async function completeProficient(page: Page) {
  const completionHeading = page.getByRole("heading", { name: "Complete Your Character" });
  await expect(completionHeading).toBeVisible({ timeout: 30_000 });
  const box = page.locator("section", { has: completionHeading }).getByRole("checkbox", {
    name: "Proficient",
  });
  // The commit right after navigation can race session startup: retry until
  // the checked state sticks, then wait for Saved.
  await expect(async () => {
    if (!(await box.isChecked())) await box.click();
    expect(await box.isChecked()).toBe(true);
  }).toPass({ timeout: 30_000 });
  await expectSaved(page);
}

test("I5 exit: sign in on phone, select system, create+play two characters, find recent, survive offline, export, sign out clears data", async ({
  page,
}) => {
  test.setTimeout(420_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const stamp = Date.now().toString(36);
  const nameA = `Exit Hero A ${stamp}`;
  const nameB = `Exit Hero B ${stamp}`;

  // 1. /welcome onboarding: welcome copy plus entries to creation and the
  // library; dismissing persists the flag without blocking sign-in.
  await page.goto("/");
  await page.evaluate(key => window.localStorage.removeItem(key), ONBOARDING_ANONYMOUS);
  await page.goto("/welcome");
  await expect(page.getByTestId("onboarding")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Welcome to Sweetroll" })).toBeVisible();
  await expect(page.getByTestId("welcome-create")).toHaveAttribute("href", "/characters/new");
  await expect(page.getByTestId("welcome-library")).toHaveAttribute("href", "/characters");
  await page.getByTestId("welcome-dismiss").click();
  await expect
    .poll(async () => page.evaluate(key => window.localStorage.getItem(key), ONBOARDING_ANONYMOUS))
    .toBe("1");

  // 2. Sign in on the phone, then publish the actor-owned clone the picker
  // is allowed to enumerate (reference seeds stay unlisted per OD-01).
  await signIn(page);
  const ownedVersionId = await publishOwnedClone(page.request, D20_VERSION_ID);

  // 3. Picker select (no ID typed) -> create hero A -> play (bump + roll).
  const characterA = await createViaPicker(page, ownedVersionId, nameA);
  expect(characterA).toMatch(/[0-9a-f-]{36}/);
  await completeProficient(page);
  await page.getByRole("button", { name: "Decrease Health" }).click();
  await expectSaved(page);
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Roll result" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Total", { exact: true })).toBeVisible();

  // 4. Create hero B through the same picker, then play it with a bump.
  const characterB = await createViaPicker(page, ownedVersionId, nameB);
  expect(characterB).toMatch(/[0-9a-f-]{36}/);
  await page.getByRole("button", { name: "Decrease Health" }).click();
  await expectSaved(page);

  // 5. /characters recent shows both; open A from the recent rail.
  await page.goto("/characters");
  await expect(page.getByRole("heading", { name: "Characters" })).toBeVisible({ timeout: 30_000 });
  // Both detail visits above did not pass through the library, so open each
  // once from the list to seed the recently-opened rail, then read it back.
  await page.getByTestId(`library-row-${characterB}`).getByRole("link", { name: `Open ${nameB}` }).click();
  await expect(page).toHaveURL(`/characters/${characterB}`);
  await page.goto("/characters");
  await expect(page.getByTestId(`library-row-${characterA}`)).toBeVisible({ timeout: 30_000 });
  await page.getByTestId(`library-row-${characterA}`).getByRole("link", { name: `Open ${nameA}` }).click();
  await expect(page).toHaveURL(`/characters/${characterA}`);
  await page.goto("/characters");
  const recent = page.getByRole("list", { name: "Recently opened" });
  await expect(recent.getByRole("link", { name: nameA })).toBeVisible({ timeout: 30_000 });
  await expect(recent.getByRole("link", { name: nameB })).toBeVisible();
  await page.screenshot({ path: `tests/e2e/evidence/exit-library-recent-390-${stamp}.png` });
  await recent.getByRole("link", { name: nameA }).click();
  await expect(page).toHaveURL(`/characters/${characterA}`);

  // 6. Offline edit -> reconnect with no dupes: exactly one more bump event.
  await page.context().setOffline(true);
  try {
    await page.getByRole("button", { name: "Increase Health" }).click();
    await expect(page.getByText("Changes pending")).toBeVisible({ timeout: 30_000 });
  } finally {
    await page.context().setOffline(false);
  }
  await expectSaved(page);
  const activity = await readActivity(page.request, characterA);
  expect(activity.events.filter(e => e.kind === "character_resource_bumped")).toHaveLength(2);
  await page.goto("/characters");
  await expect(page.locator('[data-testid^="library-row-"]', { hasText: nameA })).toHaveCount(1);

  // 7. Export A: capture the download and compare it with the authoritative
  // server export document.
  await page.getByTestId(`library-row-${characterA}`).getByRole("link", { name: `Open ${nameA}` }).click();
  await expect(page).toHaveURL(`/characters/${characterA}`);
  await page.getByRole("button", { name: "Export" }).click();
  const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
  await page.getByRole("button", { name: "Download export" }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error("export download produced no file");
  const { readFile } = await import("node:fs/promises");
  const downloaded = JSON.parse(await readFile(downloadPath, "utf8")) as unknown;
  expect(downloaded).toEqual(await exportCharacter(page.request, characterA));

  // 8. Sign out clears private data: protected views unmount (dev panel
  // returns), the library prompt carries no cached names, the recent rail is
  // gone, no stored value retains either name, and a reload stays clean.
  page.on("dialog", dialog => void dialog.accept());
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByTestId("dev-signin")).toBeVisible({ timeout: 30_000 });
  await page.goto("/characters");
  await expect(page.getByTestId("dev-signin")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(nameA)).toHaveCount(0);
  await expect(page.getByText(nameB)).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Recently opened" })).toHaveCount(0);
  const stored = await page.evaluate(() => {
    const values: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key) values.push(window.localStorage.getItem(key) ?? "");
    }
    return values.join("\n");
  });
  expect(stored).not.toContain(nameA);
  expect(stored).not.toContain(nameB);
  await page.reload();
  await expect(page.getByTestId("dev-signin")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(nameA)).toHaveCount(0);
  await expect(page.getByText(nameB)).toHaveCount(0);
});
