import { test } from "@playwright/test";
import { playEventJourney } from "../fixtures/playEventJourney.js";

test("hosted play events reach only the permitted campaign participants", async ({ page, browser }) => {
  test.setTimeout(180_000);
  await playEventJourney(page, browser);
});
