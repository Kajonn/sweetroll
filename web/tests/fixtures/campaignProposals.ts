import {
  test,
  expect,
  type Browser,
  type APIRequestContext,
} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createCatalogCampaign } from "./campaignTemplates.js";
import { json, key } from "./configurablePush.js";
import { expectOfflineAvailable } from "../offline/test-auth.js";
export async function campaignProposalJourney(
  { browser, baseURL }: { browser: Browser; baseURL: string | undefined },
  offline = false,
) {
  test.setTimeout(180000);
  if (!baseURL) throw Error("Browser base URL required");
  const gm = await browser.newContext({ baseURL }),
    co = await browser.newContext({ baseURL }),
    player = await browser.newContext({ baseURL }),
    other = await browser.newContext({ baseURL });
  let campaignId: string | undefined,
    systemId: string | undefined,
    characterId: string | undefined;
  const templateIds: string[] = [];
  const cleanup: Record<string, unknown> = {};
  const campaignRevision = async () =>
    (await json(gm.request, "GET", `/api/campaigns/${campaignId}`)).campaign
      .revision;
  async function join(request: APIRequestContext) {
    const issued = await json(
      gm.request,
      "POST",
      `/api/campaigns/${campaignId}/invitations`,
      {
        intendedRole: "player",
        expectedCampaignRevision: await campaignRevision(),
        idempotencyKey: key(),
      },
    );
    const token = issued.invitation.token;
    const reviewed = await json(request, "POST", "/api/invitations/review", {
      token,
    });
    await json(request, "POST", "/api/invitations/accept", {
      campaignId,
      token,
      expectedInvitationRevision: reviewed.review.invitationRevision,
      reviewedAccessRevision: reviewed.review.accessRevision,
      idempotencyKey: key(),
    });
  }
  try {
    const created = await createCatalogCampaign(
      gm.request,
      co.request,
      player.request,
    );
    ({ campaignId, systemId } = created);
    const otherId = (
      await json(other.request, "POST", "/dev/signin", {
        code: "code-journey-p2",
        redirectUri: new URL("/cb", baseURL).href,
      })
    ).userId;
    await join(other.request);
    const own = (
      await json(player.request, "POST", "/api/characters", {
        systemVersionId: created.versionId,
        entityDefinitionId: "character",
        name: `Suggestion bearer ${key()}`,
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
    let current = (
      await json(player.request, "GET", `/api/characters/${characterId}`)
    ).character;
    const personalId = key();
    await json(
      player.request,
      "POST",
      `/api/characters/${characterId}/entries`,
      {
        entry: {
          entryId: personalId,
          slotId: "inventory",
          templateId: null,
          values: {
            name: "Original key",
            description: "An old key",
            notes: "Personal unchanged",
          },
          quantity: 2,
        },
        expectedRevision: current.revision,
        idempotencyKey: key(),
      },
    );
    const original = (
      await json(player.request, "GET", `/api/characters/${characterId}`)
    ).character;
    const page = await player.newPage();
    await page.goto(`/campaigns/${campaignId}`);
    await page.getByRole("tab", { name: "Items & powers" }).click();
    await page.getByRole("button", { name: "Suggest a template" }).click();
    await page
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("Original key");
    await page
      .getByRole("textbox", { name: "Description", exact: true })
      .fill("An old key");
    await page
      .getByRole("textbox", { name: "Notes", exact: true })
      .fill("Personal unchanged");
    await page.getByRole("spinbutton", { name: "Default quantity" }).fill("2");
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
    const submittedRequests: unknown[] = [];
    let dropped = false;
    await page.route("**/api/campaigns/*/item-proposals", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      submittedRequests.push(route.request().postDataJSON());
      const response = await route.fetch();
      if (!dropped) {
        dropped = true;
        expect(response.status()).toBe(201);
        await route.abort();
      } else await route.fulfill({ response });
    });
    await page.getByRole("button", { name: "Submit suggestion" }).click();
    await expect(page.getByRole("alert")).toContainText("response was lost");
    await page.getByRole("button", { name: "Retry exact request" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(submittedRequests).toHaveLength(2);
    expect(submittedRequests[0]).toEqual(submittedRequests[1]);
    await page.reload();
    await page.getByRole("tab", { name: "Items & powers" }).click();
    await expect(
      page.getByText("Pending review", { exact: false }),
    ).toBeVisible();
    const proposals = (
      await json(
        player.request,
        "GET",
        `/api/campaigns/${campaignId}/item-proposals`,
      )
    ).proposals;
    expect(proposals).toHaveLength(1);
    const p = proposals[0];
    expect(
      (
        await json(
          other.request,
          "GET",
          `/api/campaigns/${campaignId}/item-proposals`,
        )
      ).proposals,
    ).toEqual([]);
    expect(
      (
        await other.request.get(
          `/api/campaigns/${campaignId}/item-proposals/${p.proposalId}`,
        )
      ).status(),
    ).toBe(404);
    expect(
      (
        await other.request.post(`/api/campaigns/${campaignId}/exports`, {
          data: { idempotencyKey: key() },
        })
      ).status(),
    ).toBe(404);
    expect(
      (
        await json(
          player.request,
          "GET",
          `/api/campaigns/${campaignId}/item-templates`,
        )
      ).templates,
    ).toEqual([]);
    const gmPage = await gm.newPage();
    await gmPage.goto(`/campaigns/${campaignId}`);
    await gmPage.getByRole("tab", { name: "Items & powers" }).click();
    await gmPage.getByRole("button", { name: "Review suggestion" }).click();
    await expect(
      gmPage
        .getByRole("dialog")
        .getByText("Personal unchanged", { exact: true }),
    ).toBeVisible();
    const a11y = await new AxeBuilder({ page: gmPage }).analyze();
    expect(a11y.violations).toEqual([]);
    let approveDropped = false;
    const decisions: unknown[] = [];
    await gmPage.route("**/item-proposals/*/approve", async (route) => {
      decisions.push(route.request().postDataJSON());
      const response = await route.fetch();
      if (!approveDropped) {
        approveDropped = true;
        expect(response.status()).toBe(200);
        await route.abort();
      } else await route.fulfill({ response });
    });
    await gmPage
      .getByRole("button", { name: "Approve and publish to all members" })
      .click();
    await expect(gmPage.getByRole("alert")).toContainText("response was lost");
    await gmPage.getByRole("button", { name: "Retry exact request" }).click();
    await expect(gmPage.getByRole("dialog")).toHaveCount(0);
    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toEqual(decisions[1]);
    const approved = (
      await json(
        player.request,
        "GET",
        `/api/campaigns/${campaignId}/item-proposals/${p.proposalId}`,
      )
    ).proposal;
    expect(approved.status).toBe("approved");
    templateIds.push(approved.approvedTemplateId);
    const catalog = (
      await json(
        player.request,
        "GET",
        `/api/campaigns/${campaignId}/item-templates`,
      )
    ).templates;
    expect(catalog).toHaveLength(1);
    expect(catalog[0].content).toEqual(p.content);
    const unchanged = (
      await json(player.request, "GET", `/api/characters/${characterId}`)
    ).character;
    expect(unchanged.state).toEqual(original.state);
    expect(unchanged.revision).toBe(original.revision);
    const sheet = await player.newPage();
    await sheet.goto(`/characters/${characterId}`);
    await sheet.getByTestId("slot-add-inventory").click();
    await sheet
      .getByTestId("slot-template-picker-inventory")
      .selectOption({ label: "Original key · Campaign" });
    await sheet.getByTestId("slot-add-confirm-inventory").click();
    await expect
      .poll(
        async () =>
          Object.keys(
            (
              await json(
                player.request,
                "GET",
                `/api/characters/${characterId}`,
              )
            ).character.state.entries,
          ).length,
      )
      .toBe(2);
    current = (
      await json(player.request, "GET", `/api/characters/${characterId}`)
    ).character;
    expect(current.state.entries[personalId]).toEqual(
      original.state.entries[personalId],
    );
    // Reject a distinct submission, lose its committed response, reload without any automatic POST.
    const second = (
      await json(
        player.request,
        "POST",
        `/api/campaigns/${campaignId}/item-proposals`,
        {
          kind: "effect",
          content: { name: "Rejected idea" },
          expectedProposalRevision: 0,
          idempotencyKey: key(),
        },
      )
    ).proposal;
    await gmPage.reload();
    await gmPage.getByRole("tab", { name: "Items & powers" }).click();
    await gmPage.getByRole("button", { name: "Review suggestion" }).click();
    await gmPage
      .getByRole("textbox", { name: "Rejection reason (optional)" })
      .fill("Private explanation");
    let rejectPosts = 0;
    await gmPage.route("**/item-proposals/*/reject", async (route) => {
      rejectPosts++;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort();
    });
    await gmPage.getByRole("button", { name: "Reject suggestion" }).click();
    await expect(gmPage.getByRole("alert")).toContainText("response was lost");
    await gmPage.reload();
    await gmPage.getByRole("tab", { name: "Items & powers" }).click();
    await expect(
      gmPage.getByText("Private explanation", { exact: true }),
    ).toBeVisible();
    expect(rejectPosts).toBe(1);
    expect(
      (
        await json(
          player.request,
          "GET",
          `/api/campaigns/${campaignId}/item-proposals/${second.proposalId}`,
        )
      ).proposal.status,
    ).toBe("rejected");
    expect(
      (
        await json(
          player.request,
          "GET",
          `/api/campaigns/${campaignId}/item-templates`,
        )
      ).templates,
    ).toHaveLength(1);
    // Competing reviewers make one terminal decision, never duplicate publication.
    const third = (
      await json(
        player.request,
        "POST",
        `/api/campaigns/${campaignId}/item-proposals`,
        {
          kind: "spell",
          content: { name: "Contested idea" },
          expectedProposalRevision: 0,
          idempotencyKey: key(),
        },
      )
    ).proposal;
    const race = await Promise.all([
      gm.request.post(
        `/api/campaigns/${campaignId}/item-proposals/${third.proposalId}/approve`,
        { data: { expectedProposalRevision: 1, idempotencyKey: key() } },
      ),
      co.request.post(
        `/api/campaigns/${campaignId}/item-proposals/${third.proposalId}/reject`,
        { data: { expectedProposalRevision: 1, idempotencyKey: key() } },
      ),
    ]);
    expect(race.map((r) => r.status()).sort()).toEqual([200, 409]);
    const terminal = (
      await json(
        gm.request,
        "GET",
        `/api/campaigns/${campaignId}/item-proposals/${third.proposalId}`,
      )
    ).proposal;
    if (terminal.approvedTemplateId)
      templateIds.push(terminal.approvedTemplateId);
    const exported = (
      await json(gm.request, "POST", `/api/campaigns/${campaignId}/exports`, {
        idempotencyKey: key(),
      })
    ).export;
    expect(exported.proposals).toHaveLength(3);
    if (offline) {
      await page.reload();
      await page.getByRole("tab", { name: "Items & powers" }).click();
      await expectOfflineAvailable(sheet);
      await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
      await player.setOffline(true);
      await expect(
        page.getByRole("button", { name: "Suggest a template" }),
      ).toBeDisabled();
      await expect(
        page.getByText("Connect to submit or review suggestions."),
      ).toBeVisible();
      const privateKeys = await page.evaluate(async () => {
        const result = [];
        for (const name of await caches.keys()) {
          const cache = await caches.open(name);
          for (const r of await cache.keys())
            if (r.url.includes("item-proposals")) result.push(r.url);
        }
        return result;
      });
      expect(privateKeys).toEqual([]);
      await player.setOffline(false);
    }
    // Removed membership loses its old private submissions even after a fresh invitation.
    await json(
      gm.request,
      "DELETE",
      `/api/campaigns/${campaignId}/members/${created.playerId}`,
      {
        expectedCampaignRevision: await campaignRevision(),
        idempotencyKey: key(),
      },
    );
    expect(
      (
        await player.request.get(
          `/api/campaigns/${campaignId}/item-proposals/${p.proposalId}`,
        )
      ).status(),
    ).toBe(404);
    await join(player.request);
    expect(
      (
        await json(
          player.request,
          "GET",
          `/api/campaigns/${campaignId}/item-proposals`,
        )
      ).proposals,
    ).toEqual([]);
    expect(
      (
        await json(
          other.request,
          "GET",
          `/api/campaigns/${campaignId}/item-proposals`,
        )
      ).proposals,
    ).toEqual([]);
    cleanup.otherId = otherId;
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
    for (const id of templateIds) {
      const path = `/api/campaigns/${campaignId}/item-templates/${id}`;
      const t = (await json(gm.request, "GET", path)).template;
      await json(gm.request, "POST", `${path}/archive`, {
        expectedTemplateRevision: t.revision,
        idempotencyKey: key(),
      });
      expect((await json(gm.request, "GET", path)).template.status).toBe(
        "archived",
      );
    }
    if (campaignId) {
      await json(gm.request, "POST", `/api/campaigns/${campaignId}/archive`, {
        expectedCampaignRevision: await campaignRevision(),
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
    await test
      .info()
      .attach("proposal-cleanup", {
        body: JSON.stringify({ ...cleanup, templateIds }),
        contentType: "application/json",
      });
    await Promise.all([gm.close(), co.close(), player.close(), other.close()]);
  }
}
