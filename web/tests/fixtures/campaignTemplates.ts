import {
  test,
  expect,
  type Browser,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { uid, expectOfflineAvailable } from "../offline/test-auth.js";
import AxeBuilder from "@axe-core/playwright";

async function post(
  request: APIRequestContext,
  path: string,
  data: unknown,
  status = 200,
) {
  const response = await request.post(path, { data });
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

async function cachedCatalog(page: Page, actorId: string, characterId: string) {
  return page.evaluate(({ actorId, characterId }) => new Promise<unknown>((resolve, reject) => {
    const request = indexedDB.open("sweetroll-characters");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const get = db.transaction("entryTemplates").objectStore("entryTemplates").get([actorId, characterId]);
      get.onsuccess = () => { resolve(get.result ?? null); db.close(); };
      get.onerror = () => { reject(get.error); db.close(); };
    };
  }), { actorId, characterId });
}

/** Review regressions use real authority changes; only the catalog transport failure is injected. */
export async function campaignTemplateReviewJourney(
  { browser, baseURL }: { browser: Browser; baseURL: string | undefined },
  offlineReload = false,
) {
  test.setTimeout(120_000);
  if (!baseURL) throw new Error("Browser base URL is required.");
  const gm = await browser.newContext({ baseURL });
  const co = await browser.newContext({ baseURL });
  const player = await browser.newContext({ baseURL });
  try {
    const { campaignId, playerId, versionId } = await createCatalogCampaign(gm.request, co.request, player.request);
    const published = await post(gm.request, `/api/campaigns/${campaignId}/item-templates`, {
      kind: "item", content: { name: "Review key", notes: "Original", defaultQuantity: 2 }, expectedTemplateRevision: 0, idempotencyKey: uid(),
    }, 201);
    const template = published.template;
    const own = (await post(player.request, "/api/characters", { systemVersionId: versionId, entityDefinitionId: "character", name: `Returnable hero ${uid()}`, idempotencyKey: uid() }, 201)).character;
    const campaignRevision = async () => (await (await gm.request.get(`/api/campaigns/${campaignId}`)).json()).campaign.revision as number;
    await post(player.request, `/api/campaigns/${campaignId}/characters/${own.characterId}/adopt`, {
      expectedCampaignRevision: await campaignRevision(), expectedCharacterRevision: own.revision, acknowledgedDisclosure: true, idempotencyKey: uid(),
    });
    const page = await player.newPage();
    await page.goto(`/characters/${own.characterId}`);
    await page.getByTestId("slot-add-inventory").click();
    const picker = page.getByTestId("slot-template-picker-inventory");
    await expect(picker.locator("option", { hasText: "Review key" })).toHaveCount(1);
    await picker.selectOption({ label: "Review key · Campaign" });
    await post(gm.request, `/api/campaigns/${campaignId}/item-templates/${template.templateId}/archive`, { expectedTemplateRevision: template.revision, idempotencyKey: uid() });
    // Disappearing choices retain the original campaign source. Recovery
    // also changes resource revision without changing immutable content.
    const refreshed = page.waitForResponse(response => response.url().endsWith(`/api/characters/${own.characterId}/templates`) && response.status() === 200);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await refreshed;
    const selected = page.waitForRequest(request => request.url().endsWith(`/api/characters/${own.characterId}/entries`) && request.method() === "POST");
    await page.getByTestId("slot-add-confirm-inventory").click();
    expect((await selected).postDataJSON().entry.source).toMatchObject({ kind: "campaign", templateRevision: 1, contentRevision: 1 });
    await expect(page.getByText(/campaign template has changed/)).toBeVisible();
    await page.getByRole("checkbox", { name: /Campaign template revision/ }).check();
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await page.getByRole("button", { name: "Confirm discard", exact: true }).click();
    const recovered = (await post(gm.request, `/api/campaigns/${campaignId}/item-templates/${template.templateId}/recover`, { expectedTemplateRevision: 2, idempotencyKey: uid() })).template;
    await page.reload();
    await page.getByTestId("slot-add-inventory").click();
    await expect(picker.locator("option", { hasText: "Review key" })).toHaveCount(1);
    await picker.selectOption({ label: "Review key · Campaign" });
    const revision2 = await gm.request.patch(`/api/campaigns/${campaignId}/item-templates/${template.templateId}`, { data: { expectedTemplateRevision: recovered.revision, content: { name: "Review key", notes: "Revised", defaultQuantity: 3 }, idempotencyKey: uid() } });
    expect(revision2.status()).toBe(200);
    const response = page.waitForResponse(response => response.url().endsWith(`/api/characters/${own.characterId}/templates`) && response.status() === 200);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await response;
    await page.getByRole("button", { name: "Use latest revision" }).click();
    await page.getByTestId("slot-add-confirm-inventory").click();
    await expect.poll(async () => Object.keys((await (await player.request.get(`/api/characters/${own.characterId}`)).json()).character.state.entries).length).toBe(1);
    const before = (await (await player.request.get(`/api/characters/${own.characterId}`)).json()).character;
    const entryId = Object.keys(before.state.entries)[0]!;
    expect(before.state.entries[entryId].source.contentRevision).toBe(2);
    expect(before.state.entries[entryId].quantity).toBe(3);
    await expect.poll(() => cachedCatalog(page, playerId, own.characterId)).not.toBeNull();
    if (offlineReload) await expectOfflineAvailable(page);

    const restricted = (await post(gm.request, `/api/campaigns/${campaignId}/characters`, { name: `Restricted hero ${uid()}`, entityDefinitionId: "character", controllerUserIds: [playerId], expectedCampaignRevision: await campaignRevision(), idempotencyKey: uid() }, 201)).character;
    const active = await player.newPage();
    const reader = await player.newPage();
    await active.goto(`/characters/${restricted.characterId}`);
    await expect.poll(() => cachedCatalog(active, playerId, restricted.characterId)).not.toBeNull();
    await reader.goto(`/characters/${restricted.characterId}`);
    await expect(reader.getByRole("heading", { name: restricted.name, exact: true })).toBeVisible();
    let continueCatalog!: () => void;
    const catalogHeld = new Promise<void>(resolve => { continueCatalog = resolve; });
    let observedCatalog!: () => void;
    const observed = new Promise<void>(resolve => { observedCatalog = resolve; });
    await active.route(`**/api/characters/${restricted.characterId}/templates`, async route => { observedCatalog(); await catalogHeld; await route.continue(); });
    await active.evaluate(() => window.dispatchEvent(new Event("focus")));
    await observed;
    const removed = await gm.request.delete(`/api/campaigns/${campaignId}/members/${playerId}`, { data: { expectedCampaignRevision: await campaignRevision(), idempotencyKey: uid() } });
    expect(removed.status()).toBe(200);
    continueCatalog();
    for (const tab of [active, reader]) {
      await expect(tab.getByRole("heading", { name: restricted.name, exact: true })).toHaveCount(0);
      await expect(tab.getByRole("alert")).toContainText("unavailable");
    }
    expect(await cachedCatalog(active, playerId, restricted.characterId)).toBeNull();

    // Return is a permitted scope change, not a character-access denial.
    await page.route(`**/api/characters/${own.characterId}/templates`, route => route.abort());
    await page.reload();
    await expect(page.getByTestId(`slot-entry-${entryId}`)).toContainText("Revised");
    await expect.poll(() => cachedCatalog(page, playerId, own.characterId)).toBeNull();
    const returned = (await (await player.request.get(`/api/characters/${own.characterId}`)).json()).character;
    expect(returned.campaignId).toBeNull();
    expect(returned.state.entries).toEqual(before.state.entries);
    if (offlineReload) { await player.setOffline(true); await page.reload(); }
    await page.getByTestId("slot-add-inventory").click();
    await expect(picker.locator("option", { hasText: "Review key" })).toHaveCount(0);
    expect(await cachedCatalog(page, playerId, own.characterId)).toBeNull();
    await player.setOffline(false);
  } finally { await Promise.all([gm.close(), co.close(), player.close()]); }
}
async function signIn(request: APIRequestContext, code: string) {
  return (
    await post(request, "/dev/signin", {
      code,
      redirectUri: "http://localhost/cb",
    })
  ).userId as string;
}
async function join(
  gm: APIRequestContext,
  member: APIRequestContext,
  campaignId: string,
  role: "player" | "co_gm",
) {
  const revision = (await (await gm.get(`/api/campaigns/${campaignId}`)).json())
    .campaign.revision;
  const invitation = await post(
    gm,
    `/api/campaigns/${campaignId}/invitations`,
    {
      intendedRole: role,
      expectedCampaignRevision: revision,
      idempotencyKey: uid(),
    },
    201,
  );
  const token = invitation.invitation.token;
  const reviewed = await post(member, "/api/invitations/review", { token });
  await post(member, "/api/invitations/accept", {
    campaignId,
    token,
    expectedInvitationRevision: reviewed.review.invitationRevision,
    reviewedAccessRevision: reviewed.review.accessRevision,
    idempotencyKey: uid(),
  });
}
export async function createCatalogCampaign(gm: APIRequestContext, co: APIRequestContext, player: APIRequestContext, configure?: (document: Record<string,unknown>)=>void) {
  await signIn(gm, "code-test-a");
  await signIn(co, "code-test-b");
  const playerId = await signIn(player, "code-journey-p1");
  const clone = await post(
    gm,
    "/api/systems",
    {
      source: {
        kind: "clone",
        versionId: "a0000000-0000-5000-8000-000000000002",
      },
      idempotencyKey: uid(),
    },
    201,
  );
  const systemId = clone.workspace.system.systemId;
  const document = clone.workspace.draft.document;
  document.slots = [
    {
      id: "inventory",
      label: "Inventory",
      accepts: ["item", "spell", "talent", "effect"],
    },
  ];
  document.sheets[0].sections[0].elements.push({
    kind: "slot",
    id: "inventory_element",
    slotId: "inventory",
  });
  configure?.(document);
  const save = await gm.put(`/api/systems/${systemId}/draft`, {
    data: { expectedRevision: clone.workspace.draft.revision, document },
  });
  expect(save.status()).toBe(200);
  const published = await post(
    gm,
    `/api/systems/${systemId}/publish`,
    {
      expectedRevision: (await save.json()).workspace.draft.revision,
      semanticVersion: "1.0.0",
      releaseNotes: "",
      acknowledgeBreaking: true,
      idempotencyKey: uid(),
    },
  );
  const campaign = await post(
    gm,
    "/api/campaigns",
    {
      systemVersionId: published.version.versionId,
      title: `Templates ${uid()}`,
      description: "",
      idempotencyKey: uid(),
    },
    201,
  );
  const campaignId = campaign.campaign.campaignId;
  await join(gm, co, campaignId, "co_gm");
  await join(gm, player, campaignId, "player");
  const sharing = await gm.patch(`/api/systems/${systemId}`, { data: { access: "link" } });
  expect(sharing.status()).toBe(200);
  return { systemId, campaignId, playerId, versionId: published.version.versionId as string };
}

export async function campaignTemplateJourney(
  { browser, baseURL }: { browser: Browser; baseURL: string | undefined },
  offlineReload = false,
) {
  test.setTimeout(120_000);
  if (baseURL === undefined) throw new Error("Browser base URL is required.");
  const gm = await browser.newContext({ baseURL });
  const co = await browser.newContext({ baseURL });
  const player = await browser.newContext({ baseURL });
  try {
    const { campaignId, playerId } = await createCatalogCampaign(gm.request, co.request, player.request);
    const gmPage = await gm.newPage();
    const coPage = await co.newPage();
    const playerPage = await player.newPage();
    const path = `/campaigns/${campaignId}`;
    await gmPage.goto(path);
    await gmPage.getByRole("tab", { name: "Items & powers" }).click();
    await gmPage.getByRole("button", { name: "Create template" }).click();
    await gmPage
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("Tower key");
    await gmPage
      .getByRole("textbox", { name: "Notes", exact: true })
      .fill("Opens gate");
    await gmPage
      .getByRole("spinbutton", { name: "Default quantity" })
      .fill("3");
    await gmPage
      .getByRole("button", { name: "Publish to all members" })
      .click();
    await expect(
      gmPage.getByRole("heading", { name: "Tower key", exact: true }),
    ).toBeVisible();
    for (const width of [320, 360, 768, 1280]) {
      await gmPage.setViewportSize({ width, height: 800 });
      expect(
        await gmPage.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
      ).toBe(true);
    }
    await gmPage.setViewportSize({ width: 360, height: 800 });
    await gmPage.emulateMedia({ colorScheme: "dark" });
    const axe = await new AxeBuilder({ page: gmPage }).analyze();
    expect(
      axe.violations.filter(
        (v) => v.impact === "serious" || v.impact === "critical",
      ),
    ).toEqual([]);
    await gmPage.emulateMedia({ colorScheme: "light" });
    await gmPage.setViewportSize({ width: 1280, height: 800 });
    await coPage.goto(path);
    await coPage.getByRole("tab", { name: "Items & powers" }).click();
    await coPage.getByRole("button", { name: "Edit template" }).click();
    await coPage
      .getByRole("textbox", { name: "Notes", exact: true })
      .fill("Co-GM copy");
    await gmPage.getByRole("button", { name: "Edit template" }).click();
    await gmPage
      .getByRole("textbox", { name: "Notes", exact: true })
      .fill("GM revision");
    await gmPage.getByRole("button", { name: "Save revision" }).click();
    await expect(gmPage.getByRole("dialog")).toHaveCount(0);
    await coPage.getByRole("button", { name: "Save revision" }).click();
    await expect(coPage.getByRole("alert")).toContainText("changed");
    await expect(
      coPage.getByRole("textbox", { name: "Notes", exact: true }),
    ).toHaveValue("Co-GM copy");
    await coPage.getByRole("button", { name: "Refresh and review" }).click();
    await expect(
      coPage.getByRole("button", { name: "Save revision" }),
    ).toBeEnabled();
    await coPage.getByRole("button", { name: "Save revision" }).click();
    await expect(coPage.getByRole("dialog")).toHaveCount(0);
    await playerPage.goto(path);
    await playerPage.getByRole("tab", { name: "Items & powers" }).click();
    await expect(
      playerPage.getByRole("heading", { name: "Tower key", exact: true }),
    ).toBeVisible();
    await expect(
      playerPage.getByRole("button", { name: "Create template" }),
    ).toHaveCount(0);
    const revision = (
      await (await gm.request.get(`/api/campaigns/${campaignId}`)).json()
    ).campaign.revision;
    const created = await post(
      gm.request,
      `/api/campaigns/${campaignId}/characters`,
      {
        name: `Key bearer ${uid()}`,
        entityDefinitionId: "character",
        controllerUserIds: [playerId],
        expectedCampaignRevision: revision,
        idempotencyKey: uid(),
      },
      201,
    );
    const char = created.character.characterId;
    await playerPage.goto(`/characters/${char}`);
    await playerPage.getByTestId("slot-add-inventory").click();
    await expect(
      playerPage
        .getByTestId("slot-template-picker-inventory")
        .locator("option"),
    ).toContainText(["Tower key"]);
    await playerPage
      .getByTestId("slot-template-picker-inventory")
      .selectOption({ label: "Tower key · Campaign" });
    await playerPage.getByTestId("slot-add-confirm-inventory").click();
    await expect(playerPage.getByTestId("slot-list-inventory")).toContainText(
      "Tower key",
    );
    await expect
      .poll(
        async () =>
          Object.keys(
            (await (await player.request.get(`/api/characters/${char}`)).json())
              .character.state.entries,
          ).length,
      )
      .toBe(1);
    const firstState = (
      await (await player.request.get(`/api/characters/${char}`)).json()
    ).character.state;
    const firstId = Object.keys(firstState.entries)[0]!;
    await playerPage
      .getByTestId(`slot-entry-${firstId}`)
      .getByRole("button", { name: "Edit entry" })
      .click();
    await playerPage
      .getByRole("textbox", { name: "Notes", exact: true })
      .fill("Player notes");
    await playerPage
      .getByRole("spinbutton", { name: "Quantity", exact: true })
      .fill("1");
    await playerPage.getByRole("button", { name: "Save entry" }).click();
    await expect
      .poll(
        async () =>
          (await (await player.request.get(`/api/characters/${char}`)).json())
            .character.state.entries[firstId].values.notes,
      )
      .toBe("Player notes");
    await gmPage.reload();
    await gmPage.getByRole("tab", { name: "Items & powers" }).click();
    await gmPage.getByRole("button", { name: "Edit template" }).click();
    await gmPage
      .getByRole("textbox", { name: "Notes", exact: true })
      .fill("New catalog revision");
    await gmPage.getByRole("button", { name: "Save revision" }).click();
    await expect(gmPage.getByRole("dialog")).toHaveCount(0);
    const revisedCatalog = playerPage.waitForResponse(response => response.url().endsWith(`/api/characters/${char}/templates`) && response.status() === 200);
    await playerPage.reload();
    await revisedCatalog;
    // Existing entry text can render from cache before the new revision is
    // fetched. Freeze the offline addition only after revision 4 is durable.
    await expect.poll(async () => {
      const catalog = await cachedCatalog(playerPage, playerId, char) as {templates: Array<{source?: {kind: string; contentRevision?: number}}> } | null;
      return catalog?.templates.find(template => template.source?.kind === "campaign")?.source?.contentRevision;
    }).toBe(4);
    await expect(playerPage.getByTestId(`slot-entry-${firstId}`)).toContainText(
      "Player notes",
    );
    if (offlineReload) await expectOfflineAvailable(playerPage);
    await player.setOffline(true);
    await playerPage.getByTestId("slot-add-inventory").click();
    await playerPage
      .getByTestId("slot-template-picker-inventory")
      .selectOption({ label: "Tower key · Campaign" });
    await playerPage.getByTestId("slot-add-confirm-inventory").click();
    await expect(
      playerPage.getByText("Changes pending", { exact: true }),
    ).toBeVisible();
    if (offlineReload) {
      await playerPage.reload();
      await expect(
        playerPage.getByText("Changes pending", { exact: true }),
      ).toBeVisible();
    }
    await player.setOffline(false);
    await expect
      .poll(
        async () =>
          Object.keys(
            (await (await player.request.get(`/api/characters/${char}`)).json())
              .character.state.entries,
          ).length,
      )
      .toBe(2);
    const state = (
      await (await player.request.get(`/api/characters/${char}`)).json()
    ).character.state;
    for (const entry of Object.values(state.entries) as any[]) {
      expect(entry.source.contentRevision).toBe(
        entry.entryId === firstId ? 3 : 4,
      );
      expect(entry.snapshot.values.notes).toBe(
        entry.entryId === firstId ? "Co-GM copy" : "New catalog revision",
      );
      expect(entry.quantity).toBe(entry.entryId === firstId ? 1 : 3);
      if (entry.entryId === firstId)
        expect(entry.values.notes).toBe("Player notes");
    }
    await gmPage.reload();
    await gmPage.getByRole("tab", { name: "Items & powers" }).click();
    await gmPage.getByRole("button", { name: "Archive template" }).click();
    await gmPage.getByRole("button", { name: "Confirm archive" }).click();
    await expect(
      gmPage.getByRole("heading", { name: "Tower key", exact: true }),
    ).toHaveCount(0);
    const refreshedCatalog = playerPage.waitForResponse(response => response.url().endsWith(`/api/characters/${char}/templates`) && response.status() === 200);
    await playerPage.reload();
    await refreshedCatalog;
    // Offline builds restore cached choices first. Wait for the fresh catalog to
    // commit before opening a *new* selection; an already selected reference is
    // intentionally retained across archive/refresh by the review contract.
    await expect.poll(async () => {
      const catalog = await cachedCatalog(playerPage, playerId, char) as { templates: Array<{ source?: { kind: string } }> } | null;
      return catalog === null ? -1 : catalog.templates.filter(t => t.source?.kind === "campaign").length;
    }).toBe(0);
    await expect(playerPage.getByTestId("slot-list-inventory")).toContainText(
      "Tower key",
    );
    await playerPage.getByTestId("slot-add-inventory").click();
    await expect(
      playerPage
        .getByTestId("slot-template-picker-inventory")
        .locator("option", { hasText: "Tower key" }),
    ).toHaveCount(0);
    await gmPage.getByRole("button", { name: "Archived templates" }).click();
    await gmPage.getByRole("button", { name: "Recover template" }).click();
    await gmPage.getByRole("button", { name: "Active templates" }).click();
    await expect(
      gmPage.getByRole("heading", { name: "Tower key", exact: true }),
    ).toBeVisible();
    if (offlineReload) {
      // A fetched choice remains pinned across reload; a racing archive must
      // produce explicit review rather than silently substituting a revision.
      await playerPage.goto(`/characters/${char}`);
      await expectOfflineAvailable(playerPage);
      await playerPage.getByTestId("slot-add-inventory").click();
      await expect(
        playerPage
          .getByTestId("slot-template-picker-inventory")
          .locator("option", { hasText: "Tower key" }),
      ).toHaveCount(1);
      await playerPage
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      await player.setOffline(true);
      await playerPage.getByTestId("slot-add-inventory").click();
      await playerPage
        .getByTestId("slot-template-picker-inventory")
        .selectOption({ label: "Tower key · Campaign" });
      await playerPage.getByTestId("slot-add-confirm-inventory").click();
      await expect(
        playerPage.getByText("Changes pending", { exact: true }),
      ).toBeVisible();
      await playerPage.reload();
      await expect(
        playerPage.getByText("Changes pending", { exact: true }),
      ).toBeVisible();
      await gmPage.getByRole("button", { name: "Archive template" }).click();
      await gmPage.getByRole("button", { name: "Confirm archive" }).click();
      await expect(
        gmPage.getByRole("heading", { name: "Tower key", exact: true }),
      ).toHaveCount(0);
      await player.setOffline(false);
      await expect(
        playerPage.getByText(/campaign template has changed/),
      ).toBeVisible({ timeout: 30000 });
      expect(
        Object.keys(
          (await (await player.request.get(`/api/characters/${char}`)).json())
            .character.state.entries,
        ),
      ).toHaveLength(2);
    }
  } finally {
    await Promise.all([gm.close(), co.close(), player.close()]);
  }
}
