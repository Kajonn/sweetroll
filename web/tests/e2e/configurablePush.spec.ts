import { test, expect } from "@playwright/test";
import { namedDicePoolDocument } from "../../../src/systems/implementation/package/fixtures/named-dice-pool.js";
import {
  signIn,
  workspace,
  withItem,
  json,
  key,
  cleanup,
  resultOf,
  assertChild,
} from "../fixtures/configurablePush.js";

test("creator publishes push rules; entity and item pushes preserve the original pool and reload with lineage", async ({
  page,
}, info) => {
  test.setTimeout(180000);
  await signIn(page);
  const created = await workspace(page.request, namedDicePoolDocument()),
    systemId = created.id;
  const characters: string[] = [];
  const evidence: Record<string, unknown> = { systemId };
  try {
    await page.goto(`/systems/${systemId}`);
    await page.getByTestId("document-editor-tab-dice").click();
    await page.getByText("Push rules", { exact: true }).click();
    await page.getByLabel("Enable pushing", { exact: true }).check();
    await page.getByLabel("Maximum pushes", { exact: true }).fill("2");
    await page
      .getByLabel("Allow pushing a successful roll", { exact: true })
      .check();
    await page.getByLabel("Push Skill", { exact: true }).uncheck();
    await page.getByLabel("Push Gear", { exact: true }).uncheck();
    const saved = page.waitForResponse(
      (r) =>
        r.request().method() === "PUT" &&
        r.url().endsWith(`/api/systems/${systemId}/draft`) &&
        r
          .request()
          .postDataJSON()
          .document?.actions.some((a: any) =>
            a.pushPolicy?.groups[0]?.reportedFaces.includes(1),
          ),
    );
    await page
      .getByLabel("Reported faces for Attribute", { exact: true })
      .fill("1");
    expect((await saved).status()).toBe(200);
    await page.reload();
    await page.getByTestId("document-editor-tab-dice").click();
    await page.getByText("Push rules", { exact: true }).click();
    await expect(
      page.getByLabel("Maximum pushes", { exact: true }),
    ).toHaveValue("2");
    await expect(
      page.getByLabel("Reported faces for Attribute", { exact: true }),
    ).toHaveValue("1");
    const current = (
      await json(page.request, "GET", `/api/systems/${systemId}`)
    ).workspace;
    expect(current.draft.document.schemaVersion).toBe("1.2");
    await json(page.request, "PUT", `/api/systems/${systemId}/draft`, {
      expectedRevision: current.draft.revision,
      document: withItem(current.draft.document),
    });
    await page.reload();
    await page.getByTestId("document-editor-publish").click();
    await page.getByTestId("publish-dialog-semver").fill("1.0.0");
    await page
      .getByTestId("publish-dialog-release-notes")
      .fill("Push acceptance");
    await page.getByTestId("publish-dialog-submit").click();
    await expect(page.getByTestId("publish-dialog-success")).toBeVisible();
    await page.getByTestId("publish-dialog-create-character").click();
    await page.getByLabel("Entity", { exact: true }).selectOption("character");
    await page.getByLabel("Character name").fill(`Push Hero ${key()}`);
    await page
      .getByRole("button", { name: "Create character", exact: true })
      .click();
    await expect(page).toHaveURL(/\/characters\/[0-9a-f-]+$/);
    const id = page.url().split("/").pop()!;
    characters.push(id);
    evidence.characterId = id;
    console.log("PUSH_JOURNEY_CHARACTER", id);
    const original = (
      await resultOf(
        page,
        () =>
          page.getByRole("button", { name: "Test Pool", exact: true }).click(),
        "/actions/test_pool",
      )
    ).result.roll;
    const edited = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        r.url().endsWith(`/characters/${id}/fields/attribute/set`),
      { timeout: 30000 },
    );
    await page
      .getByRole("spinbutton", { name: "Attribute", exact: true })
      .fill("4");
    await page
      .getByRole("spinbutton", { name: "Attribute", exact: true })
      .press("Enter");
    expect((await edited).status()).toBe(200);
    const before = (await json(page.request, "GET", `/api/characters/${id}`))
      .character;
    const panel = page.getByTestId("push-result");
    await expect(
      panel.getByRole("button", { name: "Push saved roll" }),
    ).toBeEnabled();
    const child = (
      await resultOf(
        page,
        () => panel.getByRole("button", { name: "Push saved roll" }).click(),
        "/push",
      )
    ).result.roll;
    assertChild(original, child);
    await expect(panel).toHaveAttribute("data-roll-id", child.push.rollId);
    await expect(panel).toContainText("Push 1 of 2");
    await expect(panel).toContainText("Original saved pool");
    await expect(panel).toContainText("Rerolled");
    await expect(panel).toContainText("Retained");
    await expect(panel).toContainText("Manual bookkeeping only");
    await panel.getByRole("button", { name: "View parent roll" }).click();
    await expect(
      panel.getByRole("region", { name: "Earlier roll" }),
    ).toContainText("Original roll");
    const next = (
      await resultOf(
        page,
        () => panel.getByRole("button", { name: "Push saved roll" }).click(),
        "/push",
      )
    ).result.roll;
    assertChild(child, next);
    await expect(panel).toContainText("Maximum pushes reached");
    await expect(
      panel.getByRole("button", { name: "Push saved roll" }),
    ).toBeDisabled();
    expect(
      (await json(page.request, "GET", `/api/characters/${id}`)).character
        .state,
    ).toEqual(before.state);
    await page.reload();
    await expect(page.getByTestId("push-result")).toHaveAttribute(
      "data-roll-id",
      next.push.rollId,
    );
    await page.getByTestId("slot-add-gear_slot").click();
    await page
      .getByTestId("slot-template-picker-gear_slot")
      .selectOption("pool_tool");
    await page.getByTestId("slot-add-confirm-gear_slot").click();
    const itemRoot = (
      await resultOf(
        page,
        () =>
          page.getByRole("button", { name: "Tool Pool", exact: true }).click(),
        "/actions/tool_pool",
      )
    ).result.roll;
    await expect(
      panel.getByRole("button", { name: "Push saved roll" }),
    ).toBeEnabled();
    const itemChild = (
      await resultOf(
        page,
        () => panel.getByRole("button", { name: "Push saved roll" }).click(),
        "/push",
      )
    ).result.roll;
    assertChild(itemRoot, itemChild);
    for (const width of [320, 360, 768, 1280])
      for (const colorScheme of ["light", "dark"] as const) {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        ).toBe(true);
      }
    await page.screenshot({
      path: info.outputPath("push-result.png"),
      fullPage: true,
    });
    await page.reload();
    const activity = page.getByRole("button", {
      name: "Activity",
      exact: true,
    });
    await activity.click();
    const history = await json(
      page.request,
      "GET",
      `/api/characters/${id}/activity`,
    );
    expect(history.events.filter((e: any) => e.roll?.push)).toHaveLength(5);
    await expect(
      page.getByRole("dialog", { name: "Activity" }).getByTestId("push-result"),
    ).toHaveCount(5);
    await page.keyboard.press("Escape");
    await expect(activity).toBeFocused();
    Object.assign(evidence, {
      original,
      child,
      next,
      itemRoot,
      itemChild,
      historyRolls: 5,
    });
  } finally {
    evidence.cleanup = await cleanup(page.request, systemId, characters);
    await info.attach("push-journey-evidence", {
      body: JSON.stringify(evidence, null, 2),
      contentType: "application/json",
    });
  }
});
