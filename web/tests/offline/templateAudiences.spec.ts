import { test } from "@playwright/test";
import { templateAudienceJourney } from "../fixtures/templateAudiences.js";
test("restricted catalog purges offline while disclosed sheet copies survive reload", async ({
  browser,
  baseURL,
}) => templateAudienceJourney({ browser, baseURL }, true));
