import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";
const baseURL = process.env.G9_ACCEPTANCE_URL;
if (!baseURL || !["https://sweetroll-d2-preview.up.railway.app", "https://sweetroll-acceptance-production.up.railway.app"].includes(baseURL)) {
  throw Error("G9_ACCEPTANCE_URL must name an existing Sweetroll test deployment");
}
const output = resolve(process.env.G9_OUTPUT_DIR ?? "test-results/g9-hosted");
export default defineConfig({
  testDir: "./tests/hosted", fullyParallel: true, workers: 2, retries: 0, timeout: 480_000,
  outputDir: resolve(output, "artifacts"),
  reporter: [["list"], ["json", { outputFile: resolve(output, "results.json") }]],
  use: { baseURL, browserName: "chromium", headless: true,
    ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY } } : {}),
    launchOptions: { args: ["--no-sandbox"] },
    // Authentication and display codes must not enter traces.
    trace: "off", screenshot: "only-on-failure" },
});
