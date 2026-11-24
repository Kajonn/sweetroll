import { expect, test, type APIRequestContext, type Page, type Request } from "../fixtures/browserTest";
import { json, key, signIn } from "../fixtures/configurablePush";
import { armProfileFaults } from "../fixtures/faultyProfile";
import { expectSheetSaved, watchSheetWrites } from "../fixtures/sheetSaved";

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
const OTHER_TAB = "Read-only in this tab. Another tab is editing this character.";

const heading = (view: Page, name: string) => view.getByRole("heading", { name, exact: true });

type Created = { campaignId?: string; characterId?: string };

/**
 * The GM creates a d20 campaign, invites the player (who reviews and accepts
 * with `player`'s cookies) and creates the player's character in the campaign
 * with the player as controller, as a GM does at the table. Ids are recorded in
 * `created` as they exist, for the cleanup. Returns a GM rename over the API.
 */
async function createCampaignCharacter(gm: APIRequestContext, player: APIRequestContext, playerId: string, title: string, name: string, created: Created) {
  const { campaign } = await json(gm, "POST", "/api/campaigns", {
    systemVersionId: D20_VERSION, title, idempotencyKey: key(),
  });
  const campaignId = created.campaignId = campaign.campaignId as string;
  const campaignPath = `/api/campaigns/${campaignId}`;
  const campaignRevision = async () => (await json(gm, "GET", campaignPath)).campaign.revision as number;
  const { invitation } = await json(gm, "POST", `${campaignPath}/invitations`, {
    intendedRole: "player", expectedCampaignRevision: await campaignRevision(), idempotencyKey: key(),
  });
  const { review } = await json(player, "POST", "/api/invitations/review", { token: invitation.token });
  await json(player, "POST", "/api/invitations/accept", {
    campaignId, token: invitation.token, expectedInvitationRevision: review.invitationRevision,
    reviewedAccessRevision: review.accessRevision, idempotencyKey: key(),
  });
  const { character } = await json(gm, "POST", `${campaignPath}/characters`, {
    name, entityDefinitionId: "character", controllerUserIds: [playerId],
    expectedCampaignRevision: await campaignRevision(), idempotencyKey: key(),
  });
  const characterId = created.characterId = character.characterId as string;
  const characterPath = `/api/characters/${characterId}`;
  const read = async () => (await json(gm, "GET", characterPath)).character;
  const rename = async (next: string) => {
    await json(gm, "PATCH", characterPath, {
      command: "rename", name: next, expectedRevision: (await read()).revision, idempotencyKey: key(),
    });
  };
  return { characterId, characterPath, campaignPath, campaignRevision, read, rename };
}

/** Outside the disposable runner database, archives what a journey created. */
async function archiveCreated(gm: APIRequestContext, { characterId, campaignId }: Created) {
  if (process.env.SWEETROLL_E2E_EPHEMERAL_DB === "1") return;
  if (characterId) {
    const current = (await json(gm, "GET", `/api/characters/${characterId}`)).character;
    if (current.lifecycle !== "archived") {
      await json(gm, "PATCH", `/api/characters/${characterId}`, {
        command: "archive", expectedRevision: current.revision, idempotencyKey: key(),
      });
    }
  }
  if (campaignId) {
    const current = (await json(gm, "GET", `/api/campaigns/${campaignId}`)).campaign;
    if (current.status !== "archived") {
      await json(gm, "POST", `/api/campaigns/${campaignId}/archive`, {
        expectedCampaignRevision: current.revision, idempotencyKey: key(),
      });
    }
  }
}

test("a faulty profile follows edits, reconnects and loses a removed campaign sheet", async ({ browser, page: gm, baseURL }) => {
  test.setTimeout(180_000);
  if (!baseURL) throw new Error("Browser base URL required");
  const stamp = key().slice(0, 8);
  await signIn(gm, "code-journey-gm");
  const home = await browser.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL } });
  const playerHome = await home.newPage();
  let faulty: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  const records: Created = {};
  try {
    const playerId = await signIn(playerHome, "code-journey-p1");

    // 1. The GM creates the player's character in the campaign.
    const created = `S5 Wanderer ${stamp}`;
    const { characterId, characterPath, campaignPath, campaignRevision, rename } = await createCampaignCharacter(
      gm.request, playerHome.request, playerId, `S5 read path ${stamp}`, created, records);

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
    await json(gm.request, "DELETE", `${campaignPath}/members/${playerId}`, {
      expectedCampaignRevision: await campaignRevision(), idempotencyKey: key(),
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
    await archiveCreated(gm.request, records);
  }
});

/**
 * Session view plan, V4. One healthy player browser (Web Locks and IndexedDB
 * work) has two tabs on the same campaign character: the first holds the
 * editing lock (owner), the second does not ("other-tab"). The GM renames the
 * character over the API. The non-owner tab becomes visible and shows the new
 * name while the owner tab has not refreshed and still shows, and has saved,
 * the old one. The owner tab then edits: its enqueue writes a queue entry to
 * the store without a new saved copy and broadcasts `invalidate`. The
 * non-owner tab adopts that store record but keeps the newer view (gap 1).
 * It never shows the older name again: not after the owner's enqueue, not
 * after the owner's conflict save, reapply and visibility refresh, and not
 * after its own later refresh. It stays read-only with the other-tab reason
 * and sends no character command.
 *
 * Determinism. Refreshes run only on the triggers the journey drives: a
 * `visibilitychange` event dispatched on one tab's `document` (as in S5), the
 * owner's commands and conflict fetch. A saved sheet has no timer refresh, and
 * Playwright keeps both pages visible, so the owner tab does not refresh
 * between the GM's rename and its own edit; the journey checks that by
 * counting its character GETs. The owner's command request is held by a
 * route until the non-owner tab has shown "Changes pending", the visible sign
 * that it has reread the store after the `invalidate` broadcast, so the
 * broadcast is processed before any later save. A MutationObserver in the
 * non-owner tab records whether the older name is ever rendered after the
 * GM's name was shown, so a brief flip between checks is caught too.
 */
test("a tab without the editing lock keeps the GM's newer name when the owner tab edits", async ({ browser, page: gm, baseURL }) => {
  test.setTimeout(180_000);
  if (!baseURL) throw new Error("Browser base URL required");
  const stamp = key().slice(0, 8);
  await signIn(gm, "code-journey-gm");
  const player = await browser.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL } });
  const created: Created = {};
  try {
    const playerHome = await player.newPage();
    const playerId = await signIn(playerHome, "code-journey-p1");
    const original = `V4 Ranger ${stamp}`;
    const { characterId, characterPath, read, rename } = await createCampaignCharacter(
      gm.request, playerHome.request, playerId, `V4 two tabs ${stamp}`, original, created);
    const isCharacterGet = (request: Request) => request.method() === "GET" && new URL(request.url()).pathname === characterPath;

    // 1. The owner tab opens first, takes the editing lock and saves its copy.
    const owner = await player.newPage();
    watchSheetWrites(owner);
    let ownerGets = 0;
    owner.on("request", (request) => { if (isCharacterGet(request)) ownerGets += 1; });
    await owner.goto(`/characters/${characterId}`);
    await expect(heading(owner, original)).toBeVisible({ timeout: 30_000 });
    await expectSheetSaved(owner);
    await expect(owner.getByText(OTHER_TAB, { exact: true })).toHaveCount(0);
    await expect(owner.getByRole("button", { name: "Decrease Health" })).toBeEnabled();

    // 2. The second tab opens without the lock. It records any character
    // command it sends.
    const reader = await player.newPage();
    const commands: string[] = [];
    reader.on("request", (request) => {
      const url = new URL(request.url());
      if (request.method() !== "GET" && request.method() !== "HEAD" && url.pathname.startsWith("/api/characters")) {
        commands.push(`${request.method()} ${url.pathname}`);
      }
    });
    await reader.goto(`/characters/${characterId}`);
    await expect(heading(reader, original)).toBeVisible({ timeout: 30_000 });
    await expect(reader.getByText(OTHER_TAB, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(reader.getByText("Saved", { exact: true })).toBeVisible();
    await expect(reader.getByRole("button", { name: "Decrease Health" })).toBeDisabled();
    for (const tab of [owner, reader]) expect(await tab.evaluate(() => document.visibilityState)).toBe("visible");

    // 3. The GM renames the character. The reader becomes visible and shows
    // the new name; the owner tab has not refreshed and shows the old one.
    const renamed = `V4 Ranger renamed by the GM ${stamp}`;
    const ownerGetsBeforeRename = ownerGets;
    await rename(renamed);
    const gmRevision = (await read()).revision as number;
    await reader.waitForTimeout(1_000);
    await expect(heading(reader, original)).toBeVisible();
    const readerRefresh = reader.waitForResponse(r => isCharacterGet(r.request()));
    await reader.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    expect((await readerRefresh).status()).toBe(200);
    await expect(heading(reader, renamed)).toBeVisible({ timeout: 10_000 });
    await expect(heading(reader, original)).toHaveCount(0);
    await reader.evaluate((older) => {
      const flags = window as unknown as { __olderNameShown?: boolean };
      flags.__olderNameShown = false;
      const check = () => { if (document.body.textContent?.includes(older)) flags.__olderNameShown = true; };
      new MutationObserver(check).observe(document.body, { subtree: true, childList: true, characterData: true });
      check();
    }, original);
    const olderNameShown = () => reader.evaluate(() => (window as unknown as { __olderNameShown?: boolean }).__olderNameShown);
    expect(await olderNameShown()).toBe(false);
    await expect(heading(owner, original)).toBeVisible();
    expect(ownerGets, "owner tab character GETs after the GM's rename").toBe(ownerGetsBeforeRename);

    // 4. The owner tab edits. Its command is held until the reader has
    // reread the store after the `invalidate` broadcast.
    let releaseCommand!: () => void;
    const commandGate = new Promise<void>(resolve => { releaseCommand = resolve; });
    let commandHeld!: (request: Request) => void;
    const ownerCommand = new Promise<Request>(resolve => { commandHeld = resolve; });
    const ownerCommands = (url: URL) => url.pathname.startsWith(characterPath);
    await owner.route(ownerCommands, async (route) => {
      if (route.request().method() === "GET") { await route.continue(); return; }
      commandHeld(route.request());
      await commandGate;
      await route.continue();
    });
    expect(ownerGets, "owner tab character GETs before its edit").toBe(ownerGetsBeforeRename);
    await owner.getByRole("button", { name: "Decrease Health" }).click();
    const held = await ownerCommand;
    expect(held.method()).not.toBe("GET");
    await expect(reader.getByText("Changes pending", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(heading(reader, renamed)).toBeVisible();
    await expect(heading(reader, original)).toHaveCount(0);
    await expect(reader.getByText(OTHER_TAB, { exact: true })).toBeVisible();
    await expect(reader.getByRole("button", { name: "Decrease Health" })).toBeDisabled();
    expect(await olderNameShown(), "older name rendered after the owner's enqueue").toBe(false);
    await expect(heading(owner, original)).toBeVisible();

    // 5. The command goes out with the old revision and conflicts. The owner
    // tab fetches and saves the GM's version and asks for review.
    releaseCommand();
    const conflict = await owner.waitForResponse(r => r.request() === held);
    expect(conflict.status()).toBe(409);
    await owner.unroute(ownerCommands);
    await expect(owner.getByRole("heading", { name: "Review conflicts" })).toBeVisible({ timeout: 30_000 });
    await expect(heading(owner, renamed)).toBeVisible({ timeout: 10_000 });
    await expect(heading(reader, renamed)).toBeVisible();
    expect(await olderNameShown(), "older name rendered after the owner's conflict save").toBe(false);

    // 6. The owner reapplies its edit and syncs.
    const review = owner.locator("section", { has: owner.getByRole("heading", { name: "Review conflicts" }) }).last();
    for (const checkbox of await review.getByRole("checkbox").all()) await checkbox.check();
    await owner.getByRole("button", { name: "Reapply", exact: true }).click();
    await owner.getByRole("button", { name: "Confirm reapply" }).click();
    await expectSheetSaved(owner);
    await expect(owner.getByRole("heading", { name: "Review conflicts" })).toHaveCount(0);
    const ownerRefresh = owner.waitForResponse(r => isCharacterGet(r.request()));
    await owner.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    expect((await ownerRefresh).status()).toBe(200);
    await expectSheetSaved(owner);
    await expect(heading(owner, renamed)).toBeVisible();
    const final = await read();
    expect(final.name).toBe(renamed);
    expect(final.revision).toBe(gmRevision + 1);

    // 7. The reader follows the owner's saves and its own refresh, and never
    // showed the older name.
    await expect(reader.getByText("Saved", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(heading(reader, renamed)).toBeVisible();
    const readerLater = reader.waitForResponse(r => isCharacterGet(r.request()));
    await reader.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    expect((await readerLater).status()).toBe(200);
    await reader.waitForTimeout(500);
    await expect(heading(reader, renamed)).toBeVisible();
    await expect(heading(reader, original)).toHaveCount(0);
    await expect(reader.getByText(OTHER_TAB, { exact: true })).toBeVisible();
    await expect(reader.getByRole("button", { name: "Decrease Health" })).toBeDisabled();
    expect(await olderNameShown(), "older name rendered in the tab without the lock").toBe(false);
    expect(commands, "character commands sent from the tab without the lock").toEqual([]);
  } finally {
    await player.close();
    await archiveCreated(gm.request, created);
  }
});
