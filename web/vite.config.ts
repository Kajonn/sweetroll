import { resolve } from "node:path";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

import { offlineAssetsPlugin } from "./build/offline-assets.js";

const backendTarget = process.env.SWEETROLL_BACKEND_TARGET ?? "http://localhost:3000";
const previewPort = Number(process.env.PREVIEW_PORT ?? "4173");

export default defineConfig({
  plugins: [react(), offlineAssetsPlugin()],
  resolve: {
    alias: {
      "@sweetroll/rules": resolve(__dirname, "../src/systems/implementation/rules/index.ts"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Forward /api and /dev to the HTTP backend without rewriting the Host
      // header. The backend distinguishes same-origin sign-out by comparing the
      // Origin host against this untouched Host header, so changing it here
      // would reject legitimate same-origin requests.
      "/api": { target: backendTarget, rewrite: (p) => p.replace(/^\/api/, "") },
      "/dev": { target: backendTarget },
    },
  },
  preview: {
    port: previewPort,
    strictPort: true,
    proxy: {
      "/api": { target: backendTarget, rewrite: (p) => p.replace(/^\/api/, "") },
      "/dev": { target: backendTarget },
    },
  },
  build: { outDir: "dist", sourcemap: true },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/testing/setup.ts"],
    globals: true,
    exclude: ["**/node_modules/**", "**/dist/**", "tests/e2e/**", "tests/offline/**"],
  },
});
