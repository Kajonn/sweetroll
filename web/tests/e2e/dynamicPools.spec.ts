import { expect, test } from "../fixtures/browserTest";
import { dynamicPoolDocument, dynamicPoolFixtures } from "../../../src/systems/implementation/package/fixtures/dynamic-pools.js";
import { uid } from "../offline/test-auth.js";

for (const fixture of dynamicPoolFixtures) {
  test(`creator, player and GM roll ${fixture.name}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/");
    await page.getByTestId("dev-signin").click();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    const document = dynamicPoolDocument(fixture);
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

      if (fixture.id === "keep") {
        await page.getByRole("button", { name: "Named dice groups", exact: true }).click();
        const builder = page.getByRole("group", { name: "Blades", exact: true });
        await expect(builder.getByRole("checkbox", { name: "Explode dice" })).toBeChecked();
        await expect(builder.getByLabel("Keep count source")).toHaveValue("fields.keep_count");
        await builder.getByRole("checkbox", { name: "Reroll one face once" }).check();
        await expect(builder.getByLabel("Reroll face", { exact: true })).toHaveValue("1");
      }
      await page.getByTestId("roll-action-try-check").click();
      for (const group of fixture.groups) await expect(page.getByTestId(`roll-group-${group}`)).toBeVisible();

      await page.getByTestId("document-editor-publish").click();
      await page.getByTestId("publish-dialog-semver").fill("1.0.0");
      await page.getByTestId("publish-dialog-release-notes").fill("Dynamic pools");
      await page.getByTestId("publish-dialog-submit").click();
      await expect(page.getByTestId("publish-dialog-success")).toBeVisible();
      await page.getByTestId("publish-dialog-create-character").click();
      await page.getByLabel("Entity", { exact: true }).selectOption("character");
      await page.getByLabel("Character name").fill("Rin");
      await page.getByRole("button", { name: "Create character", exact: true }).click();
      await expect(page).toHaveURL(/\/characters\/[0-9a-f-]+$/);
      await page.getByRole("button", { name: fixture.label, exact: true }).click();
      for (const group of fixture.groups) await expect(page.getByTestId(`roll-group-${group}`)).toBeVisible();

      await page.goto("/campaigns/new");
      await page.getByRole("button", { name: `${systemName} 1.0.0` }).click();
      await page.getByLabel("Campaign title").fill(`Pool table ${uid()}`);
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
      await page.getByRole("button", { name: `Roll ${fixture.label}`, exact: true }).click();
      for (const group of fixture.groups) await expect(page.getByTestId(`roll-group-${group}`)).toBeVisible();
    } finally {
      if (process.env.SWEETROLL_E2E_EPHEMERAL_DB !== "1") await page.request.delete(`/api/systems/${systemId}`);
    }
  });
}
