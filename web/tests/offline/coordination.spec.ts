import { test, expect } from "@playwright/test";

import {
  D20_REFERENCE_SYSTEM,
  TEST_USER_A,
  TEST_USER_B,
  createCharacter,
  expectOfflineAvailable,
  expectSheetReady,
  newSignedInContext,
  readActivity,
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
      // request retries and applies exactly once (I1: identical key + body).
      let abortedFirst = false;
      const bumpAttempts: Array<{ url: string; body: unknown }> = [];
      await second.route("**/characters/*/resources/*/bump", async route => {
        try {
          bumpAttempts.push({ url: route.request().url(), body: route.request().postDataJSON() });
        } catch {
          bumpAttempts.push({ url: route.request().url(), body: null });
        }
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
        expect(bumpAttempts.length).toBeGreaterThanOrEqual(2);
        const firstBump = bumpAttempts[0]!.body as { idempotencyKey?: unknown };
        const secondBump = bumpAttempts[1]!.body as { idempotencyKey?: unknown };
        expect(firstBump?.idempotencyKey).toBeDefined();
        expect(secondBump?.idempotencyKey).toBe(firstBump?.idempotencyKey);
        expect(secondBump).toEqual(firstBump);
        const after = await readCharacter(second.request, characterId);
        expect(after.character.revision).toBe(before.character.revision + 1);
        expect((after.character.state.values.health as { current: number }).current).toBe(
          initialHealth - 1,
        );
        // I2: exactly one bump row proves no double-apply across abort+retry.
        const activity = await readActivity(second.request, characterId);
        expect(activity.events.filter(e => e.kind === "character_resource_bumped").length).toBe(1);
        // Frozen-key idempotence: replaying the captured body must not add
        // a second effect.
        const replayFrozen = await second.request.post(
          `/api/characters/${characterId}/resources/health/bump`,
          { data: firstBump },
        );
        expect(replayFrozen.status()).toBe(200);
        const replayJson = (await replayFrozen.json()) as {
          result: { character: { revision: number; reconciliation: { replayed: boolean } } };
        };
        expect(replayJson.result.character.reconciliation.replayed).toBe(true);
        expect(replayJson.result.character.revision).toBe(before.character.revision + 1);
        const activityAfter = await readActivity(second.request, characterId);
        expect(activityAfter.events.filter(e => e.kind === "character_resource_bumped").length).toBe(1);
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

  test("visible takeover during an uncertain response: owner quiesces, never two owners", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const system = D20_REFERENCE_SYSTEM;
    const { context } = await newSignedInContext(browser, TEST_USER_A.code);
    try {
      const setup = await context.newPage();
      const characterName = `Takeover ${Date.now().toString(36)}`;
      const { characterId } = await createCharacter(setup.request, {
        systemVersionId: system.systemVersionId,
        name: characterName,
      });
      await setup.close();

      const deepLink = `/characters/${characterId}`;
      const first = await context.newPage();
      await first.setViewportSize({ width: 360, height: 740 });
      await first.goto(deepLink);
      await expectSheetReady(first, characterName);
      await expectOfflineAvailable(first);
      const before = await readCharacter(first.request, characterId);
      const initialHealth = (before.character.state.values.health as { current: number }).current;
      await expect(first.getByText("Editing in this tab.")).toBeVisible();

      // Make the owner's bump response uncertain: applied on the server,
      // withheld from the page, replays held so it stays unresolved.
      let withheldOnce = false;
      await first.route("**/characters/*/resources/*/bump", async route => {
        if (!withheldOnce) {
          withheldOnce = true;
          const response = await route.fetch();
          expect(response.ok()).toBe(true);
          await route.abort("failed");
          return;
        }
        await route.abort("failed");
      });
      await first.getByRole("button", { name: system.decreaseButton }).click();
      await expect(first.getByText("Confirming the last change…")).toBeVisible({ timeout: 30_000 });
      expect(withheldOnce).toBe(true);

      // Second page opens the same character while the owner is uncertain:
      // real two-page contention, owner stays open.
      const second = await context.newPage();
      await second.setViewportSize({ width: 360, height: 740 });
      await second.goto(deepLink);
      await expectSheetReady(second, characterName);
      await expect(second.getByText("Read-only in this tab.")).toBeVisible({ timeout: 30_000 });

      // Sample ownership on both pages while the visible request control
      // runs: assert never two owners/senders at any instant.
      const bothEditing: boolean[] = [];
      const sampler = (async () => {
        for (let i = 0; i < 60; i++) {
          const [firstEditing, secondEditing] = await Promise.all([
            first.getByText("Editing in this tab.").isVisible().catch(() => false),
            second.getByText("Editing in this tab.").isVisible().catch(() => false),
          ]);
          bothEditing.push(firstEditing && secondEditing);
          if (!firstEditing && secondEditing) break;
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      })();
      await second.getByRole("button", { name: "Request editing access" }).click();
      await sampler;
      expect(bothEditing.length).toBeGreaterThan(0);
      expect(bothEditing.every(both => both === false)).toBe(true);

      // Takeover completed: the second page edits, the first is read-only.
      await expect(second.getByText("Editing in this tab.")).toBeVisible({ timeout: 60_000 });
      await expect(first.getByText("Read-only in this tab.")).toBeVisible({ timeout: 60_000 });
      await expect(second.getByRole("button", { name: system.decreaseButton })).toBeEnabled();

      // The frozen attempt survives under the new owner and applies exactly
      // once when replays succeed.
      await first.unrouteAll({ behavior: "wait" }).catch(() => {});
      await expect(second.getByText("Saved", { exact: true })).toBeVisible({ timeout: 60_000 });
      const after = await readCharacter(second.request, characterId);
      expect(after.character.revision).toBe(before.character.revision + 1);
      expect((after.character.state.values.health as { current: number }).current).toBe(initialHealth - 1);
      const activity = await readActivity(second.request, characterId);
      expect(activity.events.filter(e => e.kind === "character_resource_bumped")).toHaveLength(1);

      await first.close().catch(() => {});
      await second.close().catch(() => {});
    } finally {
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
