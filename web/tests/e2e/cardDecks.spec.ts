import { expect, test } from "../fixtures/browserTest";
import { emberRoadDocument } from "../../../src/systems/implementation/package/fixtures/card-decks.js";
import { uid } from "../offline/test-auth.js";

test("creator, player and GM draw from the Ember Road omen deck", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await page.getByTestId("dev-signin").click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  const document = structuredClone(emberRoadDocument);
  const systemName = `Ember Road ${uid()}`;
  document.metadata.name = systemName;
  const created = await page.request.post("/api/systems", {
    data: { source: { kind: "blank", name: systemName }, idempotencyKey: uid() },
  });
  expect(created.status()).toBe(201);
  const { workspace } = await created.json();
  const systemId = workspace.system.systemId;
  try {
    const stored = await page.request.put(`/api/systems/${systemId}/draft`, {
      data: { expectedRevision: workspace.draft.revision, document },
    });
    expect(stored.status()).toBe(200);

    // Creator: the deck reads its cards from the dataset; draw three cards instead of two.
    await page.goto(`/systems/${systemId}`);
    await page.getByTestId("document-editor-tab-dice").click();
    await page.getByText("Card decks", { exact: true }).click();
    await expect(page.getByTestId("deck-count-omen_deck")).toHaveText("12 cards");
    await page.getByLabel("Deck name").fill("Omen deck");
    await page.getByTestId("deck-action-count-read_omens").fill("3");
    await expect(page.getByTestId("deck-action-gather_omens").getByLabel("Deck")).toHaveValue("omen_deck");

    await page.getByTestId("document-editor-publish").click();
    await page.getByTestId("publish-dialog-semver").fill("1.0.0");
    await page.getByTestId("publish-dialog-release-notes").fill("Omen deck");
    await page.getByTestId("publish-dialog-submit").click();
    await expect(page.getByTestId("publish-dialog-success")).toBeVisible();

    // Player: a standalone character has its own deck.
    await page.getByTestId("publish-dialog-create-character").click();
    await page.getByLabel("Entity", { exact: true }).selectOption("character");
    await page.getByLabel("Character name").fill("Rin");
    await page.getByRole("button", { name: "Create character", exact: true }).click();
    await expect(page).toHaveURL(/\/characters\/[0-9a-f-]+$/);
    const drawCount = page.getByTestId("deck-count-read_omens_element");
    await expect(drawCount).toHaveText("Omen deck: 12 of 12 cards left");
    await page.getByRole("button", { name: "Read the omens", exact: true }).click();
    const cards = page.getByRole("region", { name: "Cards drawn from Omen deck" });
    await expect(cards.getByRole("listitem")).toHaveCount(3);
    await expect(cards.getByRole("listitem").first()).toContainText(/ of (Ember|Tide|Gale) \(rank: \d, suit: (Ember|Tide|Gale)\)/);
    await expect(cards).toContainText("Omen deck: 9 cards left");
    await expect(drawCount).toHaveText("Omen deck: 9 of 12 cards left");
    for (const left of [6, 3, 0]) {
      await page.getByRole("button", { name: "Read the omens", exact: true }).click();
      await expect(cards).toContainText(`Omen deck: ${left} cards left`);
    }
    await expect(drawCount).toHaveText("Omen deck has no cards left. Shuffle it to draw again.");
    await expect(page.getByRole("button", { name: "Read the omens", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Gather the omens", exact: true }).click();
    await expect(drawCount).toHaveText("Omen deck: 12 of 12 cards left");
    await expect(page.getByRole("button", { name: "Read the omens", exact: true })).toBeEnabled();

    // GM: the campaign shares one deck, separate from the standalone character's.
    await page.goto("/campaigns/new");
    await page.getByRole("button", { name: `${systemName} 1.0.0` }).click();
    await page.getByLabel("Campaign title").fill(`Omen table ${uid()}`);
    await page.getByRole("button", { name: "Create campaign" }).click();
    await expect(page).toHaveURL(/\/campaigns\/[0-9a-f-]+/);
    const campaignUrl = page.url();
    await page.getByLabel("Character name").fill("Guide");
    await page.getByLabel("Entity definition").selectOption("character");
    await page.getByRole("button", { name: "New campaign character" }).click();
    await expect(page).toHaveURL(/\/characters\/[0-9a-f-]+$/);
    await expect(page.getByTestId("deck-count-read_omens_element")).toHaveText("Omen deck: 12 of 12 cards left");
    await page.goto(campaignUrl);
    await page.getByRole("tab", { name: "Session" }).click();
    await page.getByRole("button", { name: "Open Guide" }).click();
    await page.getByRole("button", { name: "Read the omens", exact: true }).click();
    await expect(cards.getByRole("listitem")).toHaveCount(3);
    await expect(cards).toContainText("Omen deck: 9 cards left");
    await page.getByRole("button", { name: "Gather the omens", exact: true }).click();
    await expect(page.getByText("Omen deck shuffled.")).toBeVisible();
  } finally {
    if (process.env.SWEETROLL_E2E_EPHEMERAL_DB !== "1") await page.request.delete(`/api/systems/${systemId}`);
  }
});
