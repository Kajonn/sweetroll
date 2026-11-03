import { randomUUID } from "node:crypto";
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const key = () => randomUUID();
const D20 = "a0000000-0000-5000-8000-000000000002";
const title = "G9 Räddningsexpeditionen – Überlieferungen från den förlorade handelskaravanen";
const longLabel = "Förmågevärde – Widerstandsfähigkeit och extraordinär uppmärksamhetsförmåga";
async function http(page: Page, method: string, path: string, data?: unknown) {
  return page.evaluate(async ({ method, path, data }) => {
    const response = await fetch(path, { method, cache: "no-store", ...(data === undefined ? {} : {
      headers: { "content-type": "application/json" }, body: JSON.stringify(data),
    }) });
    const type = response.headers.get("content-type") ?? "";
    return { status: response.status, type, body: type.includes("json") ? await response.json() : null };
  }, { method, path, data });
}
async function json(page: Page, method: string, path: string, data?: unknown) {
  const r = await http(page, method, path, data);
  expect(r.status, `${method} ${path}`).toBeGreaterThanOrEqual(200);
  expect(r.status, `${method} ${path}`).toBeLessThan(300);
  expect(r.type).toContain("json"); return r.body;
}
async function signIn(page: Page) {
  await page.goto("/");
  await json(page, "POST", "/dev/signin", { code: "code-test-a", redirectUri: new URL("/cb", page.url()).href });
  await page.reload();
  await expect(page.getByRole("button", { name: "Sign out", exact: true }).first()).toBeVisible();
}
async function fixture(page: Page) {
  const created = await json(page, "POST", "/api/systems", { source: { kind: "clone", versionId: D20 }, idempotencyKey: key() });
  const systemId = created.workspace.system.systemId;
  const document = created.workspace.draft.document;
  document.metadata.name = title;
  document.entities[0].fields[0].label = longLabel;
  const saved = await json(page, "PUT", `/api/systems/${systemId}/draft`, { expectedRevision: created.workspace.draft.revision, document });
  const published = await json(page, "POST", `/api/systems/${systemId}/publish`, {
    expectedRevision: saved.workspace.draft.revision, semanticVersion: "1.0.0", releaseNotes: "G9 hosted fixture", acknowledgeBreaking: true, idempotencyKey: key(),
  });
  const versionId = published.version.versionId;
  const campaign = (await json(page, "POST", "/api/campaigns", { systemVersionId: versionId, title, idempotencyKey: key() })).campaign;
  const character = (await json(page, "POST", `/api/campaigns/${campaign.campaignId}/characters`, {
    name: "G9 Äventyraren med ett mycket långt karaktärsnamn", entityDefinitionId: "character", expectedCampaignRevision: campaign.revision, idempotencyKey: key(),
  })).character;
  return { systemId, versionId, campaignId: campaign.campaignId, characterId: character.characterId };
}
async function cleanup(page: Page, f: Awaited<ReturnType<typeof fixture>>) {
  const ch = (await json(page, "GET", `/api/characters/${f.characterId}`)).character;
  await json(page, "PATCH", `/api/characters/${f.characterId}`, { command: "archive", expectedRevision: ch.revision, idempotencyKey: key() });
  expect((await json(page, "GET", `/api/characters/${f.characterId}`)).character.lifecycle).toBe("archived");
  const c = (await json(page, "GET", `/api/campaigns/${f.campaignId}`)).campaign;
  await json(page, "POST", `/api/campaigns/${f.campaignId}/archive`, { expectedCampaignRevision: c.revision, idempotencyKey: key() });
  expect((await json(page, "GET", `/api/campaigns/${f.campaignId}`)).campaign.status).toBe("archived");
  await json(page, "PATCH", `/api/systems/${f.systemId}`, { lifecycle: "archived", access: "private" });
  expect((await json(page, "GET", `/api/systems/${f.systemId}`)).workspace.system).toMatchObject({ lifecycle: "archived", access: "private" });
}

for (const width of [360, 768, 1280]) for (const theme of ["light", "dark"] as const) {
  test(`routes, keyboard and accessibility ${width}px ${theme}`, async ({ page }) => {
    page.setDefaultTimeout(15_000);
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await signIn(page);
    const f = await fixture(page);
    const records: unknown[] = [];
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    async function inspect(name: string, url: string, tab?: string, enlarge = false) {
      await test.step(name, async () => {
        await page.goto(url);
        if (url === "/display") await expect(page.getByRole("heading", {name:"Connect this display"})).toBeVisible();
        else await expect(page.locator("main")).toBeVisible();
        if (tab) await page.getByRole("tab", { name: tab, exact: true }).click();
        if (url.includes("/systems/")) await expect(page.getByTestId("document-editor-header")).toBeVisible();
        if (url === `/characters/${f.characterId}`) await expect(page.getByLabel(longLabel, { exact: true })).toBeVisible();
        if (enlarge) await page.evaluate(() => {
          // Snapshot first: doubling ancestors must not compound child sizes.
          const sizes = Array.from(document.querySelectorAll<HTMLElement>("body, body *")).map(el => {
            const style = getComputedStyle(el);
            return { el, font: parseFloat(style.fontSize), line: parseFloat(style.lineHeight) };
          });
          for (const { el, font, line } of sizes) {
            el.style.setProperty("font-size", `${font * 2}px`, "important");
            if (Number.isFinite(line)) el.style.setProperty("line-height", `${line * 2}px`, "important");
          }
        });
        const dimensions = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth, offenders: Array.from(document.querySelectorAll<HTMLElement>("body *")).map(el => ({tag: el.tagName, testId: el.dataset.testid, cls: el.className, text: el.textContent?.slice(0,70), right: el.getBoundingClientRect().right, width: el.getBoundingClientRect().width})).filter(e => e.right > innerWidth + 1).slice(0,30) }));
        const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
        const violations = axe.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) }));
        records.push({ name, width, theme, enlargement: enlarge ? "computed fonts/line heights 200% (CSS text-size emulation)" : "normal", dimensions, violations });
        expect.soft(dimensions.scroll, `${name} horizontal overflow`).toBeLessThanOrEqual(dimensions.viewport + 1);
        expect.soft(violations, `${name} WCAG A/AA violations`).toEqual([]);
        // An actual Tab keystroke must reach a rendered focus target.
        await page.keyboard.press("Tab");
        expect.soft(await page.evaluate(() => {
          const a = document.activeElement;
          return !!a && a !== document.body && a.getBoundingClientRect().width > 0;
        }), `${name} keyboard focus`).toBe(true);
        if (["character", "campaign-Content", "creator-sections", "account", "character-enlarged", "campaign-enlarged", "creator-enlarged"].includes(name)) {
          await test.info().attach(`${name}-${width}-${theme}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
        }
      });
    }
    try {
      for (const [name, url] of [["library", "/"], ["characters", "/characters"], ["new-character", `/characters/new?systemVersionId=${f.versionId}`], ["character", `/characters/${f.characterId}`], ["campaigns", "/campaigns"], ["new-campaign", "/campaigns/new"], ["activity", "/activity"], ["account", "/account"], ["invitations", "/invitations"], ["display-entry", "/display"]]) {
        await inspect(name!, url!);
      }
      for (const tab of ["Characters", "Content", "Items & powers", "Members", "Session", "Settings", "Activity"]) {
        await inspect(`campaign-${tab}`, `/campaigns/${f.campaignId}`, tab);
      }
      for (const tab of ["basics", "attributes", "templates", "sections", "dice", "advanced"]) {
        await inspect(`creator-${tab}`, `/systems/${f.systemId}?tab=${tab}`);
      }
      await inspect("character-enlarged", `/characters/${f.characterId}`, undefined, true);
      await inspect("campaign-enlarged", `/campaigns/${f.campaignId}`, "Content", true);
      await inspect("creator-enlarged", `/systems/${f.systemId}?tab=sections`, undefined, true);
      // Deep-link refresh and keyboard-driven tab activation.
      await page.goto(`/campaigns/${f.campaignId}`); await page.reload();
      const content = page.getByRole("tab", { name: "Content", exact: true });
      await content.focus(); await page.keyboard.press("Enter");
      await expect(page.getByLabel("Title", { exact: true })).toBeVisible();
      // Callback return with a real test-auth session, not a real-provider flow.
      await page.evaluate(() => sessionStorage.setItem("sweetroll:postSignin", "/campaigns"));
      await page.goto("/cb"); await expect(page).toHaveURL(/\/campaigns$/);
      expect.soft(errors).toEqual([]);
    } finally {
      await page.goto("/");
      await cleanup(page, f);
      await test.info().attach("g9-route-evidence", { body: JSON.stringify({ fixture: f, records, errors, cleanup: "independently verified archived/private" }, null, 2), contentType: "application/json" });
    }
  });
}
