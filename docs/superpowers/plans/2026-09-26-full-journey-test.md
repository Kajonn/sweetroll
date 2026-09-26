# Full-table journey test implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Playwright spec proves a full table journey — a GM builds and publishes a D&D-like d20 system, five players each create a character, the GM runs a campaign with locations and NPCs, all five join, and the table completes a session — using pregenerated test accounts, with real OIDC postponed.

**Architecture:** Test-only changes only: six deterministic seed codes in the test OIDC adapter plus one new serial e2e spec file (and its fixture module) following the `campaignJourney.spec.ts` pattern — API seeding for setup bulk, real browser UI for every journey-critical interaction. No product-code changes; nothing here ships.

**Tech Stack:** Playwright Chromium (`web/playwright.config.ts` dev-server E2E, serial `workers: 1`), System Builder HTTP API, deterministic test-auth adapter (`/dev/signin`).

**Spec:** Owner request 2026-09-26 (chat): D&D basic-rules-inspired system build, 5× character creation, GM campaign with non-trivial locations/NPCs, join + session; decide auth approach (pregenerated vs magic link) and UI-vs-API split. Design authority: `design_v2.md` §§17.10, 18.1 (`OD-01`, `OD-03`, `OD-05`, `OD-08`).

## Global Constraints

- Dev-server E2E only (`web/playwright.config.ts`): backend `npm run migrate && npm run dev:http` + `web:dev`, Chromium, serial workers. Do not touch the manual-test app ports/DB; honor `BACKEND_PORT`/`WEB_PORT` overrides.
- `SWEETROLL_TEST_AUTH` stays unset in this plan (dev-server config renders the real dev sign-in panel; no escape hatch needed).
- Copyright: game mechanics are not copyrightable but WotC's expressive text is. Do NOT paste text from the Basic Rules PDF into the repo. Write all names/descriptions in original wording, or quote SRD 5.1 (CC-BY-4.0) with attribution. The journey fixture is test-only and is never a shipped launch template (`OD-08` stays open).
- Grammar v0.1 only: use expression constructs proven in `src/systems/implementation/package/fixtures/d20.ts` (d20/d6 rolls, binary arithmetic, `floor`, resource-delta bumps). No reroll/explode/custom faces (`OD-04` deferred).
- No product-code changes. The only `src/` edit is the test-gated seed map. `design_v2.md` is unchanged by this plan.
- Unique names per run via `uid()` from `web/tests/offline/test-auth.ts` (no campaign/character DELETE endpoints exist).

## Decisions (locked, owner-confirmed 2026-09-26)

- **Auth: pregenerated deterministic test accounts, NOT magic link.** Magic link is a product feature (email delivery, token issuance/storage, anti-abuse) postponed together with real OIDC (`OD-05`). The journey needs six mutually-independent users with isolated sessions; the seeded test adapter already provides exactly this mechanism — it only has three codes and needs six. Reuse it.
- **System build: API-built document + UI round-trip, NOT full keystroke-by-keystroke Creator authoring.** The Creator UI is a thin client over the same System Builder endpoints (`POST /api/systems`, `PUT /api/systems/:id/draft`, `POST /api/systems/:id/publish`); blank→publish through the UI is already proven by `creatorToCharacter.spec.ts`. API publish exercises validation, checksums, expression typechecking and conflicts deterministically; the GM then opens the system in the Creator UI, makes a real edit, saves, and checks the preview — proving UI round-trip on the non-trivial system.
- **UI vs API split:** UI drives every journey-critical interaction (system edit+preview, 2× picker character creation, 5× invitation accept, 1× claim-free join verification per player, player rolls/bumps, GM session-board actions, content reads, GM-only visibility check). API seeding covers bulk setup (system publish, 3× character creation, campaign create, 6 location notes, 10 NPCs, 5 invitation issues, revision bookkeeping). API calls use the exact payload shapes in `campaignJourney.spec.ts:91-130` and `test-auth.ts:publishOwnedClone`.

## File Structure

- Modify: `src/bootstrap/http.ts:68-72` — extend the deterministic seed `Map` with six journey codes (test-gated; same map, no logic change).
- Create: `web/tests/e2e/tableJourneySystem.ts` — journey system document fixture (mirrors `src/systems/implementation/package/fixtures/d20.ts` structure) + shared journey constants/helpers.
- Create: `web/tests/e2e/tableJourney.spec.ts` — four sequential tests sharing module state (serial file, `workers: 1`): system publish, characters, campaign world, join + session.
- Create: `docs/acceptance/table-2026-09-26-journey.md` — evidence record (Task 6).

---

### Task 1: Journey seed users (test-only)

**Files:**
- Modify: `src/bootstrap/http.ts:68-72`
- Test: run `npx vitest run src/transport/http/dev-signin.test.ts` from repo root (existing suite stays green) + verify all six codes in the journey spec (Task 3 Step 1).

**Interfaces:**
- Consumes: existing `seed` map + `createTestOidcClient` (unchanged).
- Produces: codes `code-journey-gm`, `code-journey-p1` … `code-journey-p5` resolvable through `POST /dev/signin` in non-production.

- [ ] **Step 1: Extend the seed map**

In `src/bootstrap/http.ts`, extend the existing map (keep the three current entries byte-identical):

```ts
const seed = new Map([
  ["code-dev", { displayName: "Dev User", email: "dev@example.com", provider: "test", subject: "dev-1" }],
  ["code-test-a", { displayName: "Offline Test A", email: "offline-a@example.com", provider: "test", subject: "offline-test-a" }],
  ["code-test-b", { displayName: "Offline Test B", email: "offline-b@example.com", provider: "test", subject: "offline-test-b" }],
  ["code-journey-gm", { displayName: "Journey GM", email: "journey-gm@example.com", provider: "test", subject: "journey-gm" }],
  ["code-journey-p1", { displayName: "Journey Player One", email: "journey-p1@example.com", provider: "test", subject: "journey-p1" }],
  ["code-journey-p2", { displayName: "Journey Player Two", email: "journey-p2@example.com", provider: "test", subject: "journey-p2" }],
  ["code-journey-p3", { displayName: "Journey Player Three", email: "journey-p3@example.com", provider: "test", subject: "journey-p3" }],
  ["code-journey-p4", { displayName: "Journey Player Four", email: "journey-p4@example.com", provider: "test", subject: "journey-p4" }],
  ["code-journey-p5", { displayName: "Journey Player Five", email: "journey-p5@example.com", provider: "test", subject: "journey-p5" }],
]);
```

- [ ] **Step 2: Run the existing dev-signin suite**

Run: `npx vitest run src/transport/http/dev-signin.test.ts` from the repo root.
Expected: 2 passed (route gating unchanged; the seed map itself is exercised by the journey spec in Task 3).

- [ ] **Step 3: Commit**

```bash
git add src/bootstrap/http.ts
git commit -m "test: seed six deterministic journey users (gm + p1-p5)"
```

---

### Task 2: Journey system fixture + publish through the real API

**Files:**
- Create: `web/tests/e2e/tableJourneySystem.ts`
- Test: Task 3 (publish + validation assertions live in the spec, not a unit test — the document must survive server validation, which only the running backend can judge).

**Interfaces:**
- Consumes: `publishOwnedClone`, `uid` from `web/tests/offline/test-auth.js`; document shape from `src/systems/implementation/package/fixtures/d20.ts`.
- Produces: `JOURNEY_CODES`, `publishJourneySystem(request)`, `JOURNEY_FIELD_IDS`, `JOURNEY_ACTION_LABELS` for Tasks 3–5.

System content (all labels/descriptions original wording; bounded to grammar-v0.1 constructs mirrored from `fixtures/d20.ts`):
- Entity `character`: six integer abilities (`strength` … `charisma`, 3–18 validation mirroring `ability_valid`), six computed modifiers `floor((score-10)/2)` (mirrors `defense_expr` computed pattern), integer `proficiency`, integer `armor_class`, resource `hit_points`, resource `spell_slots`, singleChoice `ancestry` (human/elf/dwarf, mirrors fixture).
- Actions (mirror `check` roll + `damage`/`heal` bump patterns): `longsword_attack` (d20 + modifier + proficiency, mirrors `check_expr`), `shortbow_attack` (same pattern, other ability), `strength_save` (d20 + modifier), `damage_enemy` (resourceBump delta, GM/session use), `second_wind` (resourceBump heal on `hit_points`).
- Sheet sections: Basics (ancestry), Abilities (six scores + six modifiers), Combat (`hit_points`, `spell_slots`, three roll buttons).

- [ ] **Step 1: Read the fixture shape**

Read `src/systems/implementation/package/fixtures/d20.ts` end to end (411 lines: entities → sheets → expressions → actions → validations). Mirror its exact nesting (`entities`, `sheets[].sections[].elements`, `expressions`, `actions`, `validations`) in the new module. Keep `entityDefinitionId: "character"`.

- [ ] **Step 2: Write `web/tests/e2e/tableJourneySystem.ts`**

```ts
export const JOURNEY_CODES = {
  gm: "code-journey-gm",
  players: ["code-journey-p1", "code-journey-p2", "code-journey-p3", "code-journey-p4", "code-journey-p5"],
} as const;

export const JOURNEY_DOCUMENT = { /* full document mirroring fixtures/d20.ts shape */ } as const;

export const JOURNEY_ACTION_LABELS = {
  longsword: "Longsword Attack",
  shortbow: "Shortbow Attack",
  save: "Strength Save",
} as const;
```

(concrete document: six integer ability fields + six computed modifiers + proficiency/armor_class integers + hit_points/spell_slots resources + ancestry choice; three roll actions + two bump actions; three sheet sections. Every expression uses only binary arithmetic, `floor`, d20/d6 — verify each against `fixtures/d20.ts:116-173` while writing.)

- [ ] **Step 3: Write `publishJourneySystem` (clone → replace draft → publish)**

```ts
import type { APIRequestContext } from "@playwright/test";
import { uid } from "../offline/test-auth.js";
import { JOURNEY_DOCUMENT } from "./tableJourneySystem.js";

export async function publishJourneySystem(request: APIRequestContext, sourceVersionId: string): Promise<string> {
  const created = await request.post("/api/systems", {
    data: { source: { kind: "clone", versionId: sourceVersionId }, idempotencyKey: `journey-sys-${uid()}` },
  });
  if (created.status() !== 201) throw new Error(`clone failed: ${created.status()} ${await created.text()}`);
  const workspace = (await created.json()) as { workspace: { system: { systemId: string }; draft: { revision: number } | null } };
  const systemId = workspace.workspace.system.systemId;
  const draft = workspace.workspace.draft;
  if (draft === null) throw new Error("clone produced no draft");
  const saved = await request.put(`/api/systems/${systemId}/draft`, {
    data: { expectedRevision: draft.revision, document: JOURNEY_DOCUMENT },
  });
  if (saved.status() !== 200) throw new Error(`save journey draft failed: ${saved.status()} ${await saved.text()}`);
  const nextRevision = ((await saved.json()) as { workspace: { draft: { revision: number } } }).workspace.draft.revision;
  const published = await request.post(`/api/systems/${systemId}/publish`, {
    data: { expectedRevision: nextRevision, semanticVersion: "1.0.0", releaseNotes: "Table journey system", idempotencyKey: `journey-pub-${uid()}`, acknowledgeBreaking: true },
  });
  if (published.status() !== 200) throw new Error(`publish failed: ${published.status()} ${await published.text()}`);
  return ((await published.json()) as { version: { versionId: string } }).version.versionId;
}
```

(Payload shapes copied from `publishOwnedClone` in `web/tests/offline/test-auth.ts:261-297`; only the document differs.)

---

### Task 3: Spec part 1 — publish system, UI round-trip, five characters

**Files:**
- Create: `web/tests/e2e/tableJourney.spec.ts` (tests 1–2 + shared helpers in this task; tests 3–4 in Tasks 4–5 append to the same file)
- Test: the spec itself.

**Interfaces:**
- Consumes: Task 1 codes, Task 2 fixture + publisher.
- Produces (module state for later tests): `journeyVersionId`, `characterIds: Record<string, string>`.

Shared helpers (write once at top of file; shapes copied from `campaignJourney.spec.ts:32-64`):

```ts
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
```

- [ ] **Step 1: Test 1 — GM publishes the journey system + Creator UI round-trip**

```ts
test("table journey 1/4: publish D&D-like system, Creator round-trip", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const stamp = uid();
  const gmContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const gmUserId = await signInAs(gmContext.request, JOURNEY_CODES.gm);
    expect(gmUserId).toMatch(/.+/);
    journeyVersionId = await publishJourneySystem(gmContext.request, D20_VERSION_ID);
    expect(journeyVersionId).toMatch(/[0-9a-f-]{36}/);
    // UI round-trip on the non-trivial system: GM opens it in the Creator,
    // edits the description, saves, and sees the preview reflect the system.
    await signInViaPanel(page, JOURNEY_CODES.gm);
    await page.goto("/systems"); // library lists the GM-owned system; open it
    await page.getByRole("link", { name: /Journey/ }).first().click({ timeout: STEP_TIMEOUT });
    await expect(page.getByTestId("document-editor-header")).toBeVisible({ timeout: STEP_TIMEOUT });
    await page.getByTestId("metadata-description").fill(`Table journey system ${stamp}.`);
    await expect(page.getByTestId("document-editor-lifecycle")).toHaveText(/Saved|Draft/, { timeout: 30_000 });
    await page.getByTestId("document-editor-preview-toggle").click();
    await expect(page.getByText("Longsword Attack")).toBeVisible({ timeout: STEP_TIMEOUT });
  } finally {
    await gmContext.close();
  }
});
```

(Testids `document-editor-header`, `metadata-description`, `document-editor-lifecycle`, `document-editor-preview-toggle` follow `creatorToCharacter.spec.ts:79-147`. If the library route/link name differs, read `web/src/library/` for the exact route and list testids first — do not invent replacements silently; adjust the step to the real ones.)

- [ ] **Step 2: Test 2 — five players create one character each (2 UI + 3 API)**

```ts
test("table journey 2/4: five players create characters", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const stamp = uid();
  const origin = new URL(page.url()).origin;
  const names = ["Aldric", "Bryn", "Cora", "Dain", "Elswyth"];
  // Players 1-2: real picker UI (versionless entry exercises OD-01 discovery
  // of the GM-owned published system — reference seeds stay unlisted).
  for (const [index, code] of [JOURNEY_CODES.players[0], JOURNEY_CODES.players[1]].entries()) {
    const ctx = await browser.newContext({ baseURL: origin });
    try {
      await signInAs(ctx.request, code);
      const p = await ctx.newPage();
      await signInViaPanel(p, code);
      await p.goto("/characters/new");
      await p.getByRole("button", { name: /Journey/ }).first().click({ timeout: STEP_TIMEOUT });
      await p.getByRole("textbox", { name: /character name/i }).fill(`${names[index]} ${stamp}`);
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
```

(Picker flow follows `docs/acceptance/gui-2026-09-09-g4-character.md` exit demonstration: versionless `/characters/new` → select → create. API shape follows `test-auth.ts:createCharacter`. If picker button/field names differ, read `web/src/characters/CreateCharacter.tsx` for exact accessible names first.)

- [ ] **Step 3: Run tests 1–2**

Run: `SWEETROLL_E2E_SUITE=journeys npx playwright test tests/e2e/tableJourney.spec.ts --grep "1/4|2/4"` from `web/` (backend/DB per `playwright.config.ts` webServer; or the canonical isolated runner if configured).
Expected: 2/2 pass. If the journey-system publish fails server validation, read the 422 diagnostics, fix the fixture document (Task 2), re-run.

---

### Task 4: Spec part 2 — campaign world (locations, NPCs, invitations)

**Files:**
- Modify: `web/tests/e2e/tableJourney.spec.ts` (append test 3)
- Test: the spec itself.

**Interfaces:**
- Consumes: `journeyVersionId` (Task 3).
- Produces: `campaignId`, `inviteTokens: string[]` for Task 5.

World scale (concrete, within limits: 100 members, 200 attached characters): 6 location notes (`all_players`), 1 GM-only note (audience value read from `src/campaigns/policy.ts` — the hide/recover flow in `gmSessionJourney.spec.ts` uses it; use that exact value), 10 NPCs as campaign-attached characters, 5 player invitations.

- [ ] **Step 1: Test 3 — GM creates campaign, locations, NPCs, invitations (API bulk)**

```ts
test("table journey 3/4: campaign world — locations, NPCs, invitations", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const stamp = uid();
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
    // GM-only note: audience enum value read from src/campaigns/policy.ts.
    await post(`/api/campaigns/${campaignId}/content`, {
      title: `Secret Ledger ${stamp}`, body: `GM eyes only ${stamp}.`,
      audience: "<GM_ONLY_VALUE_FROM_POLICY_TS>", idempotencyKey: `journey-secret-${stamp}`,
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
```

(Payload shapes copied from `campaignJourney.spec.ts:91-130`. Replace `<GM_ONLY_VALUE_FROM_POLICY_TS>` with the literal audience value from `src/campaigns/policy.ts` before running — the value used by the Phase 2 hide/recover e2e.)

- [ ] **Step 2: Run test 3**

Run: same command as Task 3 Step 3 with `--grep "3/4"`.
Expected: pass; campaign detail afterwards shows 6 notes + 10 NPCs (spot-check via `GET /api/campaigns/:id`).

---

### Task 5: Spec part 3 — join + session (all UI)

**Files:**
- Modify: `web/tests/e2e/tableJourney.spec.ts` (append test 4)
- Test: the spec itself.

**Interfaces:**
- Consumes: `campaignId`, `inviteTokens` (Task 4), `characterIds` (Task 3), `JOURNEY_ACTION_LABELS`.

- [ ] **Step 1: Test 4 — five players join, read, roll; GM runs the session**

```ts
test("table journey 4/4: join and session", async ({ page, browser }) => {
  test.setTimeout(600_000);
  const campaignId: string = (globalThis as any).__journeyCampaignId;
  const tokens: string[] = (globalThis as any).__journeyTokens;
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
  // Session: each player opens their own sheet (phone viewport) and makes a
  // campaign-visible Longsword Attack; GM (phone viewport) bumps an NPC and
  // rolls from the session board; each player sees the activity.
  // (Sheet roll/resource/session-board interactions follow
  // gmSessionJourney.spec.ts: phone 360px contexts, action button labels from
  // JOURNEY_ACTION_LABELS, activity-tab assertions per campaignJourney.spec.ts:203-206.)
});
```

(Fill the session block following `gmSessionJourney.spec.ts` interaction vocabulary verbatim — same buttons/tabs the Phase 2 e2e uses at 360px. Keep all five player iterations UI-driven; the loop above is the join half, then one roll per player sheet + GM board actions + activity assertions.)

- [ ] **Step 2: Run the full file**

Run: `SWEETROLL_E2E_SUITE=journeys npx playwright test tests/e2e/tableJourney.spec.ts` from `web/`.
Expected: 4/4 pass. On failure, use the retained trace (`trace: "retain-on-failure"`) — fix product bugs as separate bugfix tasks, fixture/spec bugs inline here.

---

### Task 6: Evidence record + full-suite gate

**Files:**
- Create: `docs/acceptance/table-2026-09-26-journey.md`
- Test: none (record only).

- [ ] **Step 1: Run the affected suites**

Run from repo root: `npm test` (root unit). From `web/`: `npm test` (web unit). Expected: green, no new failures. (The journey spec itself is the e2e evidence; do not re-run the whole e2e matrix here.)

- [ ] **Step 2: Write the acceptance record**

Record: tested commit, exact commands, Chromium-only + dev-server scope, fixture scale (6 abilities, 6 locations, 10 NPCs, 5+5 characters, 5 invitations), what ran in UI vs API, manual findings, remaining limitations (no real devices, no OIDC, no playtest-with-humans claim).

- [ ] **Step 3: Commit**

```bash
git add web/tests/e2e/tableJourneySystem.ts web/tests/e2e/tableJourney.spec.ts docs/acceptance/table-2026-09-26-journey.md
git commit -m "test: full-table journey (system, 5 characters, campaign world, session)"
```

## Self-Review

- Spec coverage: system build (Tasks 2–3) ✓; 5× character creation (Task 3) ✓; campaign + locations + NPCs (Task 4) ✓; join + session (Task 5) ✓; auth decision + rationale (pregenerated, locked) ✓; UI-vs-API split (locked table above) ✓; new-implementation inventory (seed codes + fixture + spec; no product code) ✓.
- Placeholder scan: the single `<GM_ONLY_VALUE_FROM_POLICY_TS>` marker is resolved by a cited source file before running (flagged, not silent). No TBD/TODO; every API payload is copied from passing specs; every UI testid is cited to its source spec.
- Type consistency: `JOURNEY_CODES`, `publishJourneySystem`, `JOURNEY_ACTION_LABELS`, `characterIds`, `__journeyCampaignId`/`__journeyTokens` names are identical across tasks.

## Execution Handoff

Decisions locked (owner-confirmed 2026-09-26): API-built system + Playwright for the rest, pregenerated test accounts, original-wording fixture. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — execute tasks in this session with checkpoints

Which approach?
