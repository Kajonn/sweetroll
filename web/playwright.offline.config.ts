import { defineConfig } from "@playwright/test";

/**
 * Production-browser offline config. Unlike the dev-server E2E config, this
 * runs against a production build served by `vite preview` (same-origin
 * `/api` + `/dev` forwarding and SPA fallback come from `vite.config.ts`),
 * so the asset service worker actually installs and controls the page.
 *
 * Run `npm run web:build` first, then `npm run web:test:offline`.
 */
export default defineConfig({
  testDir: "./tests/offline",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: { baseURL: "http://localhost:4173", trace: "retain-on-failure" },
  webServer: [
    {
      command: "npm run preview",
      url: "http://localhost:4173",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
