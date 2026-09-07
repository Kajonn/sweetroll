import { useEffect, useState } from "react";

import type { CharacterView } from "../characters/types.js";
import {
  describeOfflineUpdate,
  hasControllingWorker,
  isSnapshotOfflineCompatible,
  offlineReady,
  queryWorkerCacheReady,
  readOfflineBuildId,
  type OfflineUpdateStatus,
} from "./register.js";

export type OfflineAvailability = {
  available: boolean;
  workerReady: boolean;
  update: OfflineUpdateStatus;
  buildId: string | null;
};

/**
 * Availability of the current character for fully offline reopening:
 * a compatible durable snapshot plus confirmed controlling-worker cache
 * readiness. Without a worker (tests, unsupported browsers, dev builds)
 * this stays unavailable rather than guessing.
 */
export function useOfflineAvailability(view: CharacterView | null, stored?: boolean): OfflineAvailability {
  const [workerReady, setWorkerReady] = useState(false);
  const [update, setUpdate] = useState<OfflineUpdateStatus>("current");
  const [buildId] = useState<string | null>(() =>
    typeof document === "undefined" ? null : readOfflineBuildId(),
  );

  useEffect(() => {
    let cancelled = false;
    if (!hasControllingWorker()) return () => {};
    void queryWorkerCacheReady().then(status => {
      if (cancelled) return;
      setWorkerReady(status.ready);
      setUpdate(describeOfflineUpdate(buildId, status.buildId));
    });
    const onChange = () => {
      void queryWorkerCacheReady().then(status => {
        if (cancelled) return;
        setWorkerReady(status.ready);
        setUpdate(describeOfflineUpdate(buildId, status.buildId));
      });
    };
    navigator.serviceWorker.addEventListener("controllerchange", onChange);
    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener("controllerchange", onChange);
    };
  }, [buildId]);

  // Strictness: `view !== null` is in-memory presence, not a durable
  // store acknowledgement. Callers on a store-ack path may pass explicit
  // `stored`; otherwise presence of the confirmed view (which the session
  // only sets after loading from the durable store) implies stored.
  const snapshotStored = stored ?? view !== null;
  return {
    available: offlineReady({
      workerReady,
      snapshotStored,
      snapshotCompatible: isSnapshotOfflineCompatible(view),
    }),
    workerReady,
    update,
    buildId,
  };
}
