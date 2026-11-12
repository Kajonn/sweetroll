import { bridgeContestDocument } from "../../../src/systems/implementation/package/fixtures/opposed.js";
import { expect, test } from "../fixtures/browserTest";
import { atEachViewport, expectAccessible, expectCreatorUsable, expectReadableInDarkAndLargeText, expectWithinViewport, PLAY_VIEWPORTS, pressFromKeyboard } from "../fixtures/guiChecks";
import { cleanup, json, key, resultOf, signIn } from "../fixtures/configurablePush.js";

test("creator, players and GM play the Bridge Contest", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await signIn(page, "code-journey-gm");
  const document = structuredClone(bridgeContestDocument);
  document.metadata.name = `Bridge Contest ${key()}`;
  for (const action of document.actions) {
    if (action.kind === "roll") {
      delete action.target;
      delete action.respondsTo;
    }
  }
  const { workspace } = await json(page.request, "POST", "/api/systems", {
    source: { kind: "blank", name: document.metadata.name }, idempotencyKey: key(),
  });
  const systemId = workspace.system.systemId as string;
  const characterIds: string[] = [];
  const baseURL = new URL(page.url()).origin;
  const contexts = await Promise.all([browser.newContext({ baseURL }), browser.newContext({ baseURL })]);
  let campaignId: string | undefined;
  try {
    await json(page.request, "PUT", `/api/systems/${systemId}/draft`, {
      expectedRevision: workspace.draft.revision, document,
    });
    await page.goto(`/systems/${systemId}`);
    await page.getByTestId("document-editor-tab-dice").click();
    const attackEditor = page.getByTestId("roll-action-attack");
    const counterEditor = page.getByTestId("roll-action-counter");
    await attackEditor.getByLabel("Target entity").selectOption("character");
    await counterEditor.getByLabel("Respond to a recorded roll").check();
    await attackEditor.getByTestId("roll-action-try-attack").click();
    await expect(attackEditor.getByTestId("roll-breakdown")).toBeVisible();
    await expectCreatorUsable(page, "targeted and opposed rolls creator");
    await page.getByTestId("document-editor-publish").click();
    await page.getByTestId("publish-dialog-semver").fill("1.0.0");
    await page.getByTestId("publish-dialog-release-notes").fill("Attack and contest");
    const published = page.waitForResponse(response =>
      response.request().method() === "POST" && response.url().endsWith(`/systems/${systemId}/publish`));
    await page.getByTestId("publish-dialog-submit").click();
    await expect(page.getByTestId("publish-dialog-success")).toBeVisible();
    const { version } = await (await published).json();
    const { campaign } = await json(page.request, "POST", "/api/campaigns", {
      systemVersionId: version.versionId, title: document.metadata.name, idempotencyKey: key(),
    });
    campaignId = campaign.campaignId;
    const path = `/api/campaigns/${campaignId}`;
    const revision = async () => (await json(page.request, "GET", path)).campaign.revision;
    const [striker, defender] = await Promise.all(contexts.map(context => context.newPage()));
    for (const [player, code, name] of [
      [striker!, "code-journey-p1", "Striker"], [defender!, "code-journey-p2", "Defender"],
    ] as const) {
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
    }
    const attack = striker!.locator("form").filter({ has: striker!.getByRole("button", { name: "Bridge attack", exact: true }) });
    await expect(attack.getByRole("button", { name: "Bridge attack", exact: true })).toBeDisabled();
    await attack.getByRole("button", { name: "Load roll options" }).click();
    await attack.getByLabel("Target character").selectOption({ label: "Defender" });
    // The striker plays on a phone by keyboard, the defender on a tablet, the GM on a desktop.
    await atEachViewport(striker!, async () => {
      await expectWithinViewport(attack.getByLabel("Target character"));
      await expectWithinViewport(attack.getByRole("button", { name: "Bridge attack", exact: true }));
    });
    await expectAccessible(striker!, "target picker on the sheet");
    await expectReadableInDarkAndLargeText(striker!, "target picker on the sheet");
    await striker!.setViewportSize(PLAY_VIEWPORTS[0]);
    const hit = (await resultOf(striker!, () => pressFromKeyboard(attack.getByRole("button", { name: "Bridge attack", exact: true })), "/actions/attack")).result.roll;
    expect(hit.targetCharacterId).toBe(characterIds[1]);
    expect(hit.total).toBe(hit.dice[0].value - 10);
    await striker!.getByText("Show roll details", { exact: true }).first().click();
    await expect(striker!.getByText("target.defense: 10", { exact: true })).toBeVisible();

    const counter = defender!.locator("form").filter({ has: defender!.getByRole("button", { name: "Counter the challenge", exact: true }) });
    await counter.getByRole("button", { name: "Load roll options" }).click();
    await counter.getByLabel("Recorded roll").selectOption({ label: hit.output });
    await atEachViewport(defender!, async () => {
      await expectWithinViewport(counter.getByLabel("Recorded roll"));
      await expectWithinViewport(counter.getByRole("button", { name: "Counter the challenge", exact: true }));
    });
    await expectAccessible(defender!, "recorded-roll picker on the sheet");
    await defender!.setViewportSize(PLAY_VIEWPORTS[1]);
    const reply = (await resultOf(defender!, () => counter.getByRole("button", { name: "Counter the challenge", exact: true }).click(), "/actions/counter")).result.roll;
    expect(reply.total).toBe(reply.dice[0].value - hit.total);
    expect(reply.bindings).toEqual([{ scope: "opposed", definitionId: "total", value: hit.total }]);

    // One response per player: the answered roll is no longer offered and the action stays off.
    await counter.getByRole("button", { name: "Load roll options" }).click();
    await expect(counter.getByLabel("Recorded roll").getByRole("option", { name: hit.output, exact: true })).toHaveCount(0);
    await expect(counter.getByRole("button", { name: "Counter the challenge", exact: true })).toBeDisabled();

    await page.goto(`/campaigns/${campaignId}`);
    await page.getByRole("tab", { name: "Session", exact: true }).click();
    await page.getByRole("button", { name: "Open Striker", exact: true }).click();
    const gmAttack = page.getByRole("button", { name: "Roll Bridge attack", exact: true }).locator("..");
    await gmAttack.getByRole("button", { name: "Load roll options" }).click();
    await gmAttack.getByLabel("Target character").selectOption({ label: "Defender" });
    const gmRoll = (await resultOf(page, () => gmAttack.getByRole("button", { name: "Roll Bridge attack", exact: true }).click(), "/actions/attack")).result.roll;
    expect(gmRoll.bindings).toEqual([{ scope: "target", definitionId: "defense", value: 10 }]);
    await atEachViewport(page, () => expectWithinViewport(gmAttack.getByLabel("Target character")));
    await expectAccessible(page, "targeted roll on the GM board");
  } finally {
    await Promise.all(contexts.map(context => context.close()));
    if (process.env.SWEETROLL_E2E_EPHEMERAL_DB !== "1") await cleanup(page.request, systemId, characterIds, campaignId);
  }
});
