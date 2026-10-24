import { test, expect } from "@playwright/test";
import { namedDicePoolDocument } from "../../../src/systems/implementation/package/fixtures/named-dice-pool.js";
import {
  testSignIn,
  TEST_USER_A,
  uid,
  createCharacter,
  expectOfflineAvailable,
} from "./test-auth.js";

test("grouped roll history reopens offline from the production build", async ({
  page,
  context,
}) => {
  await testSignIn(page.request, TEST_USER_A.code);
  const clone = await page.request.post("/api/systems", {
    data: {
      source: {
        kind: "clone",
        versionId: "c0000000-0000-5000-8000-000000000002",
      },
      idempotencyKey: uid(),
    },
  });
  expect(clone.status()).toBe(201);
  const { workspace } = await clone.json();
  const systemId = workspace.system.systemId;
  try {
    const saved = await page.request.put(`/api/systems/${systemId}/draft`, {
      data: {
        expectedRevision: workspace.draft.revision,
        document: namedDicePoolDocument(),
      },
    });
    expect(saved.status()).toBe(200);
    const published = await page.request.post(
      `/api/systems/${systemId}/publish`,
      {
        data: {
          expectedRevision: (await saved.json()).workspace.draft.revision,
          semanticVersion: "1.0.0",
          releaseNotes: "Named groups offline",
          idempotencyKey: uid(),
          acknowledgeBreaking: true,
        },
      },
    );
    expect(published.status()).toBe(200);
    const { characterId } = await createCharacter(page.request, {
      systemVersionId: (await published.json()).version.versionId,
      name: `Offline groups ${uid()}`,
    });
    await page.goto(`/characters/${characterId}`);
    await expectOfflineAvailable(page);
    await page.getByRole("button", { name: "Test Pool", exact: true }).click();
    await expect(page.getByTestId("roll-group-gear")).toContainText(
      "Empty group",
    );
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Activity", exact: true }).click();
    await expect(
      page
        .getByRole("dialog", { name: "Activity" })
        .getByTestId("roll-group-attribute"),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("dialog", { name: "Activity" }),
    ).not.toBeVisible();
    await context.setOffline(true);
    await page.reload();
    await page.getByRole("button", { name: "Activity", exact: true }).click();
    await expect(
      page
        .getByRole("dialog", { name: "Activity" })
        .getByTestId("roll-group-attribute"),
    ).toBeVisible();
    await expect(
      page
        .getByRole("dialog", { name: "Activity" })
        .getByTestId("roll-group-skill"),
    ).toContainText("Successes ≥ 5");
    expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  } finally {
    await context.setOffline(false);
    await page.request.delete(`/api/systems/${systemId}`);
  }
});
