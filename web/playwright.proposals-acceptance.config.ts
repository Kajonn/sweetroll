import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";
const baseURL = process.env.PROPOSAL_ACCEPTANCE_URL;
if (!baseURL)
  throw Error("Set PROPOSAL_ACCEPTANCE_URL to the isolated preview URL");
const output = resolve(
  process.env.PROPOSAL_ACCEPTANCE_OUTPUT_DIR ??
    "test-results/proposal-acceptance",
);
export default defineConfig({
  testDir: "./tests",
  testMatch: [
    "**/e2e/campaignProposals.spec.ts",
    "**/offline/campaignProposals.spec.ts",
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
