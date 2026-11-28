// Scene streaming client for the paired display (2026-11-07 plan, stage 2).
// Uses fetch() with a response-body reader (not EventSource) so the scoped
// display credential travels in the X-Display-Secret header and account
// cookies are never sent (`credentials: "omit"`).
import type { DisplayProjection } from "../campaigns/types.js";

export type SceneStreamStatus =
  /** Connecting for the first time; nothing to show yet. */
  | "connecting"
  /** Connected and a current snapshot has been received. */
  | "open"
  /** Disconnected; a jittered reconnect is scheduled. */
  | "reconnecting"
  /** Access lost (404 or `revoked`): no automatic retries until re-paired. */
  | "revoked";

export type SceneStreamHandlers = {
  onSnapshot(projection: DisplayProjection): void;
  onStatus(status: SceneStreamStatus): void;
};

export type SceneStreamOptions = {
  displayId: string;
  sceneId: string;
  secret: string;
  fetchImpl?: typeof fetch | undefined;
  /** Reconnect when nothing (not even a heartbeat) arrives for this long. */
  idleTimeoutMs?: number | undefined;
  retryBaseMs?: number | undefined;
  retryMaxMs?: number | undefined;
  random?: (() => number) | undefined;
};

export type SceneStreamHandle = {
  close(): void;
  /** User-initiated retry (also after revocation). */
  retryNow(): void;
};

export type SceneStreamFactory = (options: SceneStreamOptions, handlers: SceneStreamHandlers) => SceneStreamHandle;

export const SCENE_STREAM_IDLE_TIMEOUT_MS = 45_000;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;
const SAFE_ID = /^[A-Za-z0-9-]+$/;

/** Exponential backoff with ±50% jitter so many displays do not reconnect in lockstep. */
export function reconnectDelay(attempt: number, baseMs: number, maxMs: number, random: () => number): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 10));
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

function isProjection(value: unknown, sceneId: string): value is DisplayProjection {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    p.sceneId === sceneId &&
    typeof p.sceneRevision === "number" &&
    typeof p.imageRevision === "number" &&
    typeof p.imageUrl === "string" &&
    Array.isArray(p.tokens)
  );
}

export const connectSceneStream: SceneStreamFactory = (options, handlers) => {
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const idleTimeoutMs = options.idleTimeoutMs ?? SCENE_STREAM_IDLE_TIMEOUT_MS;
  const retryBaseMs = options.retryBaseMs ?? RETRY_BASE_MS;
  const retryMaxMs = options.retryMaxMs ?? RETRY_MAX_MS;
  const random = options.random ?? Math.random;
  let closed = false;
  let attempt = 0;
  let controller: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let lastRevision = 0;
  let status: SceneStreamStatus | null = null;

  const setStatus = (next: SceneStreamStatus): void => {
    if (closed || status === next) return;
    status = next;
    handlers.onStatus(next);
  };

  const clearTimers = (): void => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    if (idleTimer !== null) clearTimeout(idleTimer);
    retryTimer = null;
    idleTimer = null;
  };

  const stopCurrent = (): void => {
    controller?.abort();
    controller = null;
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
  };

  const scheduleReconnect = (): void => {
    stopCurrent();
    if (closed || status === "revoked") return;
    setStatus("reconnecting");
    const delay = reconnectDelay(attempt, retryBaseMs, retryMaxMs, random);
    attempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, delay);
  };

  const revoke = (): void => {
    stopCurrent();
    clearTimers();
    setStatus("revoked");
  };

  const armIdle = (): void => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => scheduleReconnect(), idleTimeoutMs);
  };

  const handleBlock = (block: string): void => {
    if (block.startsWith(":")) return; // heartbeat / open comment
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (event === "revoked") {
      revoke();
      return;
    }
    if (event !== "scene") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.join("\n"));
    } catch {
      return;
    }
    if (!isProjection(parsed, options.sceneId)) return;
    if (parsed.sceneRevision <= lastRevision && status === "open") return;
    lastRevision = parsed.sceneRevision;
    attempt = 0;
    handlers.onSnapshot(parsed);
    setStatus("open");
  };

  async function connect(): Promise<void> {
    if (closed) return;
    if (!SAFE_ID.test(options.displayId) || !SAFE_ID.test(options.sceneId)) {
      revoke();
      return;
    }
    const current = new AbortController();
    controller = current;
    // Each new connection starts from a fresh snapshot.
    lastRevision = 0;
    armIdle();
    try {
      const response = await fetchImpl(
        `/api/displays/${options.displayId}/scenes/${options.sceneId}/events`,
        {
          headers: { "x-display-secret": options.secret, accept: "text/event-stream" },
          credentials: "omit",
          cache: "no-store",
          signal: current.signal,
        },
      );
      if (current.signal.aborted || closed) return;
      if (response.status === 404 || response.status === 401 || response.status === 403) {
        revoke();
        return;
      }
      if (!response.ok || response.body === null) {
        scheduleReconnect();
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (current.signal.aborted || closed) return;
        if (done) break;
        armIdle();
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let index: number;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          handleBlock(block);
          if (closed || status === "revoked" || current.signal.aborted) return;
        }
      }
      if (!current.signal.aborted && !closed) scheduleReconnect();
    } catch {
      if (!current.signal.aborted && !closed) scheduleReconnect();
    }
  }

  setStatus("connecting");
  // React may dispose and remount the effect in the same turn. Avoid
  // opening a socket for the discarded handle.
  queueMicrotask(() => {
    if (controller === null) void connect();
  });

  return {
    close() {
      closed = true;
      stopCurrent();
      clearTimers();
    },
    retryNow() {
      if (closed) return;
      stopCurrent();
      clearTimers();
      attempt = 0;
      status = null;
      setStatus("connecting");
      void connect();
    },
  };
};
