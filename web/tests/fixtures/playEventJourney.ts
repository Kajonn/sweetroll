import { expect, type Browser, type Page } from "@playwright/test";
import { cleanup, json, key, publish, resultOf, signIn, workspace, pushDocument } from "./configurablePush.js";
import { emberRoadDocument } from "../../../src/systems/implementation/package/fixtures/card-decks.js";
import { expectNoPageOverflow, PLAY_VIEWPORTS } from "./guiChecks.js";

export async function playEventJourney(page: Page, browser: Browser) {
  const gmId = await signIn(page, "code-journey-gm");
  const baseURL = new URL(page.url()).origin;
  const extraHTTPHeaders = { Origin: baseURL };
  const contexts = await Promise.all(PLAY_VIEWPORTS.slice(0, 2).map(viewport =>
    browser.newContext({ baseURL, viewport, extraHTTPHeaders })));
  const rules = pushDocument();
  rules.metadata.name = `Play events ${key()}`;
  rules.referenceData.push(...emberRoadDocument.referenceData.filter(dataset => dataset.id === "omens"));
  rules.decks = emberRoadDocument.decks!;
  rules.actions.push(...emberRoadDocument.actions.filter(action => action.kind === "draw"));
  rules.sheets[0]!.sections.at(-1)!.elements.push(
    { kind: "action", id: "read_omens_element", actionId: "read_omens" },
  );
  const { id } = await workspace(page.request, rules);
  const characters: string[] = [];
  let campaignId: string | undefined;
  try {
    const versionId = await publish(page.request, id);
    const { campaign } = await json(page.request, "POST", "/api/campaigns", {
      systemVersionId: versionId, title: rules.metadata.name, idempotencyKey: key(),
    });
    campaignId = campaign.campaignId;
    const path = `/api/campaigns/${campaignId}`;
    const campaignUrl = `/campaigns/${campaignId}`;
    const revision = async () => (await json(page.request, "GET", path)).campaign.revision;
    const phone = await contexts[0]!.newPage();
    const tablet = await contexts[1]!.newPage();
    const join = async (player: Page, code: string) => {
      const actor = await signIn(player, code);
      const { invitation } = await json(page.request, "POST", `${path}/invitations`, {
        intendedRole: "player", expectedCampaignRevision: await revision(), idempotencyKey: key(),
      });
      const { review } = await json(player.request, "POST", "/api/invitations/review", { token: invitation.token });
      await json(player.request, "POST", "/api/invitations/accept", {
        campaignId, token: invitation.token, expectedInvitationRevision: review.invitationRevision,
        reviewedAccessRevision: review.accessRevision, idempotencyKey: key(),
      });
      return actor;
    };
    const phoneId = await join(phone, "code-journey-p1");
    const tabletId = await join(tablet, "code-journey-p2");
    const actors = [{ view: phone, id: phoneId }, { view: tablet, id: tabletId }, { view: page, id: gmId }];
    for (const [index, actor] of actors.entries()) {
      const { character } = await json(page.request, "POST", `${path}/characters`, {
        name: `Roller ${index + 1}`, entityDefinitionId: "character", controllerUserIds: [actor.id],
        expectedCampaignRevision: await revision(), idempotencyKey: key(),
      });
      characters.push(character.characterId);
    }
    await page.setViewportSize(PLAY_VIEWPORTS[2]);
    const open = async (view: Page, url: string) => {
      const baseline = view.waitForResponse(r => new URL(r.url()).pathname === `${path}/activity` && r.ok());
      await view.goto(url);
      await baseline;
      await expect(view.getByTestId("play-events")).toHaveCount(0);
    };
    await Promise.all([
      open(phone, `/characters/${characters[0]}`),
      open(tablet, `/characters/${characters[1]}`),
      open(page, campaignUrl),
    ]);
    await page.getByRole("tab", { name: "Session" }).click();
    await page.getByRole("button", { name: "Open Roller 3", exact: true }).click();
    const stack = (view: Page) => view.getByTestId("play-events");
    const roll = (view: Page) => resultOf(view, () => view.getByRole("button", { name: "Test Pool", exact: true }).click(), "/actions/test_pool");
    const cards = (view: Page) => stack(view).getByRole("listitem");

    const firstConfirmedAt = Date.now();
    await roll(phone);
    const local = stack(phone).getByText(/You rolled/);
    await expect(local).toBeVisible();
    await expect(stack(page).getByText(/Journey Player One rolled/)).toBeVisible({ timeout: 5000 });
    const remoteObserved = Date.now() - firstConfirmedAt;
    await roll(tablet);
    await expect(stack(page).getByText(/Journey Player Two rolled/)).toBeVisible({ timeout: 5000 });
    const gmRoll = page.getByRole("button", { name: "Roll Test Pool", exact: true });
    await resultOf(page, () => gmRoll.click(), "/actions/test_pool");
    await expect(cards(page)).toHaveCount(3, { timeout: 5000 });
    await expect(cards(page).nth(0)).toContainText("You rolled");
    await expect(cards(page).nth(1)).toContainText("Journey Player Two rolled");
    await expect(cards(page).nth(2)).toContainText("Journey Player One rolled");
    await expect(local).toHaveCount(1);
    await expectNoPageOverflow(phone);
    await expectNoPageOverflow(tablet);
    await expectNoPageOverflow(page);
    await phone.setViewportSize({ width: 320, height: 640 });
    await phone.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await expectNoPageOverflow(phone);
    await expect(phone.getByTestId("player-bottom-nav")).toBeVisible();
    await expect(cards(page)).toHaveCount(2, { timeout: 8000 });
    await expect(stack(page)).toHaveCount(0, { timeout: 8000 });
    await page.getByRole("tab", { name: "Activity" }).click();
    await expect(page.getByRole("list", { name: "Campaign activity" }).getByText("Roll executed")).toHaveCount(3);

    const note = `Visible handout ${key()}`;
    const { content } = await json(page.request, "POST", `${path}/content`, {
      title: note, body: "shareable notes", audience: "all_players", idempotencyKey: key(),
    });
    await json(page.request, "PATCH", `/api/content/${content.contentId}`, {
      title: `${note} revised`, expectedContentRevision: content.revision, idempotencyKey: key(),
    });
    await json(page.request, "POST", `${path}/content`, {
      title: "GM secret handout", body: "secret notes", audience: "gm_only", idempotencyKey: key(),
    });
    await expect(stack(tablet).getByText(`Content updated · ${note} revised`, { exact: true })).toBeVisible({ timeout: 5000 });
    await expect(stack(tablet)).not.toContainText("GM secret handout");
    await open(tablet, `/characters/${characters[1]}`);

    await page.getByRole("tab", { name: "Session" }).click();
    await page.getByRole("button", { name: "Open Roller 3", exact: true }).click();
    await gmRoll.locator("..").getByLabel("Roll audience").selectOption("owner_only");
    await resultOf(page, () => gmRoll.click(), "/actions/test_pool");
    await expect(stack(page).getByText(/You rolled .*Owner only/)).toBeVisible();
    const afterPrivate = tablet.waitForResponse(r => new URL(r.url()).pathname === `${path}/activity` && r.ok());
    await afterPrivate;
    await expect(stack(tablet)).toHaveCount(0);
    const draw = await resultOf(phone, () => phone.getByRole("button", { name: "Read the omens", exact: true }).click(), "/actions/read_omens");
    const labels = draw.result.roll.breakdown.cards.drawn.map((card: { label: string }) => card.label).join(", ");
    await expect(stack(phone).getByText(`You drew ${labels}`, { exact: false })).toBeVisible();
    await expect(stack(tablet).getByText(`Journey Player One drew ${labels}`, { exact: false })).toBeVisible({ timeout: 5000 });
    console.log(`First remote card observed ${remoteObserved} ms after the roll began.`);
  } finally {
    await Promise.all(contexts.map(context => context.close()));
    if (process.env.SWEETROLL_E2E_EPHEMERAL_DB !== "1") await cleanup(page.request, id, characters, campaignId);
  }
}
