/**
 * Production service-worker registration and offline-readiness helpers.
 *
 * Readiness rule: a character is Available offline only when a compatible
 * durable snapshot is stored AND the controlling worker confirms its build
 * cache. A failed cache installation therefore never reports ready, and
 * private snapshots stay in the account-aware IndexedDB store — never in
 * CacheStorage.
 */

import type { CharacterView } from "../characters/types.js";
import { OFFLINE_STATUS_MESSAGE } from "./worker.js";

/** Projection version this client knows how to render from cache. */
export const SUPPORTED_OFFLINE_PROJECTION = "1.0";

export type OfflineReadiness = {
  workerReady: boolean;
  snapshotStored: boolean;
  snapshotCompatible?: boolean;
};

/** Available-offline requires a stored snapshot plus worker cache readiness. */
export function offlineReady(state: OfflineReadiness): boolean {
  const compatible = state.snapshotCompatible ?? false;
  return state.workerReady && state.snapshotStored && compatible;
}

/** A durable snapshot is offline-compatible when its projection is current. */
export function isSnapshotOfflineCompatible(view: CharacterView | null): boolean {
  if (view === null) return false;
  return view.projection?.projectionVersion === SUPPORTED_OFFLINE_PROJECTION;
}

export type OfflineUpdateStatus = "current" | "update-available";

/**
 * Compare the page build against the controlling worker build. A mismatch
 * means a newer worker is waiting: open clients stay on the coherent old
 * build until they close (non-forced updates).
 */
export function describeOfflineUpdate(pageBuildId: string | null, workerBuildId: string | null): OfflineUpdateStatus {
  if (pageBuildId !== null && workerBuildId !== null && pageBuildId !== workerBuildId) return "update-available";
  return "current";
}

/** Build id the production shell was stamped with, if any. */
export function readOfflineBuildId(root: Pick<Document, "querySelector"> = document): string | null {
  const meta = root.querySelector('meta[name="offline-build-id"]');
  const content = meta?.getAttribute("content");
  return content === undefined || content === null || content === "" ? null : content;
}

type ServiceWorkerContainerLike = {
  readonly controller: unknown;
  register(scriptURL: string, options?: { scope?: string }): Promise<{ onupdatefound: ((event: Event) => void) | null }>;
};

function serviceWorkerContainer(): ServiceWorkerContainerLike | null {
  if (typeof navigator === "undefined") return null;
  if (!("serviceWorker" in navigator)) return null;
  return navigator.serviceWorker as unknown as ServiceWorkerContainerLike;
}

/** True once a worker controls this page (registration alone is not enough). */
export function hasControllingWorker(): boolean {
  const c = serviceWorkerContainer()?.controller;
  return c !== null && c !== undefined;
}

export type OfflineRegistrationResult = "registered" | "skipped" | "unsupported";

/**
 * Register the asset worker for production builds only. Resolves without
 * throwing so application startup never depends on worker installation.
 */
export async function registerOfflineWorker(options?: {
  onUpdate?: (status: OfflineUpdateStatus) => void;
}): Promise<OfflineRegistrationResult> {
  if (!import.meta.env.PROD) return "skipped";
  if (!("serviceWorker" in navigator)) return "unsupported";
  try {
    if (import.meta.env.PROD && "serviceWorker" in navigator) {
      const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      const target = registration as unknown as { onupdatefound: ((event: Event) => void) | null };
      target.onupdatefound = () => options?.onUpdate?.("update-available");
      return "registered";
    }
    return "unsupported";
  } catch {
    return "unsupported";
  }
}

export type WorkerCacheStatus = { ready: boolean; buildId: string | null };

/**
 * Ask the controlling worker whether its versioned asset cache installed.
 * The active worker only exists after a transactional install, so `ready`
 * confirms the cache; any failure (no controller, no reply, timeout) is
 * not ready rather than an error.
 */
export async function queryWorkerCacheReady(timeoutMs = 3000): Promise<WorkerCacheStatus> {
  const container = serviceWorkerContainer();
  const controller = container?.controller as unknown as { postMessage: unknown } | null | undefined;
  // Bind before entering the promise closure: property narrowing does not
  // survive into callbacks, and the method needs its controller receiver.
  const postMessage =
    controller !== null && controller !== undefined && typeof controller.postMessage === "function"
      ? (controller.postMessage as (message: unknown, transfer?: Transferable[]) => void).bind(controller)
      : null;
  if (container === null || postMessage === null) {
    return { ready: false, buildId: null };
  }
  return new Promise<WorkerCacheStatus>(resolve => {
    let settled = false;
    const done = (status: WorkerCacheStatus) => {
      if (!settled) {
        settled = true;
        resolve(status);
      }
    };
    const timer = setTimeout(() => done({ ready: false, buildId: null }), timeoutMs);
    try {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event: MessageEvent) => {
        clearTimeout(timer);
        const data = event.data as { ready?: boolean; buildId?: string } | null;
        done({ ready: data?.ready === true, buildId: typeof data?.buildId === "string" ? data.buildId : null });
      };
      postMessage({ type: OFFLINE_STATUS_MESSAGE }, [channel.port2]);
      channel.port1.onmessageerror = () => {
        clearTimeout(timer);
        done({ ready: false, buildId: null });
      };
    } catch {
      clearTimeout(timer);
      done({ ready: false, buildId: null });
    }
  });
}
