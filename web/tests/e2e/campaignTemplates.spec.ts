import { test } from "@playwright/test";
import { campaignTemplateJourney } from "../fixtures/campaignTemplates.js";
test("GM publication, co-GM conflict, player snapshot, offline retry and archive/recover", async ({
  browser,
  baseURL,
}) => {
  await campaignTemplateJourney({ browser, baseURL });
});
