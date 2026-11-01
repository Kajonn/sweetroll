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
export async function templateAudienceJourney(
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
  const revision = async () =>
    (await json(gm.request, "GET", `/api/campaigns/${campaignId}`)).campaign
      .revision;
  try {
    const made = await createCatalogCampaign(
      gm.request,
      co.request,
      player.request,
    );
    ({ campaignId, systemId } = made);
    await json(other.request, "POST", "/dev/signin", {
      code: "code-journey-p2",
      redirectUri: new URL("/cb", baseURL).href,
    });
    const invitation = (
      await json(
        gm.request,
        "POST",
        `/api/campaigns/${campaignId}/invitations`,
        {
          intendedRole: "player",
          expectedCampaignRevision: await revision(),
          idempotencyKey: key(),
        },
      )
    ).invitation;
    const reviewed = (
      await json(other.request, "POST", "/api/invitations/review", {
        token: invitation.token,
      })
    ).review;
    await json(other.request, "POST", "/api/invitations/accept", {
      campaignId,
      token: invitation.token,
      expectedInvitationRevision: reviewed.invitationRevision,
      reviewedAccessRevision: reviewed.accessRevision,
      idempotencyKey: key(),
    });
    const own = (
      await json(player.request, "POST", "/api/characters", {
        systemVersionId: made.versionId,
        entityDefinitionId: "character",
        name: "Draft bearer " + key(),
        idempotencyKey: key(),
      })
    ).character;
    characterId = own.characterId;
    await json(
      player.request,
      "POST",
      `/api/campaigns/${campaignId}/characters/${characterId}/adopt`,
      {
        expectedCampaignRevision: await revision(),
        expectedCharacterRevision: own.revision,
        acknowledgedDisclosure: true,
        idempotencyKey: key(),
      },
    );
    const page = await gm.newPage();
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(`/campaigns/${campaignId}`);
    await page.getByRole("tab", { name: "Items & powers" }).click();
    await page.getByRole("button", { name: "Create template" }).click();
    await page.getByLabel("Audience").selectOption("gm_only");
    await page
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("Secret D2 key");
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const template = (
      await json(
        gm.request,
        "GET",
        `/api/campaigns/${campaignId}/item-templates`,
      )
    ).templates[0];
    templateIds.push(template.templateId);
    expect(
      (
        await json(
          player.request,
          "GET",
          `/api/campaigns/${campaignId}/item-templates`,
        )
      ).templates,
    ).toEqual([]);
    expect(
      (
        await other.request.get(
          `/api/campaigns/${campaignId}/item-templates/${template.templateId}`,
        )
      ).status(),
    ).toBe(404);
    await page.getByRole("button", { name: "Sharing", exact: true }).click();
    await page.getByLabel("Audience").selectOption("selected_players");
    await page
      .getByRole("checkbox", { name: made.playerId, exact: true })
      .check();
    await page
      .getByRole("button", { name: "Save sharing", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByLabel("Preview as player").selectOption(made.playerId);
    await expect(page.getByText("Read-only player preview")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Secret D2 key", exact: true }),
    ).toBeVisible();
    expect(
      await page.getByRole("button", { name: "Sharing", exact: true }).count(),
    ).toBe(0);
    const actual = (
      await json(
        player.request,
        "GET",
        `/api/campaigns/${campaignId}/item-templates`,
      )
    ).templates;
    const preview = (
      await json(
        gm.request,
        "POST",
        `/api/campaigns/${campaignId}/item-template-preview`,
        { targetUserId: made.playerId },
      )
    ).templates;
    expect(preview).toEqual(actual);
    expect(actual[0].grants).toEqual([]);
    expect(
      (
        await json(
          other.request,
          "GET",
          `/api/campaigns/${campaignId}/item-templates`,
        )
      ).templates,
    ).toEqual([]);
    const reader = await player.newPage();
    await reader.goto(`/characters/${characterId}`);
    await reader.getByTestId("slot-add-inventory").click();
    await expect(
      reader
        .getByTestId("slot-template-picker-inventory")
        .locator("option", { hasText: "Secret D2 key" }),
    ).toHaveCount(0);
    const cache = await reader.evaluate(async () => {
      const result = await new Promise<unknown[]>((resolve, reject) => {
        const r = indexedDB.open("sweetroll-characters");
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const db = r.result;
          const get = db
            .transaction("entryTemplates")
            .objectStore("entryTemplates")
            .getAll();
          get.onsuccess = () => {
            resolve(get.result);
            db.close();
          };
          get.onerror = () => reject(get.error);
        };
      });
      return JSON.stringify(result);
    });
    expect(cache).not.toContain("Secret D2 key");
    const catalog = await player.newPage();
    await catalog.goto(`/campaigns/${campaignId}`);
    await catalog.getByRole("tab", { name: "Items & powers" }).click();
    await expect(
      catalog.getByRole("heading", { name: "Secret D2 key", exact: true }),
    ).toBeVisible();
    if (offline) {
      await expectOfflineAvailable(reader);
      await expect.poll(()=>catalog.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBe(true);
      await player.setOffline(true);
      await expect(
        catalog.getByRole("heading", { name: "Secret D2 key", exact: true }),
      ).toHaveCount(0);
      const privateCacheKeys=await catalog.evaluate(async()=>{const urls:string[]=[];for(const name of await caches.keys()){const cache=await caches.open(name);for(const request of await cache.keys())if(/item-template/.test(request.url))urls.push(request.url);}return urls;});
      expect(privateCacheKeys).toEqual([]);
      // Campaign routes intentionally are not in the character-only offline shell allowlist.
      // An offline direct reload must fail closed rather than restore private catalog HTML.
      await expect(catalog.reload()).rejects.toThrow('ERR_INTERNET_DISCONNECTED');
      await expect(
        catalog.getByRole("heading", { name: "Secret D2 key", exact: true }),
      ).toHaveCount(0);
      await player.setOffline(false);
    }
    await page.getByLabel("Preview as player").selectOption("");
    await page.getByRole("button", { name: "Sharing", exact: true }).click();
    await page.getByLabel("Audience").selectOption("all_players");
    await expect(
      page.getByText(/Existing sheet copies cannot be recalled/),
    ).toBeVisible();
    const violations = await new AxeBuilder({ page }).analyze();
    expect(violations.violations).toEqual([]);
    await page.screenshot({
      path: test.info().outputPath("explicit-reveal-360.png"),
    });
    let dropped = false;
    const bodies: unknown[] = [];
    await page.route("**/item-templates/*/sharing", async (route) => {
      bodies.push(route.request().postDataJSON());
      const response = await route.fetch();
      if (!dropped) {
        dropped = true;
        expect(response.status()).toBe(200);
        await route.abort();
      } else await route.fulfill({ response });
    });
    await page
      .getByRole("button", { name: "Reveal to all players", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Retry exact request", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    await page.unroute("**/item-templates/*/sharing");
    await reader.reload();
    await reader.getByTestId("slot-add-inventory").click();
    await reader
      .getByTestId("slot-template-picker-inventory")
      .selectOption({ label: "Secret D2 key · Campaign" });
    await reader.getByTestId("slot-add-confirm-inventory").click();
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
      .toBe(1);
    const before = (
      await json(player.request, "GET", `/api/characters/${characterId}`)
    ).character;
    await page.getByRole("button", { name: "Sharing", exact: true }).click();
    await page.getByLabel("Audience").selectOption("gm_only");
    await page
      .getByRole("button", { name: "Save sharing", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(
      (await json(player.request, "GET", `/api/characters/${characterId}`))
        .character.state.entries,
    ).toEqual(before.state.entries);
    expect(
      (
        await json(
          player.request,
          "GET",
          `/api/characters/${characterId}/templates`,
        )
      ).templates.filter((x: any) => x.source?.kind === "campaign"),
    ).toEqual([]);
    if (offline) {
      await expectOfflineAvailable(reader);
      await player.setOffline(true);
      await reader.reload();
      await expect(reader.getByTestId("slot-list-inventory")).toContainText(
        "Secret D2 key",
      );
      await player.setOffline(false);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({
      path: test.info().outputPath("private-catalog-1280.png"),
    });
  } finally {
    await player.setOffline(false);
    if (characterId) {
      const ch = (
        await json(player.request, "GET", `/api/characters/${characterId}`)
      ).character;
      await json(gm.request, "PATCH", `/api/characters/${characterId}`, {
        command: "archive",
        expectedRevision: ch.revision,
        idempotencyKey: key(),
      });
      expect(
        (await json(player.request, "GET", `/api/characters/${characterId}`))
          .character.lifecycle,
      ).toBe("archived");
    }
    for (const id of templateIds) {
      const path = `/api/campaigns/${campaignId}/item-templates/${id}`;
      const t = (await json(gm.request, "GET", path)).template;
      await json(gm.request, "POST", path + "/archive", {
        expectedTemplateRevision: t.revision,
        idempotencyKey: key(),
      });
      expect((await json(gm.request, "GET", path)).template.status).toBe(
        "archived",
      );
    }
    if (campaignId) {
      await json(gm.request, "POST", `/api/campaigns/${campaignId}/archive`, {
        expectedCampaignRevision: await revision(),
        idempotencyKey: key(),
      });
      expect(
        (await json(gm.request, "GET", `/api/campaigns/${campaignId}`)).campaign
          .status,
      ).toBe("archived");
    }
    if (systemId) {
      await json(gm.request, "PATCH", `/api/systems/${systemId}`, {
        access: "private",
        lifecycle: "archived",
      });
      expect(
        (await json(gm.request, "GET", `/api/systems/${systemId}`)).workspace
          .system.lifecycle,
      ).toBe("archived");
    }
    await test.info().attach("audience-cleanup", {
      body: JSON.stringify({
        campaignId,
        systemId,
        characterId,
        templateIds,
      }),
      contentType: "application/json",
    });
    await Promise.all([gm.close(), co.close(), player.close(), other.close()]);
  }
}
