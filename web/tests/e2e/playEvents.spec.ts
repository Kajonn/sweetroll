import { test } from "../fixtures/browserTest";
import { playEventJourney } from "../fixtures/playEventJourney.js";

test("play events stack and fade across GM and player screens", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await playEventJourney(page, browser);
});
