import { Client, type ClientConfig } from "pg";

/**
 * Scene streaming (2026-11-07 plan, stage 2): committed scene writes and
 * display-access changes are announced on one PostgreSQL channel. Payloads
 * carry only internal IDs and the scene revision — never fog, tokens or
 * media — and PostgreSQL remains the authoritative state: a listener that
 * receives an event reloads the authorized projection.
 *
 * `NOTIFY` issued inside a transaction is delivered only when it commits,
 * so a rolled-back write never produces an event.
 */
export const SCENE_EVENTS_CHANNEL = "sweetroll_scene_events";

export type SceneEvent =
  /** A committed scene write (any revision bump). */
  | { kind: "scene"; sceneId: string; campaignId: string; revision: number }
  /** A display credential changed (revocation). */
  | { kind: "display"; displayId: string; campaignId: string }
  /** Campaign-scoped access change (e.g. a media file was deleted). */
  | { kind: "campaign"; campaignId: string };

type Queryable = { query(text: string, values?: unknown[]): Promise<unknown> };

/** Queue the event on the caller's transaction (delivered at COMMIT). */
export async function notifySceneEvent(client: Queryable, event: SceneEvent): Promise<void> {
  await client.query("SELECT pg_notify($1, $2)", [SCENE_EVENTS_CHANNEL, encodeSceneEvent(event)]);
}

export function encodeSceneEvent(event: SceneEvent): string {
  switch (event.kind) {
    case "scene":
      return JSON.stringify({ k: "scene", s: event.sceneId, c: event.campaignId, r: event.revision });
    case "display":
      return JSON.stringify({ k: "display", d: event.displayId, c: event.campaignId });
    case "campaign":
      return JSON.stringify({ k: "campaign", c: event.campaignId });
  }
}

export function decodeSceneEvent(payload: string | undefined): SceneEvent | null {
  if (payload === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const value = parsed as Record<string, unknown>;
  if (typeof value.c !== "string") return null;
  if (value.k === "scene" && typeof value.s === "string" && typeof value.r === "number") {
    return { kind: "scene", sceneId: value.s, campaignId: value.c, revision: value.r };
  }
  if (value.k === "display" && typeof value.d === "string") {
    return { kind: "display", displayId: value.d, campaignId: value.c };
  }
  if (value.k === "campaign") return { kind: "campaign", campaignId: value.c };
  return null;
}

export type SceneEventListener = {
  /** Called for every decoded event while the hub is listening. */
  onEvent(event: SceneEvent): void;
  /** Called once when the hub loses its LISTEN connection. */
  onLost(): void;
};

export interface SceneEventHub {
  /** True while the dedicated LISTEN connection is established. */
  readonly listening: boolean;
  /**
   * Attach a listener. Returns null while the hub is not listening, so a
   * stream is never opened without change delivery.
   */
  subscribe(listener: SceneEventListener): (() => void) | null;
  start(): Promise<void>;
  close(): Promise<void>;
}

export type CreateSceneEventHubInput = {
  /** Connection settings for the dedicated (non-pool) LISTEN client. */
  connection: ClientConfig;
  logger?: { warn(obj: unknown, msg?: string): void; info(obj: unknown, msg?: string): void } | undefined;
  /** Delay before re-establishing LISTEN after a failure (default 1s, doubling to 30s). */
  retryBaseMs?: number | undefined;
  /** Test seam: replaces `new Client(config)`. */
  createClient?: ((config: ClientConfig) => Client) | undefined;
};

/**
 * One dedicated LISTEN connection per process, separate from the request
 * pool. On connection loss every subscriber is told (streams close and the
 * displays reconnect for a fresh snapshot); new subscriptions are refused
 * until LISTEN is re-established.
 */
export function createSceneEventHub(input: CreateSceneEventHubInput): SceneEventHub {
  const listeners = new Set<SceneEventListener>();
  const retryBaseMs = input.retryBaseMs ?? 1000;
  const createClient = input.createClient ?? ((config: ClientConfig) => new Client(config));
  let client: Client | null = null;
  let listening = false;
  let closed = false;
  let retryTimer: NodeJS.Timeout | null = null;
  let attempt = 0;

  function lose(reason: unknown): void {
    const wasListening = listening;
    listening = false;
    const old = client;
    client = null;
    if (old !== null) {
      old.removeAllListeners("notification");
      old.removeAllListeners("error");
      old.removeAllListeners("end");
      old.on("error", () => {});
      void old.end().catch(() => {});
    }
    if (wasListening) {
      input.logger?.warn({ err: reason }, "scene event listener lost");
      for (const listener of [...listeners]) {
        listeners.delete(listener);
        try {
          listener.onLost();
        } catch {
          // A failing subscriber must not block the others.
        }
      }
    }
    scheduleRetry();
  }

  function scheduleRetry(): void {
    if (closed || retryTimer !== null) return;
    const delay = Math.min(30_000, retryBaseMs * 2 ** Math.min(attempt, 5));
    attempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect().catch(() => {});
    }, delay);
    retryTimer.unref?.();
  }

  async function connect(): Promise<void> {
    if (closed || client !== null) return;
    const next = createClient(input.connection);
    client = next;
    next.on("error", (error) => lose(error));
    next.on("end", () => {
      if (client === next) lose(new Error("scene event connection ended"));
    });
    next.on("notification", (message) => {
      if (message.channel !== SCENE_EVENTS_CHANNEL) return;
      const event = decodeSceneEvent(message.payload);
      if (event === null) return;
      for (const listener of [...listeners]) {
        try {
          listener.onEvent(event);
        } catch {
          // Subscriber failures are isolated.
        }
      }
    });
    try {
      await next.connect();
      await next.query(`LISTEN ${SCENE_EVENTS_CHANNEL}`);
      if (client !== next || closed) return;
      listening = true;
      attempt = 0;
      input.logger?.info({ channel: SCENE_EVENTS_CHANNEL }, "scene event listener ready");
    } catch (error) {
      if (client === next) lose(error);
      throw error;
    }
  }

  return {
    get listening() {
      return listening;
    },
    subscribe(listener) {
      if (!listening) return null;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async start() {
      await connect();
    },
    async close() {
      closed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      const old = client;
      client = null;
      listening = false;
      listeners.clear();
      if (old !== null) {
        old.removeAllListeners();
        old.on("error", () => {});
        await old.end().catch(() => {});
      }
    },
  };
}
