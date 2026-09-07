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
 * Task 11 tab coordination: two pages in one context contend for the real
 * Web Lock (`character:{actor}:{character}`), the second page stays
 * read-only, and closing the owner lets the second page take over and drain
 * the durable queue — including a lost-response retry — with exactly one
 * persisted effect.
 */
test.describe("tab coordination over real web locks", () => {
  test("two pages contend; loser is read-only; takeover drains once", async ({ browser }) => {
    test.setTimeout(180_000);
    const system = D20_REFERENCE_SYSTEM;
    const { context, userId } = await newSignedInContext(browser, TEST_USER_A.code);
    try {
      const setup = await context.newPage();
      const characterName = `Coord ${Date.now().toString(36)}`;
      const { characterId } = await createCharacter(setup.request, {
        systemVersionId: system.systemVersionId,
        name: characterName,
      });
      await setup.close();

      const lockKey = `character:${userId}:${characterId}`;
      const deepLink = `/characters/${characterId}`;

      const first = await context.newPage();
      await first.setViewportSize({ width: 360, height: 740 });
      await first.goto(deepLink);
      await expectSheetReady(first, characterName);
      await expectOfflineAvailable(first);
      const before = await readCharacter(first.request, characterId);
      const initialHealth = (before.character.state.values.health as { current: number }).current;

      // Owner edits: resource controls enabled.
      await expect(first.getByRole("button", { name: system.decreaseButton })).toBeEnabled();

      // Real Web Lock proof: a contending request with `ifAvailable` fails
      // while the first page owns the lock.
      const contended = await first.evaluate(async key => {
        const result = await navigator.locks.request(key, { ifAvailable: true }, async lock => (lock ? "granted" : "denied"));
        return result;
      }, lockKey);
      expect(contended).toBe("denied");

      // Second page opens the same character: it must not edit.
      const second = await context.newPage();
      await second.setViewportSize({ width: 360, height: 740 });
      await second.goto(deepLink);
      await expectSheetReady(second, characterName);
      const secondPageEditingEnabled = await second
        .getByRole("button", { name: system.decreaseButton })
        .isEnabled();
      expect(secondPageEditingEnabled).toBe(false);

      // Owner queues one offline edit, then is closed mid-uncertainty: the
      // frozen attempt must survive takeover by the second page.
      await context.setOffline(true);
      await first.getByRole("button", { name: system.decreaseButton }).click();
      await expect(first.getByText("Changes pending")).toBeVisible({ timeout: 15_000 });
      await first.close();

      // Takeover: reload the second page so it acquires the released lock.
      await second.reload();
      await expectSheetReady(second, characterName);
      await expect(second.getByText("Changes pending")).toBeVisible({ timeout: 30_000 });

      // Lost response on the first post-takeover sync; the identical frozen
      // request retries and applies exactly once.
      let abortedFirst = false;
      await second.route("**/characters/*/resources/*/bump", async route => {
        if (!abortedFirst) {
          abortedFirst = true;
          await route.abort("failed");
          return;
        }
        await route.continue();
      });
      await context.setOffline(false);
      try {
        await expect(second.getByText("Saved", { exact: true })).toBeVisible({ timeout: 60_000 });
        expect(abortedFirst).toBe(true);
        const after = await readCharacter(second.request, characterId);
        expect(after.character.revision).toBe(before.character.revision + 1);
        expect((after.character.state.values.health as { current: number }).current).toBe(
          initialHealth - 1,
        );
        // Takeover granted editing to the second page.
        await expect(second.getByRole("button", { name: system.decreaseButton })).toBeEnabled();
      } finally {
        await second.unrouteAll({ behavior: "wait" }).catch(() => {});
        await second.close().catch(() => {});
      }
    } finally {
      await context.setOffline(false).catch(() => {});
      await context.close();
    }
  });

  test("independent users use separate contexts and stay isolated", async ({ browser }) => {
    const system = D20_REFERENCE_SYSTEM;
    const first = await newSignedInContext(browser, TEST_USER_A.code);
    const second = await newSignedInContext(browser, TEST_USER_B.code);
    try {
      expect(first.userId).not.toBe(second.userId);
      const setup = await first.context.newPage();
      const { characterId } = await createCharacter(setup.request, {
        systemVersionId: system.systemVersionId,
        name: `Isolated ${Date.now().toString(36)}`,
      });
      await setup.close();
      // User B must not read user A's owner-only character.
      const probe = await second.context.newPage();
      const response = await probe.request.get(`/api/characters/${characterId}`);
      expect(response.status()).toBe(404);
      await probe.close();
      // User A still can.
      const owner = await first.context.newPage();
      await testSignIn(owner.request, TEST_USER_A.code);
      const reread = await owner.request.get(`/api/characters/${characterId}`);
      expect(reread.status()).toBe(200);
      await owner.close();
    } finally {
      await first.context.close();
      await second.context.close();
    }
  });
});
