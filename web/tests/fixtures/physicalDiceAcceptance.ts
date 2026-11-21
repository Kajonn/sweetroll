import { expect, type Browser, type Page } from "@playwright/test";
import type { RollFinished, RollStarted } from "../../../src/campaigns/physical-dice-stream.js";
import { readPhysicalFace, type PhysicalDieSides } from "../../../src/systems/physical-dice/faces.js";
import type { CommandResultResponse } from "../../src/characters/types.js";
import { cleanup, json, key, publish, pushDocument, signIn, workspace } from "./configurablePush.js";

const shapes = [4, 6, 8, 10, 12, 20] as const;
const actions = [
  ...shapes.map((sides) => ({ id: `d${sides}`, label: `Throw d${sides}`, source: `1d${sides}`, count: 1 })),
  { id: "mixed", label: "Throw mixed dice", source: "1d4 + 1d6 + 1d8 + 1d10 + 1d12 + 1d20 + 2", count: 6 },
  { id: "large", label: "Throw 20 dice", source: "20d6", count: 20 },
];
type Event = { type: "roll.started"; data: RollStarted } | { type: "roll.finished"; data: RollFinished };
declare global {
  interface Window {
    physicalDiceAcceptance?: Event[];
  }
}

function testRules() {
  const document = pushDocument();
  document.metadata.name = `Physical dice acceptance ${key()}`;
  const section = document.sheets[0]!.sections.at(-1)!;
  for (const action of actions) {
    document.expressions.push({
      id: `throw_${action.id}_expr`,
      context: "roll",
      resultType: "number",
      source: action.source,
      fallback: 0,
    });
    const id = `throw_${action.id}`;
    document.actions.push({
      kind: "roll",
      id,
      label: action.label,
      expressionId: `throw_${action.id}_expr`,
      inputs: [],
      outputTemplate: "Total: {total}",
    });
    section.elements.push({ kind: "action", id: `${id}_element`, actionId: id });
  }
  return document;
}

async function observeStream(page: Page) {
  await page.addInitScript(() => {
    const events: Event[] = [];
    window.physicalDiceAcceptance = events;
    const Source = window.EventSource;
    window.EventSource = class extends Source {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        if (!String(url).endsWith("/physical-rolls/events")) return;
        this.addEventListener("roll.started", (e: MessageEvent<string>) =>
          events.push({ type: "roll.started", data: JSON.parse(e.data) }),
        );
        this.addEventListener("roll.finished", (e: MessageEvent<string>) =>
          events.push({ type: "roll.finished", data: JSON.parse(e.data) }),
        );
      }
    };
  });
}

const streamEvents = (page: Page, id: string) =>
  page.evaluate(
    (id) => (window.physicalDiceAcceptance ?? []).filter((event) => event.data.attemptId === id),
    id,
  );
const canvas = (page: Page) => page.locator('[data-testid="physical-dice-canvas"][data-dice-ready="true"]');

async function rolled(page: Page, click: () => Promise<void>) {
  const prepare = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/physical-rolls"),
  );
  const completion = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().endsWith("/complete") &&
      r.url().includes("/physical-rolls/"),
  );
  const result = Promise.all([
    prepare.then((r) => r.json()),
    completion.then(async (r) => {
      const body = await r.json();
      expect(r.status(), JSON.stringify(body)).toBe(200);
      return body as CommandResultResponse;
    }),
  ]);
  // Stop waiting at the first rejected preparation response.
  void result.catch(() => {});
  await click();
  const { attempt } = await (await prepare).json();
  expect(attempt).toBeTruthy();
  return { id: attempt.attemptId as string, total: result.then(([, body]) => body.result) };
}

async function checkThrow(viewer: Page, id: string, result: CommandResultResponse["result"], count: number) {
  await expect.poll(() => streamEvents(viewer, id), { timeout: 10000 }).toHaveLength(2);
  const [start, finish] = await streamEvents(viewer, id);
  if (start?.type !== "roll.started" || finish?.type !== "roll.finished" || !result.roll)
    throw Error("Missing physical roll events");
  expect(start.data.dice).toHaveLength(count);
  expect(finish.data.rollId).toBe(result.rollId);
  expect(finish.data.dice.map((physical) => physical.value)).toEqual(
    start.data.dice.map((die, index) =>
      readPhysicalFace(die.sides as PhysicalDieSides, finish.data.dice[index]!.orientation),
    ),
  );
  expect(
    finish.data.dice.every((die) =>
      result.roll!.dice.some((saved) => saved.id === die.id && saved.value === die.value),
    ),
  ).toBe(true);
  return start.data;
}

async function setDicePreferences(page: Page, show: boolean, color: string) {
  await page.goto("/account");
  const checkbox = page.getByRole("checkbox", { name: "Show 3D dice" });
  await expect(checkbox).toBeEnabled();
  if ((await checkbox.isChecked()) !== show) {
    const saved = page.waitForResponse(
      (r) => r.request().method() === "PATCH" && r.url().endsWith("/me/preferences") && r.ok(),
    );
    await checkbox.setChecked(show);
    expect((await (await saved).json()).show_3d_dice).toBe(show);
  }
  const input = page.getByLabel("My dice color");
  if ((await input.inputValue()) !== color) {
    const saved = page.waitForResponse(
      (r) => r.request().method() === "PATCH" && r.url().endsWith("/me/preferences") && r.ok(),
    );
    await input.fill(color);
    await page.getByRole("button", { name: "Save dice color" }).click();
    expect((await (await saved).json()).dice_color).toBe(color);
  }
}

export async function physicalDiceAcceptance(gm: Page, browser: Browser, baseURL: string) {
  expect((await json(gm.request, "GET", "/health/ready")).status).toBe("ok");
  await signIn(gm, "code-journey-gm");
  expect((await json(gm.request, "GET", "/api/me")).physicalDiceEnabled).toBe(true);
  const contexts = await Promise.all([
    browser.newContext({
      baseURL,
      viewport: { width: 360, height: 720 },
      extraHTTPHeaders: { Origin: baseURL },
    }),
    browser.newContext({
      baseURL,
      viewport: { width: 1024, height: 768 },
      extraHTTPHeaders: { Origin: baseURL },
    }),
  ]);
  const characterIds: string[] = [];
  const restore: { page: Page; show_3d_dice: boolean; dice_color: string }[] = [];
  let systemId: string | undefined;
  let campaignId: string | undefined;
  try {
    const roller = await contexts[0]!.newPage();
    const other = await contexts[1]!.newPage();
    const rollerId = await signIn(roller, "code-journey-p1");
    const otherId = await signIn(other, "code-journey-p2");
    const rules = testRules();
    const system = await workspace(gm.request, rules);
    systemId = system.id;
    const version = await publish(gm.request, system.id);
    const { campaign } = await json(gm.request, "POST", "/api/campaigns", {
      systemVersionId: version,
      title: rules.metadata.name,
      idempotencyKey: key(),
    });
    campaignId = campaign.campaignId;
    const path = `/api/campaigns/${campaignId}`;
    const revision = async () => (await json(gm.request, "GET", path)).campaign.revision;
    for (const [member, actorId, name] of [
      [roller, rollerId, "Dice roller"],
      [other, otherId, "Second roller"],
    ] as const) {
      const { invitation } = await json(gm.request, "POST", `${path}/invitations`, {
        intendedRole: "player",
        expectedCampaignRevision: await revision(),
        idempotencyKey: key(),
      });
      const { review } = await json(member.request, "POST", "/api/invitations/review", {
        token: invitation.token,
      });
      await json(member.request, "POST", "/api/invitations/accept", {
        campaignId,
        token: invitation.token,
        expectedInvitationRevision: review.invitationRevision,
        reviewedAccessRevision: review.accessRevision,
        idempotencyKey: key(),
      });
      const { character } = await json(gm.request, "POST", `${path}/characters`, {
        name,
        entityDefinitionId: "character",
        controllerUserIds: [actorId],
        expectedCampaignRevision: await revision(),
        idempotencyKey: key(),
      });
      characterIds.push(character.characterId);
    }
    for (const page of [roller, other, gm])
      restore.push({ page, ...(await json(page.request, "GET", "/api/me/preferences")) });
    await setDicePreferences(roller, false, "#ce5482");
    await setDicePreferences(other, true, "#399c84");
    await setDicePreferences(gm, true, "#4c79c9");
    await Promise.all([observeStream(gm), observeStream(other)]);
    const openViewer = async (page: Page) => {
      const stream = page.waitForResponse((r) => r.ok() && r.url().endsWith("/physical-rolls/events"));
      const feed = page.waitForResponse((r) => r.ok() && new URL(r.url()).pathname === `${path}/activity`);
      await page.goto(`/campaigns/${campaignId}`);
      await Promise.all([stream, feed]);
    };
    await Promise.all([openViewer(gm), openViewer(other)]);
    await roller.goto(`/characters/${characterIds[0]}`);

    const records: {
      action: string;
      rollId: string | null | undefined;
      total: number | null;
      dice: number[];
    }[] = [];
    const record = (action: string, result: CommandResultResponse["result"]) =>
      records.push({
        action,
        rollId: result.rollId,
        total: result.roll?.total ?? null,
        dice: result.roll?.dice.map((die) => die.value) ?? [],
      });
    for (const action of actions) {
      const thrower = await rolled(roller, () =>
        roller.getByRole("button", { name: action.label, exact: true }).click(),
      );
      if (action.id === "d4" || action.id === "large")
        await expect(canvas(other)).toBeVisible({ timeout: 12000 });
      if (action.id === "large") {
        await other.setViewportSize({ width: 720, height: 360 });
        await expect(canvas(other)).toBeVisible();
        expect(await canvas(other).boundingBox()).toMatchObject({ width: 720, height: 360 });
      }
      const result = await thrower.total;
      const starts = await Promise.all([
        checkThrow(gm, thrower.id, result, action.count),
        checkThrow(other, thrower.id, result, action.count),
      ]);
      expect(starts[0].color).toBe("#ce5482");
      expect(starts[0].launch).toEqual(starts[1].launch);
      expect(result.roll?.total).toBe(
        result.roll!.dice.reduce((total, die) => total + die.value, action.id === "mixed" ? 2 : 0),
      );
      const history = (
        await json(roller.request, "GET", `/api/characters/${characterIds[0]}/rolls/${result.rollId}`)
      ).roll;
      expect(history.dice).toEqual(result.roll!.dice);
      expect(history.total).toBe(result.roll!.total);
      record(action.id, result);
    }
    await expect(canvas(roller)).toHaveCount(0);

    const pool = await rolled(roller, () =>
      roller.getByRole("button", { name: "Test Pool", exact: true }).click(),
    );
    const root = await pool.total;
    const push = await rolled(roller, () =>
      roller.getByRole("button", { name: "Push saved roll", exact: true }).click(),
    );
    const child = await push.total;
    const rerolled = child.roll!.push!.rerolledDiceIds;
    expect(child.roll!.push!.parentRollId).toBe(root.rollId);
    expect(rerolled.length).toBeGreaterThan(0);
    const pushStart = await checkThrow(gm, push.id, child, rerolled.length);
    expect(pushStart.dice.map((die) => die.id)).toEqual(rerolled);
    expect(child.roll!.dice.filter((d) => !rerolled.includes(d.id!))).toEqual(
      root.roll!.dice.filter((d) => !rerolled.includes(d.id!)),
    );
    record("push", child);

    await gm.getByRole("tab", { name: "Session", exact: true }).click();
    await gm.getByRole("button", { name: "Open Dice roller", exact: true }).click();
    const privateButton = gm.getByRole("button", { name: "Roll Throw d6", exact: true });
    const audience = privateButton.locator("..").getByLabel("Roll audience");
    await audience.selectOption("owner_only");
    const privateThrow = await rolled(gm, () => privateButton.click());
    const secret = await privateThrow.total;
    expect(secret.roll?.audience).toBe("owner_only");
    await other.waitForResponse((r) => r.ok() && new URL(r.url()).pathname === `${path}/activity`);
    expect(await streamEvents(other, privateThrow.id)).toEqual([]);
    for (const viewer of [roller, other]) {
      const lookup = await viewer.request.get(`/api/characters/${characterIds[0]}/rolls/${secret.rollId}`);
      expect(lookup.status()).toBe(404);
    }

    await other.goto(`/characters/${characterIds[1]}`);
    const [one, two] = await Promise.all([
      rolled(roller, () => roller.getByRole("button", { name: "Throw mixed dice", exact: true }).click()),
      rolled(other, () => other.getByRole("button", { name: "Throw mixed dice", exact: true }).click()),
    ]);
    expect(one.id).not.toBe(two.id);
    const [first, second] = await Promise.all([one.total, two.total]);
    await Promise.all([checkThrow(gm, one.id, first, 6), checkThrow(gm, two.id, second, 6)]);

    await openViewer(other);
    await contexts[1]!.setOffline(true);
    const disconnected = await rolled(roller, () =>
      roller.getByRole("button", { name: "Throw 20 dice", exact: true }).click(),
    );
    await contexts[1]!.setOffline(false);
    // The existing EventSource connection must recover a pending throw or
    // receive its committed settlement when it reconnects.
    const after = await disconnected.total;
    await expect
      .poll(
        async () =>
          (await streamEvents(other, disconnected.id)).some(
            (event) => event.type === "roll.finished" && event.data.rollId === after.rollId,
          ),
        { timeout: 12000 },
      )
      .toBe(true);
    record("reconnected", after);
    return { records, browser: browser.version(), campaignId };
  } finally {
    try {
      await contexts[1]!.setOffline(false);
      await Promise.all(
        restore.map(({ page, show_3d_dice, dice_color }) =>
          json(page.request, "PATCH", "/api/me/preferences", { show_3d_dice, dice_color }),
        ),
      );
      if (systemId && process.env.SWEETROLL_E2E_EPHEMERAL_DB !== "1")
        await cleanup(gm.request, systemId, [], campaignId);
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  }
}
