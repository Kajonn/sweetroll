import type { ApiClient } from "../api/client.js";
import type { MeState } from "../api/hooks.js";
import type { CharacterStore } from "./store.js";

export type BrowserChannel = {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
};
export type IdentitySnapshot = { actorId: string | null; verified: boolean; generation: number; pendingLogout: boolean; sessionExpired: boolean };
export type IdentityGate = ReturnType<typeof createIdentityGate>;

/**
 * Post-sign-in return path for the `/cb` route. The Account screen's
 * re-auth entry stores the pre-sign-in path here; `/cb` consumes it once
 * (default `/characters`). Provider-agnostic by design: `/cb` validates
 * nothing provider-specific, so any configured OIDC adapter (test adapter
 * today) can use the same return journey.
 */
export const POST_SIGNIN_STORAGE_KEY = "sweetroll:postSignin";
export const POST_SIGNIN_DEFAULT_PATH = "/characters";

export function storePostSigninPath(path: string): void {
  try {
    sessionStorage.setItem(POST_SIGNIN_STORAGE_KEY, path);
  } catch {
    // Best-effort only: a missing store just falls back to the default path.
  }
}

export function takePostSigninPath(): string {
  let stored: string | null = null;
  try {
    stored = sessionStorage.getItem(POST_SIGNIN_STORAGE_KEY);
    sessionStorage.removeItem(POST_SIGNIN_STORAGE_KEY);
  } catch {
    stored = null;
  }
  // Same-app paths only; anything else falls back to the default.
  if (stored !== null && stored.startsWith("/") && !stored.startsWith("//")) return stored;
  return POST_SIGNIN_DEFAULT_PATH;
}

export function createIdentityGate(input: {
  store: CharacterStore | null; client: ApiClient; online?: () => boolean; channel?: BrowserChannel | null; locks?: LockManager | null;
}) {
  const { store, client } = input;
  const online = input.online ?? (() => navigator.onLine);
  const locks = input.locks === undefined ? navigator.locks : input.locks;
  const lifetime = new AbortController();
  const channel = input.channel === undefined && typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel("character-identity") : input.channel;
  let snapshot: IdentitySnapshot = { actorId: null, verified: false, generation: 0, pendingLogout: false, sessionExpired: false };
  let disposed = false;
  let epoch = 0;
  let lastConfirmed: string | null = null;
  let durableGeneration: number | null = null;
  let work: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();
  const publish = (actorId: string | null, verified: boolean, pendingLogout: boolean, invalidate = false, sessionExpired = false) => {
    snapshot = { actorId, verified, pendingLogout, sessionExpired, generation: snapshot.generation + (invalidate || actorId !== snapshot.actorId ? 1 : 0) };
    for (const listener of listeners) listener();
  };
  const serialize = (run: () => Promise<void>) => {
    work = work.catch(() => {}).then(async () => {
      if (locks) await locks.request("character:identity", { signal: lifetime.signal }, run);
      else await run();
    });
    return work;
  };
  function refresh(): Promise<void> {
    const token = ++epoch;
    return serialize(async () => {
      if (disposed || token !== epoch) return;
      try {
        let state = await store?.readIdentity();
        const pending = state?.pendingLogout ?? (snapshot.pendingLogout ? "logout" : null);
        if (disposed || token !== epoch) return;
        if (pending) {
          publish(null, false, true);
          await store?.clearAccount(pending);
          if (!online()) return;
          state = await store?.readIdentity();
          await client.fetch("POST", "/signout");
          await store?.clearPendingLogout(state?.generation);
          state = await store?.readIdentity();
        }
        if (disposed || token !== epoch) return;
        if (!online()) {
          const actor = state?.actorId ?? null;
          durableGeneration = state?.generation ?? null;
          if (!disposed && token === epoch) publish(actor, false, false);
          return;
        }
        // Do not expose a startup cache until this request confirms its account.
        publish(snapshot.actorId, false, false, false, snapshot.sessionExpired);
        const previous = await store?.readIdentity();
        if (disposed || token !== epoch) return;
        if (previous && (previous.pendingLogout !== null || previous.generation !== state?.generation)) {
          publish(null, false, previous.pendingLogout !== null, true);
          return;
        }
        const me = await client.fetch<MeState>("GET", "/me");
        if (disposed || token !== epoch) return;
        if (me.state === "authenticated" && typeof me.userId === "string" && me.userId.length > 0) {
          const changed = store ? await store.setLastAccount(me.userId, previous) : lastConfirmed !== me.userId;
          if (disposed || token !== epoch) return;
          lastConfirmed = me.userId;
          durableGeneration = previous ? previous.generation + (changed ? 1 : 0) : null;
          publish(me.userId, true, false);
          if (changed) channel?.postMessage({ type: "identity-changed" });
        } else if (me.state === "anonymous") {
          const changed = lastConfirmed !== null;
          lastConfirmed = null;
          publish(null, false, false);
          if (changed) channel?.postMessage({ type: "identity-changed" });
        } else if (me.state === "session_expired") {
          // Expired sessions read as signed-out (no actor, unverified) but
          // carry the expired entry the Account screen owns for re-auth.
          const changed = lastConfirmed !== null;
          lastConfirmed = null;
          publish(null, false, false, false, true);
          if (changed) channel?.postMessage({ type: "identity-changed" });
        } else throw new Error("Invalid identity response");
      } catch (error) {
        if (!disposed && token === epoch) {
          publish(error instanceof Error && error.message.startsWith("stale ") ? null : snapshot.actorId, false, snapshot.pendingLogout, false, snapshot.sessionExpired);
        }
      }
    }).catch(() => {});
  }
  function signOut(): Promise<void> {
    const actor = snapshot.actorId;
    ++epoch;
    lastConfirmed = null;
    publish(null, false, true, true);
    channel?.postMessage({ type: "signed-out" });
    const clearing = (async () => {
      if (!store) {
        if (!online()) throw new Error("Offline sign-out requires local storage.");
        return;
      }
      const account = actor ?? (await store.readIdentity()).actorId;
      await store.setPendingLogout(account ?? "logout");
      if (account) await store.clearAccount(account);
    })();
    let revocationError: unknown = null;
    const revoking = serialize(async () => {
      await clearing;
      if (!online()) return;
      try {
        const state = await store?.readIdentity();
        if (store && (!state || state.pendingLogout === null)) {
          if (!disposed) publish(null, false, false);
          return;
        }
        await client.fetch("POST", "/signout");
        await store?.clearPendingLogout(state?.generation);
        if (!disposed) publish(null, false, false);
      } catch (error) {
        // The durable barrier must survive failed server revocation, but the
        // failure is reported so the caller can surface a retryable error
        // instead of claiming success. Local data is already hidden.
        revocationError = error;
        throw error;
      }
    });
    return Promise.all([clearing, revoking]).then(
      () => {
        if (!store) throw new Error("Local sign-out could not be saved because storage is unavailable.");
        if (revocationError !== null) {
          throw new Error("Server sign-out failed; local data is cleared and sign-out will be retried.", {
            cause: revocationError,
          });
        }
      },
      (error) => {
        // Local clearing failures propagate unchanged; a revocation failure
        // is reported as retryable while the pending-logout barrier survives.
        if (!store) throw new Error("Local sign-out could not be saved because storage is unavailable.");
        if (revocationError !== null) {
          throw new Error("Server sign-out failed; local data is cleared and sign-out will be retried.", {
            cause: revocationError,
          });
        }
        throw error;
      },
    );
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
      if (disposed || !store || actor === null || snapshot.pendingLogout) return false;
      const current = await store.readIdentity();
      if (disposed || snapshot.generation !== generation) return false;
      if (current.actorId !== actor || current.pendingLogout !== null || current.generation !== durableGeneration) {
        ++epoch;
        publish(null, false, current.pendingLogout !== null, true);
        return false;
      }
      return true;
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh, signOut,
    dispose() {
      disposed = true; ++epoch; listeners.clear();
      lifetime.abort();
      globalThis.removeEventListener?.("online", connectivityChanged);
      globalThis.removeEventListener?.("offline", connectivityChanged);
      if (channel) { channel.onmessage = null; channel.close(); }
    },
  };
}
