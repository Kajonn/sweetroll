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
      "/api": { target: "http://localhost:3000", changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, "") },
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
