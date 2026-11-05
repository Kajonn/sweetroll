import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const key = () => randomUUID();
async function json(page: Page, method: string, path: string, data?: unknown) {
  const result = await page.evaluate(async ({ method, path, data }) => {
    const response = await fetch(path, { method, cache: "no-store", ...(data === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(data) }) });
    return { status: response.status, body: await response.json() };
  }, { method, path, data });
  expect(result.status, `${method} ${path}: ${JSON.stringify(result.body)}`).toBeGreaterThanOrEqual(200);
  expect(result.status).toBeLessThan(300);
  return result.body;
}

test("T1/T2 creator, publication, pinned sheets, portals and scoped navigation", async ({ page }, info) => {
  test.setTimeout(480_000);
  await page.goto("/");
  await json(page, "POST", "/dev/signin", { code: "code-test-a", redirectUri: new URL("/cb", page.url()).href });
  await page.reload();
  const systems: string[] = [], characters: string[] = [], campaigns: string[] = [];
  const clone = async (versionId: string) => {
    const workspace = (await json(page, "POST", "/api/systems", { source: { kind: "clone", versionId }, idempotencyKey: key() })).workspace;
    systems.push(workspace.system.systemId); return workspace;
  };
  try {
    const workspace = await clone("a0000000-0000-5000-8000-000000000002");
    const id = workspace.system.systemId;
    await page.goto(`/systems/${id}`);
    await expect(page.getByLabel("System colors", { exact: true })).toBeVisible();
    await page.getByTestId("metadata-name").fill(`T1 hosted ${key().slice(0, 8)}`);
    await page.getByLabel("System colors", { exact: true }).selectOption("blue");
    await expect.poll(async () => (await json(page, "GET", `/api/systems/${id}`)).workspace.draft.document.metadata.presentation?.colorPreset).toBe("blue");
    await page.reload();
    await expect(page.getByLabel("System colors", { exact: true })).toHaveValue("blue");
    await page.getByLabel("System style", { exact: true }).selectOption("classic");
    await expect.poll(async () => (await json(page, "GET", `/api/systems/${id}`)).workspace.draft.document.metadata.presentation?.componentStyle).toBe("classic");
    await page.getByTestId("document-editor-preview-toggle").click();
    await page.getByTestId("document-editor-publish").click();
    await expect(page.getByRole("dialog")).toHaveAttribute("data-system-preset", "blue");
    await expect(page.getByRole("dialog")).toHaveAttribute("data-system-style", "classic");
    expect(await page.getByRole("dialog").getByRole("heading").first().evaluate(el => getComputedStyle(el).fontFamily)).toContain("Georgia");
    await page.getByTestId("publish-dialog-semver").fill("1.0.0");
    await page.getByTestId("publish-dialog-submit").click();
    await expect(page.getByTestId("publish-dialog-success")).toBeVisible();
    await page.getByTestId("publish-dialog-close").click();
    const published = (await json(page, "GET", `/api/systems/${id}`)).workspace.versions[0];
    const exported = await json(page, "GET", `/api/system-versions/${published.versionId}/export`);
    expect(exported.package.presentation).toEqual({ colorPreset: "blue", componentStyle: "classic" });
    const cloned = await clone(published.versionId);
    expect(cloned.draft.document.metadata.presentation?.colorPreset).toBe("blue");
    const campaign = (await json(page, "POST", "/api/campaigns", { title: "T1 pinned campaign", systemVersionId: published.versionId, idempotencyKey: key() })).campaign;
    campaigns.push(campaign.campaignId);
    const character = (await json(page, "POST", `/api/campaigns/${campaign.campaignId}/characters`, { name: "T1 hero", entityDefinitionId: "character", expectedCampaignRevision: campaign.revision, idempotencyKey: key() })).character;
    characters.push(character.characterId);
    await page.getByLabel("System colors", { exact: true }).selectOption("ochre");
    await expect.poll(async () => (await json(page, "GET", `/api/systems/${id}`)).workspace.draft.document.metadata.presentation?.colorPreset).toBe("ochre");
    expect((await json(page, "GET", `/api/characters/${character.characterId}`)).character.projection.presentation.colorPreset).toBe("blue");
    expect((await json(page, "GET", `/api/campaigns/${campaign.campaignId}`)).campaign.presentation.colorPreset).toBe("blue");
    for (const width of [360, 1280]) for (const mode of ["light", "dark"] as const) for (const preset of ["default", "blue", "ochre"]) for (const style of ["default", "classic"]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(mode => { localStorage.setItem("sweetroll:theme", mode); }, mode);
      await page.goto(`/systems/${id}`);
      await page.getByLabel("System colors", { exact: true }).selectOption(preset);
      await page.getByLabel("System style", { exact: true }).selectOption(style);
      await expect(page.locator(`section[data-system-preset="${preset}"]`).first()).toBeVisible();
      await expect.poll(async () => (await json(page, "GET", `/api/systems/${id}`)).workspace.draft.document.metadata.presentation?.colorPreset).toBe(preset);
      await expect.poll(async () => (await json(page, "GET", `/api/systems/${id}`)).workspace.draft.document.metadata.presentation?.componentStyle ?? "default").toBe(style);
      await expect(page.locator(`section[data-system-preset="${preset}"]`).first()).toHaveAttribute("data-system-style", style);
      await expect(page.locator("html")).toHaveAttribute("data-theme", mode);
      const findings = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
      expect(findings.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
      await page.screenshot({ path: info.outputPath(`creator-${preset}-${style}-${mode}-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 360, height: 1000 });
    await page.evaluate(() => {
      const nodes = [...document.querySelectorAll<HTMLElement>("body, body *")].map(el => ({ el, font: parseFloat(getComputedStyle(el).fontSize), line: parseFloat(getComputedStyle(el).lineHeight) }));
      for (const { el, font, line } of nodes) { if (Number.isFinite(font)) el.style.fontSize = `${font * 2}px`; if (Number.isFinite(line)) el.style.lineHeight = `${line * 2}px`; }
    });
    await page.keyboard.press("Tab");
    await page.getByLabel("System style", { exact: true }).focus();
    expect(await page.getByLabel("System style", { exact: true }).evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe("none");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath("creator-classic-200-percent-360.png"), fullPage: true });
    await page.goto(`/characters/${character.characterId}`);
    await expect(page.locator('section[data-system-preset="blue"]')).toBeVisible();
    await expect(page.locator('section[data-system-preset="blue"]')).toHaveAttribute("data-system-style", "classic");
    await page.getByLabel("Ability Score", { exact: true }).fill("14");
    await page.getByLabel("Ability Score", { exact: true }).press("Tab");
    await page.getByRole("button", { name: "Check", exact: true }).click();
    await expect(page.getByText("Roll result", { exact: true })).toBeVisible();
    await page.goto("/account");
    expect(await page.locator("[data-system-preset]").count()).toBe(0);
    await page.goto(`/systems/${cloned.system.systemId}`);
    await expect(page.getByLabel("System colors", { exact: true })).toHaveValue("blue");
    // The cached, authorized character projection supplies offline colors.
    await page.goto(`/characters/${character.characterId}`);
    await expect(page.locator('section[data-system-preset="blue"]')).toBeVisible();
    await expect(page.getByText("Available offline", { exact: true })).toBeVisible({ timeout: 60_000 });
    await page.context().setOffline(true);
    await page.reload();
    await expect(page.locator('section[data-system-preset="blue"]')).toBeVisible();
    await page.context().setOffline(false);
  } finally {
    await page.context().setOffline(false);
    await page.goto("/");
    for (const id of characters) { const ch = (await json(page, "GET", `/api/characters/${id}`)).character; await json(page, "PATCH", `/api/characters/${id}`, { command: "archive", expectedRevision: ch.revision, idempotencyKey: key() }); }
    for (const id of campaigns) { const c = (await json(page, "GET", `/api/campaigns/${id}`)).campaign; await json(page, "POST", `/api/campaigns/${id}/archive`, { expectedCampaignRevision: c.revision, idempotencyKey: key() }); }
    for (const id of systems) await json(page, "PATCH", `/api/systems/${id}`, { lifecycle: "archived", access: "private" });
  }
});
