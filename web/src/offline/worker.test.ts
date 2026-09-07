import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  OFFLINE_CACHE_PREFIX,
  cacheNameForBuild,
  isKnownShellRoute,
  renderServiceWorker,
  shouldHandle,
  type OfflineManifest,
} from "./worker.js";

function navigate(url: string): URL {
  return new URL(url);
}

describe("shouldHandle", () => {
  it("excludes API requests from service-worker handling", () => {
    expect(shouldHandle(new URL("https://app.test/api/characters/one"), "navigate")).toBe(false);
  });

  it("excludes dev routes", () => {
    expect(shouldHandle(navigate("https://app.test/dev/sign-in"), "navigate")).toBe(false);
    expect(shouldHandle(navigate("https://app.test/dev"), "navigate")).toBe(false);
  });

  it("excludes unknown document paths so API failures never render as HTML", () => {
    expect(shouldHandle(navigate("https://app.test/not-a-route"), "navigate")).toBe(false);
    expect(shouldHandle(navigate("https://app.test/systems/some-id"), "navigate")).toBe(false);
  });

  it("handles known shell navigations", () => {
    expect(shouldHandle(navigate("https://app.test/"), "navigate")).toBe(true);
    expect(shouldHandle(navigate("https://app.test/characters/new"), "navigate")).toBe(true);
    expect(shouldHandle(navigate("https://app.test/characters/char-1"), "navigate")).toBe(true);
  });

  it("handles same-origin subresource requests while still excluding API/dev", () => {
    expect(shouldHandle(navigate("https://app.test/assets/index-abc.js"), "asset")).toBe(true);
    expect(shouldHandle(navigate("https://app.test/api/characters/one"), "asset")).toBe(false);
    expect(shouldHandle(navigate("https://app.test/dev/panel"), "asset")).toBe(false);
  });
});

describe("isKnownShellRoute", () => {
  it("accepts only the offline shell routes", () => {
    expect(isKnownShellRoute("/")).toBe(true);
    expect(isKnownShellRoute("/characters/new")).toBe(true);
    expect(isKnownShellRoute("/characters/abc-123")).toBe(true);
    expect(isKnownShellRoute("/characters")).toBe(false);
    expect(isKnownShellRoute("/characters/a/b")).toBe(false);
    expect(isKnownShellRoute("/unknown")).toBe(false);
  });
});

describe("cacheNameForBuild", () => {
  it("versions the asset cache per build", () => {
    expect(cacheNameForBuild("build-1")).toBe(`${OFFLINE_CACHE_PREFIX}:build-1`);
    expect(cacheNameForBuild("build-1")).not.toBe(cacheNameForBuild("build-2"));
  });
});

describe("renderServiceWorker", () => {
  const manifest: OfflineManifest = { buildId: "build-1", assets: ["/index.html", "/assets/index-abc.js"] };

  it("embeds the versioned asset list", () => {
    const source = renderServiceWorker(manifest);
    expect(source).toContain("/index.html");
    expect(source).toContain("build-1");
  });

  it("stays asset-only: never caches API/dev responses and never forces updates", () => {
    const source = renderServiceWorker(manifest);
    expect(source).toContain("/api");
    expect(source).not.toContain("skipWaiting");
    expect(source).not.toMatch(/cache\.put/i);
  });

  it("answers the cache-readiness status message used by availability UI", () => {
    const source = renderServiceWorker(manifest);
    expect(source).toContain("sweetroll:offline-status");
  });

  it("is eviction-aware: status reply checks cache presence before reporting ready", () => {
    const source = renderServiceWorker(manifest);
    expect(source).toContain("caches.has");
    expect(source).toContain("caches.match");
    expect(source).not.toContain("ready: true");
  });

  it("has no DOM-only dependencies so it can build as an isolated worker", async () => {
    const fs = await import("node:fs/promises");
    const here = dirname(fileURLToPath(import.meta.url));
    const source = await fs.readFile(resolve(here, "worker.ts"), "utf8");
    expect(source).not.toMatch(/from\s+["']react["']/);
    expect(source).not.toContain("document.");
    expect(source).not.toContain("window.");
  });
});
