import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { defineConfig } from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// Test-config-only env knobs (mirroring playwright.offline.config.ts) so E2E
// can run against dedicated ports/DB without touching the manual-test app's
// 3000/5173. Defaults preserve the historical behavior exactly.
const backendPort = process.env.BACKEND_PORT ?? "3000";
const webPort = process.env.WEB_PORT ?? "5173";
const backendTarget = process.env.SWEETROLL_BACKEND_TARGET ?? `http://localhost:${backendPort}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  // The e2e suites share a single dev identity in one Postgres DB. Tests
  // clone systems and clean them up (DELETE /api/systems/:systemId), but
  // the library sidebar in full-page visual baselines reflects whatever
  // concurrent tests have cloned. Run serially so each clone's lifecycle
  // (create -> snapshot -> delete) completes before the next test reads
  // the shared state.
  workers: 1,
  retries: 0,
  snapshotPathTemplate: "{testDir}/../visual/__screenshots__/{testFilePath}/{arg}{ext}",
  use: { baseURL: `http://localhost:${webPort}`, trace: "retain-on-failure" },
  webServer: [
    {
      command: "npm run migrate && npm run dev:http",
      url: `http://localhost:${backendPort}/health/ready`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      cwd: repoRoot,
      env: { PORT: backendPort },
    },
    {
      command: "npm run web:dev",
      url: `http://localhost:${webPort}`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      cwd: repoRoot,
      env: { SWEETROLL_BACKEND_TARGET: backendTarget },
    },
  ],
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
