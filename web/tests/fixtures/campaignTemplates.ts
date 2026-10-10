import {
  test,
  expect,
  type Browser,
  type APIRequestContext,
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
    await signIn(gm.request, "code-test-a");
    await signIn(co.request, "code-test-b");
    const playerId = await signIn(player.request, "code-journey-p1");
    const clone = await post(
      gm.request,
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
    const save = await gm.request.put(`/api/systems/${systemId}/draft`, {
      data: { expectedRevision: clone.workspace.draft.revision, document },
    });
    expect(save.status()).toBe(200);
    const published = await post(
      gm.request,
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
      gm.request,
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
    await join(gm.request, co.request, campaignId, "co_gm");
    await join(gm.request, player.request, campaignId, "player");
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
    await playerPage.reload();
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
    await playerPage.reload();
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
