import { test, expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { uid } from "../offline/test-auth.js";
import { JOURNEY_CODES, JOURNEY_ACTION_LABELS, publishJourneySystem } from "./tableJourneySystem.js";

const D20_VERSION_ID = "a0000000-0000-5000-8000-000000000002";
const STEP_TIMEOUT = 15_000;
let journeyVersionId = "";
const characterIds: Record<string, string> = {};

async function signInAs(request: APIRequestContext, code: string): Promise<string> {
  const response = await request.post("/dev/signin", { data: { code, redirectUri: "http://localhost/cb" } });
  if (response.status() !== 200) throw new Error(`seed sign-in (${code}) failed: ${response.status()} ${await response.text()}`);
  return ((await response.json()) as { userId: string }).userId;
}

async function signInViaPanel(page: Page, code: string) {
  await page.goto("/");
  await page.getByTestId("dev-signin-code").fill(code);
  await page.getByTestId("dev-signin").click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: STEP_TIMEOUT });
}

test("table journey 1/4: publish D&D-like system, Creator round-trip", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const stamp = uid();
  // Navigate first: a fresh page is about:blank whose origin is "null",
  // which would make the context baseURL invalid (campaignJourney.spec.ts:83-85).
  await page.goto("/");
  const gmContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const gmUserId = await signInAs(gmContext.request, JOURNEY_CODES.gm);
    expect(gmUserId).toMatch(/.+/);
    journeyVersionId = await publishJourneySystem(gmContext.request, D20_VERSION_ID);
    expect(journeyVersionId).toMatch(/[0-9a-f-]{36}/);
    // UI round-trip on the non-trivial system: GM opens it in the Creator,
    // edits the description, saves, and sees the preview reflect the system.
    await signInViaPanel(page, JOURNEY_CODES.gm);
    // NOTE (brief adjustment): the system library is the index route "/"
    // (web/src/router.tsx:106-109); "/systems" is only the editor route
    // "/systems/$systemId" (router.tsx:111), so there is no "/systems" page.
    await page.goto("/"); // library lists the GM-owned system; open it
    await page.getByRole("link", { name: /Journey/ }).first().click({ timeout: STEP_TIMEOUT });
    await expect(page.getByTestId("document-editor-header")).toBeVisible({ timeout: STEP_TIMEOUT });
    await page.getByTestId("metadata-description").fill(`Table journey system ${stamp}.`);
    // NOTE (brief adjustment): the published system shows lifecycle "Active",
    // not "Saved|Draft" (DocumentEditor.tsx:386-390 renders
    // editor.lifecycle.<system.lifecycle>; "Active" per messages.ts:80).
    // The save signal is the autosave span ("Saved" per
    // DocumentEditor.test.tsx:413). MetadataEditor buffers until blur
    // (creatorToCharacter.spec.ts:82-89), so Tab out before waiting.
    await expect(page.getByTestId("document-editor-lifecycle")).toHaveText(/Active/, { timeout: STEP_TIMEOUT });
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("document-editor-autosave")).toHaveText(/Saved/, { timeout: 30_000 });
    await page.getByTestId("document-editor-preview-toggle").click();
    await expect(page.getByText("Longsword Attack")).toBeVisible({ timeout: STEP_TIMEOUT });
  } finally {
    await gmContext.close();
  }
});

test("table journey 2/4: five players create characters", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const stamp = uid();
  // Same as test 1: navigate before deriving the origin (about:blank has none).
  await page.goto("/");
  const origin = new URL(page.url()).origin;
  const names = ["Aldric", "Bryn", "Cora", "Dain", "Elswyth"];
  // Players 1-2: real picker UI (versionless entry exercises OD-01 discovery
  // of the GM-owned published system — reference seeds stay unlisted).
  for (const [index, code] of [JOURNEY_CODES.players[0], JOURNEY_CODES.players[1]].entries()) {
    const ctx = await browser.newContext({ baseURL: origin });
    try {
      // NOTE (brief adjustment): no API sign-in here — it would session-bind
      // the context first, and the dev panel form only renders while signed
      // out, so signInViaPanel's fill would wait forever. Panel sign-in alone
      // establishes the session (campaignJourney.spec.ts:145 pattern: one
      // sign-in path per context).
      const p = await ctx.newPage();
      await signInViaPanel(p, code);
      await p.goto("/characters/new");
      await p.getByRole("button", { name: /Journey/ }).first().click({ timeout: STEP_TIMEOUT });
      await p.getByRole("textbox", { name: /character name/i }).fill(`${names[index]} ${stamp}`);
      // NOTE (brief adjustment): creation requires an entity choice
      // (CreateCharacter.tsx:703-710 `canCreate` needs entityId; native
      // Select labeled character.create.entity="Entity", messages.ts:460).
      await p.getByLabel("Entity", { exact: true }).selectOption("character");
      await p.getByRole("button", { name: /create/i }).click({ timeout: STEP_TIMEOUT });
      await expect(p.getByRole("heading", { name: `${names[index]} ${stamp}` })).toBeVisible({ timeout: 30_000 });
      const match = /\/characters\/([0-9a-f-]{36})/.exec(p.url());
      if (!match?.[1]) throw new Error("creation did not land on a character route");
      characterIds[code] = match[1];
      await p.close();
    } finally {
      await ctx.close();
    }
  }
  // Players 3-5: same server path through the API (bulk; UI path proven above).
  for (const [offset, code] of [JOURNEY_CODES.players[2], JOURNEY_CODES.players[3], JOURNEY_CODES.players[4]].entries()) {
    const ctx = await browser.newContext({ baseURL: origin });
    try {
      await signInAs(ctx.request, code);
      const res = await ctx.request.post("/api/characters", {
        data: { systemVersionId: journeyVersionId, entityDefinitionId: "character", name: `${names[offset + 2]} ${stamp}`, idempotencyKey: `journey-char-${stamp}-${offset}` },
      });
      if (res.status() !== 201) throw new Error(`create failed: ${res.status()} ${await res.text()}`);
      characterIds[code] = ((await res.json()) as { character: { characterId: string } }).character.characterId;
    } finally {
      await ctx.close();
    }
  }
  expect(Object.keys(characterIds)).toHaveLength(5);
});

test("table journey 3/4: campaign world — locations, NPCs, invitations", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const stamp = uid();
  // NOTE (brief adjustment): navigate before deriving the origin — a fresh
  // page is about:blank whose origin is "null" (same as tests 1-2 above,
  // campaignJourney.spec.ts:83-85).
  await page.goto("/");
  const origin = new URL(page.url()).origin;
  const gmContext = await browser.newContext({ baseURL: origin });
  try {
    await signInAs(gmContext.request, JOURNEY_CODES.gm);
    const post = async (path: string, data: unknown, ok: number[]) => {
      const res = await gmContext.request.post(path, { data });
      if (!ok.includes(res.status())) throw new Error(`POST ${path} failed: ${res.status()} ${await res.text()}`);
      return (await res.json()) as Record<string, any>;
    };
    const created = await post("/api/campaigns", {
      systemVersionId: journeyVersionId, title: `Journey Campaign ${stamp}`,
      description: "Table journey fixture", idempotencyKey: `journey-camp-${stamp}`,
    }, [200, 201]);
    const campaignId: string = created.campaign.campaignId;
    (globalThis as any).__journeyCampaignId = campaignId;
    const locations = ["Village Green", "Old Mill", "Sunken Chapel", "Bandit Camp", "Riverside Dock", "Hilltop Beacon"];
    for (const [i, title] of locations.entries()) {
      await post(`/api/campaigns/${campaignId}/content`, {
        title: `${title} ${stamp}`, body: `What the party can see at ${title.toLowerCase()} ${stamp}.`,
        audience: "all_players", idempotencyKey: `journey-loc-${stamp}-${i}`,
      }, [200, 201]);
    }
    // GM-only note: audience enum value read from src/campaigns/policy.ts:108
    // (case "gm_only"; ContentAudience in src/campaigns/persistence.ts:34;
    // used as "gm_only" in campaignVisibility.spec.ts:132).
    await post(`/api/campaigns/${campaignId}/content`, {
      title: `Secret Ledger ${stamp}`, body: `GM eyes only ${stamp}.`,
      audience: "gm_only", idempotencyKey: `journey-secret-${stamp}`,
    }, [200, 201]);
    let revision = (await gmContext.request.get(`/api/campaigns/${campaignId}`).then(async r => ((await r.json()) as any).campaign.revision)) as number;
    const npcs = ["Innkeeper", "Blacksmith", "Scout", "Priest", "Bandit Chief", "Bandit Archer", "Bandit Brute", "Ferryman", "Herbalist", "Guard Captain"];
    for (const [i, name] of npcs.entries()) {
      await post(`/api/campaigns/${campaignId}/characters`, {
        name: `${name} ${stamp}`, entityDefinitionId: "character",
        expectedCampaignRevision: revision, idempotencyKey: `journey-npc-${stamp}-${i}`,
      }, [200, 201]);
      revision = (await gmContext.request.get(`/api/campaigns/${campaignId}`).then(async r => ((await r.json()) as any).campaign.revision)) as number;
    }
    const tokens: string[] = [];
    for (let i = 0; i < 5; i++) {
      const issued = await post(`/api/campaigns/${campaignId}/invitations`, {
        intendedRole: "player", expectedCampaignRevision: revision, idempotencyKey: `journey-inv-${stamp}-${i}`,
      }, [200, 201]);
      tokens.push(issued.invitation.token as string);
      revision = (await gmContext.request.get(`/api/campaigns/${campaignId}`).then(async r => ((await r.json()) as any).campaign.revision)) as number;
    }
    (globalThis as any).__journeyTokens = tokens;
    expect(tokens).toHaveLength(5);
  } finally {
    await gmContext.close();
  }
});

test("table journey 4/4: join and session", async ({ page, browser }) => {
  test.setTimeout(600_000);
  const campaignId: string = (globalThis as any).__journeyCampaignId;
  const tokens: string[] = (globalThis as any).__journeyTokens;
  // NOTE (brief adjustment): navigate before deriving the origin — a fresh
  // page is about:blank whose origin is "null" (same as tests 1-3 above,
  // campaignJourney.spec.ts:83-85).
  await page.goto("/");
  const origin = new URL(page.url()).origin;
  // Join: every player accepts through the real invitation UI (token never echoed).
  for (const [i, code] of JOURNEY_CODES.players.entries()) {
    const ctx = await browser.newContext({ baseURL: origin });
    try {
      const p = await ctx.newPage();
      await signInViaPanel(p, code);
      await p.goto(`/invitations?token=${encodeURIComponent(tokens[i] as string)}`);
      await expect(p.getByText(tokens[i] as string)).toHaveCount(0);
      await p.getByRole("button", { name: "Accept", exact: true }).click({ timeout: STEP_TIMEOUT });
      await expect(p.getByText(/Welcome to/)).toBeVisible({ timeout: STEP_TIMEOUT });
      // Campaign visible in list; permitted locations readable; secret absent.
      await p.goto("/campaigns");
      await p.getByRole("link", { name: /Journey Campaign/ }).click({ timeout: STEP_TIMEOUT });
      await expect(p).toHaveURL(`/campaigns/${campaignId}`);
      await p.getByRole("tab", { name: "Content" }).click({ timeout: STEP_TIMEOUT });
      await expect(p.getByText("Village Green", { exact: false })).toBeVisible({ timeout: STEP_TIMEOUT });
      await expect(p.getByText(/Secret Ledger/)).toHaveCount(0);
      await p.close();
    } finally {
      await ctx.close();
    }
  }
  // Session, part 1: each player opens their own sheet (phone viewport) and
  // rolls Longsword Attack; the result renders on the sheet. The roll stays
  // owner_only by server design (standalone actions accept only owner_only —
  // src/characters/index.ts:1322-1335), so campaign visibility below is
  // carried by the GM's campaign-audience board roll. The Damage Enemy /
  // Second Wind sheet buttons are never touched: harm/recovery targets the
  // character entity's hit_points off-sheet by design (Ruling 3).
  for (const code of JOURNEY_CODES.players) {
    const ctx = await browser.newContext({ baseURL: origin });
    try {
      const p = await ctx.newPage();
      await p.setViewportSize({ width: 360, height: 640 });
      await signInViaPanel(p, code);
      await p.goto(`/characters/${characterIds[code]}`);
      await p.getByRole("button", { name: JOURNEY_ACTION_LABELS.longsword, exact: true }).click({ timeout: STEP_TIMEOUT });
      // Roll-result vocabulary from CharacterSheet.tsx:119-121 ("Roll
      // result" heading per messages.ts:520; output template per
      // tableJourneySystem.ts:220).
      await expect(p.getByRole("heading", { name: "Roll result" })).toBeVisible({ timeout: STEP_TIMEOUT });
      await expect(p.getByText(/The longsword strike totals/)).toBeVisible({ timeout: STEP_TIMEOUT });
      await p.close();
    } finally {
      await ctx.close();
    }
  }
  // Session, part 2: GM (phone viewport) bumps an NPC and rolls from the
  // session board (board vocabulary verbatim from gmSessionJourney.spec.ts
  // steps 9-12: "Open {name}" directory rows, "Decrease {label}" bumps,
  // "Roll {label}" executes with the default campaign audience).
  await page.setViewportSize({ width: 360, height: 640 });
  await signInViaPanel(page, JOURNEY_CODES.gm);
  await page.goto(`/campaigns/${campaignId}`);
  await page.getByRole("tab", { name: "Session" }).click({ timeout: STEP_TIMEOUT });
  await expect(page.getByRole("heading", { name: "Session", exact: true })).toBeVisible({ timeout: STEP_TIMEOUT });
  await expect(page.getByRole("heading", { name: "Characters" })).toBeVisible({ timeout: STEP_TIMEOUT });
  // NPC names carry test 3's stamp, so expand the first directory row; its
  // Hit Points start at the 10/10 default (tableJourneySystem.ts:86-94).
  await page.getByRole("button", { name: /^Open / }).first().click({ timeout: STEP_TIMEOUT });
  await expect(page.getByRole("button", { name: "Decrease Hit Points" })).toBeVisible({ timeout: STEP_TIMEOUT });
  await expect(page.getByText("10 / 10")).toBeVisible({ timeout: STEP_TIMEOUT });
  await page.getByRole("button", { name: "Decrease Hit Points" }).click({ timeout: STEP_TIMEOUT });
  await expect(page.getByText("9 / 10")).toBeVisible({ timeout: STEP_TIMEOUT });
  const boardRoll = `Roll ${JOURNEY_ACTION_LABELS.longsword}`;
  await expect(page.getByRole("button", { name: boardRoll })).toBeVisible({ timeout: STEP_TIMEOUT });
  const rollRequest = page.waitForRequest(
    (request) => request.url().includes("/actions/longsword_attack") && request.method() === "POST",
    { timeout: STEP_TIMEOUT },
  );
  const rollResponse = page.waitForResponse(
    (response) => response.url().includes("/actions/longsword_attack") &&
      response.request().method() === "POST" && response.status() === 200,
    { timeout: STEP_TIMEOUT },
  );
  await page.getByRole("button", { name: boardRoll }).click({ timeout: STEP_TIMEOUT });
  expect((await rollRequest).postDataJSON()).toMatchObject({ audience: "campaign" });
  const rollBody = await (await rollResponse).json() as { result: { roll: { total: number } } };
  await expect(page.getByRole("button", { name: boardRoll }).locator("..").getByRole("status"))
    .toHaveText(String(rollBody.result.roll.total), { timeout: STEP_TIMEOUT });
  await expect(page.getByText("The roll may have applied.")).toHaveCount(0);
  // Session, part 3: each player sees the activity — seeding events plus the
  // GM's campaign-audience roll (Activity-tab assertions per
  // campaignJourney.spec.ts:203-206; "Roll executed" per messages.ts:831).
  for (const code of JOURNEY_CODES.players) {
    const ctx = await browser.newContext({ baseURL: origin });
    try {
      const p = await ctx.newPage();
      await p.setViewportSize({ width: 360, height: 640 });
      await signInViaPanel(p, code);
      await p.goto(`/campaigns/${campaignId}`);
      await p.getByRole("tab", { name: "Activity" }).click({ timeout: STEP_TIMEOUT });
      // NOTE (brief adjustment): six location notes each render a "Content
      // created" line, so the bare campaignJourney.spec.ts:206 assertion
      // violates strict mode here — assert the first line instead.
      await expect(p.getByText("Content created").first()).toBeVisible({ timeout: STEP_TIMEOUT });
      await expect(p.getByText("Roll executed")).toBeVisible({ timeout: STEP_TIMEOUT });
      await p.close();
    } finally {
      await ctx.close();
    }
  }
});
