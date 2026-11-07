import { defineConfig } from "@playwright/test";
import local from "./playwright.config.js";
const hosted = process.env.SCENE_VISUAL_HOSTED === "1";
const baseURL = process.env.G9_ACCEPTANCE_URL;
if (hosted && baseURL !== "https://sweetroll-d2-preview.up.railway.app") throw Error("Visual-controls acceptance must target the isolated preview");
export default defineConfig({
  ...local, testMatch:"**/sceneVisualControls.spec.ts", testIgnore:[],
  webServer:hosted?undefined:local.webServer,
  reporter:[["list"],["json",{outputFile:process.env.SCENE_VISUAL_RESULTS??"test-results/scene-visual/results.json"}]],
  use:{...local.use,...(hosted?{baseURL,ignoreHTTPSErrors:true}:{}),
    ...(hosted&&process.env.HTTPS_PROXY?{proxy:{server:process.env.HTTPS_PROXY}}:{}),trace:"off",screenshot:"only-on-failure"},
});
