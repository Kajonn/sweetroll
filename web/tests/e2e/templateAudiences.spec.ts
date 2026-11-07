import { test } from "../fixtures/browserTest";
import { templateAudienceJourney } from "../fixtures/templateAudiences.js";
test("restricted drafts, actual player preview, explicit reveal and independent copies", async ({
  browser,
  baseURL,
}) => templateAudienceJourney({ browser, baseURL }));
