import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

const baseURL = process.env.PUSH_ACCEPTANCE_URL;
if (!baseURL) throw Error("Set PUSH_ACCEPTANCE_URL to the isolated preview URL.");
const output = resolve(process.env.PUSH_ACCEPTANCE_OUTPUT_DIR ?? "test-results/push-acceptance");

export default defineConfig({
  testDir: "./tests",
  testMatch: ["**/e2e/configurablePush.spec.ts", "**/e2e/campaignPush.spec.ts", "**/e2e/pushTransitions.spec.ts", "**/offline/pushRecovery.spec.ts"],
  workers: 1,
  retries: 0,
  timeout: 180_000,
  outputDir: resolve(output, "artifacts"),
  reporter: [["list"], ["json", { outputFile: resolve(output, "results.json") }]],
  use: {
    baseURL,
    browserName: "chromium",
    headless: true,
    ignoreHTTPSErrors: true,
    ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY } } : {}),
    launchOptions: { args: ["--no-sandbox", "--ignore-certificate-errors"] },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
