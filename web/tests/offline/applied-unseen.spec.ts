import { test, expect, type BrowserContext, type Page } from "@playwright/test";

import {
  D20_REFERENCE_SYSTEM,
  TEST_USER_A,
  createCharacter,
  expectOfflineAvailable,
  expectSheetReady,
  newSignedInContext,
  publishCompletionVariant,
  readActivity,
  readCharacter,
  testSignIn,
  uid,
} from "./test-auth.js";

/**
 * Task 8 critical proof: applied-but-unseen responses. Each test forwards the
 * intercepted mutation to the REAL backend with `route.fetch()`, awaits a
 * successful application, then withholds/aborts the browser response. The
 * page must retry the identical frozen body/key and the server must show
 * exactly one effect. A pre-request abort alone would not prove this: the
 * server applies the effect before the client loses the response.
 *
 * Covered: resource bump (same page), archive across a page restart (a newer
 * mutation cannot overtake it; a new migration preview does not erase it),
 * and expiry/manual review via backdated persisted timestamps (backend
 * retention is never weakened). Pending uncertain outcomes block export.
 */

const system = D20_REFERENCE_SYSTEM;

type Captured = { url: string; method: string; body: unknown };

function captureBody(route: import("@playwright/test").Route): unknown {
  try {
    return route.request().postDataJSON();
  } catch {
    return null;
  }
}

async function openSheet(context: BrowserContext, characterId: string, name: string): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto(`/characters/${characterId}`);
  await expectSheetReady(page, name);
  await expectOfflineAvailable(page);
  return page;
}

test.describe("applied-but-unseen mutations", () => {
  test("withheld bump response retries identically with exactly one effect", async ({ browser }) => {
    test.setTimeout(240_000);
    const { context } = await newSignedInContext(browser, TEST_USER_A.code);
    try {
      const setup = await context.newPage();
      const name = `Unseen ${uid()}`;
      const { characterId } = await createCharacter(setup.request, {
        systemVersionId: system.systemVersionId,
        name,
      });
      await setup.close();
      for (const p of context.pages()) await p.close();

      const page = await openSheet(context, characterId, name);
      const before = await readCharacter(page.request, characterId);
      const initialHealth = (before.character.state.values.health as { current: number }).current;

      // Forward the first bump to the real backend, await success, then
      // withhold the response: applied on the server, unseen by the page.
      const attempts: Captured[] = [];
      let withheldOnce = false;
      await page.route("**/characters/*/resources/*/bump", async route => {
        attempts.push({ url: route.request().url(), method: route.request().method(), body: captureBody(route) });
        if (!withheldOnce) {
          withheldOnce = true;
          const response = await route.fetch();
          expect(response.ok()).toBe(true);
          await route.abort("failed");
          return;
        }
        await route.continue();
      });

      await page.getByRole("button", { name: system.decreaseButton }).click();
      // While the outcome is uncertain, export must stay blocked.
      await expect(page.getByRole("button", { name: "Export" })).toBeDisabled();
      await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 60_000 });
      expect(withheldOnce).toBe(true);
      await page.unrouteAll({ behavior: "wait" });

      // The retry carries the exact original body/key...
      expect(attempts.length).toBeGreaterThanOrEqual(2);
      const first = attempts[0]!.body as Record<string, unknown>;
      const retry = attempts[1]!.body as Record<string, unknown>;
      expect(first["idempotencyKey"]).toBeDefined();
      expect(retry).toEqual(first);
      for (const later of attempts.slice(2)) {
        expect((later.body as Record<string, unknown>)["idempotencyKey"]).toBe(first["idempotencyKey"]);
      }
      // ...and the server applied exactly one effect.
      const after = await readCharacter(page.request, characterId);
      expect(after.character.revision).toBe(before.character.revision + 1);
      expect((after.character.state.values.health as { current: number }).current).toBe(initialHealth - 1);
      const activity = await readActivity(page.request, characterId);
      expect(activity.events.filter(e => e.kind === "character_resource_bumped")).toHaveLength(1);
      await page.close();
    } finally {
      await context.close();
    }
  });

  test("withheld archive survives restart; newer mutation cannot overtake; preview does not erase", async ({
    browser,
  }) => {
    test.setTimeout(300_000);
    const { context } = await newSignedInContext(browser, TEST_USER_A.code);
    try {
      const setup = await context.newPage();
      await testSignIn(setup.request, TEST_USER_A.code);
      const name = `UnseenArchive ${uid()}`;
      const { characterId } = await createCharacter(setup.request, {
        systemVersionId: system.systemVersionId,
        name,
      });
      const migrationTarget = await publishCompletionVariant(setup.request, system.systemVersionId, "ancestry_element");
      await setup.close();
      for (const p of context.pages()) await p.close();

      const page = await openSheet(context, characterId, name);
      const before = await readCharacter(page.request, characterId);

      const archiveAttempts: Captured[] = [];
      let withheldOnce = false;
      // Withhold the first response (applied, unseen), then hold every
      // replay aborted so the attempt stays uncertain until the restart.
      await page.route("**/api/characters/*", async route => {
        if (route.request().method() !== "PATCH") {
          await route.continue();
          return;
        }
        archiveAttempts.push({
          url: route.request().url(),
          method: "PATCH",
          body: captureBody(route),
        });
        if (!withheldOnce) {
          withheldOnce = true;
          const response = await route.fetch();
          expect(response.ok()).toBe(true);
          await route.abort("failed");
          return;
        }
        await route.abort("failed");
      });

      // Count bump traffic: nothing newer may overtake the uncertain archive.
      let bumpRequests = 0;
      await page.route("**/characters/*/resources/*/bump", async route => {
        bumpRequests += 1;
        await route.continue();
      });

      await page.getByRole("button", { name: "Archive" }).click();
      await page.getByRole("button", { name: "Confirm archive" }).click();

      // A newer mutation attempt must not be sent while the outcome is unknown.
      const bumpButton = page.getByRole("button", { name: system.decreaseButton });
      if (await bumpButton.isEnabled()) await bumpButton.click();
      await page.waitForTimeout(3_000);
      expect(bumpRequests).toBe(0);

      // A new migration preview must not erase or overtake the frozen
      // request: while the archive outcome is uncertain the dialog refuses
      // to preview at all (disabled control + explicit reason).
      await page.getByRole("button", { name: "Migration" }).click();
      await page.getByLabel("Target version").fill(migrationTarget);
      await expect(page.getByRole("button", { name: "Preview migration" })).toBeDisabled();
      const migrationDialogText = (await page.getByRole("dialog").last().textContent()) ?? "";
      expect(migrationDialogText).toMatch(/uncertain outcome|pending edits/i);
      await page.keyboard.press("Escape");

      // Restart the page: the frozen archive must replay first, verbatim.
      const url = page.url();
      await page.close();
      const restarted = await context.newPage();
      try {
        await restarted.setViewportSize({ width: 360, height: 740 });
        const restartedArchives: Captured[] = [];
        await restarted.route("**/api/characters/*", async route => {
          if (route.request().method() !== "PATCH") {
            await route.continue();
            return;
          }
          restartedArchives.push({ url: route.request().url(), method: "PATCH", body: captureBody(route) });
          await route.continue();
        });
        await restarted.goto(url);
        await expect(
          restarted.getByText("This character is archived and read-only until recovered."),
        ).toBeVisible({
          timeout: 60_000,
        });
        expect(withheldOnce).toBe(true);
        // Every pre-restart send — the original plus held replays — carries
        // the identical frozen body/key.
        expect(archiveAttempts.length).toBeGreaterThanOrEqual(1);
        for (const attempt of archiveAttempts) {
          expect(attempt.body).toEqual(archiveAttempts[0]!.body);
        }
        expect(restartedArchives.length).toBeGreaterThanOrEqual(1);
        expect(restartedArchives[0]!.body).toEqual(archiveAttempts[0]!.body);

        // Exactly one archive effect, no bump leaked through.
        const after = await readCharacter(restarted.request, characterId);
        expect(after.character.revision).toBe(before.character.revision + 1);
        const activity = await readActivity(restarted.request, characterId);
        expect(activity.events.filter(e => e.kind === "character_archived")).toHaveLength(1);
        expect(activity.events.filter(e => e.kind === "character_resource_bumped")).toHaveLength(0);
        await restarted.unrouteAll({ behavior: "wait" });
      } finally {
        await restarted.close().catch(() => {});
      }
    } finally {
      await context.close();
    }
  });

  test("backdated uncertain archive requires explicit unknown-outcome review", async ({ browser }) => {
    test.setTimeout(240_000);
    const { context } = await newSignedInContext(browser, TEST_USER_A.code);
    try {
      const setup = await context.newPage();
      const name = `UnseenExpiry ${uid()}`;
      const { characterId } = await createCharacter(setup.request, {
        systemVersionId: system.systemVersionId,
        name,
      });
      await setup.close();
      for (const p of context.pages()) await p.close();

      const page = await openSheet(context, characterId, name);
      const before = await readCharacter(page.request, characterId);

      // Withhold the archive response, then keep failing replays so the
      // frozen archive attempt (an OnlineAttempt, not a queue entry) stays
      // uncertain with its original key.
      const archiveBodies: unknown[] = [];
      let withheldOnce = false;
      await context.route("**/api/characters/*", async route => {
        if (route.request().method() !== "PATCH") {
          await route.continue();
          return;
        }
        try {
          archiveBodies.push(route.request().postDataJSON());
        } catch {
          archiveBodies.push(null);
        }
        if (!withheldOnce) {
          withheldOnce = true;
          const response = await route.fetch();
          expect(response.ok()).toBe(true);
          await route.abort("failed");
          return;
        }
        await route.abort("failed");
      });
      await page.getByRole("button", { name: "Archive" }).click();
      await page.getByRole("button", { name: "Confirm archive" }).click();
      await page.waitForTimeout(2_000);
      expect(withheldOnce).toBe(true);

      // Backdate the persisted attempt past the 30-day replay window using
      // the real IndexedDB record (controlled fixture, backend untouched).
      const backdated = await page.evaluate(async characterIdInner => {
        const open = (): Promise<IDBDatabase> =>
          new Promise((resolve, reject) => {
            const request = indexedDB.open("sweetroll-characters");
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
        const db = await open();
        try {
          const read = (): Promise<
            Array<{
              actorId: string;
              id: string;
              characterId: string | null;
              kind: string;
              createdAt: string;
              request: { firstAttemptAt: string };
            }>
          > =>
            new Promise((resolve, reject) => {
              const tx = db.transaction("onlineAttempts", "readonly");
              const request = tx.objectStore("onlineAttempts").getAll();
              request.onsuccess = () => resolve(request.result as never);
              request.onerror = () => reject(request.error);
            });
          const attempts = await read();
          const target = attempts.find(
            a => a.characterId === characterIdInner && a.kind === "archive",
          );
          if (!target) return { backdated: false, count: attempts.length };
          const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
          const updated = { ...target, createdAt: old, request: { ...target.request, firstAttemptAt: old } };
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction("onlineAttempts", "readwrite");
            tx.objectStore("onlineAttempts").put(updated);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
          return { backdated: true, count: attempts.length };
        } finally {
          db.close();
        }
      }, characterId);
      expect(backdated.backdated).toBe(true);

      await page.reload();
      await expect(page.getByRole("heading", { name: "Review unknown outcome" })).toBeVisible({
        timeout: 60_000,
      });
      await page.getByRole("checkbox", { name: "I accept the unknown outcome for this change" }).check();
      await page.getByRole("button", { name: "Acknowledge and retire" }).click();
      await expect(
        page.getByText("This character is archived and read-only until recovered."),
      ).toBeVisible({ timeout: 60_000 });

      // Retiring the expired attempt minted no replacement: every archive
      // request ever sent carried the one original idempotency key.
      const keys = archiveBodies.map(body => (body as Record<string, unknown> | null)?.["idempotencyKey"]);
      expect(keys.length).toBeGreaterThanOrEqual(1);
      for (const key of keys) expect(key).toBe(keys[0]);

      // The server applied the original withheld archive exactly once.
      const after = await readCharacter(page.request, characterId);
      expect(after.character.revision).toBe(before.character.revision + 1);
      const activity = await readActivity(page.request, characterId);
      expect(activity.events.filter(e => e.kind === "character_archived")).toHaveLength(1);
      await context.unrouteAll({ behavior: "wait" }).catch(() => {});
      await page.close();
    } finally {
      await context.close();
    }
  });
});
