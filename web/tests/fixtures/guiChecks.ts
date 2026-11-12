import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";

/** Phone, tablet and desktop sizes of the rules coverage GUI test plan (T1). */
export const PLAY_VIEWPORTS = [
  { width: 360, height: 640 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
] as const;
export const DESKTOP = PLAY_VIEWPORTS[2];

/** The page itself never scrolls sideways; wide content scrolls inside its own container. */
export async function expectNoPageOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() =>
    document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
}

/** A control can be used at this width: scrolled into view, it lies inside the viewport horizontally. */
export async function expectWithinViewport(control: Locator): Promise<void> {
  await control.scrollIntoViewIfNeeded();
  const box = await control.boundingBox();
  const width = control.page().viewportSize()!.width;
  expect(box, "control has no layout box").not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
}

/** No serious or critical axe violation in the current state of the page. */
export async function expectAccessible(page: Page, state: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter(violation => violation.impact === "serious" || violation.impact === "critical")
      .map(violation => `${violation.id}: ${violation.nodes.map(node => node.target.join(" ")).join(" | ")}`),
    state,
  ).toEqual([]);
}

/** Activates a control from the keyboard alone. */
export async function pressFromKeyboard(control: Locator, key: "Enter" | "Space" = "Enter"): Promise<void> {
  await control.focus();
  await expect(control).toBeFocused();
  await control.page().keyboard.press(key);
}

/**
 * Runs a check at each play width and leaves the page at desktop size. The
 * check must be repeatable: it runs once per width in the same session.
 */
export async function atEachViewport(
  page: Page,
  check: (viewport: typeof PLAY_VIEWPORTS[number]) => Promise<void>,
): Promise<void> {
  for (const viewport of PLAY_VIEWPORTS) {
    await page.setViewportSize(viewport);
    await expectNoPageOverflow(page);
    await check(viewport);
    await expectNoPageOverflow(page);
  }
  await page.setViewportSize(DESKTOP);
}

/**
 * Uses one sheet or session-board action at every play width: by keyboard on
 * the phone width, by pointer otherwise. Each use waits for its own command
 * response, so a result left over from the previous width cannot satisfy
 * `settled`. Scans the page for accessibility before the first and after the
 * last use.
 */
export async function playAtEachViewport(
  page: Page,
  state: string,
  control: Locator,
  settled: () => Promise<void>,
): Promise<void> {
  await expectAccessible(page, `${state}: before use`);
  await atEachViewport(page, async ({ width }) => {
    await expectWithinViewport(control);
    const command = page.waitForResponse(response =>
      response.request().method() === "POST" && /\/api\/characters\/[0-9a-f-]+\/actions\//.test(response.url()));
    if (width === PLAY_VIEWPORTS[0].width) await pressFromKeyboard(control);
    else await control.click();
    expect((await command).status(), `${state} at ${width}px`).toBe(200);
    await settled();
  });
  await expectAccessible(page, `${state}: after use`);
}

/** The creator page: accessible at desktop size, and no sideways page scroll at tablet and phone widths. */
export async function expectCreatorUsable(page: Page, state: string): Promise<void> {
  await expectAccessible(page, state);
  for (const viewport of [PLAY_VIEWPORTS[1], PLAY_VIEWPORTS[0]]) {
    await page.setViewportSize(viewport);
    await expectNoPageOverflow(page);
  }
  await page.setViewportSize(DESKTOP);
}
