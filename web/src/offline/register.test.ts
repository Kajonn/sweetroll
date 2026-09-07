import { describe, expect, it } from "vitest";

import {
  describeOfflineUpdate,
  hasControllingWorker,
  isSnapshotOfflineCompatible,
  offlineReady,
  queryWorkerCacheReady,
  readOfflineBuildId,
  registerOfflineWorker,
} from "./register.js";
import { makeView } from "../characters/testing.js";

describe("offlineReady", () => {
  it("requires both worker readiness and a stored snapshot", () => {
    expect(offlineReady({ workerReady: false, snapshotStored: true })).toBe(false);
    expect(offlineReady({ workerReady: true, snapshotStored: false })).toBe(false);
    expect(offlineReady({ workerReady: true, snapshotStored: true, snapshotCompatible: true })).toBe(true);
  });

  it("defaults missing compatibility to not ready", () => {
    expect(offlineReady({ workerReady: true, snapshotStored: true })).toBe(false);
  });

  it("treats an incompatible snapshot as not ready", () => {
    expect(offlineReady({ workerReady: true, snapshotStored: true, snapshotCompatible: false })).toBe(false);
    expect(offlineReady({ workerReady: true, snapshotStored: true, snapshotCompatible: true })).toBe(true);
  });

  it("reports a failed cache installation as not ready", () => {
    expect(offlineReady({ workerReady: false, snapshotStored: true, snapshotCompatible: true })).toBe(false);
  });
});

describe("isSnapshotOfflineCompatible", () => {
  it("accepts the current projection version", () => {
    const view = makeView({ characterId: "char-1", revision: 1 });
    expect(isSnapshotOfflineCompatible(view)).toBe(true);
  });

  it("rejects missing or version-drifted snapshots", () => {
    expect(isSnapshotOfflineCompatible(null)).toBe(false);
    const view = makeView({ characterId: "char-1", revision: 1 });
    const drifted = { ...view, projection: { ...view.projection, projectionVersion: "99.0" } } as unknown as ReturnType<typeof makeView>;
    expect(isSnapshotOfflineCompatible(drifted)).toBe(false);
  });
});

describe("readOfflineBuildId", () => {
  it("reads the build id injected into the production shell", () => {
    document.head.innerHTML = '<meta name="offline-build-id" content="build-1">';
    expect(readOfflineBuildId()).toBe("build-1");
    document.head.innerHTML = "";
    expect(readOfflineBuildId()).toBeNull();
  });
});

describe("describeOfflineUpdate", () => {
  it("flags a controlling worker from a different build", () => {
    expect(describeOfflineUpdate("build-1", "build-1")).toBe("current");
    expect(describeOfflineUpdate("build-1", "build-2")).toBe("update-available");
    expect(describeOfflineUpdate("build-1", null)).toBe("current");
    expect(describeOfflineUpdate(null, "build-2")).toBe("current");
  });
});

describe("production gating", () => {
  it("skips registration outside production builds", async () => {
    await expect(registerOfflineWorker()).resolves.toBe("skipped");
  });

  it("reports no controlling worker without a service-worker container", async () => {
    expect(hasControllingWorker()).toBe(false);
    await expect(queryWorkerCacheReady(10)).resolves.toEqual({ ready: false, buildId: null });
  });
});
