import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/physical-dice",
  testMatch: "**/*.spec.ts",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:4189" },
  webServer: {
    command: "node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4189",
    url: "http://127.0.0.1:4189/dice/v1/worker.js",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "phone-chromium", use: { ...devices["Pixel 7"] } },
    { name: "phone-webkit", use: { ...devices["iPhone 13"] } },
  ],
});
