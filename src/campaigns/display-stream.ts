import type { CampaignError, CampaignResult } from "./index.js";
import type { DisplayProjection, DisplaySceneInput } from "./display.js";
import type { SceneEvent, SceneEventHub } from "./scene-events.js";

/**
 * Scene streaming (2026-11-07 plan, stage 2): one server-sent-event stream
 * per paired display and scene. The stream carries complete, credential-
 * scoped `scene` snapshots; it never sends deltas, fog or hidden tokens.
 *
 * Ordering rules:
 * - subscribe to change events BEFORE loading the first snapshot, so an
 *   update committed during setup triggers a catch-up reload;
 * - reloads coalesce: at most one load in flight, plus one "dirty" rerun;
 * - only strictly newer scene revisions are sent;
 * - while the client is backpressured only the latest pending snapshot is
 *   kept, and a client that stays stalled is disconnected;
 * - a reload that is no longer authorized sends `revoked` and closes;
 *   results that arrive after close are discarded.
 * Heartbeats are plain SSE comments and never query PostgreSQL.
 */

export type DisplaySnapshot = { campaignId: string; projection: DisplayProjection };

export type DisplayStreamSink = {
  /** Write one SSE chunk; false means the client is backpressured. */
  write(chunk: string): boolean;
  /** Register the (single) drain callback. */
  onDrain(callback: () => void): void;
  /** End the HTTP response. Idempotent. */
  end(): void;
};

export type DisplayStreamOpenError = CampaignError | { code: "unavailable"; message: string };

export type OpenDisplayStreamResult =
  | { ok: true; value: OpenDisplayStream }
  | { ok: false; error: DisplayStreamOpenError };

export type OpenDisplayStream = {
  /** Start writing to the client: flushes the first snapshot. */
  attach(sink: DisplayStreamSink): void;
  /** Client went away (or server shutdown). Idempotent. */
  close(): void;
};

export type DisplayStreams = {
  open(input: DisplaySceneInput): Promise<OpenDisplayStreamResult>;
  /** Number of open streams in this process (observability/tests). */
  activeCount(): number;
  /** Close every stream (process shutdown). */
  closeAll(): void;
};

export type CreateDisplayStreamsInput = {
  hub: SceneEventHub | null;
  loadSnapshot(input: DisplaySceneInput): Promise<CampaignResult<DisplaySnapshot>>;
  heartbeatMs?: number | undefined;
  /** Disconnect a client that has not drained a pending write for this long. */
  stallTimeoutMs?: number | undefined;
};

export const DISPLAY_STREAM_HEARTBEAT_MS = 15_000;
export const DISPLAY_STREAM_STALL_MS = 30_000;

export function formatSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createDisplayStreams(input: CreateDisplayStreamsInput): DisplayStreams {
  const heartbeatMs = input.heartbeatMs ?? DISPLAY_STREAM_HEARTBEAT_MS;
  const stallTimeoutMs = input.stallTimeoutMs ?? DISPLAY_STREAM_STALL_MS;
  const active = new Map<string, Set<{ close(): void }>>();
  const maxStreamsPerDisplay = 2;

  async function open(
    request: DisplaySceneInput,
  ): Promise<OpenDisplayStreamResult> {
    if (input.hub === null) {
      return { ok: false, error: { code: "unavailable", message: "Live display updates are unavailable." } };
    }

    let closed = false;
    let sink: DisplayStreamSink | null = null;
    let campaignId: string | null = null;
    let lastSentRevision = 0;
    let pending: string | null = null;
    let backpressured = false;
    let loading = false;
    let dirty = false;
    let heartbeat: NodeJS.Timeout | null = null;
    let stallTimer: NodeJS.Timeout | null = null;
    let unsubscribe: (() => void) | null = null;

    const handle = { close: () => close() };

    function close(): void {
      if (closed) return;
      closed = true;
      const streams = active.get(request.displayId);
      streams?.delete(handle);
      if (streams?.size === 0) active.delete(request.displayId);
      unsubscribe?.();
      unsubscribe = null;
      if (heartbeat !== null) clearInterval(heartbeat);
      if (stallTimer !== null) clearTimeout(stallTimer);
      heartbeat = null;
      stallTimer = null;
      pending = null;
      sink?.end();
    }

    function flush(chunk: string): void {
      if (closed) return;
      if (sink === null || backpressured) {
        // Latest-wins: an older pending snapshot is superseded.
        pending = chunk;
        return;
      }
      if (!sink.write(chunk)) {
        backpressured = true;
        stallTimer = setTimeout(() => close(), stallTimeoutMs);
        stallTimer.unref?.();
      }
    }

    function onDrain(): void {
      if (closed) return;
      backpressured = false;
      if (stallTimer !== null) clearTimeout(stallTimer);
      stallTimer = null;
      const next = pending;
      pending = null;
      if (next !== null) flush(next);
    }

    function deliver(snapshot: DisplaySnapshot): void {
      if (snapshot.projection.sceneRevision <= lastSentRevision) return;
      lastSentRevision = snapshot.projection.sceneRevision;
      flush(formatSseEvent("scene", snapshot.projection));
    }

    function revoke(): void {
      if (closed) return;
      if (sink !== null && !backpressured) sink.write(formatSseEvent("revoked", {}));
      close();
    }

    async function reload(): Promise<void> {
      if (closed) return;
      if (loading) {
        dirty = true;
        return;
      }
      loading = true;
      try {
        do {
          dirty = false;
          const result = await input.loadSnapshot(request);
          if (closed) return;
          if (!result.ok) {
            if (result.error.code === "not_found") revoke();
            else close(); // Transient failure: the client reconnects for a fresh snapshot.
            return;
          }
          deliver(result.value);
        } while (dirty && !closed);
      } catch {
        close();
      } finally {
        loading = false;
      }
    }

    function relevant(event: SceneEvent): boolean {
      switch (event.kind) {
        case "scene":
          return event.sceneId === request.sceneId;
        case "display":
          return event.displayId === request.displayId;
        case "campaign":
          return campaignId === null || event.campaignId === campaignId;
      }
    }

    unsubscribe = input.hub.subscribe({
      onEvent(event) {
        if (!closed && relevant(event)) void reload();
      },
      onLost() {
        unsubscribe = null;
        close();
      },
    });
    if (unsubscribe === null) {
      return { ok: false, error: { code: "unavailable", message: "Live display updates are unavailable." } };
    }

    // First snapshot after subscribing: an event during this load marks the
    // stream dirty and the loop below catches up.
    loading = true;
    try {
      let first: CampaignResult<DisplaySnapshot>;
      do {
        dirty = false;
        first = await input.loadSnapshot(request);
        if (!first.ok) break;
        campaignId = first.value.campaignId;
        deliver(first.value);
      } while (dirty && !closed);
      if (!first.ok) {
        closed = true;
        unsubscribe?.();
        return { ok: false, error: first.error };
      }
    } catch (error) {
      closed = true;
      unsubscribe?.();
      throw error;
    } finally {
      loading = false;
    }
    if (closed) {
      return { ok: false, error: { code: "unavailable", message: "Live display updates are unavailable." } };
    }

    // Only count authorized streams. A request with an invalid secret must
    // never reserve a slot or displace a legitimate display.
    const streams = active.get(request.displayId) ?? new Set();
    if (streams.size >= maxStreamsPerDisplay) {
      close();
      return { ok: false, error: { code: "rate_limited", message: "This display has too many open streams." } };
    }
    streams.add(handle);
    active.set(request.displayId, streams);
    return {
      ok: true,
      value: {
        attach(target) {
          if (closed || sink !== null) {
            if (closed) target.end();
            return;
          }
          sink = target;
          target.onDrain(onDrain);
          const first = pending;
          pending = null;
          if (first !== null) flush(first);
          heartbeat = setInterval(() => {
            if (!closed && sink !== null && !backpressured) {
              if (!sink.write(": hb\n\n")) {
                backpressured = true;
                stallTimer = setTimeout(() => close(), stallTimeoutMs);
                stallTimer.unref?.();
              }
            }
          }, heartbeatMs);
          heartbeat.unref?.();
        },
        close,
      },
    };
  }

  return {
    open,
    activeCount: () => [...active.values()].reduce((total, streams) => total + streams.size, 0),
    closeAll() {
      for (const streams of active.values()) {
        for (const handle of streams) handle.close();
      }
    },
  };
}
