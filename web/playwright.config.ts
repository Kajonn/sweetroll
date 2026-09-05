import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { defineConfig } from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: 0,
  snapshotPathTemplate: "{testDir}/../visual/__screenshots__/{testFilePath}/{arg}{ext}",
  use: { baseURL: "http://localhost:5173", trace: "retain-on-failure" },
  webServer: [
    { command: "npm run migrate && npm run dev:http", url: "http://localhost:3000/health/ready", reuseExistingServer: !process.env.CI, timeout: 60_000, cwd: repoRoot },
    { command: "npm run web:dev", url: "http://localhost:5173", reuseExistingServer: !process.env.CI, timeout: 60_000, cwd: repoRoot },
  ],
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
