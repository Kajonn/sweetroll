import { expect, test, type Page, type Request } from "../fixtures/browserTest";
import { json, key, signIn } from "../fixtures/configurablePush";
import { armProfileFaults } from "../fixtures/faultyProfile";

/**
 * Character session read-path plan, S5. A player's browser runs without Web
 * Locks and with an incomplete IndexedDB profile (no character copy can be
 * written). The GM creates the player's campaign character; the faulty
 * profile shows it read-only with the reason, follows another device's edits
 * without a reload, hides the live view offline and shows the latest state
 * when back online, and loses the sheet at the next refresh after the player
 * is removed from the campaign. The faulty profile never sends a character
 * command.
 *
 * Refresh triggers are driven deterministically: a `visibilitychange` event
 * (the page is visible) for the edit, the browser `online` event from
 * `context.setOffline(false)` for the reconnect, and the 30-second live-view
 * timer advanced with `page.clock.fastForward` for the removal.
 */
const D20_VERSION = "a0000000-0000-5000-8000-000000000002";
const UNAVAILABLE = "This character is unavailable.";
const LOCKS = "Read-only in this browser.";

test("a faulty profile follows edits, reconnects and loses a removed campaign sheet", async ({ browser, page: gm, baseURL }) => {
  test.setTimeout(180_000);
  if (!baseURL) throw new Error("Browser base URL required");
  const stamp = key().slice(0, 8);
  await signIn(gm, "code-journey-gm");
  const home = await browser.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL } });
  const playerHome = await home.newPage();
  let faulty: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  let campaignId: string | undefined;
  let characterId: string | undefined;
  try {
    const playerId = await signIn(playerHome, "code-journey-p1");
    const { campaign } = await json(gm.request, "POST", "/api/campaigns", {
      systemVersionId: D20_VERSION, title: `S5 read path ${stamp}`, idempotencyKey: key(),
    });
    campaignId = campaign.campaignId as string;
    const path = `/api/campaigns/${campaignId}`;
    const revision = async () => (await json(gm.request, "GET", path)).campaign.revision as number;
    const { invitation } = await json(gm.request, "POST", `${path}/invitations`, {
      intendedRole: "player", expectedCampaignRevision: await revision(), idempotencyKey: key(),
    });
    const { review } = await json(playerHome.request, "POST", "/api/invitations/review", { token: invitation.token });
    await json(playerHome.request, "POST", "/api/invitations/accept", {
      campaignId, token: invitation.token, expectedInvitationRevision: review.invitationRevision,
      reviewedAccessRevision: review.accessRevision, idempotencyKey: key(),
    });

    // 1. The GM creates the player's character in the campaign.
    const created = `S5 Wanderer ${stamp}`;
    const { character } = await json(gm.request, "POST", `${path}/characters`, {
      name: created, entityDefinitionId: "character", controllerUserIds: [playerId],
      expectedCampaignRevision: await revision(), idempotencyKey: key(),
    });
    characterId = character.characterId as string;
    const characterPath = `/api/characters/${characterId}`;
    const rename = async (name: string) => {
      const current = (await json(gm.request, "GET", characterPath)).character;
      await json(gm.request, "PATCH", characterPath, {
        command: "rename", name, expectedRevision: current.revision, idempotencyKey: key(),
      });
    };

    // 2. The player opens it in a profile without Web Locks whose character
    // store rejects writes. It keeps the sign-in cookie (and dismissed
    // welcome) but has no IndexedDB copy.
    faulty = await browser.newContext({ baseURL, storageState: await home.storageState(), extraHTTPHeaders: { Origin: baseURL } });
    await armProfileFaults(faulty, ["locks", "storage"]);
    const commands: string[] = [];
    faulty.on("request", (request: Request) => {
      const url = new URL(request.url());
      if (request.method() !== "GET" && request.method() !== "HEAD" && url.pathname.startsWith("/api/characters")) {
        commands.push(`${request.method()} ${url.pathname}`);
      }
    });
    const phone = await faulty.newPage();
    await phone.clock.install();
    await phone.goto(`/characters/${characterId}`);
    const heading = (view: Page, name: string) => view.getByRole("heading", { name, exact: true });
    await expect(heading(phone, created)).toBeVisible({ timeout: 30_000 });
    await expect(phone.getByText(LOCKS, { exact: true })).toBeVisible();
    await expect(phone.getByText(UNAVAILABLE)).toHaveCount(0);
    await expect(phone.getByText("Available online only", { exact: true })).toBeVisible();

    // 3. The GM edits it on another device. No push arrives; the faulty
    // profile shows the change when the page reports itself visible again.
    const edited = `S5 Wanderer edited ${stamp}`;
    await rename(edited);
    await phone.waitForTimeout(1_000);
    await expect(heading(phone, created)).toBeVisible();
    const visibleRefresh = phone.waitForResponse(r => new URL(r.url()).pathname === characterPath && r.request().method() === "GET");
    await phone.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    expect((await visibleRefresh).status()).toBe(200);
    await expect(heading(phone, edited)).toBeVisible({ timeout: 10_000 });
    await expect(heading(phone, created)).toHaveCount(0);

    // 4. Offline hides the live view. The GM edits again meanwhile; back
    // online the sheet returns with the latest state.
    await faulty.setOffline(true);
    await expect(heading(phone, edited)).toHaveCount(0, { timeout: 10_000 });
    const latest = `S5 Wanderer latest ${stamp}`;
    await rename(latest);
    await faulty.setOffline(false);
    await expect(heading(phone, latest)).toBeVisible({ timeout: 15_000 });
    await expect(phone.getByText(LOCKS, { exact: true })).toBeVisible();

    // 5. The GM removes the player. At the next timer refresh the sheet
    // disappears and the access loss is shown, with no stale data.
    await json(gm.request, "DELETE", `${path}/members/${playerId}`, {
      expectedCampaignRevision: await revision(), idempotencyKey: key(),
    });
    await phone.waitForTimeout(1_000);
    await expect(heading(phone, latest)).toBeVisible();
    const timerRefresh = phone.waitForResponse(r => new URL(r.url()).pathname === characterPath && r.request().method() === "GET");
    await phone.clock.fastForward(30_000);
    expect((await timerRefresh).status()).toBe(404);
    await expect(phone.getByText(UNAVAILABLE)).toBeVisible({ timeout: 10_000 });
    for (const name of [created, edited, latest]) await expect(phone.locator("body")).not.toContainText(name);

    expect(commands, "character commands sent from the faulty profile").toEqual([]);
  } finally {
    await faulty?.close();
    await home.close();
    if (process.env.SWEETROLL_E2E_EPHEMERAL_DB !== "1") {
      if (characterId) {
        const current = (await json(gm.request, "GET", `/api/characters/${characterId}`)).character;
        if (current.lifecycle !== "archived") {
          await json(gm.request, "PATCH", `/api/characters/${characterId}`, {
            command: "archive", expectedRevision: current.revision, idempotencyKey: key(),
          });
        }
      }
      if (campaignId) {
        const current = (await json(gm.request, "GET", `/api/campaigns/${campaignId}`)).campaign;
        if (current.status !== "archived") {
          await json(gm.request, "POST", `/api/campaigns/${campaignId}/archive`, {
            expectedCampaignRevision: current.revision, idempotencyKey: key(),
          });
        }
      }
    }
  }
});
