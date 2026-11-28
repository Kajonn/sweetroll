import { expect, test } from "../fixtures/browserTest";
import { cleanup, createCharacter, publish, pushDocument, resultOf, signIn, workspace } from "../fixtures/configurablePush.js";

// Regression for the 2026-11-12 fix: a pushable roll whose output text reads a
// resource part could be rolled but not reopened or pushed.
test("a pushable roll that prints a resource part can be reloaded and pushed", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, "code-test-a");
  const document = pushDocument();
  const action = document.actions.find(candidate => candidate.kind === "roll");
  const resource = document.entities[0]!.fields.find(field => field.kind === "resource");
  if (action?.kind !== "roll" || resource === undefined) throw new Error("The pool fixture needs a roll and a resource.");
  action.outputTemplate = `${resource.label} {fields.${resource.id}.current} of {fields.${resource.id}.max}: {total}`;
  const created = await workspace(page.request, document);
  const characters: string[] = [];
  try {
    const character = await createCharacter(page.request, await publish(page.request, created.id));
    characters.push(character.characterId);
    await page.goto(`/characters/${character.characterId}`);
    const roll = (await resultOf(page, () => page.getByRole("button", { name: action.label, exact: true }).click(),
      `/actions/${action.id}`)).result.roll;
    const prefix = `${resource.label} ${resource.default.current} of ${resource.default.max}: `;
    expect(roll.output).toContain(prefix);
    const panel = page.getByTestId("push-result");
    await expect(panel).toContainText(prefix);

    // Reloading reads the saved roll and its push options again.
    await page.reload();
    await expect(panel).toContainText(prefix);
    await expect(panel.getByRole("button", { name: "Push saved roll" })).toBeEnabled();
    const child = (await resultOf(page, () => panel.getByRole("button", { name: "Push saved roll" }).click(), "/push")).result.roll;
    expect(child.output).toContain(prefix);
    await expect(panel).toContainText("Push 1 of 2");
    await expect(panel).toContainText(prefix);
  } finally {
    if (process.env.SWEETROLL_E2E_EPHEMERAL_DB !== "1") await cleanup(page.request, created.id, characters);
  }
});
