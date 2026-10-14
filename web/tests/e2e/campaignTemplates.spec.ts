import { test } from "@playwright/test";
import { campaignTemplateJourney, campaignTemplateReviewJourney } from "../fixtures/campaignTemplates.js";
test("GM publication, co-GM conflict, player snapshot, offline retry and archive/recover", async ({
  browser,
  baseURL,
}) => {
  await campaignTemplateJourney({ browser, baseURL });
});
test("selected revisions, returned catalog cache and live two-tab revocation", async ({ browser, baseURL }) => {
  await campaignTemplateReviewJourney({ browser, baseURL });
});
