/**
 * Vite production plugin for fully offline application loading.
 *
 * Emits an isolated `sw.js` (rendered from `src/offline/worker.ts`, never
 * bundled with application code) plus a versioned asset manifest covering
 * the entry HTML and every lazy chunk/CSS/font dependency. Sourcemaps, API
 * payloads, and export bodies are never listed. The plugin also stamps the
 * shell with its build id and gives `vite preview` an SPA fallback so
 * production E2E can reload character deep links.
 */

import type { Plugin } from "vite";

import { renderServiceWorker, type OfflineManifest } from "../src/offline/worker.js";

export type OfflineBundleInput = Record<string, { fileName: string }>;

export type OfflineAssetsPluginOptions = {
  buildId?: string;
};

const CACHEABLE_EXTENSIONS = new Set(["js", "css", "woff", "woff2", "ttf", "otf", "eot", "svg", "png", "jpg", "jpeg", "gif", "webp", "ico"]);
const GENERATED_FILES = new Set(["sw.js", "offline-manifest.json", "manifest.webmanifest"]);

/**
 * Versioned asset list: entry HTML first, then every cacheable bundle
 * output. Excludes sourcemaps, the generated worker/manifest themselves,
 * and anything that is not a same-origin build asset.
 */
export function collectOfflineAssets(bundle: OfflineBundleInput): string[] {
  const assets = new Set<string>(["/index.html"]);
  for (const entry of Object.values(bundle)) {
    const fileName = entry?.fileName;
    if (typeof fileName !== "string" || fileName === "") continue;
    if (fileName.endsWith(".map")) continue;
    if (GENERATED_FILES.has(fileName)) continue;
    if (fileName.endsWith(".html")) continue;
    const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
    if (!CACHEABLE_EXTENSIONS.has(extension)) continue;
    assets.add(`/${fileName}`);
  }
  const rest = [...assets].filter(asset => asset !== "/index.html").sort();
  return ["/index.html", ...rest];
}

export function buildOfflineManifest(bundle: OfflineBundleInput, buildId: string): OfflineManifest {
  return { buildId, assets: collectOfflineAssets(bundle) };
}

export function offlineAssetsPlugin(options: OfflineAssetsPluginOptions = {}): Plugin {
  let buildId = options.buildId ?? process.env["OFFLINE_BUILD_ID"] ?? "";
  const ensureBuildId = (): string => {
    if (buildId === "") buildId = `build-${Date.now().toString(36)}`;
    return buildId;
  };

  return {
    name: "sweetroll-offline-assets",
    buildStart() {
      ensureBuildId();
    },
    generateBundle(_outputOptions, bundle) {
      const manifest = buildOfflineManifest(bundle, ensureBuildId());
      this.emitFile({ type: "asset", fileName: "sw.js", source: renderServiceWorker(manifest) });
      this.emitFile({ type: "asset", fileName: "offline-manifest.json", source: JSON.stringify(manifest, null, 2) });
    },
    transformIndexHtml(html: string) {
      return {
        html,
        tags: [
          {
            tag: "meta",
            attrs: { name: "offline-build-id", content: ensureBuildId() },
            injectTo: "head",
          },
        ],
      };
    },
    configurePreviewServer(server) {
      // Production SPA fallback: known shell paths and character deep links
      // serve index.html; API/dev, files, and the worker pass through.
      server.middlewares.use((req, _res, next) => {
        const rawUrl = req.url ?? "/";
        const path = rawUrl.split("?")[0] ?? "/";
        if (req.method !== "GET") {
          next();
          return;
        }
        if (path === "/api" || path.startsWith("/api/")) {
          next();
          return;
        }
        if (path === "/dev" || path.startsWith("/dev/")) {
          next();
          return;
        }
        if (path.includes(".")) {
          next();
          return;
        }
        req.url = "/index.html";
        next();
      });
    },
  };
}
