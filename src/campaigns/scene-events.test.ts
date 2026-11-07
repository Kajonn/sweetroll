import { EventEmitter } from "node:events";
import type { Client } from "pg";
import { expect, it, vi } from "vitest";

import { createSceneEventHub } from "./scene-events.js";

it("disconnects subscribers when PostgreSQL stops replying and restores LISTEN", async () => {
  vi.useFakeTimers();
  const stalled = new EventEmitter();
  const stalledQuery = vi.fn(async (sql: string) => {
    if (sql === "SELECT 1") await new Promise(() => {});
  });
  const makeClient = (emitter: EventEmitter, query: typeof stalledQuery) =>
    Object.assign(emitter, { connect: async () => {}, query, end: async () => {} }) as unknown as Client;
  const createClient = vi.fn()
    .mockReturnValueOnce(makeClient(stalled, stalledQuery))
    .mockReturnValueOnce(makeClient(new EventEmitter(), vi.fn(async () => {})));
  const hub = createSceneEventHub({
    connection: {}, createClient, retryBaseMs: 100, probeIntervalMs: 200, probeTimeoutMs: 50,
  });
  try {
    await hub.start();
    const onLost = vi.fn();
    expect(hub.subscribe({ onEvent: vi.fn(), onLost })).not.toBeNull();
    await vi.advanceTimersByTimeAsync(249);
    expect(stalledQuery).toHaveBeenCalledWith("SELECT 1");
    expect(hub.listening).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(hub.listening).toBe(false);
    expect(onLost).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(hub.listening).toBe(true);
    expect(createClient).toHaveBeenCalledTimes(2);
  } finally {
    await hub.close();
    vi.useRealTimers();
  }
});
