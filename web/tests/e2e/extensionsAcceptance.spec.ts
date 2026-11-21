import { expect, test, type APIRequestContext, type Page } from "../fixtures/browserTest";

import { createCatalogCampaign, join, signIn } from "../fixtures/campaignTemplates.js";
import { json, key } from "../fixtures/configurablePush.js";
import { derivedTemplateDocument } from "../../../src/systems/implementation/package/fixtures/campaign-derived.js";

/**
 * System extensions plan E8, local ordered journey:
 *  1. the creator publishes a system and extensions X and Y (API; the GUI
 *     authoring path is covered by extensionAuthoring.spec.ts);
 *  2. player A creates a character with X ticked (GUI);
 *  3. the GM adds Y to the campaign in Settings (GUI);
 *  4. A's character is adopted (API), so the campaign has X and Y;
 *  5. player B places an X item from the grouped picker (GUI);
 *  6. the GM upgrades X campaign-wide, then reverts (GUI);
 *  7. removing X is blocked by B's item, then allowed once it is gone (GUI).
 * Every step is read back through the API.
 */
type Ref = { extensionId: string; versionId: string };

const pack = (name: string, templateId: string, edge: number) => ({
  schemaVersion: "2.0",
  metadata: { name, description: "", language: "en" },
  expressions: [{ id: `${templateId}_hit`, context: "roll", resultType: "number", source: "d20 + item.edge", fallback: 0 }],
  templates: [{
    kind: "item", id: templateId, label: name.replace(/ pack.*$/, " blade"),
    fields: [{ kind: "integer", id: "edge", label: "Edge", default: edge, min: 0, max: 10, step: 1, required: false }],
    grantedActions: [{ kind: "roll", id: `${templateId}_strike`, label: "Strike", expressionId: `${templateId}_hit`, inputs: [], outputTemplate: "{total}" }],
  }],
});

async function publishExtension(request: APIRequestContext, systemId: string, baseVersionId: string, name: string, templateId: string) {
  const created = await json(request, "POST", `/api/systems/${systemId}/extensions`, { baseVersionId, name, idempotencyKey: key() });
  const extensionId = created.workspace.extension.extensionId as string;
  let revision = created.workspace.draft.revision as number;
  const publish = async (semanticVersion: string, edge: number): Promise<Ref> => {
    const saved = await json(request, "PUT", `/api/extensions/${extensionId}/draft`, { expectedRevision: revision, document: pack(name, templateId, edge) });
    revision = saved.workspace.draft.revision;
    const published = await json(request, "POST", `/api/extensions/${extensionId}/publish`, {
      expectedRevision: revision, semanticVersion, releaseNotes: "", acknowledgeBreaking: false, idempotencyKey: key(),
    });
    return { extensionId, versionId: published.version.versionId };
  };
  const first = await publish("1.0.0", 1);
  await json(request, "PATCH", `/api/systems/${extensionId}`, { access: "public" });
  return { first, publish };
}

async function openRules(page: Page, campaignId: string) {
  await page.goto(`/campaigns/${campaignId}`);
  await page.getByRole("tab", { name: "Settings" }).click();
}

async function changeRules(page: Page, choice: RegExp, confirm: string) {
  await page.getByRole("radio", { name: choice }).check();
  await expect(page.getByText(/can move/)).toBeVisible();
  await page.getByRole("button", { name: confirm, exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: confirm, exact: true }).click();
  await expect(page.getByText("The rules were changed.")).toBeVisible();
}

test("E8: extensions across a campaign, from creation to removal", async ({ browser, baseURL }) => {
  test.setTimeout(240_000);
  if (!baseURL) throw new Error("Browser base URL required");
  const gm = await browser.newContext({ baseURL });
  const co = await browser.newContext({ baseURL });
  const playerA = await browser.newContext({ baseURL });
  const playerB = await browser.newContext({ baseURL });
  try {
    // 1. Creator: system, extension X (player-facing gear) and extension Y.
    const { systemId, campaignId, versionId } = await createCatalogCampaign(
      gm.request, co.request, playerA.request, (document) => Object.assign(document, derivedTemplateDocument()),
    );
    const suffix = key().slice(0, 6);
    const x = await publishExtension(gm.request, systemId, versionId, `Frost pack ${suffix}`, "frost_blade");
    const y = await publishExtension(gm.request, systemId, versionId, `Ember pack ${suffix}`, "ember_blade");
    const playerBId = await signIn(playerB.request, "code-journey-p2");
    await join(gm.request, playerB.request, campaignId, "player");

    // 2. Player A: a standalone character with X.
    const aPage = await playerA.newPage();
    await aPage.goto("/characters/new");
    await aPage.getByRole("textbox", { name: "System version ID" }).fill(versionId);
    await aPage.getByRole("button", { name: "Look up version" }).click();
    await aPage.getByRole("checkbox", { name: `Frost pack ${suffix} 1.0.0` }).check();
    await expect(aPage.getByRole("checkbox", { name: `Ember pack ${suffix} 1.0.0` })).not.toBeChecked();
    await aPage.getByLabel("Entity").selectOption({ label: "Character" });
    await aPage.getByLabel("Character name").fill(`Frost scout ${suffix}`);
    await aPage.getByRole("button", { name: "Create character" }).click();
    await expect(aPage).toHaveURL(/\/characters\/[0-9a-f-]{36}$/);
    const aCharacterId = aPage.url().split("/").pop()!;
    const aCreated = await json(playerA.request, "GET", `/api/characters/${aCharacterId}`);
    expect(aCreated.character.extensions).toEqual([x.first]);

    // 3. GM: add Y to the campaign in Settings.
    const gmPage = await gm.newPage();
    await openRules(gmPage, campaignId);
    await changeRules(gmPage, new RegExp(`^Add Ember pack ${suffix} 1\\.0\\.0`), "Add extension");
    const extensionIds = async () => (await json(gm.request, "GET", `/api/campaigns/${campaignId}/extensions`)).extensions.extensions
      .map((ref: Ref) => ref.extensionId).sort();
    expect(await extensionIds()).toEqual([y.first.extensionId]);

    // 4. A's character is adopted: it brings X, so the campaign has X and Y.
    const campaignRevision = (await json(playerA.request, "GET", `/api/campaigns/${campaignId}`)).campaign.revision;
    await json(playerA.request, "POST", `/api/campaigns/${campaignId}/characters/${aCharacterId}/adopt`, {
      expectedCampaignRevision: campaignRevision, expectedCharacterRevision: aCreated.character.revision,
      acknowledgedDisclosure: true, idempotencyKey: key(),
    });
    expect(await extensionIds()).toEqual([x.first.extensionId, y.first.extensionId].sort());
    const aAttached = await json(playerA.request, "GET", `/api/characters/${aCharacterId}`);
    expect(aAttached.character.extensions.map((ref: Ref) => ref.extensionId).sort()).toEqual([x.first.extensionId, y.first.extensionId].sort());

    // 5. Player B: a campaign character with an X item from the grouped picker.
    const created = await json(gm.request, "POST", `/api/campaigns/${campaignId}/characters`, {
      name: `Ember guard ${suffix}`, entityDefinitionId: "character", controllerUserIds: [playerBId],
      expectedCampaignRevision: (await json(gm.request, "GET", `/api/campaigns/${campaignId}`)).campaign.revision,
      idempotencyKey: key(),
    });
    const bCharacterId = created.character.characterId as string;
    const bPage = await playerB.newPage();
    await bPage.goto(`/characters/${bCharacterId}`);
    await bPage.getByTestId("slot-add-inventory").click();
    const picker = bPage.getByTestId("slot-template-picker-inventory");
    await expect(picker.locator(`optgroup[label="Frost pack ${suffix}"] option`)).toHaveText(["Frost blade"]);
    await expect(picker.locator(`optgroup[label="Ember pack ${suffix}"] option`)).toHaveText(["Ember blade"]);
    await picker.selectOption({ label: "Frost blade" });
    await bPage.getByTestId("slot-add-confirm-inventory").click();
    await expect(bPage.getByTestId("slot-list-inventory").getByText("Frost blade", { exact: true })).toBeVisible();
    const bEntries = async () => Object.values((await json(playerB.request, "GET", `/api/characters/${bCharacterId}`)).character.state.entries as
      Record<string, { entryId: string; extensionId?: string; values: { edge?: number } }>);
    await expect.poll(async () => (await bEntries()).map((entry) => [entry.extensionId, entry.values.edge])).toEqual([[x.first.extensionId, 1]]);

    // 6. GM: upgrade X campaign-wide; B's item follows the unchanged default. Then revert.
    const x2 = await x.publish("1.1.0", 2);
    await openRules(gmPage, campaignId);
    await changeRules(gmPage, new RegExp(`^Upgrade Frost pack ${suffix} to 1\\.1\\.0`), "Upgrade");
    const versionsOf = async (characterId: string, who: APIRequestContext) =>
      (await json(who, "GET", `/api/characters/${characterId}`)).character.extensions as Ref[];
    expect((await versionsOf(aCharacterId, playerA.request)).find((ref) => ref.extensionId === x.first.extensionId)).toEqual(x2);
    expect((await versionsOf(bCharacterId, playerB.request)).find((ref) => ref.extensionId === x.first.extensionId)).toEqual(x2);
    expect((await bEntries())[0]!.values.edge).toBe(2);
    await openRules(gmPage, campaignId);
    await changeRules(gmPage, /^Revert to /, "Revert");
    expect((await versionsOf(bCharacterId, playerB.request)).find((ref) => ref.extensionId === x.first.extensionId)).toEqual(x.first);
    expect((await bEntries())[0]!.values.edge).toBe(1);

    // 7. Removing X is blocked by B's item, then allowed once it is gone.
    await openRules(gmPage, campaignId);
    await gmPage.getByRole("radio", { name: `Remove Frost pack ${suffix}` }).check();
    await expect(gmPage.getByText("Blocked: fix the problems below first. Nothing has changed.")).toBeVisible();
    await expect(gmPage.getByRole("button", { name: "Remove extension", exact: true })).toBeDisabled();
    const [entry] = await bEntries();
    await json(playerB.request, "DELETE", `/api/characters/${bCharacterId}/entries/${entry!.entryId}`, {
      expectedRevision: (await json(playerB.request, "GET", `/api/characters/${bCharacterId}`)).character.revision, idempotencyKey: key(),
    });
    await openRules(gmPage, campaignId);
    await changeRules(gmPage, new RegExp(`^Remove Frost pack ${suffix}$`), "Remove extension");
    expect(await extensionIds()).toEqual([y.first.extensionId]);
    expect((await versionsOf(aCharacterId, playerA.request)).map((ref) => ref.extensionId)).toEqual([y.first.extensionId]);
    const activity = await json(gm.request, "GET", `/api/campaigns/${campaignId}/activity`);
    expect(activity.events.map((event: { kind: string }) => event.kind)).toEqual(expect.arrayContaining([
      "extension_added", "extension_upgraded", "system_version_reverted", "extension_removed",
    ]));
  } finally {
    await Promise.all([gm.close(), co.close(), playerA.close(), playerB.close()]);
  }
});
