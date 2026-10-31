import { test } from "@playwright/test";
import { campaignDerivedJourney } from "../fixtures/campaignDerivedTemplates.js";
test("derived campaign template authoring, independent copies, actions, pushes and returned play", async ({
  browser,
  baseURL,
}) => campaignDerivedJourney({ browser, baseURL }));
