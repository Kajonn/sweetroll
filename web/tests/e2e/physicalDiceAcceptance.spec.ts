import { test } from "../fixtures/browserTest.js";
import { physicalDiceAcceptance } from "../fixtures/physicalDiceAcceptance.js";

test("acceptance matrix for shared physical dice", async ({ page, browser, baseURL }) => {
  test.skip(
    process.env.SWEETROLL_PHYSICAL_DICE !== "true",
    "Requires the physical dice server configuration",
  );
  test.setTimeout(180000);
  if (!baseURL) throw Error("Missing test URL");
  await physicalDiceAcceptance(page, browser, baseURL);
});
