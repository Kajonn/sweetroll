import { test, expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";

import { uid } from "../offline/test-auth.js";

/**
 * G7 Phase 3 exit demonstration (dev-server E2E): campaign upgrade isolation
 * end to end through the production chain.
 *
 * A fixture system is built through the REAL creator UI (the same blank →
 * simple-system flow the G5 creatorToCharacter exit journey exercises: blank
 * draft, metadata, one entity with two scalar fields, a guided roll, a sheet
 * binding both fields, publish 1.0.0 — no product publish bypass). Two
 * GM-owned campaigns are pinned to that version with one character each.
 * A newer version is published through the same creator UI by tightening one
 * field constraint (additive, acknowledgement-free); the constraint change
 * surfaces as a per-character preview warning without requiring explicit
 * mappings (every valued field is sheet-bound, so nothing is ever dropped).
 * Immediately after publishing, both campaigns still read the old pin.
 * Campaign A: Settings tab → Campaign settings → Upgrade campaign → the new
 * version is discovered in the target list → preview shows the before/after
 * pin plus the per-character warning → a second GM context (co-GM) bumps the
 * campaign so the first commit goes stale (409) → the dialog reports the
 * conflict and refetches a fresh preview → renewed confirmation plus an
 * explicit retry commits → the dialog stays open on success (closed
 * explicitly here; test-only handling, no product change) → campaign A reads
 * the new pin and migrated character versions while campaign B stays
 * byte-identical via real reads.
 *
 * Needs a live backend per web/playwright.config.ts (migrate + dev:http and
 * web:dev, with DATABASE_URL pointing at Postgres). Systems created by this
 * test are deleted in test.afterEach (page.request shares the browser
 * context's sign-in cookie); campaigns/characters have no DELETE endpoint,
 * so every campaign/hero name is unique per run. The dev sign-in panel stays
 * (dev server), so no SWEETROLL_TEST_AUTH escape hatch is needed here. The
 * ordinary-player claim and Hidden-recovery journeys stay untouched in their
 * own specs.
 */

const STEP_TIMEOUT = 30_000;

// Systems created by this test are deleted in test.afterEach so a failing
// assertion cannot leave residue in the shared DB (deterministic library
// baselines). page.request shares the browser context's sign-in cookie.
const createdSystemIds: string[] = [];
test.afterEach(async ({ page }) => {
  for (const id of createdSystemIds.splice(0)) {
    await page.request.delete(`/api/systems/${id}`).catch(() => {});
  }
});

async function signInAs(request: APIRequestContext, code: string): Promise<string> {
  const response = await request.post("/dev/signin", {
    data: { code, redirectUri: "http://localhost/cb" },
  });
  if (response.status() !== 200) {
    throw new Error(`seed sign-in (${code}) failed: ${response.status()} ${await response.text()}`);
  }
  const body = (await response.json()) as { userId: string };
  return body.userId;
}

async function postJson(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  if (response.status() !== 200 && response.status() !== 201) {
    throw new Error(`POST ${path} failed: ${response.status()} ${await response.text()}`);
  }
  return (await response.json()) as Record<string, any>;
}

async function patchJson(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.patch(path, { data });
  if (response.status() !== 200) {
    throw new Error(`PATCH ${path} failed: ${response.status()} ${await response.text()}`);
  }
  return (await response.json()) as Record<string, any>;
}

async function getJson(request: APIRequestContext, path: string) {
  const response = await request.get(path);
  if (response.status() !== 200) {
    throw new Error(`GET ${path} failed: ${response.status()} ${await response.text()}`);
  }
  return (await response.json()) as Record<string, any>;
}

async function signInViaPanel(page: Page, code: string) {
  await page.goto("/");
  await page.getByTestId("dev-signin-code").fill(code);
  await page.getByTestId("dev-signin").click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: STEP_TIMEOUT });
}

function waitForDraftPut(page: Page, snippet?: string) {
  return page.waitForResponse(
    (r) => {
      if (
        !(
          r.request().method() === "PUT" &&
          r.url().includes("/api/systems/") &&
          r.url().endsWith("/draft")
        )
      ) {
        return false;
      }
      if (snippet === undefined) return true;
      try {
        const body = r.request().postDataJSON() as { document?: unknown } | null;
        return JSON.stringify(body?.document ?? null).includes(snippet);
      } catch {
        return false;
      }
    },
    { timeout: 20_000 },
  );
}

async function publishThroughCreatorUi(page: Page, semver: string, releaseNotes: string): Promise<void> {
  await page.getByTestId("document-editor-publish").click();
  await expect(page.getByTestId("publish-dialog")).toBeVisible({ timeout: STEP_TIMEOUT });
  await page.getByTestId("publish-dialog-semver").fill(semver);
  await page.getByTestId("publish-dialog-release-notes").fill(releaseNotes);
  await page.getByTestId("publish-dialog-submit").click();
  // Constraint-only edits publish cleanly; acknowledge server-reported
  // breaking findings first if the package assessment flags any.
  const findings = page.getByTestId("publish-dialog-findings");
  await expect(findings.or(page.getByTestId("publish-dialog-success"))).toBeVisible({ timeout: STEP_TIMEOUT });
  if (await findings.isVisible()) {
    const boxes = page.locator('[data-testid^="publish-dialog-finding-checkbox-"]');
    const count = await boxes.count();
    expect(count).toBeGreaterThan(0);
    for (let index = 0; index < count; index += 1) {
      await boxes.nth(index).check({ timeout: STEP_TIMEOUT });
    }
    await page.getByTestId("publish-dialog-submit").click();
  }
  await expect(page.getByTestId("publish-dialog-success")).toBeVisible({ timeout: STEP_TIMEOUT });
  await page.getByTestId("publish-dialog-close").click();
  await expect(page.getByTestId("publish-dialog-success")).toHaveCount(0);
}

test("G7 exit: publish newer version via creator UI, upgrade campaign A with stale retry, campaign B untouched", async ({
  page,
  browser,
}: {
  page: Page;
  browser: Browser;
}) => {
  test.setTimeout(420_000);
  const stamp = uid();
  const campaignTitleA = `G7 Upgrade A ${stamp}`;
  const campaignTitleB = `G7 Upgrade B ${stamp}`;
  const heroNameA = `G7 Upgrade Hero A ${stamp}`;
  const heroNameB = `G7 Upgrade Hero B ${stamp}`;

  await page.goto("/");
  const origin = new URL(page.url()).origin;
  const gmContext = await browser.newContext({ baseURL: origin });
  try {
    const gmUserId = await signInAs(gmContext.request, "code-test-a");
    expect(gmUserId).toMatch(/.+/);

    // 1. Real creator UI (G5 flow): blank draft → metadata → one entity with
    // an integer and a text field → a guided roll → a sheet binding both
    // fields (every valued field stays sheet-bound, so upgrades never drop
    // anything) → publish 1.0.0.
    await signInViaPanel(page, "code-test-a");
    await page.getByTestId("library-new-system").click();
    await page.getByTestId("create-draft-name").fill(`G7 Upgrade System ${stamp}`);
    await page.getByTestId("create-draft-submit").click();
    await expect(page).toHaveURL(/\/systems\/[0-9a-f-]+/, { timeout: STEP_TIMEOUT });
    const systemId = page.url().split("/").pop() ?? "";
    createdSystemIds.push(systemId);
    await expect(page.getByTestId("document-editor-header")).toBeVisible({ timeout: STEP_TIMEOUT });

    await page.getByTestId("metadata-description").fill("A tiny upgrade fixture built without expressions.");
    await page.getByTestId("metadata-default-dice").fill("d6");
    const basicsSaved = waitForDraftPut(page, "A tiny upgrade fixture built without expressions.");
    await page.keyboard.press("Tab");
    await basicsSaved;

    await page.getByTestId("document-editor-tab-attributes").click();
    await page.getByTestId("entity-list-add").click();
    const entityRow = page.locator('li[data-testid^="entity-row-"]').last();
    const entityId =
      (await entityRow.getAttribute("data-testid"))?.replace("entity-row-", "") ?? "";
    expect(entityId).not.toBe("");
    await page.getByTestId(`entity-label-input-${entityId}`).fill("Hero");
    await page.getByTestId(`entity-field-kind-picker-${entityId}`).selectOption("integer");
    await page.getByTestId(`entity-add-field-${entityId}`).click();
    await page.getByTestId(`entity-field-kind-picker-${entityId}`).selectOption("text");
    await page.getByTestId(`entity-add-field-${entityId}`).click();
    await page.getByTestId("scalar-field-label-field").fill("Might");
    await page.getByTestId("scalar-field-label-field_1").fill("Name");
    await waitForDraftPut(page, "Might");

    await page.getByTestId("document-editor-tab-dice").click();
    await page.getByTestId("actions-add-roll").click();
    const rollSection = page.locator('[data-testid^="roll-action-"]').first();
    const actionId =
      (await rollSection.getAttribute("data-testid"))?.replace("roll-action-", "") ?? "";
    expect(actionId).not.toBe("");
    await expect(page.getByTestId(`dice-kind-${actionId}`)).toBeVisible();
    await page.getByTestId(`dice-kind-${actionId}`).selectOption("d6");
    await waitForDraftPut(page, actionId);

    await page.getByTestId("document-editor-tab-sections").click();
    await page.getByTestId("sheet-add-button").click();
    await page.getByTestId("sheet-add-section").click();
    await page.getByTestId("sheet-add-section").click();
    await page.getByTestId("section-label-section_1").fill("Alpha");
    await page.getByTestId("section-label-section_2").fill("Beta");
    await page.getByTestId("section-add-element-field-section_1").click();
    await page.getByTestId("section-add-element-field-section_2").click();
    await page
      .getByTestId("section-row-section_1")
      .locator('[data-testid^="element-binding-"]')
      .getByTestId("definition-id-input")
      .fill("field");
    await page
      .getByTestId("section-row-section_2")
      .locator('[data-testid^="element-binding-"]')
      .getByTestId("definition-id-input")
      .fill("field_1");
    await waitForDraftPut(page, "section_2");

    await expect(page.getByTestId("document-editor-autosave")).toContainText("Saved", {
      timeout: STEP_TIMEOUT,
    });
    await publishThroughCreatorUi(page, "1.0.0", `G7 upgrade fixture ${stamp}.`);
    const versionsAfterFirst = await getJson(gmContext.request, `/api/systems/${systemId}/versions`);
    const version1Id = (versionsAfterFirst.versions as Array<Record<string, string>>).find(
      (entry) => entry.semanticVersion === "1.0.0",
    )?.versionId;
    expect(version1Id).toMatch(/[0-9a-f-]{36}/);

    // 2. Two GM-owned campaigns on the same published fixture version, one
    // character each, through real HTTP as the GM actor.
    const createdA = await postJson(gmContext.request, "/api/campaigns", {
      systemVersionId: version1Id,
      title: campaignTitleA,
      description: `G7 upgrade campaign A ${stamp}`,
      idempotencyKey: `g7-upgrade-a-${stamp}`,
    });
    const campaignIdA: string = createdA.campaign.campaignId;
    const createdB = await postJson(gmContext.request, "/api/campaigns", {
      systemVersionId: version1Id,
      title: campaignTitleB,
      description: `G7 upgrade campaign B ${stamp}`,
      idempotencyKey: `g7-upgrade-b-${stamp}`,
    });
    const campaignIdB: string = createdB.campaign.campaignId;
    expect(campaignIdA).toMatch(/[0-9a-f-]{36}/);
    expect(campaignIdB).toMatch(/[0-9a-f-]{36}/);
    for (const [campaignId, heroName, key] of [
      [campaignIdA, heroNameA, `g7-upgrade-hero-a-${stamp}`],
      [campaignIdB, heroNameB, `g7-upgrade-hero-b-${stamp}`],
    ] as const) {
      const revision = (await getJson(gmContext.request, `/api/campaigns/${campaignId}`)).campaign
        .revision as number;
      const created = await postJson(gmContext.request, `/api/campaigns/${campaignId}/characters`, {
        name: heroName,
        entityDefinitionId: entityId,
        expectedCampaignRevision: revision,
        idempotencyKey: key,
      });
      expect(created.character.characterId).toMatch(/[0-9a-f-]{36}/);
    }

    // 3. Real creator UI: tighten the Might max (20 → 10) on the Attributes
    // tab — the carried default 0 stays valid — then publish 2.0.0. The
    // constraint change surfaces as a per-character preview warning without
    // requiring explicit mappings.
    await page.getByTestId("document-editor-tab-attributes").click();
    await page.getByTestId(`entity-row-${entityId}-select`).click();
    const maxSaved = waitForDraftPut(page, '"max":10');
    await page.getByTestId("scalar-field-max-field").fill("10");
    await maxSaved;
    await expect(page.getByTestId("document-editor-autosave")).toContainText("Saved", {
      timeout: STEP_TIMEOUT,
    });
    await publishThroughCreatorUi(page, "2.0.0", `G7 upgrade target ${stamp}.`);
    const versionsAfterSecond = await getJson(gmContext.request, `/api/systems/${systemId}/versions`);
    const version2Id = (versionsAfterSecond.versions as Array<Record<string, string>>).find(
      (entry) => entry.semanticVersion === "2.0.0",
    )?.versionId;
    expect(version2Id).toMatch(/[0-9a-f-]{36}/);
    expect(version2Id).not.toBe(version1Id);

    // 4. Publishing alone upgrades nothing: both campaigns still read the
    // old pin right after the publish.
    const pinAfterPublishA = (await getJson(gmContext.request, `/api/campaigns/${campaignIdA}`)).campaign;
    const pinAfterPublishB = (await getJson(gmContext.request, `/api/campaigns/${campaignIdB}`)).campaign;
    expect(pinAfterPublishA.systemVersionId).toBe(version1Id);
    expect(pinAfterPublishB.systemVersionId).toBe(version1Id);

    // 5. Baseline campaign B (pin, revision, character versions) for the
    // byte-identical comparison after campaign A's upgrade.
    const baselineBCampaign = (await getJson(gmContext.request, `/api/campaigns/${campaignIdB}`)).campaign;
    const baselineBRoster = await getJson(gmContext.request, `/api/campaigns/${campaignIdB}/characters`);
    const baselineB = JSON.stringify({
      campaign: baselineBCampaign,
      characters: baselineBRoster.characters,
      nextCursor: baselineBRoster.nextCursor,
    });
    expect(baselineBRoster.characters).toHaveLength(1);

    // 6. Second GM context: invite code-test-b to campaign A as co-GM and
    // accept through the real invitation UI, so the stale-commit bump below
    // comes from a different GM actor.
    const revisionForInvite = (await getJson(gmContext.request, `/api/campaigns/${campaignIdA}`)).campaign
      .revision as number;
    const issued = await postJson(gmContext.request, `/api/campaigns/${campaignIdA}/invitations`, {
      intendedRole: "co_gm",
      expectedCampaignRevision: revisionForInvite,
      idempotencyKey: `g7-upgrade-invite-${stamp}`,
    });
    const inviteToken: string = issued.invitation.token;
    expect(inviteToken.length).toBeGreaterThan(0);
    const gm2Context = await browser.newContext({ baseURL: origin });
    try {
      const gm2UserId = await signInAs(gm2Context.request, "code-test-b");
      expect(gm2UserId).toMatch(/.+/);
      const gm2Page = await gm2Context.newPage();
      await gm2Page.goto(`/invitations?token=${encodeURIComponent(inviteToken)}`);
      await expect(gm2Page.getByRole("heading", { name: campaignTitleA })).toBeVisible({
        timeout: STEP_TIMEOUT,
      });
      await gm2Page.getByRole("button", { name: "Accept", exact: true }).click({ timeout: STEP_TIMEOUT });
      await expect(gm2Page.getByText(`Welcome to ${campaignTitleA}.`)).toBeVisible({
        timeout: STEP_TIMEOUT,
      });
      await gm2Page.close();

      // 7. Campaign A: Settings tab → Campaign settings → Upgrade campaign.
      // The 2.0.0 target is discovered from the same creation-versions
      // catalog the dialog reads.
      const catalog = await getJson(gmContext.request, "/api/characters/creation-versions?limit=25");
      const catalogVersions = catalog.data.versions as Array<Record<string, string>>;
      const targetEntry = catalogVersions.find((entry) => entry.versionId === version2Id);
      expect(targetEntry).toBeDefined();
      const targetLabel = `${targetEntry!.systemName} ${targetEntry!.semanticVersion}`;
      expect(targetLabel).toContain("2.0.0");
      await page.goto(`/campaigns/${campaignIdA}`);
      await expect(page.getByRole("heading", { name: campaignTitleA })).toBeVisible({
        timeout: STEP_TIMEOUT,
      });
      await page.getByRole("tab", { name: "Settings" }).click({ timeout: STEP_TIMEOUT });
      await expect(page.getByText("Campaign settings")).toBeVisible({ timeout: STEP_TIMEOUT });
      await page.getByRole("button", { name: "Upgrade campaign", exact: true }).click({
        timeout: STEP_TIMEOUT,
      });
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByText("Move the campaign pin")).toBeVisible({ timeout: STEP_TIMEOUT });
      await dialog.getByRole("button", { name: targetLabel }).click({ timeout: STEP_TIMEOUT });

      // 8. Preview shows the before/after pin, the attached hero, and the
      // per-character constraint warning — with no explicit mapping demand.
      await expect(dialog.getByText("1.0.0 → 2.0.0")).toBeVisible({ timeout: STEP_TIMEOUT });
      await expect(dialog.getByText(heroNameA)).toBeVisible({ timeout: STEP_TIMEOUT });
      await expect(dialog.getByText(/Constraints for field/)).toBeVisible({ timeout: STEP_TIMEOUT });
      await expect(dialog.getByText("Requires explicit mapping")).toHaveCount(0);

      // 9. The second GM bumps campaign A (title edit through real HTTP),
      // so the dialog's preview revision goes stale before the commit.
      const freshPreview = page.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          r.url().includes(`/api/campaigns/${campaignIdA}/upgrade-previews`),
        { timeout: STEP_TIMEOUT },
      );
      const bumpedTitle = `${campaignTitleA} bumped`;
      const revisionForBump = (await getJson(gm2Context.request, `/api/campaigns/${campaignIdA}`)).campaign
        .revision as number;
      await patchJson(gm2Context.request, `/api/campaigns/${campaignIdA}`, {
        title: bumpedTitle,
        description: `G7 upgrade campaign A ${stamp}`,
        expectedCampaignRevision: revisionForBump,
        idempotencyKey: `g7-upgrade-bump-${stamp}`,
      });
      const confirmBox = dialog.getByRole("checkbox", { name: /I understand/ });
      await confirmBox.check({ timeout: STEP_TIMEOUT });
      await dialog.getByRole("button", { name: "Commit upgrade" }).click({ timeout: STEP_TIMEOUT });

      // 10. Stale commit answers 409: the dialog reports the conflict and
      // refetches a fresh preview (observed on the wire); the confirmation
      // gate is renewed, so the checkbox is unchecked again.
      await expect(dialog.getByText("Campaign changed — review fresh preview.")).toBeVisible({
        timeout: STEP_TIMEOUT,
      });
      await freshPreview;
      await expect(confirmBox).not.toBeChecked({ timeout: STEP_TIMEOUT });
      await expect(dialog.getByText("1.0.0 → 2.0.0")).toBeVisible({ timeout: STEP_TIMEOUT });

      // 11. Explicit retry with a fresh confirmation commits; the dialog
      // stays open on success and is closed explicitly here (test-only
      // handling, no product change).
      await confirmBox.check({ timeout: STEP_TIMEOUT });
      await dialog.getByRole("button", { name: "Commit upgrade" }).click({ timeout: STEP_TIMEOUT });
      await expect(dialog.getByText("Upgraded to 2.0.0.")).toBeVisible({ timeout: STEP_TIMEOUT });
      await dialog.getByRole("button", { name: "Close" }).click({ timeout: STEP_TIMEOUT });
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByRole("heading", { name: bumpedTitle })).toBeVisible({
        timeout: STEP_TIMEOUT,
      });

      // 12. Campaign A reads the new pin and migrated character versions;
      // campaign B is byte-identical to its pre-upgrade baseline.
      const upgradedA = (await getJson(gmContext.request, `/api/campaigns/${campaignIdA}`)).campaign;
      expect(upgradedA.systemVersionId).toBe(version2Id);
      expect(upgradedA.revision).toBeGreaterThan(pinAfterPublishA.revision);
      const rosterA = await getJson(gmContext.request, `/api/campaigns/${campaignIdA}/characters`);
      expect(rosterA.characters).toHaveLength(1);
      expect(rosterA.characters[0].name).toBe(heroNameA);
      expect(rosterA.characters[0].systemVersionId).toBe(version2Id);
      const afterB = await getJson(gmContext.request, `/api/campaigns/${campaignIdB}`);
      const afterBRoster = await getJson(gmContext.request, `/api/campaigns/${campaignIdB}/characters`);
      expect(
        JSON.stringify({
          campaign: afterB.campaign,
          characters: afterBRoster.characters,
          nextCursor: afterBRoster.nextCursor,
        }),
      ).toBe(baselineB);
    } finally {
      await gm2Context.close();
    }
  } finally {
    await gmContext.close();
  }
});
