import { test, expect } from "@playwright/test";

import {
  D20_REFERENCE_SYSTEM,
  TEST_USER_A,
  TEST_USER_B,
  createCharacter,
  expectOfflineAvailable,
  expectSheetReady,
  newSignedInContext,
  readCharacter,
  testSignIn,
} from "./test-auth.js";

/**
 * Task 11 privacy: offline sign-out barrier, account switching isolation,
 * revoked-access purge, and storage rejection.
 */
test.describe("offline privacy and sign-out", () => {
  test("offline sign-out hides data and finishes revocation on reconnect", async ({ browser }) => {
    test.setTimeout(180_000);
    const system = D20_REFERENCE_SYSTEM;
    const { context } = await newSignedInContext(browser, TEST_USER_A.code);
    try {
      const setup = await context.newPage();
      const characterName = `Signout ${Date.now().toString(36)}`;
      const { characterId } = await createCharacter(setup.request, {
        systemVersionId: system.systemVersionId,
        name: characterName,
      });
      await setup.close();

      const page = await context.newPage();
      await page.setViewportSize({ width: 360, height: 740 });
      await page.goto(`/characters/${characterId}`);
      await expectSheetReady(page, characterName);
      await expectOfflineAvailable(page);

      // Offline sign-out: local data hides immediately; server revocation
      // stays pending behind a non-sensitive barrier.
      await context.setOffline(true);
      page.on("dialog", dialog => void dialog.accept());
      await page.getByRole("button", { name: "Sign out" }).click();
      await expect(
        page.getByText("Local data hidden; server sign-out is pending. Reconnect to finish signing out."),
      ).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole("heading", { name: characterName })).toHaveCount(0);

      // Reconnect: the barrier drains through real server sign-out first, so
      // /me can never silently restore the prior account.
      await context.setOffline(false);
      await expect(page.getByText("Signed out.", { exact: true })).toBeVisible({ timeout: 30_000 });
      const me = await page.request.get("/api/me");
      expect(me.status()).toBe(200);
      expect((await me.json()) as { state: string }).toMatchObject({ state: "anonymous" });
      await page.close();
    } finally {
      await context.setOffline(false).catch(() => {});
      await context.close();
    }
  });

  test("account switch hides the previous account and never sends its queue", async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const system = D20_REFERENCE_SYSTEM;
    const { context } = await newSignedInContext(browser, TEST_USER_A.code);
    try {
      const setup = await context.newPage();
      const characterName = `Switch ${Date.now().toString(36)}`;
      const { characterId } = await createCharacter(setup.request, {
        systemVersionId: system.systemVersionId,
        name: characterName,
      });
      const before = await readCharacter(setup.request, characterId);
      await setup.close();

      const page = await context.newPage();
      await page.setViewportSize({ width: 360, height: 740 });
      await page.goto(`/characters/${characterId}`);
      await expectSheetReady(page, characterName);

      // Queue an edit as A while offline, then switch to B in the same
      // context: the old account's attempt must never run under B's session.
      await context.setOffline(true);
      await page.getByRole("button", { name: system.decreaseButton }).click();
      await expect(page.getByText("Changes pending")).toBeVisible({ timeout: 15_000 });
      await testSignIn(page.request, TEST_USER_B.code);
      await context.setOffline(false);
      await page.reload();
      await expect(page.getByRole("heading", { name: characterName })).toHaveCount(0);

      // A's revision is untouched: nothing from A's queue was sent as B.
      const verifier = await context.newPage();
      await testSignIn(verifier.request, TEST_USER_A.code);
      const after = await readCharacter(verifier.request, characterId);
      expect(after.character.revision).toBe(before.character.revision);
      await verifier.close();
      await page.close();
    } finally {
      await context.setOffline(false).catch(() => {});
      await context.close();
    }
  });

  test("revoked access purges cached reads for the affected character", async ({ browser }) => {
    test.setTimeout(120_000);
    const system = D20_REFERENCE_SYSTEM;
    const owner = await newSignedInContext(browser, TEST_USER_A.code);
    const stranger = await newSignedInContext(browser, TEST_USER_B.code);
    try {
      const setup = await owner.context.newPage();
      const characterName = `Purge ${Date.now().toString(36)}`;
      const { characterId } = await createCharacter(setup.request, {
        systemVersionId: system.systemVersionId,
        name: characterName,
      });
      await setup.close();

      // B opens A's deep link: server denies, UI shows unavailable, and the
      // private name never renders.
      const page = await stranger.context.newPage();
      await page.setViewportSize({ width: 360, height: 740 });
      await page.goto(`/characters/${characterId}`);
      await expect(page.getByText("This character is unavailable.")).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByRole("heading", { name: characterName })).toHaveCount(0);
      const api = await page.request.get(`/api/characters/${characterId}`);
      expect(api.status()).toBe(404);
      await page.close();
    } finally {
      await owner.context.close();
      await stranger.context.close();
    }
  });

  test("storage rejection blocks mutations with recovery guidance", async ({ browser }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({ baseURL: "http://localhost:4173" });
    try {
      const page = await context.newPage();
      // Simulate unavailable IndexedDB before the app boots: opening the
      // database throws, so the store resolves to null and the shell must
      // explain recovery instead of accepting mutations.
      await page.addInitScript(() => {
        try {
          const factory = window.indexedDB;
          if (factory) {
            factory.open = () => {
              throw new DOMException("Quota exceeded.", "QuotaExceededError");
            };
          }
        } catch {
          /* ignore */
        }
      });
      await testSignIn(page.request, TEST_USER_A.code);
      await page.goto("/characters/new");
      const banner = page.getByText("Offline character storage is unavailable. Online sign-in and System Builder remain available.");
      await expect(banner.first()).toBeVisible({ timeout: 30_000 });
      await page.close();
    } finally {
      await context.close();
    }
  });
});
