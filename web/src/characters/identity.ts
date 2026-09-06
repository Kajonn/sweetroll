import type { ApiClient } from "../api/client.js";
import type { MeState } from "../api/hooks.js";
import type { CharacterStore } from "./store.js";

export type BrowserChannel = {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
};
export type IdentitySnapshot = { actorId: string | null; verified: boolean; generation: number; pendingLogout: boolean };
export type IdentityGate = ReturnType<typeof createIdentityGate>;

export function createIdentityGate(input: {
  store: CharacterStore; client: ApiClient; online?: () => boolean; channel?: BrowserChannel | null;
}) {
  const { store, client } = input;
  const online = input.online ?? (() => navigator.onLine);
  const channel = input.channel === undefined && typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel("character-identity") : input.channel;
  let snapshot: IdentitySnapshot = { actorId: null, verified: false, generation: 0, pendingLogout: false };
  let disposed = false;
  let epoch = 0;
  let lastConfirmed: string | null = null;
  let work: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();
  const publish = (actorId: string | null, verified: boolean, pendingLogout: boolean, invalidate = false) => {
    snapshot = { actorId, verified, pendingLogout, generation: snapshot.generation + (invalidate || actorId !== snapshot.actorId ? 1 : 0) };
    for (const listener of listeners) listener();
  };
  const serialize = (run: () => Promise<void>) => {
    work = work.catch(() => {}).then(run);
    return work;
  };
  function refresh(): Promise<void> {
    const token = ++epoch;
    return serialize(async () => {
      if (disposed || token !== epoch) return;
      try {
        const pending = await store.readPendingLogout();
        if (disposed || token !== epoch) return;
        if (pending) {
          publish(null, false, true);
          await store.clearAccount(pending);
          if (!online()) return;
          await client.fetch("POST", "/signout");
          await store.clearPendingLogout();
        }
        if (disposed || token !== epoch) return;
        if (!online()) {
          const actor = await store.readLastAccount();
          if (!disposed && token === epoch) publish(actor, false, false);
          return;
        }
        // Do not expose a startup cache until this request confirms its account.
        publish(snapshot.actorId, false, false);
        const previousAccount = await store.readLastAccount();
        if (disposed || token !== epoch) return;
        const me = await client.fetch<MeState>("GET", "/me");
        if (disposed || token !== epoch) return;
        if (me.state === "authenticated" && typeof me.userId === "string" && me.userId.length > 0) {
          const changed = await store.setLastAccount(me.userId, previousAccount);
          if (disposed || token !== epoch) return;
          lastConfirmed = me.userId;
          publish(me.userId, true, false);
          if (changed) channel?.postMessage({ type: "identity-changed" });
        } else if (me.state === "anonymous") {
          const changed = lastConfirmed !== null;
          lastConfirmed = null;
          publish(null, false, false);
          if (changed) channel?.postMessage({ type: "identity-changed" });
        } else throw new Error("Invalid identity response");
      } catch (error) {
        if (!disposed && token === epoch) {
          publish(error instanceof Error && error.message === "stale account confirmation" ? null : snapshot.actorId, false, snapshot.pendingLogout);
        }
      }
    });
  }
  function signOut(): Promise<void> {
    const actor = snapshot.actorId;
    ++epoch;
    lastConfirmed = null;
    publish(null, false, true, true);
    channel?.postMessage({ type: "signed-out" });
    const clearing = (async () => {
      const account = actor ?? await store.readLastAccount();
      await store.setPendingLogout(account ?? "logout");
      if (account) await store.clearAccount(account);
    })();
    const revoking = serialize(async () => {
      await clearing;
      if (!online()) return;
      try {
        await client.fetch("POST", "/signout");
        await store.clearPendingLogout();
        if (!disposed) publish(null, false, false);
      } catch { /* The durable barrier must survive failed server revocation. */ }
    });
    return Promise.all([clearing, revoking]).then(() => {});
  }
  if (channel) channel.onmessage = event => {
    if (event.data?.type !== "identity-changed" && event.data?.type !== "signed-out") return;
    ++epoch;
    publish(null, false, event.data.type === "signed-out", true);
    if (event.data.type === "identity-changed") void refresh();
  };
  const connectivityChanged = () => { void refresh(); };
  globalThis.addEventListener?.("online", connectivityChanged);
  globalThis.addEventListener?.("offline", connectivityChanged);
  return {
    getSnapshot: () => snapshot,
    getActorId: () => snapshot.actorId,
    getGeneration: () => snapshot.generation,
    isOnline: () => online() && snapshot.verified && !snapshot.pendingLogout,
    async isCurrent() {
      const generation = snapshot.generation;
      const actor = snapshot.actorId;
      if (disposed || actor === null || snapshot.pendingLogout) return false;
      const [lastAccount, pendingLogout] = await Promise.all([store.readLastAccount(), store.readPendingLogout()]);
      if (disposed || snapshot.generation !== generation) return false;
      if (lastAccount !== actor || pendingLogout !== null) {
        ++epoch;
        publish(null, false, pendingLogout !== null, true);
        return false;
      }
      return true;
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh, signOut,
    dispose() {
      disposed = true; ++epoch; listeners.clear();
      globalThis.removeEventListener?.("online", connectivityChanged);
      globalThis.removeEventListener?.("offline", connectivityChanged);
      if (channel) { channel.onmessage = null; channel.close(); }
    },
  };
}
