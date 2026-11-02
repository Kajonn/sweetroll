import { expect, test, type Page, type Browser, type BrowserContext } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { json, key } from "./configurablePush.js";
import { expectOfflineAvailable } from "../offline/test-auth.js";

/** MU-00–MU-12: user operations are GUI-only. HTTP is restricted to fixture
 * authentication, independent observations/denial probes and scoped archiving.
 * Keep contexts alive for the complete shared-session/worker journey.
 */
export async function multiUserJourney({ browser, baseURL }: { browser: Browser; baseURL: string | undefined }) {
  test.setTimeout(360_000); // Four actors, authoring, 24 rolls and a production-worker offline cycle.
  if (!baseURL) throw Error("An explicit isolated target is required");
  const stamp = key().slice(0, 8);
  const contexts: BrowserContext[] = [];
  const pages: Page[] = [];
  const actorIds: string[] = [];
  const names = ["Journey GM", "Journey Player One", "Journey Player Two", "Journey Player Three"];
  const widths = [1280, 360, 768, 1280];
  const characters: Array<{ characterId: string; name: string; revision: number }> = [];
  const templates: Array<{ templateId: string; name: string }> = [];
  const steps: Array<{ step: string; status: string }> = [];
  const rolls: unknown[] = [];
  const pageErrors: string[] = [];
  const cleanup: Record<string, unknown> = {};
  let systemId = "", versionId = "", campaignId = "";
  let journeyFailed = false;
  async function step(id: string, run: () => Promise<void>) {
    await test.step(id, async () => {
      try { await run(); steps.push({ step: id, status: "PASS" }); console.log(`${id}: PASS`); }
      catch (cause) { steps.push({ step: id, status: "FAIL" }); throw cause; }
    });
  }
  const campaign = async () => (await json(contexts[0]!.request, "GET", `/api/campaigns/${campaignId}`)).campaign;
  const character = async (i: number) => (await json(contexts[i + 1]!.request, "GET", `/api/characters/${characters[i]!.characterId}`)).character;
  async function shot(page: Page, label: string) {
    await test.info().attach(label, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  }
  async function noOverflow(page: Page) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
  async function saveDraft(page: Page) {
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("document-editor-autosave")).toContainText("Saved", { timeout: 15_000 });
  }
  async function addEntry(page: Page, slot: string, label: string) {
    await page.getByTestId(`slot-add-${slot}`).click();
    const picker = page.getByTestId(`slot-template-picker-${slot}`);
    await expect(picker.locator("option", { hasText: slot === "slot_1" ? "Firebolt" : "Longsword" })).toHaveCount(0);
    await page.getByTestId(`slot-template-picker-${slot}`).selectOption({ label });
    await page.getByTestId(`slot-add-confirm-${slot}`).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText(label.replace(" · Campaign", ""), { exact: true }).first()).toBeVisible();
  }
  async function customEntry(page: Page, label: string, notes: string) {
    await page.getByTestId("slot-add-slot_1").click();
    await page.getByLabel("Template", { exact: true }).selectOption("");
    await page.getByLabel("Entry name", { exact: true }).fill(label);
    await page.getByLabel("Description", { exact: true }).fill("Personal adventure equipment");
    await page.getByLabel("Notes", { exact: true }).fill(notes);
    await page.getByLabel("Quantity", { exact: true }).fill("2");
    await page.getByRole("button", { name: "Add entry", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }
  async function roll(i: number, entryName: string, actionName: string, sides: number, field: string, bonus: number) {
    const page = pages[i + 1]!;
    const entry = page.locator('li[data-testid^="slot-entry-"]').filter({ has: page.getByText(entryName, { exact: true }) });
    const entryId = (await entry.getAttribute("data-testid"))!.slice("slot-entry-".length);
    const action = entry.getByRole("button", { name: actionName, exact: true });
    const actionId = (await entry.locator("form").filter({ has: page.getByRole("button", { name: actionName, exact: true }) }).getAttribute("data-testid"))!.slice(`slot-granted-${entryId}-`.length);
    const response = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith(`/characters/${characters[i]!.characterId}/actions/${actionId}`));
    await action.click();
    const res = await response;
    expect(res.status(), "entry action status").toBe(200);
    expect(res.request().postDataJSON().entryId, "roll uses the selected entry").toBe(entryId);
    const payload = await res.json();
    const result = payload.result ?? payload;
    const value = result.roll ?? result.result?.roll;
    expect(value, "server roll payload").toBeTruthy();
    expect(value.actionId).toBe(actionId);
    expect(value.dice).toHaveLength(1);
    expect(value.dice[0].sides).toBe(sides);
    expect(value.bindings).toContainEqual(expect.objectContaining({ scope: "fields", definitionId: field, value: bonus }));
    expect(value.total).toBe(value.dice[0].value + bonus);
    rolls.push({ player: i + 1, entryName, actionName, roll: value });
    const close = page.getByRole("button", { name: "Close", exact: true });
    if (await close.isVisible()) await close.click();
  }
  async function archive() {
    if (!contexts[0]) return;
    await Promise.all(contexts.map(c => c.setOffline(false)));
    for (let i = 0; i < characters.length; i++) {
      const ch = await character(i);
      if (ch.lifecycle !== "archived") await json(ch.campaignId ? contexts[0]!.request : contexts[i + 1]!.request, "PATCH", `/api/characters/${ch.characterId}`, { command: "archive", expectedRevision: ch.revision, idempotencyKey: key() });
      expect((await character(i)).lifecycle).toBe("archived");
    }
    cleanup.characterCount = characters.length;
    for (const item of templates) {
      const path = `/api/campaigns/${campaignId}/item-templates/${item.templateId}`;
      const current = (await json(contexts[0]!.request, "GET", path)).template;
      if (current.status !== "archived") await json(contexts[0]!.request, "POST", path + "/archive", { expectedTemplateRevision: current.revision, idempotencyKey: key() });
      expect((await json(contexts[0]!.request, "GET", path)).template.status).toBe("archived");
    }
    cleanup.templateCount = templates.length;
    if (campaignId) {
      const c = await campaign();
      if (c.status !== "archived") await json(contexts[0]!.request, "POST", `/api/campaigns/${campaignId}/archive`, { expectedCampaignRevision: c.revision, idempotencyKey: key() });
      expect((await campaign()).status).toBe("archived"); cleanup.campaign = "archived";
    }
    if (systemId) {
      await json(contexts[0]!.request, "PATCH", `/api/systems/${systemId}`, { lifecycle: "archived", access: "private" });
      const system = (await json(contexts[0]!.request, "GET", `/api/systems/${systemId}`)).workspace.system;
      expect(system).toMatchObject({ lifecycle: "archived", access: "private" }); cleanup.system = "private, archived";
    }
  }
  try {
    await step("MU-00 deployment/fixture preflight", async () => {
      for (let i = 0; i < 4; i++) {
        const context = await browser.newContext({ baseURL, viewport: { width: widths[i]!, height: 900 } });
        // An unavailable control is a failed step, not a six-minute navigation wait.
        context.setDefaultTimeout(15_000);
        contexts.push(context);
        const signed = await json(context.request, "POST", "/dev/signin", { code: i === 0 ? "code-journey-gm" : `code-journey-p${i}`, redirectUri: new URL("/cb", baseURL).href });
        actorIds.push(signed.userId);
        const me = await json(context.request, "GET", "/api/me");
        expect(me).toMatchObject({ state: "authenticated", userId: signed.userId });
        const page = await context.newPage(); pages.push(page);
        page.on("pageerror", e => pageErrors.push(e.message));
      }
      expect(new Set(actorIds).size).toBe(4);
      expect((await contexts[0]!.request.get("/health/ready")).status()).toBe(200);
    });
    const gm = pages[0]!;
    await step("MU-01 GUI blank-system authoring/save/reopen/publish", async () => {
      await gm.goto("/");
      await gm.getByTestId("library-new-system").click();
      await gm.getByTestId("create-draft-name").fill(`Tower of Ash ${stamp}`);
      await gm.getByTestId("create-draft-submit").click();
      await expect(gm).toHaveURL(/\/systems\/[0-9a-f-]{36}/);
      systemId = new URL(gm.url()).pathname.split("/").pop()!;
      await gm.getByTestId("metadata-default-dice").fill("d20");
      await gm.getByTestId("document-editor-tab-attributes").click();
      await gm.getByTestId("entity-list-add").click();
      const row = gm.locator('li[data-testid^="entity-row-"]').last();
      const entityId = (await row.getAttribute("data-testid"))!.slice("entity-row-".length);
      await gm.getByTestId(`entity-label-input-${entityId}`).fill("Hero");
      await gm.getByTestId(`entity-field-kind-picker-${entityId}`).selectOption("integer");
      for (const label of ["Might", "Agility", "Will"]) {
        await gm.getByTestId(`entity-add-field-${entityId}`).click();
        await gm.locator('[data-testid^="scalar-field-label-"]').last().fill(label);
      }
      await gm.getByTestId("document-editor-tab-templates").click();
      const modifiers: Array<{ actionId: string; fieldId: string }> = [];
      for (const [index, label, kind] of [[1,"Longsword","item"],[2,"Firebolt","spell"],[3,"Rope","item"]] as const) {
        await gm.getByTestId("templates-add-button").click();
        await gm.getByTestId(`template-label-template_${index}`).fill(label);
        await gm.getByTestId(`template-kind-template_${index}`).selectOption(kind);
        if (index < 3) {
          for (const [action, die] of (index === 1 ? [["Sword attack","d20"],["Sword damage","d8"]] : [["Cast Firebolt","d20"],["Firebolt damage","d6"]])) {
            await gm.getByTestId(`template-add-roll-template_${index}`).click();
            const section = gm.getByTestId(`template-actions-template_${index}`).locator('[data-testid^="roll-action-"]').filter({ has: gm.locator('[data-testid^="roll-action-label-"]') }).last();
            const id = (await section.getAttribute("data-testid"))!.slice("roll-action-".length);
            await gm.getByTestId(`roll-action-label-${id}`).fill(action!);
            await gm.getByTestId(`dice-kind-${id}`).selectOption(die!);
            // Character fields become eligible only after a compatible slot is
            // bound to the character's sheet. Author the roll now, bind it below.
            modifiers.push({ actionId: id, fieldId: index === 1 ? "field" : "field_2" });
          }
        }
      }
      for (const [i, label] of [[1,"Equipment"],[2,"Spells"]] as const) {
        await gm.getByTestId("slots-add-button").click();
        await gm.getByTestId(`slot-label-slot_${i}`).fill(label);
        if (i === 2) { await gm.getByTestId("slot-accepts-slot_2-spell").check(); await gm.getByTestId("slot-accepts-slot_2-item").uncheck(); }
      }
      await gm.getByTestId("document-editor-tab-sections").click();
      await gm.getByTestId("sheet-add-button").click();
      await gm.getByTestId("sheet-add-section").click();
      await gm.getByTestId("section-label-section_1").fill("Adventurer");
      for (const id of ["field","field_1","field_2","slot_1","slot_2"]) await gm.getByTestId(`sheet-place-definition-${id}`).click();
      await gm.getByTestId("document-editor-tab-templates").click();
      for (const { actionId, fieldId } of modifiers) {
        await gm.getByTestId(`roll-field-modifier-${actionId}`).selectOption(fieldId);
      }
      await saveDraft(gm);
      await gm.reload();
      await expect(gm.getByTestId("document-editor-header")).toBeVisible();
      const doc = (await json(contexts[0]!.request, "GET", `/api/systems/${systemId}`)).workspace.draft.document;
      expect(doc.entities[0].fields.map((f: any) => f.label)).toEqual(["Might","Agility","Will"]);
      expect(doc.templates).toHaveLength(3);
      await gm.getByTestId("document-editor-publish").click();
      await gm.getByTestId("publish-dialog-semver").fill("1.0.0");
      await gm.getByTestId("publish-dialog-release-notes").fill("Multi-user acceptance rules");
      await gm.getByTestId("publish-dialog-submit").click();
      const cta = gm.getByTestId("publish-dialog-create-character"); await expect(cta).toBeVisible();
      versionId = new URL((await cta.getAttribute("href"))!, baseURL).searchParams.get("systemVersionId")!;
      await gm.goto("/");
      await gm.getByTestId(`system-sharing-${systemId}`).selectOption("link");
      await gm.getByRole("button", { name: "Share with link", exact: true }).click();
      await expect(gm.getByRole("dialog")).toHaveCount(0);
    });
    await step("MU-02 GUI adventure and public/GM-only notes", async () => {
      await gm.goto("/campaigns/new");
      // The picker also includes the publish date and short version ID.
      await gm.getByRole("button", { name: new RegExp(`^Tower of Ash ${stamp} 1\\.0\\.0 ·`) }).click();
      await gm.getByLabel("Campaign title").fill(`The Missing Caravan ${stamp}`);
      await gm.getByRole("button", { name: "Create campaign", exact: true }).click();
      await expect(gm).toHaveURL(/\/campaigns\/[0-9a-f-]{36}/);
      campaignId = new URL(gm.url()).pathname.split("/").pop()!;
      expect((await campaign()).systemVersionId).toBe(versionId);
      await gm.getByRole("tab", { name: "Content", exact: true }).click();
      for (const [title, body, audience] of [["Village briefing","Find the caravan near the ruined tower","all_players"],["GM secret: ambush","Caravan master betrayed the party","gm_only"]]) {
        await gm.getByLabel("Title", { exact: true }).fill(title!);
        await gm.getByLabel("Body", { exact: true }).fill(body!);
        await gm.getByLabel("Audience", { exact: true }).selectOption(audience!);
        const saved = gm.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/content"));
        await gm.getByRole("button", { name: "Save note", exact: true }).click();
        expect((await saved).status()).toBe(201);
        await expect(gm.getByLabel("Title", { exact: true })).toHaveValue("");
      }
    });
    await step("MU-03 three manual token reviews and accepts", async () => {
      for (let i = 1; i < 4; i++) {
        await gm.reload(); await gm.getByRole("tab", { name: "Members", exact: true }).click();
        await gm.getByRole("button", { name: "Issue invitation", exact: true }).click();
        await expect(gm.getByText("Share this invitation link token now")).toBeVisible();
        const token = (await gm.locator("code").first().innerText()).trim();
        const page = pages[i]!; await page.goto("/invitations");
        await page.getByLabel("Invitation token").fill(token);
        await page.getByRole("button", { name: "Review invitation", exact: true }).click();
        await expect(page.getByText(`The Missing Caravan ${stamp}`, { exact: true })).toBeVisible();
        const accepted = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/invitations/accept"));
        await page.getByRole("button", { name: "Accept", exact: true }).click();
        const res = await accepted; expect(res.status()).toBe(200);
        expect(res.request().postDataJSON().token === token, "manual acceptance retains token").toBe(true);
        await page.getByRole("link", { name: "Open campaign", exact: true }).click();
        await expect(page.getByRole("tab", { name: "Settings", exact: true })).toHaveCount(0);
        await page.getByRole("tab", { name: "Content", exact: true }).click();
        await page.getByRole("button", { name: "Open Village briefing", exact: true }).click();
        await expect(page.getByText("Find the caravan near the ruined tower", { exact: true })).toBeVisible();
        await expect(page.getByText("GM secret: ambush", { exact: true })).toHaveCount(0);
        await gm.getByRole("button", { name: "Done", exact: true }).click();
      }
    });
    await step("MU-04 personal creation/GUI adoption and two direct campaign creations", async () => {
      for (let i = 0; i < 3; i++) {
        const page = pages[i + 1]!, name = `${["Aldric the fighter","Bryn the mage","Cora the scout"][i]} ${stamp}`;
        if (i === 0) {
          await page.goto(`/characters/new?systemVersionId=${versionId}`);
          await page.getByLabel("Entity", { exact: true }).selectOption({ label: "Hero" });
          await page.getByLabel("Character name").fill(name);
          await page.getByRole("button", { name: "Create character", exact: true }).click();
          await expect(page).toHaveURL(/\/characters\/[0-9a-f-]{36}/);
          const id = new URL(page.url()).pathname.split("/").pop()!;
          characters.push({ characterId: id, name, revision: 1 });
          await page.goto(`/campaigns/${campaignId}`);
          await page.getByRole("button", { name: "Bring a personal character", exact: true }).click();
          await page.getByLabel("Personal character", { exact: true }).selectOption(id);
          await expect(page.getByText(/game masters can read and edit/)).toBeVisible();
          await shot(page, "MU-04-personal-adoption-phone");
          await page.getByRole("button", { name: "Join campaign with character", exact: true }).click();
          await expect(page.getByRole("dialog")).toHaveCount(0);
          expect((await character(i)).campaignId).toBe(campaignId);
        } else {
          await page.goto(`/campaigns/${campaignId}`);
          await page.getByLabel("Character name").fill(name);
          await page.getByLabel("Entity definition", { exact: true }).selectOption({ label: "Hero" });
          const created = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith(`/campaigns/${campaignId}/characters`));
          await page.getByRole("button", { name: "New campaign character", exact: true }).click();
          const res = await created; expect(res.status()).toBe(201);
          characters.push((await res.json()).character);
        }
        await page.goto(`/characters/${characters[i]!.characterId}`);
        await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
        await expect(page.getByText("Editing in this tab.", { exact: true })).toBeVisible();
        await expect(page.getByText("Saved", { exact: true })).toBeVisible();
        for (const [field, value] of [["Might", i + 2],["Agility",3],["Will",4 - i]] as const) {
          const fieldId = { Might: "field", Agility: "field_1", Will: "field_2" }[field];
          const committed = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith(`/fields/${fieldId}/set`));
          const input = page.getByLabel(field, { exact: true });
          await input.fill(String(value));
          // Enter is the sheet's explicit commit gesture; do not rely on focus
          // advancing away while a newly opened sheet acquires its writer.
          await input.press("Enter");
          const response = await committed;
          expect(response.status(), `Player ${i + 1} ${field} save status`).toBe(200);
          expect(response.request().postDataJSON().value).toBe(value);
          await expect.poll(async () => (await character(i)).state.values[fieldId]).toBe(value);
          await expect(page.getByText("Saved", { exact: true })).toBeVisible();
        }
      }
    });
    await step("MU-05 inherited and blank adventure templates", async () => {
      await gm.goto(`/campaigns/${campaignId}`); await gm.getByRole("tab", { name: "Items & powers", exact: true }).click();
      for (const [name, kind, source, audience, quantity] of [["Ashguard blade","item","template_1","all_players",1],["Ember spell","spell","template_2","all_players",1],["Caravan supplies","item","","all_players",3],["Secret vault key","item","","gm_only",1]] as const) {
        await gm.getByRole("button", { name: "Create template", exact: true }).click();
        if (source) { await gm.getByLabel("Source", { exact: true }).selectOption("system"); await gm.getByLabel("System template", { exact: true }).selectOption(source); }
        else await gm.getByLabel("Kind", { exact: true }).selectOption(kind);
        await gm.getByLabel("Name", { exact: true }).fill(name);
        await gm.getByLabel("Audience", { exact: true }).selectOption(audience);
        if (kind === "item") await gm.getByLabel("Default quantity", { exact: true }).fill(String(quantity));
        const saved = gm.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/item-templates"));
        await gm.getByRole("button", { name: audience === "gm_only" ? "Save draft" : "Publish to all members", exact: true }).click();
        const res = await saved; expect(res.status()).toBe(201);
        const template = (await res.json()).template; templates.push({ templateId: template.templateId, name });
        expect(template).toMatchObject({ kind, audience });
        await expect(gm.getByRole("dialog")).toHaveCount(0);
      }
    });
    await step("MU-06 six entries and six actions for each player", async () => {
      for (let i = 0; i < 3; i++) {
        const page = pages[i + 1]!; await page.goto(`/characters/${characters[i]!.characterId}`);
        for (const [slot, label] of [["slot_1","Longsword"],["slot_2","Firebolt"],["slot_1","Ashguard blade · Campaign"],["slot_2","Ember spell · Campaign"],["slot_1","Caravan supplies · Campaign"]]) await addEntry(page, slot!, label!);
        await customEntry(page, `Lucky token ${i + 1}`, `Player ${i + 1} personal notes`);
        await expect.poll(async () => Object.keys((await character(i)).state.entries).length).toBe(6);
        expect(Object.values((await character(i)).state.entries).filter((e: any) => e.values.name === `Lucky token ${i + 1}` && e.templateId !== null)).toHaveLength(0);
        for (const [entryName, actionName, sides, field, bonus] of [["Longsword","Sword attack",20,"field",i+2],["Longsword","Sword damage",8,"field",i+2],["Firebolt","Cast Firebolt",20,"field_2",4-i],["Firebolt","Firebolt damage",6,"field_2",4-i],["Ashguard blade","Sword attack",20,"field",i+2],["Ember spell","Cast Firebolt",20,"field_2",4-i]] as const) await roll(i, entryName, actionName, sides, field, bonus);
      }
      expect(rolls).toHaveLength(18);
    });
    await step("MU-07 reopen/responsiveness and authorization", async () => {
      for (let i = 0; i < 3; i++) {
        const page = pages[i + 1]!; await page.reload();
        await expect(page.getByText(`Lucky token ${i + 1}`, { exact: true })).toBeVisible(); await noOverflow(page);
        expect((await contexts[i + 1]!.request.get(`/api/characters/${characters[(i + 1) % 3]!.characterId}`)).status()).toBe(404);
        await page.goto(`/characters/${characters[(i + 1) % 3]!.characterId}`);
        await expect(page.getByText("This character is unavailable.", { exact: true })).toBeVisible();
        await expect(page.getByRole("heading", { name: characters[(i + 1) % 3]!.name, exact: true })).toHaveCount(0);
        await page.goto(`/characters/${characters[i]!.characterId}`);
        expect((await contexts[i + 1]!.request.get(`/api/campaigns/${campaignId}/item-templates/${templates[3]!.templateId}`)).status()).toBe(404);
        const deniedManagement = await contexts[i + 1]!.request.post(`/api/campaigns/${campaignId}/item-templates`, { data: { kind: "item", audience: "all_players", grants: [], content: { name: "Forbidden" }, expectedTemplateRevision: 0, idempotencyKey: key() } });
        // Current campaign members receive forbidden for GM administration;
        // hidden templates and other players' sheets remain collapsed to 404.
        expect(deniedManagement.status()).toBe(403);
        expect((await deniedManagement.json()).error.code).toBe("forbidden");
        await page.getByTestId("slot-add-slot_1").click(); await expect(page.getByRole("option", { name: /Secret vault key/ })).toHaveCount(0); await page.getByRole("button", { name: "Cancel", exact: true }).click();
      }
      await gm.goto(`/campaigns/${campaignId}`);
      for (const ch of characters) await expect(gm.getByRole("button", { name: `Open ${ch.name}`, exact: true })).toBeVisible();
      for (const ch of characters) { expect((await contexts[0]!.request.get(`/api/characters/${ch.characterId}`)).status()).toBe(200); }
      await shot(pages[1]!, "MU-07-equipped-phone");
    });
    await step("MU-08 six concurrent actor-bound rolls", async () => {
      await Promise.all([0,1,2].map(async i => { await roll(i,"Longsword","Sword attack",20,"field",i+2); await roll(i,"Firebolt","Cast Firebolt",20,"field_2",4-i); }));
      expect(rolls).toHaveLength(24);
    });
    await step("MU-09 named restricted recipients/actual preview/reveal/narrow", async () => {
      await gm.goto(`/campaigns/${campaignId}`); await gm.getByRole("tab", { name: "Items & powers", exact: true }).click();
      const secret = gm.locator("li").filter({ has: gm.getByRole("heading", { name: "Secret vault key", exact: true }) });
      const sharing = async (audience: string) => {
        await secret.getByRole("button", { name: "Sharing", exact: true }).click(); await gm.getByLabel("Audience", { exact: true }).selectOption(audience);
        if (audience === "selected_players") await gm.getByRole("checkbox", { name: `${names[1]} (${actorIds[1]})`, exact: true }).check();
        await gm.getByRole("button", { name: audience === "all_players" ? "Reveal to all players" : "Save sharing", exact: true }).click(); await expect(gm.getByRole("dialog")).toHaveCount(0);
      };
      const path = `/api/campaigns/${campaignId}/item-templates/${templates[3]!.templateId}`;
      await sharing("selected_players");
      const roster = (await json(contexts[0]!.request,"GET",`/api/campaigns/${campaignId}/members`)).members;
      const p1 = roster.find((m: any) => m.userId === actorIds[1]);
      expect((await json(contexts[0]!.request,"GET",path)).template.grants).toEqual([{ userId: actorIds[1], generation: p1.generation }]);
      for (let i = 1; i < 4; i++) {
        expect((await contexts[i]!.request.get(path)).status()).toBe(i === 1 ? 200 : 404);
        await pages[i]!.goto(`/campaigns/${campaignId}`);
        await pages[i]!.getByRole("tab", { name: "Items & powers", exact: true }).click();
        await expect(pages[i]!.getByRole("heading", { name: "Ashguard blade", exact: true })).toBeVisible();
        await expect(pages[i]!.getByRole("heading", { name: "Secret vault key", exact: true })).toHaveCount(i === 1 ? 1 : 0);
      }
      for (const i of [1,2]) {
        const renderedPreview = gm.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/item-template-preview") && r.request().postDataJSON().targetUserId === actorIds[i]);
        await gm.getByLabel("Preview as player", { exact: true }).selectOption({ label: `${names[i]} (${actorIds[i]})` });
        expect((await renderedPreview).status()).toBe(200);
        await expect(gm.getByRole("heading", { name: "Ashguard blade", exact: true })).toBeVisible();
        const actual = (await json(contexts[i]!.request,"GET",`/api/campaigns/${campaignId}/item-templates`)).templates;
        const preview = (await json(contexts[0]!.request,"POST",`/api/campaigns/${campaignId}/item-template-preview`,{targetUserId:actorIds[i]})).templates;
        expect(preview).toEqual(actual);
        if (i === 1) await expect(gm.getByRole("heading", { name: "Secret vault key", exact: true })).toBeVisible(); else await expect(gm.getByRole("heading", { name: "Secret vault key", exact: true })).toHaveCount(0);
      }
      await gm.getByLabel("Preview as player", { exact: true }).selectOption("");
      // Authorized catalog visibility does not permit placement of a restricted draft.
      await pages[1]!.goto(`/characters/${characters[0]!.characterId}`);
      await pages[1]!.getByTestId("slot-add-slot_1").click();
      await expect(pages[1]!.getByRole("option", { name: /Secret vault key/ })).toHaveCount(0);
      await pages[1]!.getByRole("button", { name: "Cancel", exact: true }).click();
      const ch = await character(0);
      const restricted = (await json(contexts[1]!.request,"GET",path)).template;
      const blocked = await contexts[1]!.request.post(`/api/characters/${ch.characterId}/entries`, { data: { entry: { entryId: key(), slotId: "slot_1", templateId: null, values: {}, source: { kind: "campaign", campaignId, templateId: restricted.templateId, templateRevision: restricted.revision, contentRevision: restricted.contentRevision } }, expectedRevision: ch.revision, idempotencyKey: key() } });
      expect(blocked.status()).toBe(404);
      await sharing("all_players");
      await pages[2]!.goto(`/characters/${characters[1]!.characterId}`); await addEntry(pages[2]!, "slot_1", "Secret vault key · Campaign");
      await sharing("gm_only");
      await pages[2]!.reload(); await expect(pages[2]!.getByText("Secret vault key", { exact: true })).toBeVisible();
      await pages[2]!.getByTestId("slot-add-slot_1").click(); await expect(pages[2]!.getByRole("option", { name: /Secret vault key/ })).toHaveCount(0); await pages[2]!.getByRole("button", { name: "Cancel", exact: true }).click();
      for (const theme of ["light","dark"] as const) { await gm.emulateMedia({ colorScheme: theme }); for (const width of [360,768,1280]) { await gm.setViewportSize({ width, height:900 }); await noOverflow(gm); } }
      await shot(gm,"MU-09-named-preview-desktop");
      expect((await new AxeBuilder({ page: gm }).analyze()).violations).toEqual([]);
    });
    await step("MU-10 production-worker offline pending/reload/replay", async () => {
      const page = pages[1]!; await page.goto(`/characters/${characters[0]!.characterId}`); await expectOfflineAvailable(page);
      await contexts[1]!.setOffline(true); await customEntry(page,"Offline trail ration","Pending offline");
      await expect(page.getByText("Changes pending", { exact: true })).toBeVisible();
      await page.reload(); await expect(page.getByText("Offline trail ration", { exact: true })).toBeVisible();
      await expect(page.getByText("Changes pending", { exact: true })).toBeVisible(); await contexts[1]!.setOffline(false);
      await expect.poll(async () => Object.values((await character(0)).state.entries).filter((e: any) => e.values.name === "Offline trail ration").length).toBe(1);
      await expectOfflineAvailable(page);
    });
    await step("MU-11 independent placed-copy quantities", async () => {
      const page = pages[1]!;
      const entry = page.locator('li[data-testid^="slot-entry-"]').filter({ has: page.getByText("Caravan supplies",{exact:true}) });
      await entry.getByRole("button",{name:"Edit entry",exact:true}).click(); await entry.getByLabel("Quantity",{exact:true}).fill("2"); await entry.getByRole("button",{name:"Save entry",exact:true}).click();
      await expect.poll(async () => (Object.values((await character(0)).state.entries).find((e:any)=>e.values.name==="Caravan supplies") as any)?.quantity).toBe(2);
      await page.reload(); await expect(page.getByText("Caravan supplies",{exact:true})).toBeVisible();
      expect((Object.values((await character(1)).state.entries).find((e:any)=>e.values.name==="Caravan supplies") as any)?.quantity).toBe(3);
      const path = `/api/campaigns/${campaignId}/item-templates/${templates[2]!.templateId}`;
      expect((await json(contexts[0]!.request,"GET",path)).template.content.defaultQuantity).toBe(3);
      expect(pageErrors).toEqual([]);
    });
    await step("MU-12 scoped archive and independent readback", archive);
  } catch (error) {
    journeyFailed = true;
    throw error;
  } finally {
    if (!steps.some(s => s.step.startsWith("MU-12") && s.status === "PASS")) {
      try { await archive(); } catch (error) { cleanup.error = String(error); }
    }
    await test.info().attach("multi-user-sanitized-evidence", { body: JSON.stringify({ stamp, baseURL, systemId, versionId, campaignId, actorIds, viewports:widths, characters, templates, steps, rolls, totalSuccessfulRolls: rolls.length, pageErrors, cleanup },null,2), contentType:"application/json" });
    const closed = await Promise.allSettled(contexts.map(c => c.close()));
    // A timeout already disposes contexts. Do not replace the primary failed
    // step with Target.disposeBrowserContext from best-effort cleanup.
    if (!journeyFailed) {
      const failures = closed.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Journey context cleanup failed");
    }
  }
}
