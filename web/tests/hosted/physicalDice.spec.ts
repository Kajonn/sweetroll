import { test } from "@playwright/test";
import { physicalDiceAcceptance } from "../fixtures/physicalDiceAcceptance.js";

test.use({ extraHTTPHeaders: { Origin: process.env.G9_ACCEPTANCE_URL! } });

test("hosted shared dice cover all shapes, pools, pushes and audience recovery", async ({
  page,
  browser,
  baseURL,
}, info) => {
  if (!baseURL) throw Error("Missing acceptance URL");
  const result = await physicalDiceAcceptance(page, browser, baseURL);
  await info.attach("physical dice acceptance", {
    contentType: "application/json",
    body: JSON.stringify(result, null, 2),
  });
});
