import type { BrowserContext } from "@playwright/test";

/** A browser fault armed before the app loads. */
export type ProfileFault = "storage" | "locks";

/**
 * Arms browser faults in a context before any page script runs.
 *
 * - `locks`: a browser without the Web Locks API (`navigator.locks` is undefined).
 * - `storage`: an incomplete profile. IndexedDB opens and the account records
 *   save, but every `put` to the `characters` object store throws
 *   `QuotaExceededError`, so no character copy can be written.
 */
export async function armProfileFaults(context: BrowserContext, faults: readonly ProfileFault[]): Promise<void> {
  await context.addInitScript((kinds: ProfileFault[]) => {
    if (kinds.includes("locks")) {
      Object.defineProperty(Navigator.prototype, "locks", { configurable: true, get: () => undefined });
    }
    if (kinds.includes("storage")) {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
        if (this.name === "characters") throw new DOMException("Quota exceeded.", "QuotaExceededError");
        return put.apply(this, args);
      };
    }
  }, [...faults]);
}
