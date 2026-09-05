import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: 0,
  use: { baseURL: "http://localhost:5173", trace: "retain-on-failure" },
  webServer: [
    { command: "npm run migrate && npm run dev:http", url: "http://localhost:3000/health/ready", reuseExistingServer: !process.env.CI, timeout: 60_000 },
    { command: "npm run web:dev", url: "http://localhost:5173", reuseExistingServer: !process.env.CI, timeout: 60_000 },
  ],
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
