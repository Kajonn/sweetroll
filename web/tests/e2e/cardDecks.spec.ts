import { expect, test } from "../fixtures/browserTest";
import { expectAccessible, expectCreatorUsable, expectReadableInDarkAndLargeText, playAtEachViewport, pressFromKeyboard } from "../fixtures/guiChecks";
import { emberRoadDocument } from "../../../src/systems/implementation/package/fixtures/card-decks.js";
import { cleanup, json, key, resultOf, signIn } from "../fixtures/configurablePush.js";
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

    await expectCreatorUsable(page, "card decks creator");
    await expectReadableInDarkAndLargeText(page, "deck editor in the Dice tab");
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
    const draw = page.getByRole("button", { name: "Read the omens", exact: true });
    const cards = page.getByRole("region", { name: "Cards drawn from Omen deck" });
    // One draw of three cards per width: by keyboard at 360 px, by pointer at 768 and 1280 px.
    await playAtEachViewport(page, "card draw on the sheet", draw, async () => {
      await expect(cards.getByRole("listitem")).toHaveCount(3);
      await expect(cards.getByRole("listitem").first()).toContainText(/ of (Ember|Tide|Gale) \(rank: \d, suit: (Ember|Tide|Gale)\)/);
    });
    await expect(cards).toContainText("Omen deck: 3 cards left");
    await expect(drawCount).toHaveText("Omen deck: 3 of 12 cards left");
    await expectReadableInDarkAndLargeText(page, "drawn cards with the count");
    await draw.click();
    await expect(cards).toContainText("Omen deck: 0 cards left");
    await expect(drawCount).toHaveText("Omen deck has no cards left. Shuffle it to draw again.");
    await expect(page.getByRole("button", { name: "Read the omens", exact: true })).toBeDisabled();
    await expectAccessible(page, "empty deck on the sheet");
    await pressFromKeyboard(page.getByRole("button", { name: "Gather the omens", exact: true }));
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
    await playAtEachViewport(page, "card draw on the GM board", draw,
      () => expect(cards.getByRole("listitem")).toHaveCount(3));
    await expect(cards).toContainText("Omen deck: 3 cards left");
    await page.getByRole("button", { name: "Gather the omens", exact: true }).click();
    await expect(page.getByText("Omen deck shuffled.")).toBeVisible();
  } finally {
    if (process.env.SWEETROLL_E2E_EPHEMERAL_DB !== "1") await page.request.delete(`/api/systems/${systemId}`);
  }
});

// GUI test plan T1 item 6: a campaign deck shared by two players in separate browser profiles.
test("two players share the campaign's omen deck and never see the same card", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await signIn(page, "code-journey-gm");
  const document = structuredClone(emberRoadDocument);
  document.metadata.name = `Ember Road ${key()}`;
  const { workspace } = await json(page.request, "POST", "/api/systems", {
    source: { kind: "blank", name: document.metadata.name }, idempotencyKey: key(),
  });
  const systemId = workspace.system.systemId as string;
  const characterIds: string[] = [];
  const baseURL = new URL(page.url()).origin;
  const contexts = await Promise.all([browser.newContext({ baseURL }), browser.newContext({ baseURL })]);
  let campaignId: string | undefined;
  try {
    const saved = await json(page.request, "PUT", `/api/systems/${systemId}/draft`, {
      expectedRevision: workspace.draft.revision, document,
    });
    const { version } = await json(page.request, "POST", `/api/systems/${systemId}/publish`, {
      expectedRevision: saved.workspace.draft.revision, semanticVersion: "1.0.0", releaseNotes: "Shared omen deck",
      acknowledgeBreaking: true, idempotencyKey: key(),
    });
    const { campaign } = await json(page.request, "POST", "/api/campaigns", {
      systemVersionId: version.versionId, title: document.metadata.name, idempotencyKey: key(),
    });
    campaignId = campaign.campaignId;
    const path = `/api/campaigns/${campaignId}`;
    const revision = async () => (await json(page.request, "GET", path)).campaign.revision;
    const [seer, scout] = await Promise.all(contexts.map(context => context.newPage()));
    for (const [player, code, name] of [[seer!, "code-journey-p1", "Seer"], [scout!, "code-journey-p2", "Scout"]] as const) {
      const userId = await signIn(player, code);
      const { invitation } = await json(page.request, "POST", `${path}/invitations`, {
        intendedRole: "player", expectedCampaignRevision: await revision(), idempotencyKey: key(),
      });
      const { review } = await json(player.request, "POST", "/api/invitations/review", { token: invitation.token });
      await json(player.request, "POST", "/api/invitations/accept", {
        campaignId, token: invitation.token, expectedInvitationRevision: review.invitationRevision,
        reviewedAccessRevision: review.accessRevision, idempotencyKey: key(),
      });
      const { character } = await json(page.request, "POST", `${path}/characters`, {
        name, entityDefinitionId: "character", controllerUserIds: [userId],
        expectedCampaignRevision: await revision(), idempotencyKey: key(),
      });
      characterIds.push(character.characterId);
      await player.goto(`/characters/${character.characterId}`);
      await expect(player.getByTestId("deck-count-read_omens_element")).toHaveText("Omen deck: 12 of 12 cards left");
    }
    const count = (player: typeof page) => player.getByTestId("deck-count-read_omens_element");
    const draw = async (player: typeof page) =>
      (await resultOf(player, () => player.getByRole("button", { name: "Read the omens", exact: true }).click(), "/actions/read_omens")).result.roll;
    const shown = (player: typeof page) => player.getByRole("region", { name: "Cards drawn from Omen deck" }).getByRole("listitem");

    // Alternating draws come from one deck: each sheet shows its own cards and the shared count.
    const first = await draw(seer!);
    await expect(shown(seer!)).toHaveText(first.breakdown.cards.drawn.map((card: { label: string }) => new RegExp(`^${card.label} `)));
    await expect(count(seer!)).toHaveText("Omen deck: 10 of 12 cards left");
    const second = await draw(scout!);
    await expect(count(scout!)).toHaveText("Omen deck: 8 of 12 cards left");
    const ids = (roll: { breakdown: { cards: { drawn: { id: string }[] } } }) => roll.breakdown.cards.drawn.map(card => card.id);
    expect(new Set([...ids(first), ...ids(second)]).size).toBe(4);
    // The other sheet learns the count when it is loaded again, as documented.
    await expect(count(seer!)).toHaveText("Omen deck: 10 of 12 cards left");
    await seer!.reload();
    await expect(count(seer!)).toHaveText("Omen deck: 8 of 12 cards left");

    // Both draw at the same moment: still no card twice.
    const [third, fourth] = await Promise.all([draw(seer!), draw(scout!)]);
    expect(new Set([...ids(first), ...ids(second), ...ids(third), ...ids(fourth)]).size).toBe(8);
    expect([third.breakdown.cards.remaining, fourth.breakdown.cards.remaining].sort()).toEqual([4, 6]);

    // The GM reads both campaign-audience draws on the session board's sheet and may shuffle the shared deck.
    await page.goto(`/campaigns/${campaignId}`);
    await page.getByRole("tab", { name: "Session", exact: true }).click();
    await page.getByRole("button", { name: "Open Seer", exact: true }).click();
    await page.getByRole("button", { name: "Gather the omens", exact: true }).click();
    await expect(page.getByText("Omen deck shuffled.")).toBeVisible();
    await scout!.reload();
    await expect(count(scout!)).toHaveText("Omen deck: 12 of 12 cards left");
  } finally {
    await Promise.all(contexts.map(context => context.close()));
    if (process.env.SWEETROLL_E2E_EPHEMERAL_DB !== "1") await cleanup(page.request, systemId, characterIds, campaignId);
  }
});
