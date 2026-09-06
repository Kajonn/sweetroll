import type { BrowserChannel } from "./identity.js";
import type { CoordinationEvent } from "./session.js";

export function createCoordination(input: {
  actorId: string; characterId: string; locks?: LockManager | null; channel?: BrowserChannel | null;
}) {
  const key = `character:${input.actorId}:${input.characterId}`;
  const locks = input.locks === undefined ? navigator.locks : input.locks;
  const channel = input.channel === undefined && typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel(key) : input.channel;
  const listeners = new Set<(event: CoordinationEvent) => void>();
  let owned = false;
  let disposed = false;
  let unlock: (() => void) | null = null;
  let acquisition: Promise<boolean> | null = null;
  let acquisitionAbort: AbortController | null = null;
  let releasing: Promise<void> | null = null;
  let lockLifetime: Promise<unknown> = Promise.resolve();
  let quiesce: () => Promise<void> = async () => {};
  const emit = (event: CoordinationEvent) => { for (const listener of listeners) listener(event); };
  function acquire(wait = false): Promise<boolean> {
    if (disposed || !locks || releasing) return Promise.resolve(false);
    if (owned) return Promise.resolve(true);
    if (acquisition) return acquisition;
    acquisitionAbort = new AbortController();
    acquisition = new Promise<boolean>(resolve => {
      lockLifetime = locks.request(key, wait ? { signal: acquisitionAbort!.signal } : { ifAvailable: true }, async lock => {
        if (!lock || disposed || releasing) { resolve(false); return; }
        const held = new Promise<void>(done => { unlock = done; });
        owned = true;
        emit({ type: "ownership-changed", owned: true, owner: null });
        resolve(true);
        await held;
      }).catch(() => resolve(false));
    }).finally(() => { acquisition = null; acquisitionAbort = null; });
    return acquisition;
  }
  function release(): Promise<void> {
    if (releasing) return releasing;
    acquisitionAbort?.abort();
    owned = false;
    emit({ type: "ownership-changed", owned: false, owner: null });
    releasing = quiesce().then(async () => {
      unlock?.(); unlock = null;
      await lockLifetime;
      if (!disposed) channel?.postMessage({ type: "released" });
    }).finally(() => { releasing = null; });
    return releasing;
  }
  if (channel) channel.onmessage = event => {
    if (event.data?.type === "takeover" && owned) void release();
    if (event.data?.type === "invalidate") emit({ type: "invalidate", characterId: input.characterId });
  };
  return {
    acquire, requestEditing: acquire,
    async requestTakeover() {
      if (disposed) return false;
      if (acquisition) await acquisition;
      if (disposed) return false;
      const granted = acquire(true);
      channel?.postMessage({ type: "takeover" });
      return granted;
    },
    release, letGo: () => { void release(); },
    isOwner: () => owned,
    setQuiesce(callback: () => Promise<void>) { quiesce = callback; },
    invalidate() { if (!disposed) channel?.postMessage({ type: "invalidate" }); },
    subscribe(listener: (event: CoordinationEvent) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() {
      disposed = true;
      void release(); listeners.clear();
      if (channel) { channel.onmessage = null; channel.close(); }
    },
  };
}
