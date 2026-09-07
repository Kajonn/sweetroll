import { test, expect, type Page } from "@playwright/test";

import {
  D20_REFERENCE_SYSTEM,
  PREVIEW_ORIGIN,
  TEST_USER_A,
  TEST_USER_B,
  apiBump,
  createCharacter,
  expectOfflineAvailable,
  expectSheetReady,
  newSignedInContext,
  readActivity,
  readCharacter,
  testSignIn,
} from "./test-auth.js";

/**
 * Task 8 privacy: offline sign-out barrier, account switching isolation,
 * revoked-access purge, and storage rejection.
 */

/** Scope to the explicit conflict-review surface (excludes sheet controls). */
function reviewSection(page: Page) {
  return page.locator("section", { has: page.getByRole("heading", { name: "Review conflicts" }) });
}
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
    const context = await browser.newContext({ baseURL: PREVIEW_ORIGIN });
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

  test("sign-out during delayed creation never completes under the disposed lifetime", async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const system = D20_REFERENCE_SYSTEM;
    const { context } = await newSignedInContext(browser, TEST_USER_A.code);
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width: 360, height: 740 });
      await page.goto(`/characters/new?systemVersionId=${system.systemVersionId}`);
      await page.getByLabel("System version ID").fill(system.systemVersionId);
      await page.getByRole("button", { name: "Look up version" }).click();
      await page.getByLabel("Entity").selectOption("character");
      const characterName = `SignoutCreate ${Date.now().toString(36)}`;
      await page.getByLabel("Character name").fill(characterName);

      // Hold the creation response, then sign out through the real UI
      // control mid-flight: the disposed lifetime must never navigate or
      // expose the late response.
      let release!: () => void;
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });
      await page.route("**/api/characters", async route => {
        if (route.request().method() !== "POST") {
          await route.continue();
          return;
        }
        await gate;
        await route.continue();
      });
      await page.getByRole("button", { name: "Create character", exact: true }).click();
      await page.waitForTimeout(500);
      page.on("dialog", dialog => void dialog.accept());
      await page.getByRole("button", { name: "Sign out" }).click();
      await expect(
        page.getByText("Signed out.", { exact: true }).or(page.getByText(/server sign-out is pending/i)),
      ).toBeVisible({ timeout: 30_000 });
      release();
      await page.waitForTimeout(3_000);
      await expect(page).not.toHaveURL(/\/characters\/[0-9a-f-]+/);
      await expect(page.getByRole("heading", { name: characterName })).toHaveCount(0);
      await page.unrouteAll({ behavior: "wait" }).catch(() => {});

      // The held request raced server-side revocation: either it applied
      // before the session died (an applied-but-unseen create owned by A)
      // or revocation rejected it. In both cases B is isolated and the
      // disposed page never navigated.
      const verifierA = await context.newPage();
      await testSignIn(verifierA.request, TEST_USER_A.code);
      const listAsA = await verifierA.request.get("/api/characters");
      expect(listAsA.status()).toBe(200);
      await verifierA.close();

      const other = await newSignedInContext(browser, TEST_USER_B.code);
      try {
        const probe = await other.context.newPage();
        const listAsB = await probe.request.get("/api/characters");
        expect(listAsB.status()).toBe(200);
        expect(JSON.stringify(await listAsB.json())).not.toContain(characterName);
        await probe.close();
      } finally {
        await other.context.close();
      }
      await page.close();
    } finally {
      await context.close();
    }
  });

  test("storage failure during reapply keeps the queue intact for retry", async ({ browser }) => {
    test.setTimeout(240_000);
    const system = D20_REFERENCE_SYSTEM;
    const { context } = await newSignedInContext(browser, TEST_USER_A.code);
    try {
      const setup = await context.newPage();
      const characterName = `ReapplyFail ${Date.now().toString(36)}`;
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
      const before = await readCharacter(page.request, characterId);

      // Two queued offline edits, then a concurrent server revision so the
      // reconnect ends in explicit review.
      await context.setOffline(true);
      await page.getByRole("button", { name: system.decreaseButton }).click();
      await expect(page.getByText("Changes pending")).toBeVisible({ timeout: 15_000 });
      await page.getByRole("button", { name: system.decreaseButton }).click();
      const writerRevision = await (async () => {
        // The writer needs connectivity: briefly reconnect through a held
        // queue (abort syncs), advance the server, then go offline again.
        await page.route("**/characters/*/resources/*/bump", route => void route.abort("failed"));
        await context.setOffline(false);
        await page.waitForTimeout(1_000);
        const revision = await apiBump(page.request, characterId, system.resourceId, "down", before.character.revision);
        await page.unrouteAll({ behavior: "wait" }).catch(() => {});
        await context.setOffline(true);
        return revision;
      })();
      expect(writerRevision).toBe(before.character.revision + 1);
      await context.setOffline(false);
      await expect(page.getByRole("heading", { name: "Review conflicts" })).toBeVisible({
        timeout: 60_000,
      });

      // Fail the replacement write inside the atomic recovery transaction.
      await page.evaluate(() => {
        const proto = IDBObjectStore.prototype as IDBObjectStore & { __i4Armed?: boolean };
        if (proto.__i4Armed !== undefined) return;
        proto.__i4Armed = true;
        const original = proto.put;
        proto.put = function (this: IDBObjectStore, ...args: [unknown, unknown?]) {
          if ((proto.__i4Armed as boolean) === true) {
            proto.__i4Armed = false;
            throw new DOMException("Quota exceeded.", "QuotaExceededError");
          }
          return (original as (...a: unknown[]) => IDBRequest).apply(this, args);
        };
      });
      for (const checkbox of await reviewSection(page).getByRole("checkbox").all()) {
        await checkbox.check();
      }
      let sentDuringFailure = 0;
      await page.route("**/characters/*/resources/*/bump", async route => {
        sentDuringFailure += 1;
        await route.continue();
      });
      await page.getByRole("button", { name: "Reapply", exact: true }).click();
      await page.getByRole("button", { name: "Confirm reapply" }).click();
      // The failed transaction sends nothing and keeps the review open.
      await page.waitForTimeout(3_000);
      expect(sentDuringFailure).toBe(0);
      await expect(page.getByRole("heading", { name: "Review conflicts" })).toBeVisible({
        timeout: 15_000,
      });
      await page.unrouteAll({ behavior: "wait" }).catch(() => {});

      // A reload clears the injected failure (prototype patch is memory-only)
      // and the intact queue is still explicitly reviewable.
      await page.reload();
      await expect(page.getByRole("heading", { name: "Review conflicts" })).toBeVisible({
        timeout: 60_000,
      });
      for (const checkbox of await reviewSection(page).getByRole("checkbox").all()) {
        await checkbox.check();
      }
      await page.getByRole("button", { name: "Reapply", exact: true }).click();
      await page.getByRole("button", { name: "Confirm reapply" }).click();
      await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 60_000 });
      const after = await readCharacter(page.request, characterId);
      expect(after.character.revision).toBe(writerRevision + 2);
      const activity = await readActivity(page.request, characterId);
      // Exactly the writer bump plus the two reapplied bumps.
      expect(activity.events.filter(e => e.kind === "character_resource_bumped")).toHaveLength(3);
      await page.close();
    } finally {
      await context.setOffline(false).catch(() => {});
      await context.close();
    }
  });

  test("evicted storage visits degrade gracefully and recover online", async ({ browser }) => {    test.setTimeout(180_000);
    const system = D20_REFERENCE_SYSTEM;
    const { context } = await newSignedInContext(browser, TEST_USER_A.code);
    try {
      const setup = await context.newPage();
      const characterName = `Evict ${Date.now().toString(36)}`;
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

      // Simulate browser eviction: delete the account-partitioned database,
      // then reload offline. The app must not crash or leak private state.
      await page.evaluate(() => indexedDB.deleteDatabase("sweetroll-characters"));
      await context.setOffline(true);
      await page.reload();
      await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("heading", { name: characterName })).toHaveCount(0);
      const offlineBody = (await page.content()) ?? "";
      expect(offlineBody).not.toContain(characterName);

      // Back online the character recovers (recaching is best-effort, never
      // promised while offline).
      await context.setOffline(false);
      await page.reload();
      await expectSheetReady(page, characterName);
      await page.close();
    } finally {
      await context.setOffline(false).catch(() => {});
      await context.close();
    }
  });

  test("no private data in CacheStorage or after purge", async ({ browser }) => {
    test.setTimeout(180_000);
    const system = D20_REFERENCE_SYSTEM;
    const owner = await newSignedInContext(browser, TEST_USER_A.code);
    const nextOwner = await newSignedInContext(browser, TEST_USER_B.code);
    try {
      const setup = await owner.context.newPage();
      const characterName = `Private ${Date.now().toString(36)}`;
      const { characterId } = await createCharacter(setup.request, {
        systemVersionId: system.systemVersionId,
        name: characterName,
      });
      const before = await readCharacter(setup.request, characterId);
      await setup.close();

      const page = await owner.context.newPage();
      await page.setViewportSize({ width: 360, height: 740 });
      await page.goto(`/characters/${characterId}`);
      await expectSheetReady(page, characterName);
      await expectOfflineAvailable(page);
      // Queue an edit so snapshot + queue + attempt-adjacent state exist.
      await owner.context.setOffline(true);
      await page.getByRole("button", { name: system.decreaseButton }).click();
      await expect(page.getByText("Changes pending")).toBeVisible({ timeout: 15_000 });
      await owner.context.setOffline(false);

      // CacheStorage holds build assets only: no API/dev URLs and no body
      // containing the private character name.
      const cacheScan = await page.evaluate(async () => {
        const names = await caches.keys();
        const urls: string[] = [];
        const hits: string[] = [];
        for (const name of names) {
          const cache = await caches.open(name);
          const requests = await cache.keys();
          for (const request of requests) {
            urls.push(request.url);
            try {
              const response = await cache.match(request);
              const text = await response?.text();
              if (text && text.includes("Private")) hits.push(request.url);
            } catch {
              /* ignore opaque entries */
            }
          }
        }
        return { urls, hits };
      });
      expect(cacheScan.urls.length).toBeGreaterThan(0);
      expect(cacheScan.urls.every(url => !new URL(url).pathname.startsWith("/api/"))).toBe(true);
      expect(cacheScan.urls.every(url => !new URL(url).pathname.startsWith("/dev/"))).toBe(true);
      expect(cacheScan.hits).toEqual([]);

      // Transfer ownership away, then verify the prior owner's device holds
      // no private rows for the character in any account-partitioned store.
      await page.route("**/characters/*/resources/*/bump", route => void route.abort("failed"));
      const transfer = await page.request.post(`/api/characters/${characterId}/ownership-transfer`, {
        data: {
          toUserId: nextOwner.userId,
          expectedRevision: before.character.revision,
          idempotencyKey: `private-${Date.now().toString(36)}`,
        },
      });
      expect(transfer.status()).toBe(200);
      await page.unrouteAll({ behavior: "wait" }).catch(() => {});
      await page.reload();
      await expect(page.getByText("This character is unavailable.")).toBeVisible({ timeout: 30_000 });

      const idbScan = await page.evaluate(async () => {
        const open = (): Promise<IDBDatabase> =>
          new Promise((resolve, reject) => {
            const request = indexedDB.open("sweetroll-characters");
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
        let db: IDBDatabase;
        try {
          db = await open();
        } catch {
          return { stores: [], leaked: [] as string[] };
        }
        try {
          const stores = Array.from(db.objectStoreNames);
          const leaked: string[] = [];
          for (const store of stores) {
            const rows: unknown[] = await new Promise((resolve, reject) => {
              const tx = db.transaction(store, "readonly");
              const request = tx.objectStore(store).getAll();
              request.onsuccess = () => resolve(request.result as unknown[]);
              request.onerror = () => reject(request.error);
            });
            if (JSON.stringify(rows).includes("Private")) leaked.push(store);
          }
          return { stores, leaked };
        } finally {
          db.close();
        }
      });
      expect(idbScan.leaked).toEqual([]);
      await page.close();
    } finally {
      await owner.context.setOffline(false).catch(() => {});
      await owner.context.close();
      await nextOwner.context.close();
    }
  });
});
