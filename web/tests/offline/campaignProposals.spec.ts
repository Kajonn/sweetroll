import { test } from "../fixtures/browserTest";
import { campaignProposalJourney } from "../fixtures/campaignProposals.js";
test("proposal recovery preserves private online-only authority with the production worker", async ({
  browser,
  baseURL,
}) => campaignProposalJourney({ browser, baseURL }, true));
