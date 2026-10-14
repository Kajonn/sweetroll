import { test } from "@playwright/test";
import { campaignTemplateJourney, campaignTemplateReviewJourney } from "../fixtures/campaignTemplates.js";
test("campaign choice survives offline reload and reconnect, while racing archive requires review", async ({
  browser,
  baseURL,
}) => {
  await campaignTemplateJourney({ browser, baseURL }, true);
});
test("reviewed selections and returned snapshots survive offline reload without revoked catalog data", async ({ browser, baseURL }) => {
  await campaignTemplateReviewJourney({ browser, baseURL }, true);
});
