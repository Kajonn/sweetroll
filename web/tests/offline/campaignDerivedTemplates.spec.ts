import { test } from "@playwright/test";
import { campaignDerivedJourney } from "../fixtures/campaignDerivedTemplates.js";
test("derived placement, values and committed push recover through the production worker", async ({
  browser,
  baseURL,
}) => campaignDerivedJourney({ browser, baseURL }, true));
