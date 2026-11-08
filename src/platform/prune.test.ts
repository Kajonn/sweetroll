import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startPruneScheduler, type PruneResult } from "./prune.js";

const completed: PruneResult = {
  skipped: false,
  deleted: {
    idempotency_receipts: 2,
    preview_snapshots: 0,
    character_command_executions: 0,
    campaign_command_executions: 0,
    character_image_receipts: 0,
    item_image_receipts: 0,
    sessions: 1,
    personal_access_tokens: 0,
    campaign_invitations: 0,
    display_codes: 0,
  },
  totalDeleted: 3,
  truncated: false,
  durationMs: 5,
};

function fakeLogger() {
  return { info: vi.fn(), debug: vi.fn(), error: vi.fn() };
}

describe("startPruneScheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs after the initial delay and then every interval, logging counts", async () => {
    const logger = fakeLogger();
    const run = vi.fn(async () => completed);
    const scheduler = startPruneScheduler({ intervalMs: 1000, initialDelayMs: 100, logger, run });

    await vi.advanceTimersByTimeAsync(99);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "prune_completed", totalDeleted: 3, deleted: completed.deleted }),
      "expired rows pruned",
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("logs failures and keeps the schedule running", async () => {
    const logger = fakeLogger();
    const run = vi.fn<() => Promise<PruneResult>>().mockRejectedValueOnce(new Error("db down")).mockResolvedValue({ skipped: true });
    const scheduler = startPruneScheduler({ intervalMs: 1000, initialDelayMs: 0, logger, run });

    await vi.advanceTimersByTimeAsync(0);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ event: "prune_failed" }), "expired-row prune failed");
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(logger.debug).toHaveBeenCalledWith(expect.objectContaining({ event: "prune_skipped" }), expect.any(String));
    scheduler.stop();
  });

  it("never overlaps a slow run with the next one", async () => {
    let finish!: () => void;
    const run = vi.fn(() => new Promise<PruneResult>((resolve) => (finish = () => resolve(completed))));
    const scheduler = startPruneScheduler({ intervalMs: 1000, initialDelayMs: 0, logger: fakeLogger(), run });

    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("stops scheduling once stopped, including after an in-flight run", async () => {
    let finish!: () => void;
    const run = vi.fn(() => new Promise<PruneResult>((resolve) => (finish = () => resolve(completed))));
    const scheduler = startPruneScheduler({ intervalMs: 1000, initialDelayMs: 0, logger: fakeLogger(), run });

    await vi.advanceTimersByTimeAsync(0);
    scheduler.stop();
    finish();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not keep the process alive", () => {
    vi.useRealTimers();
    const spy = vi.spyOn(globalThis, "setTimeout");
    const scheduler = startPruneScheduler({ intervalMs: 60_000, logger: fakeLogger(), run: async () => completed });
    const timer = spy.mock.results[0]?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    scheduler.stop();
    spy.mockRestore();
  });
});
