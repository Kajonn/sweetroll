import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CampaignResult } from "./index.js";
import type { DisplayProjection } from "./display.js";
import { createDisplayStreams, type DisplaySnapshot, type DisplayStreamSink } from "./display-stream.js";
import type { SceneEvent, SceneEventHub, SceneEventListener } from "./scene-events.js";

const REQUEST = { displayId: "display-1", secret: "secret", sceneId: "scene-1" };

function projection(sceneRevision: number, imageRevision = 1): DisplayProjection {
  return {
    sceneId: "scene-1",
    sceneRevision,
    imageRevision,
    imageUrl: `/displays/display-1/scenes/scene-1/image?rev=${imageRevision}`,
    tokens: [],
  };
}

function snapshot(sceneRevision: number, imageRevision = 1): CampaignResult<DisplaySnapshot> {
  return { ok: true, value: { campaignId: "campaign-1", projection: projection(sceneRevision, imageRevision) } };
}

const NOT_FOUND: CampaignResult<DisplaySnapshot> = { ok: false, error: { code: "not_found", message: "gone" } };

function fakeHub(listening = true) {
  const listeners = new Set<SceneEventListener>();
  const hub: SceneEventHub & { emit(event: SceneEvent): void; lose(): void; setListening(v: boolean): void } = {
    get listening() {
      return listening;
    },
    subscribe(listener) {
      if (!listening) return null;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async start() {},
    async close() {},
    emit(event) {
      for (const listener of [...listeners]) listener.onEvent(event);
    },
    lose() {
      listening = false;
      for (const listener of [...listeners]) {
        listeners.delete(listener);
        listener.onLost();
      }
    },
    setListening(value) {
      listening = value;
    },
  };
  return { hub, listeners };
}

function recordingSink(options: { accept?: () => boolean } = {}) {
  const chunks: string[] = [];
  let drain: (() => void) | null = null;
  let ended = false;
  const sink: DisplayStreamSink = {
    write(chunk) {
      chunks.push(chunk);
      return options.accept ? options.accept() : true;
    },
    onDrain(callback) {
      drain = callback;
    },
    end() {
      ended = true;
    },
  };
  const scenes = () =>
    chunks
      .filter((chunk) => chunk.startsWith("event: scene"))
      .map((chunk) => JSON.parse(chunk.split("\ndata: ")[1] ?? "{}") as DisplayProjection);
  return { sink, chunks, scenes, drain: () => drain?.(), ended: () => ended };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("display streams", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses to open without a listening hub", async () => {
    const loadSnapshot = vi.fn(async () => snapshot(1));
    const none = createDisplayStreams({ hub: null, loadSnapshot });
    expect(await none.open(REQUEST)).toMatchObject({ ok: false, error: { code: "unavailable" } });
    const { hub } = fakeHub(false);
    const down = createDisplayStreams({ hub, loadSnapshot });
    expect(await down.open(REQUEST)).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(loadSnapshot).not.toHaveBeenCalled();
  });

  it("collapses an unauthorized first snapshot to not_found and unsubscribes", async () => {
    const { hub, listeners } = fakeHub();
    const streams = createDisplayStreams({ hub, loadSnapshot: async () => NOT_FOUND });
    expect(await streams.open(REQUEST)).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(listeners.size).toBe(0);
    expect(streams.activeCount()).toBe(0);
  });

  it("subscribes before the first snapshot and catches up on an update during setup", async () => {
    const { hub } = fakeHub();
    const first = deferred<CampaignResult<DisplaySnapshot>>();
    const loads: Array<CampaignResult<DisplaySnapshot> | Promise<CampaignResult<DisplaySnapshot>>> = [
      first.promise,
      snapshot(2),
    ];
    const loadSnapshot = vi.fn(async () => await loads.shift()!);
    const streams = createDisplayStreams({ hub, loadSnapshot });
    const opening = streams.open(REQUEST);
    await flush();
    // The write commits while the stale first snapshot is still loading.
    hub.emit({ kind: "scene", sceneId: "scene-1", campaignId: "campaign-1", revision: 2 });
    first.resolve(snapshot(1));
    const opened = await opening;
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const client = recordingSink();
    opened.value.attach(client.sink);
    expect(loadSnapshot).toHaveBeenCalledTimes(2);
    // Latest-wins before attach: only revision 2 reaches the client.
    expect(client.scenes().map((p) => p.sceneRevision)).toEqual([2]);
    opened.value.close();
  });

  it("ignores other scenes, coalesces bursts and sends only newer revisions", async () => {
    const { hub } = fakeHub();
    let revision = 1;
    const gate = { current: deferred<void>() };
    const loadSnapshot = vi.fn(async () => {
      if (loadSnapshot.mock.calls.length > 1) await gate.current.promise;
      return snapshot(revision);
    });
    const streams = createDisplayStreams({ hub, loadSnapshot });
    const opened = await streams.open(REQUEST);
    if (!opened.ok) throw new Error("expected stream");
    const client = recordingSink();
    opened.value.attach(client.sink);

    hub.emit({ kind: "scene", sceneId: "other-scene", campaignId: "campaign-1", revision: 9 });
    expect(loadSnapshot).toHaveBeenCalledTimes(1);

    revision = 2;
    hub.emit({ kind: "scene", sceneId: "scene-1", campaignId: "campaign-1", revision: 2 });
    revision = 4;
    hub.emit({ kind: "scene", sceneId: "scene-1", campaignId: "campaign-1", revision: 3 });
    hub.emit({ kind: "scene", sceneId: "scene-1", campaignId: "campaign-1", revision: 4 });
    gate.current.resolve();
    await flush();
    await flush();
    // One in-flight load plus one dirty rerun for the whole burst.
    expect(loadSnapshot).toHaveBeenCalledTimes(3);
    expect(client.scenes().map((p) => p.sceneRevision)).toEqual([1, 4]);
    opened.value.close();
  });

  it("keeps only the latest pending snapshot for a slow client and disconnects it when stalled", async () => {
    const { hub } = fakeHub();
    let revision = 1;
    const streams = createDisplayStreams({
      hub,
      loadSnapshot: async () => snapshot(revision),
      stallTimeoutMs: 1000,
    });
    const opened = await streams.open(REQUEST);
    if (!opened.ok) throw new Error("expected stream");
    let accept = false;
    const client = recordingSink({ accept: () => accept });
    opened.value.attach(client.sink); // first write reports backpressure
    for (revision = 2; revision <= 5; revision++) {
      hub.emit({ kind: "scene", sceneId: "scene-1", campaignId: "campaign-1", revision });
      await flush();
    }
    expect(client.scenes().map((p) => p.sceneRevision)).toEqual([1]);
    accept = true;
    client.drain();
    expect(client.scenes().map((p) => p.sceneRevision)).toEqual([1, 5]);

    accept = false;
    revision = 6;
    hub.emit({ kind: "scene", sceneId: "scene-1", campaignId: "campaign-1", revision: 6 });
    await flush();
    vi.advanceTimersByTime(1001);
    expect(client.ended()).toBe(true);
    expect(streams.activeCount()).toBe(0);
  });

  it("sends revoked and closes when a reload is no longer authorized, discarding late results", async () => {
    const { hub, listeners } = fakeHub();
    const reloads: Array<ReturnType<typeof deferred<CampaignResult<DisplaySnapshot>>>> = [];
    let immediate = true;
    const loadSnapshot = vi.fn(async () => {
      if (immediate) return snapshot(1);
      const next = deferred<CampaignResult<DisplaySnapshot>>();
      reloads.push(next);
      return await next.promise;
    });
    const streams = createDisplayStreams({ hub, loadSnapshot });
    const opened = await streams.open(REQUEST);
    if (!opened.ok) throw new Error("expected stream");
    const client = recordingSink();
    opened.value.attach(client.sink);

    immediate = false;
    hub.emit({ kind: "display", displayId: "display-1", campaignId: "campaign-1" });
    reloads[0]!.resolve(NOT_FOUND);
    await flush();
    expect(client.chunks.at(-1)).toBe('event: revoked\ndata: {}\n\n');
    expect(client.ended()).toBe(true);
    expect(listeners.size).toBe(0);

    // A second stream closed by the client mid-load never writes the late result.
    immediate = true;
    const again = await streams.open(REQUEST);
    immediate = false;
    if (!again.ok) throw new Error("expected stream");
    const other = recordingSink();
    again.value.attach(other.sink);
    hub.emit({ kind: "scene", sceneId: "scene-1", campaignId: "campaign-1", revision: 7 });
    again.value.close();
    reloads[1]!.resolve(snapshot(7));
    await flush();
    expect(other.scenes().map((p) => p.sceneRevision)).toEqual([1]);
  });

  it("closes every stream on listener loss and refuses new streams until listening resumes", async () => {
    const { hub } = fakeHub();
    const streams = createDisplayStreams({ hub, loadSnapshot: async () => snapshot(1) });
    const a = await streams.open(REQUEST);
    const b = await streams.open({ ...REQUEST, displayId: "display-2" });
    if (!a.ok || !b.ok) throw new Error("expected streams");
    const clientA = recordingSink();
    const clientB = recordingSink();
    a.value.attach(clientA.sink);
    b.value.attach(clientB.sink);
    hub.lose();
    expect(clientA.ended() && clientB.ended()).toBe(true);
    expect(streams.activeCount()).toBe(0);
    expect(await streams.open(REQUEST)).toMatchObject({ ok: false, error: { code: "unavailable" } });
    hub.setListening(true);
    expect((await streams.open(REQUEST)).ok).toBe(true);
    streams.closeAll();
  });

  it("bounds concurrent streams per authorized display and frees a slot on close", async () => {
    const { hub } = fakeHub();
    const streams = createDisplayStreams({
      hub, loadSnapshot: async (request) => request.secret === REQUEST.secret ? snapshot(1) : NOT_FOUND,
    });
    const opened = await Promise.all([
      streams.open(REQUEST),
      streams.open({ ...REQUEST, sceneId: "scene-2" }),
      streams.open({ ...REQUEST, sceneId: "scene-3" }),
    ]);
    expect(opened.filter((result) => result.ok)).toHaveLength(2);
    expect(opened.find((result) => !result.ok)).toMatchObject({ error: { code: "rate_limited" } });
    expect(await streams.open({ ...REQUEST, secret: "wrong" })).toMatchObject({ error: { code: "not_found" } });
    expect((await streams.open({ ...REQUEST, displayId: "display-2" })).ok).toBe(true);
    for (const result of opened) if (result.ok) result.value.close();
    expect((await streams.open(REQUEST)).ok).toBe(true);
    streams.closeAll();
  });

  it("sends heartbeats without loading snapshots", async () => {
    const { hub } = fakeHub();
    const loadSnapshot = vi.fn(async () => snapshot(1));
    const streams = createDisplayStreams({ hub, loadSnapshot, heartbeatMs: 100 });
    const opened = await streams.open(REQUEST);
    if (!opened.ok) throw new Error("expected stream");
    const client = recordingSink();
    opened.value.attach(client.sink);
    vi.advanceTimersByTime(1000);
    expect(client.chunks.filter((chunk) => chunk === ": hb\n\n")).toHaveLength(10);
    expect(loadSnapshot).toHaveBeenCalledTimes(1);
    opened.value.close();
  });

  it("reloads on a media change in its own campaign only", async () => {
    const { hub } = fakeHub();
    const loadSnapshot = vi.fn(async () => snapshot(1));
    const streams = createDisplayStreams({ hub, loadSnapshot });
    const opened = await streams.open(REQUEST);
    if (!opened.ok) throw new Error("expected stream");
    opened.value.attach(recordingSink().sink);
    hub.emit({ kind: "campaign", campaignId: "campaign-2" });
    await flush();
    expect(loadSnapshot).toHaveBeenCalledTimes(1);
    hub.emit({ kind: "campaign", campaignId: "campaign-1" });
    await flush();
    expect(loadSnapshot).toHaveBeenCalledTimes(2);
    opened.value.close();
  });
});
