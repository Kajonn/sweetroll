import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";
const baseURL = process.env.DERIVED_ACCEPTANCE_URL;
if (!baseURL)
  throw Error("Set DERIVED_ACCEPTANCE_URL to the isolated preview URL");
const output = resolve(
  process.env.DERIVED_ACCEPTANCE_OUTPUT_DIR ??
    "test-results/derived-acceptance",
);
export default defineConfig({
  testDir: "./tests",
  testMatch: [
    "**/e2e/campaignDerivedTemplates.spec.ts",
    "**/offline/campaignDerivedTemplates.spec.ts",
  ],
  workers: 1,
  retries: 0,
  timeout: 180000,
  outputDir: resolve(output, "artifacts"),
  reporter: [
    ["list"],
    ["json", { outputFile: resolve(output, "results.json") }],
  ],
  use: {
    baseURL,
    browserName: "chromium",
    headless: true,
    ignoreHTTPSErrors: true,
    ...(process.env.HTTPS_PROXY
      ? { proxy: { server: process.env.HTTPS_PROXY } }
      : {}),
    launchOptions: { args: ["--no-sandbox", "--ignore-certificate-errors"] },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
