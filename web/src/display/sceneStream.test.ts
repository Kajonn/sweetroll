import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectSceneStream, reconnectDelay, type SceneStreamStatus } from "./sceneStream.js";
import type { DisplayProjection } from "../campaigns/types.js";

const encoder = new TextEncoder();

function projection(sceneRevision: number, imageRevision = 1): DisplayProjection {
  return {
    sceneId: "s1",
    sceneRevision,
    imageRevision,
    imageUrl: `/displays/d1/scenes/s1/image?rev=${imageRevision}`,
    tokens: [],
  };
}

const sceneEvent = (p: DisplayProjection) => `event: scene\ndata: ${JSON.stringify(p)}\n\n`;

/** A response whose body the test feeds chunk by chunk. */
function streamingResponse(status = 200) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: { ok: status >= 200 && status < 300, status, body } as unknown as Response,
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
  };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("scene stream client", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function connect(fetchImpl: ReturnType<typeof vi.fn>, extra: Record<string, unknown> = {}) {
    const snapshots: DisplayProjection[] = [];
    const statuses: SceneStreamStatus[] = [];
    const handle = connectSceneStream(
      { displayId: "d1", sceneId: "s1", secret: "s3cr3t", fetchImpl: fetchImpl as never, random: () => 1, ...extra },
      { onSnapshot: (p) => snapshots.push(p), onStatus: (s) => statuses.push(s) },
    );
    return { handle, snapshots, statuses };
  }

  it("skips opening a request when the handle is closed in the same turn", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const handle = connectSceneStream(
      { displayId: "d1", sceneId: "s1", secret: "secret", fetchImpl },
      { onSnapshot: vi.fn(), onStatus: vi.fn() },
    );
    handle.close();
    await flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requests the credential-scoped stream without cookies and parses complete snapshots", async () => {
    const stream = streamingResponse();
    const fetchImpl = vi.fn().mockResolvedValue(stream.response);
    const { handle, snapshots, statuses } = connect(fetchImpl);
    await flush();
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/displays/d1/scenes/s1/events",
      expect.objectContaining({
        credentials: "omit",
        cache: "no-store",
        headers: expect.objectContaining({ "x-display-secret": "s3cr3t" }),
      }),
    );
    await flush();
    // Split across chunks, with heartbeats and an open comment in between.
    const first = sceneEvent(projection(1));
    stream.push(": open\n\n" + first.slice(0, 20));
    await flush();
    expect(snapshots).toHaveLength(0);
    stream.push(first.slice(20) + ": hb\n\n" + sceneEvent(projection(2)));
    await flush();
    expect(snapshots.map((p) => p.sceneRevision)).toEqual([1, 2]);
    expect(statuses).toEqual(["connecting", "open"]);
    // Malformed or foreign-scene events are ignored.
    stream.push("event: scene\ndata: {not json}\n\n");
    stream.push(sceneEvent({ ...projection(3), sceneId: "other" }));
    await flush();
    expect(snapshots).toHaveLength(2);
    handle.close();
  });

  it("treats 404 and the revoked event as lost access and stops retrying", async () => {
    const fetch404 = vi.fn().mockResolvedValue({ ok: false, status: 404, body: null });
    const a = connect(fetch404);
    await flush();
    expect(a.statuses.at(-1)).toBe("revoked");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetch404).toHaveBeenCalledTimes(1);

    const stream = streamingResponse();
    const fetchRevoked = vi.fn().mockResolvedValue(stream.response);
    const b = connect(fetchRevoked);
    await flush();
    stream.push(sceneEvent(projection(1)) + "event: revoked\ndata: {}\n\n");
    await flush();
    expect(b.statuses).toEqual(["connecting", "open", "revoked"]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchRevoked).toHaveBeenCalledTimes(1);

    // Explicit user retry is allowed.
    b.handle.retryNow();
    expect(fetchRevoked).toHaveBeenCalledTimes(2);
    b.handle.close();
  });

  it("reconnects with backoff after a dropped stream or 503 and starts from a fresh snapshot", async () => {
    const first = streamingResponse();
    const second = streamingResponse();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce({ ok: false, status: 503, body: null })
      .mockResolvedValueOnce(second.response);
    const { handle, snapshots, statuses } = connect(fetchImpl, { retryBaseMs: 1000 });
    await flush();
    first.push(sceneEvent(projection(5)));
    await flush();
    first.end(); // server restart / listener loss
    await flush();
    expect(statuses.at(-1)).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // 503
    await flush();
    await vi.advanceTimersByTimeAsync(2000); // doubled delay
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    await flush();
    // The new connection's first snapshot is accepted even if not newer.
    second.push(sceneEvent(projection(5)));
    await flush();
    expect(snapshots.map((p) => p.sceneRevision)).toEqual([5, 5]);
    expect(statuses.at(-1)).toBe("open");
    handle.close();
  });

  it("reconnects when no data or heartbeat arrives within the idle timeout", async () => {
    const first = streamingResponse();
    const second = streamingResponse();
    const fetchImpl = vi.fn().mockResolvedValueOnce(first.response).mockResolvedValueOnce(second.response);
    const { handle, statuses } = connect(fetchImpl, { idleTimeoutMs: 1000, retryBaseMs: 100 });
    await flush();
    first.push(sceneEvent(projection(1)));
    await flush();
    await vi.advanceTimersByTimeAsync(900);
    first.push(": hb\n\n");
    await flush();
    await vi.advanceTimersByTimeAsync(900);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(statuses.at(-1)).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    handle.close();
  });

  it("jitters reconnect delays and caps them", () => {
    expect(reconnectDelay(0, 1000, 30_000, () => 0)).toBe(500);
    expect(reconnectDelay(0, 1000, 30_000, () => 1)).toBe(1000);
    expect(reconnectDelay(3, 1000, 30_000, () => 1)).toBe(8000);
    expect(reconnectDelay(20, 1000, 30_000, () => 1)).toBe(30_000);
  });

  it("closing aborts the request and suppresses further callbacks", async () => {
    const stream = streamingResponse();
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_url: string, init: { signal: AbortSignal }) => {
      signal = init.signal;
      return Promise.resolve(stream.response);
    });
    const { handle, snapshots } = connect(fetchImpl as never);
    await flush();
    handle.close();
    expect(signal?.aborted).toBe(true);
    stream.push(sceneEvent(projection(1)));
    await flush();
    expect(snapshots).toHaveLength(0);
  });
});
