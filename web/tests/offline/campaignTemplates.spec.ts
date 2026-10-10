import { test } from "@playwright/test";
import { campaignTemplateJourney } from "../fixtures/campaignTemplates.js";
test("campaign choice survives offline reload and reconnect, while racing archive requires review", async ({
  browser,
  baseURL,
}) => {
  await campaignTemplateJourney({ browser, baseURL }, true);
});
