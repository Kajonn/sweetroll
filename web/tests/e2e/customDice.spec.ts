import { expect, test } from "../fixtures/browserTest";
import { customDiceDocument, customDiceFixtures } from "../../../src/systems/implementation/package/fixtures/custom-dice.js";
import { uid } from "../offline/test-auth.js";

for (const fixture of customDiceFixtures) {
  test(`creator, player and GM roll ${fixture.name}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/");
    await page.getByTestId("dev-signin").click();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    const document = customDiceDocument(fixture);
    if (fixture.id === "fudge") delete document.dice;
    const systemName = `${fixture.name} ${uid()}`;
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
      await page.goto(`/systems/${systemId}`);
      await page.getByTestId("document-editor-tab-dice").click();

      await page.getByText("Custom dice", { exact: true }).click();
      if (fixture.id === "fudge") {
        await page.getByRole("button", { name: "Add custom die" }).click();
        await page.getByLabel("Die name").fill(fixture.dice.label);
        for (const [index, face] of fixture.dice.faces.entries()) {
          if (index > 0) await page.getByRole("button", { name: "Add face" }).click();
          const form = page.getByRole("group", { name: `Face ${index + 1}`, exact: true });
          await form.getByLabel("Face value").fill(String(face.value));
          await form.getByLabel("Face label").fill(face.label!);
        }
      } else {
        const symbols = page.getByRole("group", { name: "Face 1", exact: true }).getByLabel("Symbols");
        await symbols.fill("hit=0");
        await symbols.blur();
        await expect(page.getByText(/unique symbol IDs/)).toBeVisible();
        await symbols.fill("hit=3");
        await symbols.blur();
        await expect(page.getByText(/unique symbol IDs/)).toHaveCount(0);
      }
      const faces = page.getByRole("list", { name: fixture.id === "fudge" ? "Compass die faces" : "Signals faces" });
      await page.getByTestId("roll-action-try-check").click();
      await expect(faces.getByRole("listitem")).toHaveCount(4);

      await page.getByTestId("document-editor-publish").click();
      await page.getByTestId("publish-dialog-semver").fill("1.0.0");
      await page.getByTestId("publish-dialog-release-notes").fill("Custom dice");
      await page.getByTestId("publish-dialog-submit").click();
      await expect(page.getByTestId("publish-dialog-success")).toBeVisible();
      await page.getByTestId("publish-dialog-create-character").click();
      await page.getByLabel("Entity", { exact: true }).selectOption("character");
      await page.getByLabel("Character name").fill("Rin");
      await page.getByRole("button", { name: "Create character", exact: true }).click();
      await expect(page).toHaveURL(/\/characters\/[0-9a-f-]+$/);
      await page.getByRole("button", { name: fixture.action, exact: true }).click();
      await expect(faces.getByRole("listitem")).toHaveCount(4);

      await page.goto("/campaigns/new");
      await page.getByRole("button", { name: `${systemName} 1.0.0` }).click();
      await page.getByLabel("Campaign title").fill(`Custom dice table ${uid()}`);
      await page.getByRole("button", { name: "Create campaign" }).click();
      await expect(page).toHaveURL(/\/campaigns\/[0-9a-f-]+/);
      const campaignUrl = page.url();
      await page.getByLabel("Character name").fill("Guide");
      await page.getByLabel("Entity definition").selectOption("character");
      await page.getByRole("button", { name: "New campaign character" }).click();
      await expect(page).toHaveURL(/\/characters\/[0-9a-f-]+$/);
      await page.goto(campaignUrl);
      await page.getByRole("tab", { name: "Session" }).click();
      await page.getByRole("button", { name: "Open Guide" }).click();
      await page.getByRole("button", { name: `Roll ${fixture.action}`, exact: true }).click();
      await expect(faces.getByRole("listitem")).toHaveCount(4);
    } finally {
      if (process.env.SWEETROLL_E2E_EPHEMERAL_DB !== "1") await page.request.delete(`/api/systems/${systemId}`);
    }
  });
}
