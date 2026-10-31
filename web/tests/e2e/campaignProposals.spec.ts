import { test } from "@playwright/test";
import { campaignProposalJourney } from "../fixtures/campaignProposals.js";
test("private player suggestions, atomic GM publication and exact-request recovery", async ({
  browser,
  baseURL,
}) => campaignProposalJourney({ browser, baseURL }));
