import { expect, test } from "../fixtures/browserTest";
import { cleanup, createCharacter, json, key, publish, signIn, workspace } from "../fixtures/configurablePush.js";
import { expectAccessible } from "../fixtures/guiChecks";
import { d20Document } from "../../../src/systems/implementation/package/fixtures/d20.js";
import { bridgeContestDocument } from "../../../src/systems/implementation/package/fixtures/opposed.js";
import { movesDocument } from "../../../src/systems/implementation/package/fixtures/outcome-systems.js";

// GUI test plan T1 item 5: error and edge states of the rules coverage features.

test("R0: a sheet over the evaluation budget is refused at publish with a located diagnostic", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, "code-test-a");
  const document = structuredClone(d20Document);
  // 220 nodes at depth 4: inside every per-expression limit, 8,800 for the sheet.
  const inner = "min(1, 2, 3, 4, 5, 6, 7, 8)";
  const middle = `max(${Array.from({ length: 8 }, () => inner).join(", ")})`;
  const source = `max(${middle}, ${middle}, ${middle})`;
  for (let index = 0; index < 40; index += 1) {
    document.entities[0]!.fields.push({ kind: "computed", id: `heavy_${index}`, label: `Heavy ${index}`, valueType: "number", expressionId: `heavy_expr_${index}` });
    document.expressions.push({ id: `heavy_expr_${index}`, context: "computed", resultType: "number", source, fallback: 0 });
  }
  const created = await workspace(page.request, document);
  try {
    await page.goto(`/systems/${created.id}`);
    // The creator finds the problem before any publish request and names it in the diagnostics.
    const publishButton = page.getByTestId("document-editor-publish");
    await expect(publishButton).toBeDisabled();
    await expect(publishButton).toHaveAttribute("title", /Resolve 1 issue before publishing/);
    await page.getByTestId("document-editor-diagnostics-toggle").click();
    await expect(page.getByTestId("diagnostics-drawer")).toContainText(/evaluation steps; the limit is 8192/);
    await expect(page.getByTestId("publish-dialog-success")).toHaveCount(0);
  } finally {
    if (process.env.SWEETROLL_E2E_EPHEMERAL_DB !== "1") await cleanup(page.request, created.id, []);
  }
});

test("R3: a lookup without a row shows its fallback and a message, not a broken sheet", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, "code-test-a");
  const document = structuredClone(d20Document);
  document.referenceData.push({
    id: "ancestries", label: "Ancestries", keyColumn: "name", columns: { name: "text", bonus: "number" },
    records: [{ id: "human", label: "Human", values: { name: "human", bonus: 2 } }],
  });
  document.entities[0]!.fields.push({ kind: "computed", id: "ancestry_bonus", label: "Ancestry bonus", valueType: "number", expressionId: "ancestry_bonus_expr" });
  document.expressions.push({ id: "ancestry_bonus_expr", context: "computed", resultType: "number", source: 'lookup("ancestries", fields.ancestry, "bonus")', fallback: 0 });
  document.sheets[0]!.sections[0]!.elements.push({ kind: "field", id: "ancestry_bonus_element", fieldId: "ancestry_bonus" });
  const created = await workspace(page.request, document);
  const characters: string[] = [];
  try {
    const character = await createCharacter(page.request, await publish(page.request, created.id));
    characters.push(character.characterId);
    await page.goto(`/characters/${character.characterId}`);
    const derived = async () => (await json(page.request, "GET", `/api/characters/${character.characterId}`)).character.derivedValues.ancestry_bonus;
    await page.getByLabel("Ancestry", { exact: true }).selectOption("human");
    await expect.poll(derived).toBe(2);
    await page.getByLabel("Ancestry", { exact: true }).selectOption("elf");
    await expect.poll(derived).toBe(0);
    await expect(page.getByText("no row in 'ancestries' for the lookup key").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Check", exact: true })).toBeEnabled();
    await expectAccessible(page, "lookup fallback on the sheet");
  } finally {
    if (process.env.SWEETROLL_E2E_EPHEMERAL_DB !== "1") await cleanup(page.request, created.id, characters);
  }
});

test("R4: a roll over the dice limit is refused with a readable message", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, "code-test-a");
  const document = structuredClone(d20Document);
  const check = document.actions.find(action => action.id === "check");
  if (check?.kind !== "roll") throw new Error("Missing reference roll action");
  check.inputs = [];
  document.expressions.find(expression => expression.id === check.expressionId)!.source = "dice(fields.ability * 10, 6)";
  const created = await workspace(page.request, document);
  const characters: string[] = [];
  try {
    const character = await createCharacter(page.request, await publish(page.request, created.id));
    characters.push(character.characterId);
    await page.goto(`/characters/${character.characterId}`);
    // Ability 10 rolls exactly 100 dice; 11 would need 110.
    await page.getByRole("button", { name: "Check", exact: true }).click();
    await expect(page.getByTestId("roll-breakdown")).toBeVisible();
    const ability = page.getByLabel("Ability Score", { exact: true });
    await ability.fill("11");
    await ability.press("Enter");
    await expect.poll(async () => (await json(page.request, "GET", `/api/characters/${character.characterId}`)).character.state.values.ability).toBe(11);
    const refused = page.waitForResponse(response => response.request().method() === "POST" && response.url().includes("/actions/check"));
    await page.getByRole("button", { name: "Check", exact: true }).click();
    expect((await refused).status()).toBe(422);
    await expect(page.getByText(/evaluation budget exceeded/i).first()).toBeVisible();
  } finally {
    if (process.env.SWEETROLL_E2E_EPHEMERAL_DB !== "1") await cleanup(page.request, created.id, characters);
  }
});

test("R5: a roll that matches no band shows its total without an outcome", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, "code-test-a");
  const document = movesDocument();
  const move = document.actions.find(action => action.id === "make_move");
  if (move?.kind !== "roll") throw new Error("Missing move action");
  move.outcomes = [{ id: "legend", label: "Legend", expressionId: "move_strong" }];
  move.outputTemplate = "Rolled {total}";
  document.expressions = document.expressions.filter(expression => expression.id !== "move_weak" && expression.id !== "move_miss");
  document.expressions.find(expression => expression.id === "move_strong")!.source = "roll.total >= 100";
  const created = await workspace(page.request, document);
  const characters: string[] = [];
  try {
    const character = await createCharacter(page.request, await publish(page.request, created.id));
    characters.push(character.characterId);
    await page.goto(`/characters/${character.characterId}`);
    await page.getByRole("button", { name: "Make Move", exact: true }).click();
    await expect(page.getByText(/^Rolled -?\d+$/)).toBeVisible();
    await expect(page.getByTestId("roll-outcome")).toHaveCount(0);
    await expect(page.getByText("Legend")).toHaveCount(0);
  } finally {
    if (process.env.SWEETROLL_E2E_EPHEMERAL_DB !== "1") await cleanup(page.request, created.id, characters);
  }
});

test("R7: with no character of the target kind the picker is empty and the action stays off", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, "code-journey-gm");
  const document = structuredClone(bridgeContestDocument);
  document.entities.push({
    id: "gate", label: "Gate", kind: "npc",
    fields: [{ kind: "integer", id: "defense", label: "Defense", default: 12, required: true, min: 0, max: 30, step: 1 }],
  });
  const attack = document.actions.find(action => action.id === "attack");
  if (attack?.kind !== "roll") throw new Error("Missing attack action");
  attack.target = { entityId: "gate" };
  const created = await workspace(page.request, document);
  const characters: string[] = [];
  let campaignId: string | undefined;
  try {
    const versionId = await publish(page.request, created.id);
    const { campaign } = await json(page.request, "POST", "/api/campaigns", { systemVersionId: versionId, title: `Gate ${key()}`, idempotencyKey: key() });
    campaignId = campaign.campaignId;
    const { character } = await json(page.request, "POST", `/api/campaigns/${campaignId}/characters`, {
      name: "Striker", entityDefinitionId: "character", expectedCampaignRevision: campaign.revision, idempotencyKey: key(),
    });
    characters.push(character.characterId);
    await page.goto(`/characters/${character.characterId}`);
    const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Bridge attack", exact: true }) });
    await form.getByRole("button", { name: "Load roll options" }).click();
    await expect(form.getByLabel("Target character")).toBeDisabled();
    await expect(form.getByLabel("Target character")).toHaveText("No eligible targets");
    await expect(form.getByRole("button", { name: "Bridge attack", exact: true })).toBeDisabled();
    await expectAccessible(page, "empty target picker");
  } finally {
    if (process.env.SWEETROLL_E2E_EPHEMERAL_DB !== "1") await cleanup(page.request, created.id, characters, campaignId);
  }
});
