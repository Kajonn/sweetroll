import {
  expect,
  test,
  type Browser,
  type APIRequestContext,
} from "@playwright/test";
import { createCatalogCampaign } from "./campaignTemplates.js";
import { derivedTemplateDocument } from "../../../tests/fixtures/derived-template.js";
import {
  json,
  key,
  resultOf,
  assertChild,
  cachedPushState,
} from "./configurablePush.js";
import { expectOfflineAvailable } from "../offline/test-auth.js";

/** Same workflow runs in dev, the production worker, and isolated deployed acceptance. */
export async function campaignDerivedJourney(
  { browser, baseURL }: { browser: Browser; baseURL: string | undefined },
  offlineReload = false,
) {
  test.setTimeout(180000);
  if (!baseURL) throw Error("Browser base URL required");
  const gm = await browser.newContext({ baseURL }),
    co = await browser.newContext({ baseURL }),
    player = await browser.newContext({ baseURL });
  let systemId: string | undefined,
    campaignId: string | undefined,
    characterId: string | undefined,
    templateId: string | undefined;
  const cleanup: Record<string, unknown> = {};
  try {
    const created = await createCatalogCampaign(
      gm.request,
      co.request,
      player.request,
      (d) => Object.assign(d, derivedTemplateDocument()),
    );
    ({ systemId, campaignId } = created);
    const campaignRevision = async () =>
      (await json(gm.request, "GET", `/api/campaigns/${campaignId}`)).campaign
        .revision;
    const gmPage = await gm.newPage();
    await gmPage.goto(`/campaigns/${campaignId}`);
    await gmPage.getByRole("tab", { name: "Items & powers" }).click();
    await gmPage.getByRole("button", { name: "Create template" }).click();
    await gmPage.getByLabel("Source", { exact: true }).selectOption("system");
    await gmPage
      .getByLabel("System template", { exact: true })
      .selectOption("sword");
    await gmPage
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("Captain's sword");
    await gmPage.getByLabel("Damage bonus", { exact: true }).fill("4");
    await expect(
      gmPage.getByText(/Inherited actions: Hit, Damage, Salute, Refuel, Pool/),
    ).toBeVisible();
    for (const colorScheme of ["light", "dark"] as const) {
      await gmPage.emulateMedia({ colorScheme });
      for (const width of [320, 360, 768, 1280]) {
        await gmPage.setViewportSize({ width, height: 900 });
        expect(
          await gmPage.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        ).toBe(true);
      }
    }
    const published = gmPage.waitForResponse(
      (r) =>
        r.request().method() === "POST" && r.url().endsWith("/item-templates"),
    );
    await gmPage
      .getByRole("button", { name: "Publish to all members" })
      .click();
    const response = await published;
    expect(response.status(), await response.text()).toBe(201);
    const template = (await response.json()).template;
    templateId = template.templateId;
    let resourceRevision = template.revision;
    await expect(gmPage.getByRole("dialog")).toHaveCount(0);
    const own = (
      await json(player.request, "POST", "/api/characters", {
        systemVersionId: created.versionId,
        entityDefinitionId: "character",
        name: `Derived bearer ${key()}`,
        idempotencyKey: key(),
      })
    ).character;
    characterId = own.characterId;
    await json(
      player.request,
      "POST",
      `/api/campaigns/${campaignId}/characters/${characterId}/adopt`,
      {
        expectedCampaignRevision: await campaignRevision(),
        expectedCharacterRevision: own.revision,
        acknowledgedDisclosure: true,
        idempotencyKey: key(),
      },
    );
    const page = await player.newPage();
    await page.goto(`/characters/${characterId}`);
    await page.getByTestId("slot-add-inventory").click();
    await page
      .getByTestId("slot-template-picker-inventory")
      .selectOption({ label: "Captain's sword · Campaign" });
    if (offlineReload) {
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await expectOfflineAvailable(page);
      await player.setOffline(true);
      await page.getByTestId("slot-add-inventory").click();
      await page
        .getByTestId("slot-template-picker-inventory")
        .selectOption({ label: "Captain's sword · Campaign" });
    }
    await page.getByTestId("slot-add-confirm-inventory").click();
    if (offlineReload) {
      await expect(
        page.getByText("Changes pending", { exact: true }),
      ).toBeVisible();
      await page.reload();
      await expect(
        page.getByText("Changes pending", { exact: true }),
      ).toBeVisible();
      await player.setOffline(false);
    }
    const open = async (request: APIRequestContext = player.request) =>
      (await json(request, "GET", `/api/characters/${characterId}`)).character;
    await expect
      .poll(async () => Object.keys((await open()).state.entries).length)
      .toBe(1);
    let current = await open();
    const entryId = Object.keys(current.state.entries)[0]!,
      entry = () => page.getByTestId(`slot-entry-${entryId}`);
    expect(current.state.entries[entryId].values.damage_bonus).toBe(4);
    await expect(entry()).toContainText("Captain's sword");
    await expect(
      entry().getByRole("button", { name: "Hit", exact: true }),
    ).toBeVisible();
    if (offlineReload) {
      await page.getByTestId("slot-add-inventory").click();
      await page
        .getByTestId("slot-template-picker-inventory")
        .selectOption({ label: "Captain's sword · Campaign" });
      await player.setOffline(true);
      await page.getByTestId("slot-add-confirm-inventory").click();
      await expect(
        page.getByText("Changes pending", { exact: true }),
      ).toBeVisible();
      await json(
        gm.request,
        "POST",
        `/api/campaigns/${campaignId}/item-templates/${templateId}/archive`,
        { expectedTemplateRevision: resourceRevision, idempotencyKey: key() },
      );
      const recovered = await json(
        gm.request,
        "POST",
        `/api/campaigns/${campaignId}/item-templates/${templateId}/recover`,
        {
          expectedTemplateRevision: resourceRevision + 1,
          idempotencyKey: key(),
        },
      );
      resourceRevision = recovered.template.revision;
      await page.reload();
      await player.setOffline(false);
      await expect(
        page.getByText(/campaign template has changed/),
      ).toBeVisible();
      expect(Object.keys((await open()).state.entries)).toHaveLength(1);
      await page
        .getByRole("checkbox", { name: /Campaign template revision/ })
        .check();
      await page.getByRole("button", { name: "Discard", exact: true }).click();
      await page
        .getByRole("button", { name: "Confirm discard", exact: true })
        .click();
      await page.reload();
      await expect(
        entry().getByRole("button", { name: "Edit values", exact: true }),
      ).toBeEnabled();
      await player.setOffline(true);
    }
    await entry()
      .getByRole("button", { name: "Edit values", exact: true })
      .click();
    await page.getByLabel("Damage bonus", { exact: true }).fill("6");
    await page
      .getByRole("button", { name: "Save values", exact: true })
      .click();
    if (offlineReload) {
      await expect(
        page.getByText("Changes pending", { exact: true }),
      ).toBeVisible();
      await page.reload();
      await expect(entry()).toContainText("Captain's sword");
      await player.setOffline(false);
    }
    await expect
      .poll(
        async () => (await open()).state.entries[entryId].values.damage_bonus,
      )
      .toBe(6);
    for (const action of ["Hit", "Damage", "Salute", "Refuel"]) {
      const result = (
        await resultOf(
          page,
          () =>
            entry().getByRole("button", { name: action, exact: true }).click(),
          `/actions/sword_${action.toLowerCase()}`,
        )
      ).result;
      if (action === "Hit" || action === "Damage")
        expect(result.roll.bindings).toContainEqual({
          scope: "fields",
          definitionId: "damage_bonus",
          value: 6,
        });
      if (action === "Salute") expect(result.nominal.output).toBe("You salute");
    }
    const root = (
      await resultOf(
        page,
        () =>
          entry().getByRole("button", { name: "Pool", exact: true }).click(),
        "/actions/sword_pool",
      )
    ).result.roll;
    expect(root.push.attempt).toBe(0);
    await expect(
      page.getByRole("button", { name: "Push saved roll" }),
    ).toBeEnabled();
    if (offlineReload) {
      let committed!: () => void;
      const applied = new Promise<void>((r) => {
        committed = r;
      });
      let child: any;
      let first = true;
      const bodies: unknown[] = [];
      const pattern = `**/api/characters/${characterId}/rolls/${root.push.rollId}/push`;
      page.on("request", (r) => {
        if (
          r.method() === "POST" &&
          r.url().endsWith(`/rolls/${root.push.rollId}/push`)
        )
          bodies.push(r.postDataJSON());
      });
      await page.route(pattern, async (route) => {
        if (first) {
          first = false;
          const result = await route.fetch();
          expect(result.status()).toBe(200);
          child = (await result.json()).result.roll;
          await player.setOffline(true);
          await route.abort("failed");
          committed();
        } else await route.abort("failed");
      });
      await page.getByRole("button", { name: "Push saved roll" }).click();
      await applied;
      assertChild(root, child);
      await expect
        .poll(
          async () =>
            (await cachedPushState(page, created.playerId, characterId!))
              .attempts.length,
        )
        .toBe(1);
      const frozen = (
        await cachedPushState(page, created.playerId, characterId!)
      ).attempts;
      await page.reload();
      expect(
        (await cachedPushState(page, created.playerId, characterId!)).attempts,
      ).toEqual(frozen);
      await page.unroute(pattern);
      await player.setOffline(false);
      await expect(page.getByTestId("push-result")).toHaveAttribute(
        "data-roll-id",
        child.push.rollId,
      );
      await expect
        .poll(
          async () =>
            (await cachedPushState(page, created.playerId, characterId!))
              .attempts.length,
        )
        .toBe(0);
      expect(bodies.length).toBeGreaterThanOrEqual(2);
      for (const body of bodies) expect(body).toEqual(bodies[0]);
    } else {
      const pushed = (
        await resultOf(
          page,
          () => page.getByRole("button", { name: "Push saved roll" }).click(),
          "/push",
        )
      ).result.roll;
      assertChild(root, pushed);
    }
    // Co-GM and GM race: only the first catalog revision commits; existing copies retain values/source.
    const edit = {
      expectedTemplateRevision: resourceRevision,
      content: { name: "Revised sword", defaultValues: { damage_bonus: 7 } },
      idempotencyKey: key(),
    };
    await json(
      co.request,
      "PATCH",
      `/api/campaigns/${campaignId}/item-templates/${templateId}`,
      edit,
    );
    const stale = await gm.request.patch(
      `/api/campaigns/${campaignId}/item-templates/${templateId}`,
      { data: { ...edit, idempotencyKey: key() } },
    );
    expect(stale.status()).toBe(409);
    current = await open();
    expect(current.state.entries[entryId].source.contentRevision).toBe(1);
    expect(current.state.entries[entryId].values.damage_bonus).toBe(6);
    await page.reload();
    await page.getByTestId("slot-add-inventory").click();
    await page
      .getByTestId("slot-template-picker-inventory")
      .selectOption({ label: "Revised sword · Campaign" });
    await page.getByTestId("slot-add-confirm-inventory").click();
    await expect
      .poll(async () => Object.keys((await open()).state.entries).length)
      .toBe(2);
    current = await open();
    expect(
      Object.values(current.state.entries).find(
        (e: any) => e.entryId !== entryId,
      ),
    ).toMatchObject({
      values: { damage_bonus: 7 },
      source: { contentRevision: 2 },
    });
    await json(
      gm.request,
      "POST",
      `/api/campaigns/${campaignId}/item-templates/${templateId}/archive`,
      { expectedTemplateRevision: resourceRevision + 1, idempotencyKey: key() },
    );
    await page.reload();
    await expect(
      entry().getByRole("button", { name: "Hit", exact: true }),
    ).toBeEnabled();
    // Returning retains independent executable copies and purges former catalog access.
    const oldPool = (
      await resultOf(
        page,
        () =>
          entry().getByRole("button", { name: "Pool", exact: true }).click(),
        "/actions/sword_pool",
      )
    ).result.roll;
    await json(
      gm.request,
      "DELETE",
      `/api/campaigns/${campaignId}/members/${created.playerId}`,
      {
        expectedCampaignRevision: await campaignRevision(),
        idempotencyKey: key(),
      },
    );
    current = await open();
    expect(current.campaignId).toBeNull();
    const denied = await player.request.post(
      `/api/characters/${characterId}/rolls/${oldPool.push.rollId}/push`,
      { data: { expectedRevision: current.revision, idempotencyKey: key() } },
    );
    expect(denied.status()).toBe(404);
    await page.route(`**/api/characters/${characterId}/templates`, (route) =>
      route.abort(),
    );
    await page.reload();
    await expect(
      entry().getByRole("button", { name: "Hit", exact: true }),
    ).toBeEnabled();
    const fresh = (
      await resultOf(
        page,
        () =>
          entry().getByRole("button", { name: "Pool", exact: true }).click(),
        "/actions/sword_pool",
      )
    ).result.roll;
    await expect(
      page.getByRole("button", { name: "Push saved roll" }),
    ).toBeEnabled();
    assertChild(
      fresh,
      (
        await resultOf(
          page,
          () => page.getByRole("button", { name: "Push saved roll" }).click(),
          "/push",
        )
      ).result.roll,
    );
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      for (const width of [320, 360, 768, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        ).toBe(true);
      }
    }
    await test.info().attach("derived-template-evidence", {
      body: JSON.stringify({
        systemId,
        campaignId,
        characterId,
        templateId,
        entryId,
        offlineReload,
      }),
      contentType: "application/json",
    });
  } finally {
    await player.setOffline(false);
    if (characterId) {
      const ch = (
        await json(player.request, "GET", `/api/characters/${characterId}`)
      ).character;
      await json(
        ch.campaignId ? gm.request : player.request,
        "PATCH",
        `/api/characters/${characterId}`,
        {
          command: "archive",
          expectedRevision: ch.revision,
          idempotencyKey: key(),
        },
      );
      expect(
        (await json(player.request, "GET", `/api/characters/${characterId}`))
          .character.lifecycle,
      ).toBe("archived");
      cleanup.characterId = characterId;
    }
    if (campaignId && templateId) {
      const path = `/api/campaigns/${campaignId}/item-templates/${templateId}`;
      const current = (await json(gm.request, "GET", path)).template;
      if (current.status !== "archived")
        await json(gm.request, "POST", `${path}/archive`, {
          expectedTemplateRevision: current.revision,
          idempotencyKey: key(),
        });
      expect((await json(gm.request, "GET", path)).template.status).toBe(
        "archived",
      );
      cleanup.templateId = templateId;
    }
    if (campaignId) {
      const c = (await json(gm.request, "GET", `/api/campaigns/${campaignId}`))
        .campaign;
      await json(gm.request, "POST", `/api/campaigns/${campaignId}/archive`, {
        expectedCampaignRevision: c.revision,
        idempotencyKey: key(),
      });
      expect(
        (await json(gm.request, "GET", `/api/campaigns/${campaignId}`)).campaign
          .status,
      ).toBe("archived");
      cleanup.campaignId = campaignId;
    }
    if (systemId) {
      await json(gm.request, "PATCH", `/api/systems/${systemId}`, {
        lifecycle: "archived",
        access: "private",
      });
      expect(
        (await json(gm.request, "GET", `/api/systems/${systemId}`)).workspace
          .system.lifecycle,
      ).toBe("archived");
      cleanup.systemId = systemId;
    }
    await test.info().attach("derived-cleanup", {
      body: JSON.stringify(cleanup),
      contentType: "application/json",
    });
    await Promise.all([gm.close(), co.close(), player.close()]);
  }
}
