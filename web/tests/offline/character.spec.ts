import { test, expect } from "@playwright/test";

import {
  REFERENCE_SYSTEMS,
  TEST_USER_A,
  createCharacter,
  expectNoHorizontalOverflow,
  expectOfflineAvailable,
  expectSheetReady,
  newSignedInContext,
  readActivity,
  readCharacter,
  testSignIn,
  type ReferenceSystem,
} from "./test-auth.js";

/**
 * Task 11 full acceptance: at 360 px, for every reference system, create a
 * character, wait for offline readiness, queue a resource edit offline, close
 * and reopen the deep link in the same context while offline, reconnect
 * (surviving one lost response with an identical retry), and assert the
 * final persisted revision/activity/resource values show exactly one effect.
 */
test.describe("offline character play and recovery", () => {
  for (const system of REFERENCE_SYSTEMS) {
    test(`full acceptance at 360px (${system.key}): offline edit survives close/reopen with one persisted effect`, async ({
      browser,
    }) => {
      test.setTimeout(180_000);
      const { context, userId } = await newSignedInContext(browser, TEST_USER_A.code);
      expect(userId.length).toBeGreaterThan(0);
      try {
        await runAcceptance(context, system);
      } finally {
        await context.close();
      }
    });
  }

  test("production UI exposes no dev sign-in", async ({ browser }) => {
    const { context } = await newSignedInContext(browser, TEST_USER_A.code);
    try {
      const page = await context.newPage();
      await page.goto("/");
      await expect(page.getByTestId("app-header")).toBeVisible();
      await expect(page.getByTestId("dev-signin")).toHaveCount(0);
      await expect(page.getByTestId("dev-signin-panel")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});

async function runAcceptance(
  context: import("@playwright/test").BrowserContext,
  system: ReferenceSystem,
) {
  await context.clearCookies().catch(() => {});
  // Re-authenticate after the cookie clear: the fixture posts through the
  // existing test-identity endpoint, never a production synthetic user.
  const authProbe = await context.newPage();
  await testSignIn(authProbe.request, TEST_USER_A.code);
  await authProbe.close();

  const characterName = `Offline ${system.key} ${Date.now().toString(36)}`;
  const created = await createCharacter((await context.newPage()).request, {
    systemVersionId: system.systemVersionId,
    name: characterName,
  });
  // Close the helper page used for API setup; the test below uses one page
  // at a time so lock ownership stays unambiguous.
  for (const p of context.pages()) await p.close();

  const page = await context.newPage();
  await page.setViewportSize({ width: 360, height: 740 });
  const deepLink = `/characters/${created.characterId}`;
  await page.goto(deepLink);
  await expectSheetReady(page, characterName);

  // The production build must not offer dev sign-in, even on the sheet.
  await expect(page.getByTestId("dev-signin")).toHaveCount(0);

  const before = await readCharacter(page.request, created.characterId);
  const initialResource = resourceCurrent(before, system.resourceId);

  // Offline readiness: durable snapshot plus controlling worker cache.
  await expectOfflineAvailable(page);
  await expectNoHorizontalOverflow(page);

  // Queue one resource step offline. Direction depends on the fixture
  // default (d20 Health 10/10 can decrease; Harm/Stress start at min 0).
  const bumpDown = initialResource > 0;
  const bumpButton = bumpDown ? system.decreaseButton : system.increaseButton;
  await context.setOffline(true);
  try {
    await page.getByRole("button", { name: bumpButton }).click();
    await expect(page.getByText("Changes pending")).toBeVisible({ timeout: 15_000 });
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: `test-results/offline-${system.key}-360-pending.png` });

    // Close and reopen the deep link in the SAME context while offline:
    // IndexedDB persistence must restore queue and state.
    const url = page.url();
    await page.close();
    const reopened = await context.newPage();
    try {
      await reopened.setViewportSize({ width: 360, height: 740 });
      await reopened.goto(url);
      await expectSheetReady(reopened, characterName);
      await expect(reopened.getByText("Changes pending")).toBeVisible({ timeout: 30_000 });
      await expect(reopened.getByText("Available offline", { exact: true })).toBeVisible({
        timeout: 30_000,
      });

      // Reconnect with one lost response: abort the first bump attempt so the
      // client must retry the identical frozen request (same idempotency key).
      // I1: capture both attempt bodies and assert the frozen request is
      // replayed verbatim (identical idempotencyKey + body).
      let abortedFirst = false;
      const bumpAttempts: Array<{ url: string; body: unknown }> = [];
      await reopened.route("**/characters/*/resources/*/bump", async route => {
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
      await expect(reopened.getByText("Saved", { exact: true })).toBeVisible({ timeout: 60_000 });
      expect(abortedFirst).toBe(true);
      await reopened.unrouteAll({ behavior: "wait" });
      // Same frozen request replayed: at least retry, identical key + body.
      expect(bumpAttempts.length).toBeGreaterThanOrEqual(2);
      const firstBump = bumpAttempts[0]!.body as { idempotencyKey?: unknown };
      const secondBump = bumpAttempts[1]!.body as { idempotencyKey?: unknown };
      expect(firstBump?.idempotencyKey).toBeDefined();
      expect(secondBump?.idempotencyKey).toBe(firstBump?.idempotencyKey);
      expect(secondBump).toEqual(firstBump);

      // Final persisted values: exactly one resource effect.
      const after = await readCharacter(reopened.request, created.characterId);
      expect(after.character.revision).toBe(before.character.revision + 1);
      const expected = bumpDown ? initialResource - 1 : initialResource + 1;
      expect(resourceCurrent(after, system.resourceId)).toBe(expected);

      const activity = await readActivity(reopened.request, created.characterId);
      const bumpEvents = activity.events.filter(e => e.kind === "character_resource_bumped");
      // I2: revision +1 already proves single effect; exactly one row proves
      // no double-apply across the abort+retry window.
      expect(bumpEvents.length).toBe(1);

      // Abort landed pre-apply (client-side failure never reached the
      // server), so additionally prove the frozen key is idempotent: replay
      // the captured frozen body server-side — it must return replayed
      // without a second effect (revision still +1, still one activity row).
      const replayFrozen = await reopened.request.post(
        `/api/characters/${created.characterId}/resources/${system.resourceId}/bump`,
        { data: firstBump },
      );
      expect(replayFrozen.status()).toBe(200);
      const replayJson = (await replayFrozen.json()) as {
        result: { character: { revision: number; reconciliation: { replayed: boolean } } };
      };
      expect(replayJson.result.character.reconciliation.replayed).toBe(true);
      expect(replayJson.result.character.revision).toBe(before.character.revision + 1);
      const activityAfterReplay = await readActivity(reopened.request, created.characterId);
      expect(
        activityAfterReplay.events.filter(e => e.kind === "character_resource_bumped").length,
      ).toBe(1);

      await expectNoHorizontalOverflow(reopened);
      await reopened.screenshot({ path: `test-results/offline-${system.key}-360-synced.png` });
    } finally {
      await reopened.close().catch(() => {});
    }
  } finally {
    await context.setOffline(false).catch(() => {});
  }
}

function resourceCurrent(
  envelope: { character: { state: { values: Record<string, unknown> } } },
  resourceId: string,
): number {
  const raw = envelope.character.state.values[resourceId] as { current?: unknown } | undefined;
  if (typeof raw?.current !== "number") {
    throw new Error(`resource ${resourceId} has no numeric current value`);
  }
  return raw.current;
}
