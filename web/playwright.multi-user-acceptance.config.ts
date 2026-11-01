import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";
const baseURL = process.env.MULTI_USER_ACCEPTANCE_URL;
if (!baseURL) throw Error("Set MULTI_USER_ACCEPTANCE_URL to the isolated fixed-commit preview URL");
const output = resolve(process.env.MULTI_USER_ACCEPTANCE_OUTPUT_DIR ?? "test-results/multi-user-acceptance");
export default defineConfig({
  testDir: "./tests/offline", testMatch: "multiUserJourney.spec.ts", workers: 1, retries: 0,
  outputDir: resolve(output,"artifacts"),
  reporter: [["list"],["json",{outputFile:resolve(output,"results.json")}]],
  use: { baseURL, browserName:"chromium", headless:true, ignoreHTTPSErrors:true,
    ...(process.env.HTTPS_PROXY ? {proxy:{server:process.env.HTTPS_PROXY}} : {}),
    launchOptions:{args:["--no-sandbox","--ignore-certificate-errors"]},
    trace:"off", screenshot:"only-on-failure" }, // Tokens stay out of hosted traces.
});
