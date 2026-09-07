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

  test("prior owner cache is purged after server-side ownership transfer", async ({ browser }) => {
    test.setTimeout(180_000);
    const system = D20_REFERENCE_SYSTEM;
    const owner = await newSignedInContext(browser, TEST_USER_A.code);
    const nextOwner = await newSignedInContext(browser, TEST_USER_B.code);
    try {
      const setup = await owner.context.newPage();
      const characterName = `Revoke ${Date.now().toString(36)}`;
      const { characterId } = await createCharacter(setup.request, {
        systemVersionId: system.systemVersionId,
        name: characterName,
      });
      const before = await readCharacter(setup.request, characterId);
      await setup.close();

      // Cache as owner: open the sheet until offline-ready (durable
      // snapshot + worker cache), then queue one offline bump so both a
      // snapshot and a queued attempt exist locally.
      const page = await owner.context.newPage();
      await page.setViewportSize({ width: 360, height: 740 });
      await page.goto(`/characters/${characterId}`);
      await expectSheetReady(page, characterName);
      await expectOfflineAvailable(page);
      await owner.context.setOffline(true);
      await page.getByRole("button", { name: system.decreaseButton }).click();
      await expect(page.getByText("Changes pending")).toBeVisible({ timeout: 15_000 });

      // Hold the queued bump (abort sync attempts) while transferring
      // ownership server-side as the current owner, so the queue cannot
      // drain before revocation.
      await owner.context.setOffline(false);
      await page.route("**/characters/*/resources/*/bump", route => void route.abort("failed"));
      const transfer = await page.request.post(`/api/characters/${characterId}/ownership-transfer`, {
        data: {
          toUserId: nextOwner.userId,
          expectedRevision: before.character.revision,
          idempotencyKey: `revoke-${Date.now().toString(36)}`,
        },
      });
      expect(transfer.status()).toBe(200);

      // Reconnect as the prior owner: the next sync must observe the
      // purge disposition, drop local snapshot + queue, and never leak
      // the private name.
      await page.unrouteAll({ behavior: "wait" }).catch(() => {});
      await page.reload();
      await expect(page.getByText("This character is unavailable.")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("heading", { name: characterName })).toHaveCount(0);
      await expect(page.getByText("Changes pending")).toHaveCount(0);
      const bodyText = (await page.content()) ?? "";
      expect(bodyText).not.toContain(characterName);
      const api = await page.request.get(`/api/characters/${characterId}`);
      expect(api.status()).toBe(404);
      expect(((await api.json()) as { error: { cacheDisposition: string } }).error.cacheDisposition).toBe(
        "purge",
      );

      // Queue is deleted, not sent: the new owner still sees the
      // pre-transfer revision (no bump effect leaked through).
      const verifier = await nextOwner.context.newPage();
      await testSignIn(verifier.request, TEST_USER_B.code);
      const afterTransfer = await readCharacter(verifier.request, characterId);
      expect(afterTransfer.character.revision).toBe(before.character.revision + 1);
      await verifier.close();

      // Snapshot is deleted: a fresh page in the prior-owner context still
      // shows unavailable (never the cached name), even after reload.
      const fresh = await owner.context.newPage();
      await fresh.goto(`/characters/${characterId}`);
      await expect(fresh.getByText("This character is unavailable.")).toBeVisible({ timeout: 30_000 });
      await expect(fresh.getByRole("heading", { name: characterName })).toHaveCount(0);
      await fresh.close();
      await page.close();
    } finally {
      await owner.context.setOffline(false).catch(() => {});
      await owner.context.close();
      await nextOwner.context.close();
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
