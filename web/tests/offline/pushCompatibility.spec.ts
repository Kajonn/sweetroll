import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { test, expect } from "@playwright/test";

// Run the real current store in browser IndexedDB. A supplied historical
// source additionally exercises the exact preceding reader; CI's shallow
// checkout checks its version-4 opening contract without fetching history.
const current = transformSync(readFileSync(new URL("../../src/characters/store.ts", import.meta.url), "utf8"), { loader: "ts", format: "iife", globalName: "CurrentStore" }).code;
const previous = process.env.PUSH_PREVIOUS_STORE_SOURCE
  ? transformSync(readFileSync(process.env.PUSH_PREVIOUS_STORE_SOURCE, "utf8"), { loader: "ts", format: "iife", globalName: "PreviousStore" }).code
  : null;

test("the version-5 store preserves older frozen work and rejects a version-4 reader without losing a pending push", async ({ page }, info) => {
  await page.goto("/");
  await page.addScriptTag({ content: current });
  if (previous) await page.addScriptTag({ content: previous });
  const result = await page.evaluate(async () => {
    const runtime = window as any, name = `push-reader-compatibility-${crypto.randomUUID()}`;
    const openV4 = () => new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 4);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("characters", { keyPath: ["actorId", "characterId"] });
        db.createObjectStore("queue", { keyPath: ["actorId", "characterId", "id"] }).createIndex("by-seq", ["actorId", "characterId", "sequence"]);
        db.createObjectStore("onlineAttempts", { keyPath: ["actorId", "id"] });
        db.createObjectStore("lastAccount", { keyPath: "key" });
        db.createObjectStore("pendingLogout", { keyPath: "key" });
        db.createObjectStore("entryTemplates", { keyPath: ["actorId", "characterId"] });
        db.createObjectStore("activity", { keyPath: ["actorId", "characterId", "cursorKey"] });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const older = { id: "older-archive", actorId: "compat-actor", characterId: "compat-character", kind: "archive", createdAt: new Date().toISOString(), request: { method: "PATCH", path: "/characters/compat-character", body: { command: "archive", expectedRevision: 1, idempotencyKey: "older-exact-key" }, firstAttemptAt: new Date().toISOString() } };
    const old = runtime.PreviousStore ? await runtime.PreviousStore.openCharacterStore(name) : null;
    let closeLegacy: () => Promise<void> | void;
    if (old) {
      await old.setLastAccount("compat-actor");
      await old.saveOnlineAttempt(older);
      closeLegacy = () => old.close();
    } else {
      const db = await openV4();
      await new Promise<void>((resolve, reject) => { const tx = db.transaction("onlineAttempts", "readwrite"); tx.objectStore("onlineAttempts").put(older); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
      closeLegacy = () => db.close();
    }
    let blockedUpgrade: string | null = null;
    try { const unexpected = await runtime.CurrentStore.openCharacterStore(name); await unexpected.close(); }
    catch (error) { blockedUpgrade = (error as Error).message; }
    await closeLegacy();
    const store = await runtime.CurrentStore.openCharacterStore(name);
    await store.setLastAccount("compat-actor");
    const frozen = { id: "pending-push", actorId: "compat-actor", characterId: "compat-character", kind: "push", createdAt: new Date().toISOString(), request: { method: "POST", path: "/characters/compat-character/rolls/original/push", body: { expectedRevision: 1, idempotencyKey: "keep-exactly" }, firstAttemptAt: new Date().toISOString() } };
    await store.saveOnlineAttempt(frozen);
    await store.close();
    let previousError: string | null = null;
    try {
      const reader = runtime.PreviousStore ? await runtime.PreviousStore.openCharacterStore(name) : await openV4();
      await reader.close();
    } catch (error) { previousError = (error as Error).name; }
    const reopened = await runtime.CurrentStore.openCharacterStore(name);
    const attempts = await reopened.readOnlineAttempts("compat-actor");
    await reopened.close();
    await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(name); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
    return { blockedUpgrade, previousError, older, frozen, attempts };
  });
  expect(result.blockedUpgrade).toContain("Close older Sweetroll tabs");
  expect(result.previousError).toBe("VersionError");
  expect(result.attempts).toHaveLength(2);
  expect(result.attempts).toEqual(expect.arrayContaining([result.older, result.frozen]));
  await info.attach("push-reader-evidence", { body: JSON.stringify({ ...result, historicalSource: previous !== null }, null, 2), contentType: "application/json" });
});
