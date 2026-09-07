import { describe, expect, it } from "vitest";

import {
  buildOfflineManifest,
  collectOfflineAssets,
  offlineAssetsPlugin,
} from "../../build/offline-assets.js";

const bundle = {
  "index.html": { fileName: "index.html" },
  "assets/index-abc.js": { fileName: "assets/index-abc.js" },
  "assets/lazy-chunk-def.js": { fileName: "assets/lazy-chunk-def.js" },
  "assets/index-abc.css": { fileName: "assets/index-abc.css" },
  "assets/font-abc.woff2": { fileName: "assets/font-abc.woff2" },
  "assets/index-abc.js.map": { fileName: "assets/index-abc.js.map" },
};

describe("buildOfflineManifest", () => {
  it("includes entry HTML and every lazy chunk/CSS/font dependency", () => {
    const manifest = buildOfflineManifest(bundle, "build-1");
    expect(manifest.buildId).toBe("build-1");
    expect(manifest.assets).toContain("/index.html");
    expect(manifest.assets).toContain("/assets/index-abc.js");
    expect(manifest.assets).toContain("/assets/lazy-chunk-def.js");
    expect(manifest.assets).toContain("/assets/index-abc.css");
    expect(manifest.assets).toContain("/assets/font-abc.woff2");
  });

  it("excludes sourcemaps and never lists API/export bodies", () => {
    const manifest = buildOfflineManifest(bundle, "build-1");
    expect(manifest.assets.some(asset => asset.endsWith(".map"))).toBe(false);
    expect(manifest.assets.some(asset => asset.startsWith("/api"))).toBe(false);
    expect(manifest.assets.some(asset => asset.includes("export"))).toBe(false);
  });
});

describe("collectOfflineAssets", () => {
  it("lists the shell first, then a deduped sorted asset list", () => {
    const assets = collectOfflineAssets({ ...bundle, duplicate: { fileName: "assets/index-abc.js" } });
    expect(assets[0]).toBe("/index.html");
    expect(new Set(assets).size).toBe(assets.length);
    expect(assets.slice(1)).toEqual([...assets.slice(1)].sort());
  });
});

describe("offlineAssetsPlugin", () => {
  it("emits sw.js and a manifest, and tags the shell with the build id", async () => {
    const plugin = offlineAssetsPlugin({ buildId: "build-1" }) as {
      name: string;
      buildStart?: () => void;
      generateBundle?: (outputOptions: unknown, bundle: Record<string, { fileName: string }>) => void;
      transformIndexHtml?: (html: string) => { html: string; tags: Array<{ tag: string; attrs: Record<string, string> }> };
    };
    expect(plugin.name).toBe("sweetroll-offline-assets");
    plugin.buildStart?.();
    const emitted: Array<{ fileName: string; source: string }> = [];
    await plugin.generateBundle?.call({ emitFile: (file: { fileName: string; source: string }) => emitted.push(file) }, {}, bundle);
    const worker = emitted.find(file => file.fileName === "sw.js");
    const manifestFile = emitted.find(file => file.fileName === "offline-manifest.json");
    expect(worker).toBeDefined();
    expect(worker?.source).toContain("/index.html");
    expect(worker?.source).not.toContain("skipWaiting");
    const manifest = JSON.parse(manifestFile?.source ?? "{}") as { buildId: string; assets: string[] };
    expect(manifest.buildId).toBe("build-1");
    expect(manifest.assets).toContain("/index.html");
    const tagged = plugin.transformIndexHtml?.("<html><head></head></html>");
    expect(tagged?.tags.some(tag => tag.attrs["name"] === "offline-build-id" && tag.attrs["content"] === "build-1")).toBe(true);
  });
});
