import { resolve } from "node:path";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
      "/api": { target: "http://localhost:3000", rewrite: (p) => p.replace(/^\/api/, "") },
      "/dev": { target: "http://localhost:3000" },
    },
  },
  preview: {
    port: 4173,
    strictPort: true,
    proxy: {
      "/api": { target: "http://localhost:3000", rewrite: (p) => p.replace(/^\/api/, "") },
      "/dev": { target: "http://localhost:3000" },
    },
  },
  build: { outDir: "dist", sourcemap: true },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/testing/setup.ts"],
    globals: true,
    exclude: ["**/node_modules/**", "**/dist/**", "tests/e2e/**"],
  },
});
