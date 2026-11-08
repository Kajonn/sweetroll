import { expect, type Page, type Request } from "@playwright/test";

type WriteTracker = { inFlight: Set<Request>; started: number };
const trackers = new WeakMap<Page, WriteTracker>();

function isWrite(request: Request): boolean {
  return request.method() !== "GET" && request.method() !== "HEAD" && new URL(request.url()).pathname.startsWith("/api/");
}

function tracker(page: Page): WriteTracker {
  let state = trackers.get(page);
  if (state === undefined) {
    const created: WriteTracker = { inFlight: new Set(), started: 0 };
    page.on("request", (request) => {
      if (!isWrite(request)) return;
      created.inFlight.add(request);
      created.started += 1;
    });
    const settle = (request: Request) => created.inFlight.delete(request);
    page.on("requestfinished", settle);
    page.on("requestfailed", settle);
    trackers.set(page, created);
    state = created;
  }
  return state;
}

/** Starts watching a page's API writes; call before the first edit so none are missed. */
export function watchSheetWrites(page: Page): void {
  tracker(page);
}

/**
 * Waits until the sheet has really saved. The sync status also reads "Saved"
 * when idle, so it can be visible before a just-made edit is queued. Require
 * "Saved", no API write in flight, and no new write starting for a short
 * quiet window.
 */
export async function expectSheetSaved(page: Page, timeout = 60_000): Promise<void> {
  const state = tracker(page);
  const saved = page.getByText("Saved", { exact: true });
  await expect(async () => {
    await expect(saved).toBeVisible({ timeout: 1_000 });
    expect(state.inFlight.size).toBe(0);
    const startedBefore = state.started;
    await page.waitForTimeout(750);
    expect(state.started).toBe(startedBefore);
    expect(state.inFlight.size).toBe(0);
    await expect(saved).toBeVisible({ timeout: 0 });
  }).toPass({ timeout });
}
