import { test, expect, type Page } from "@playwright/test";

// Visual regression baselines at 360 (mobile) and 1280 (desktop) px.
// Baselines land under web/tests/visual/__screenshots__/ (configured in
// web/playwright.config.ts via snapshotPathTemplate). Run `npm run
// web:test:e2e:update` to generate the first baselines; subsequent runs
// diff against the committed PNGs.
//
// Tests that clone the d20 fixture clean up the cloned system afterwards
// (DELETE /api/systems/:systemId) so the library column stays
// deterministic and baselines do not drift across runs.
//
// Per the design (design_v2.md §17.4 + docs/superpowers/specs/2026-09-04
// -i2-system-builder-design.md §Visual regression): the spec exercises
// the library, the document editor with the d20 fixture loaded, the
// sheet preview frame at both widths, the publish dialog, and the
// conflict-recovery banner.

const WIDTHS = [360, 1280] as const;

// Track systems cloned by these tests so test.afterEach can delete them
// even when an assertion fails before the in-test cleanup line runs.
// page.request shares the browser context's cookies (dev sign-in), so the
// deletes are authorized. Keeps the shared DB deterministic across runs.
const createdSystemIds: string[] = [];
test.afterEach(async ({ page }) => {
  for (const id of createdSystemIds.splice(0)) {
    await page.request.delete(`/api/systems/${id}`).catch(() => {});
  }
});

async function expectNoPageHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - window.innerWidth,
    body: document.body.scrollWidth - window.innerWidth,
  }));
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.body).toBeLessThanOrEqual(1);
}

type Rect = { left: number; top: number; right: number; bottom: number };

function intersectionArea(a: Rect, b: Rect): number {
  const xOverlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const yOverlap = Math.max(0, Math.min(a.top, b.top) - Math.max(a.top, b.top));
  return xOverlap * yOverlap;
}

async function rectOf(page: Page, testId: string): Promise<Rect | null> {
  return page.evaluate((id: string) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!(el instanceof HTMLElement)) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }, testId);
}

test.describe("visual: library", () => {
  for (const width of WIDTHS) {
    test(`at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/");
      await page.getByTestId("dev-signin").click();
      // The list can legitimately be empty (deterministic template-only DB),
      // which gives the <ul> zero height; assert it is attached rather than
      // visible so the screenshot captures the empty-library state.
      await expect(page.getByTestId("system-library")).toBeAttached();
      await expect(page.getByTestId("library-new-system")).toBeVisible();
      await expectNoPageHorizontalOverflow(page);
      // Mask the footer: StatusBar shows the per-mount random request-id
      // (by design, I2 task 1 request/error correlation). It is random per
      // mount and width varies with its hex digits, so it would make this
      // full-page baseline non-deterministic.
      await expect(page).toHaveScreenshot(`library-${width}.png`, {
        mask: [page.getByTestId("status-bar")],
      });
    });
  }
});

test.describe("visual: document editor (d20)", () => {
  for (const width of WIDTHS) {
    test(`at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/");
      await page.getByTestId("dev-signin").click();
      await page.getByTestId("clone-from-template-d20").click();
      await expect(page.getByTestId("document-editor-header")).toBeVisible();
      await expect(page.getByTestId("document-editor-name")).toBeVisible();
      createdSystemIds.push(page.url().split("/").pop() ?? "");
      await expect(page.getByTestId("document-editor-autosave")).toHaveText("Saved", {
        timeout: 30_000,
      });
      await expectNoPageHorizontalOverflow(page);
      await expect(page).toHaveScreenshot(`document-editor-${width}.png`, {
        mask: [page.getByTestId("status-bar")],
      });
    });
  }
});

test.describe("visual: sheet preview", () => {
  for (const width of WIDTHS) {
    test(`at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/");
      await page.getByTestId("dev-signin").click();
      await page.getByTestId("clone-from-template-d20").click();
      await expect(page.getByTestId("document-editor-header")).toBeVisible();
      await page.getByTestId("document-editor-tab-sheets").click();
      await page.getByTestId("document-editor-preview-toggle").click();
      createdSystemIds.push(page.url().split("/").pop() ?? "");
      const frame = page.getByTestId("preview-frame");
      // PreviewFrame defaults to 360; toggle once to land on 1280 when needed.
      if (width === 1280) {
        await page.getByTestId("preview-frame-toggle").click();
      }
      await expect(frame).toHaveAttribute("data-width", String(width));

      // The canvas width transition (0.2s ease) must settle before measuring:
      // assert the real settled geometry, not a mid-flight animation frame.
      await page.waitForFunction((expected: number) => {
        const canvas = document.querySelector('[data-testid="preview-frame-container"]');
        return canvas instanceof HTMLElement &&
          Math.abs(canvas.getBoundingClientRect().width - expected) <= 1;
      }, width, { timeout: 10_000 });

      // Exact-width canvas inside its scrolling viewport: the canvas keeps
      // the declared width, the viewport owns horizontal scrolling, and no
      // surrounding surface overflows the page.
      const geometry = await page.evaluate((expected: number) => {
        const viewport = document.querySelector('[data-testid="preview-frame-viewport"]');
        const canvas = document.querySelector('[data-testid="preview-frame-container"]');
        if (!(viewport instanceof HTMLElement) || !(canvas instanceof HTMLElement)) return null;
        viewport.scrollLeft = 0;
        const canvasRect = canvas.getBoundingClientRect();
        const viewportRect = viewport.getBoundingClientRect();
        const body = document.querySelector('[data-testid="document-editor-body-sheets"]');
        const app = document.querySelector('[data-testid="app-content"]');
        const maxScroll = viewport.scrollWidth - viewport.clientWidth;
        viewport.scrollLeft = viewport.scrollWidth;
        const reached = viewport.scrollLeft;
        viewport.scrollLeft = 0;
        return {
          canvasWidth: canvasRect.width,
          viewportScrollWidth: viewport.scrollWidth,
          viewportClientWidth: viewport.clientWidth,
          bodyOverflow: body instanceof HTMLElement ? body.scrollWidth - body.clientWidth : 0,
          appOverflow: app instanceof HTMLElement ? app.scrollWidth - app.clientWidth : 0,
          documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
          pageBodyOverflow: document.body.scrollWidth - window.innerWidth,
          atZeroDelta: canvasRect.left - viewportRect.left,
          maxScroll,
          reached,
          reset: viewport.scrollLeft,
        };
      }, width);
      expect(geometry).not.toBeNull();
      const g = geometry!;
      expect(Math.abs(g.canvasWidth - width)).toBeLessThanOrEqual(1);
      expect(Math.abs(g.viewportScrollWidth - width)).toBeLessThanOrEqual(1);
      expect(g.bodyOverflow).toBeLessThanOrEqual(1);
      expect(g.appOverflow).toBeLessThanOrEqual(1);
      expect(g.documentOverflow).toBeLessThanOrEqual(1);
      expect(g.pageBodyOverflow).toBeLessThanOrEqual(1);
      // The 360 case may have clientWidth === width; require a positive
      // scroll range only when clientWidth < width.
      if (g.viewportClientWidth < width) {
        expect(g.maxScroll).toBeGreaterThan(0);
        expect(Math.abs(g.reached - g.maxScroll)).toBeLessThanOrEqual(1);
      }
      expect(g.reset).toBe(0);
      expect(Math.abs(g.atZeroDelta)).toBeLessThanOrEqual(1);

      // Chrome overlap: the preview frame never intersects the status bar,
      // and the Check action stays clear of header and status bar.
      const frameRect = await rectOf(page, "preview-frame");
      const statusRect = await rectOf(page, "status-bar");
      expect(frameRect).not.toBeNull();
      expect(statusRect).not.toBeNull();
      expect(intersectionArea(frameRect!, statusRect!)).toBe(0);
      await page.getByTestId("preview-action-check_element").scrollIntoViewIfNeeded();
      const checkRect = await rectOf(page, "preview-action-check_element");
      const headerRect = await rectOf(page, "app-header");
      const statusAfterScroll = await rectOf(page, "status-bar");
      expect(checkRect).not.toBeNull();
      expect(headerRect).not.toBeNull();
      expect(statusAfterScroll).not.toBeNull();
      expect(intersectionArea(checkRect!, headerRect!)).toBe(0);
      expect(intersectionArea(checkRect!, statusAfterScroll!)).toBe(0);

      // The overlap guard deliberately scrolls the bottom action into view.
      // Restore the editor pane before capture so the baseline represents the
      // preview entry state, including its width controls, rather than a
      // transient post-assertion scroll position.
      await page.getByTestId("document-editor-body-sheets").evaluate((element) => {
        element.scrollTop = 0;
      });
      const header = page.getByTestId("app-header");
      await header.evaluate((element) => {
        element.style.position = "static";
      });
      try {
        await expect(frame).toHaveScreenshot(`sheet-preview-${width}.png`);
      } finally {
        await header.evaluate((element) => {
          element.style.removeProperty("position");
        });
      }
    });
  }
});

test.describe("visual: publish dialog", () => {
  for (const width of WIDTHS) {
    test(`at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/");
      await page.getByTestId("dev-signin").click();
      await page.getByTestId("clone-from-template-d20").click();
      await expect(page.getByTestId("document-editor-header")).toBeVisible();
      await page.getByTestId("document-editor-publish").click();
      createdSystemIds.push(page.url().split("/").pop() ?? "");
      const dialog = page.getByTestId("publish-dialog");
      await expect(dialog).toBeVisible();
      // The dialog content stays within the viewport (no clipped actions).
      const dialogGeometry = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="publish-dialog"]');
        if (!(el instanceof HTMLElement)) return null;
        const r = el.getBoundingClientRect();
        return {
          left: r.left,
          top: r.top,
          right: r.right,
          bottom: r.bottom,
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
        };
      });
      expect(dialogGeometry).not.toBeNull();
      expect(dialogGeometry!.left).toBeGreaterThanOrEqual(-1);
      expect(dialogGeometry!.top).toBeGreaterThanOrEqual(-1);
      expect(dialogGeometry!.right).toBeLessThanOrEqual(dialogGeometry!.innerWidth + 1);
      expect(dialogGeometry!.bottom).toBeLessThanOrEqual(dialogGeometry!.innerHeight + 1);
      await expect(dialog).toHaveScreenshot(`publish-dialog-${width}.png`);
    });
  }
});

test.describe("visual: conflict banner", () => {
  // The production ConflictBanner mounted by DocumentEditor when useDraftSync
  // receives a 409 with a newer server revision. This exercises the real
  // routed flow: clone the d20 fixture, let the mount autosave settle, advance
  // the server revision out-of-band through the same PUT /systems/:id/draft
  // contract the UI uses (simulating another writer), then edit locally so the
  // debounced autosave fires with a stale expectedRevision. Test name and
  // screenshot paths are unchanged; only the setup is real.
  for (const width of WIDTHS) {
    test(`at ${width}px`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/");
      await page.getByTestId("dev-signin").click();
      // Register before the click so the mount autosave cannot slip past us:
      // the editor schedules its first PUT ~600ms after mounting.
      const firstSave = page.waitForResponse(
        (r) => r.request().method() === "PUT" && r.url().includes("/draft"),
        { timeout: 30_000 },
      );
      await page.getByTestId("clone-from-template-d20").click();
      await expect(page.getByTestId("document-editor-header")).toBeVisible();
      await firstSave;
      const systemId = page.url().split("/").pop() ?? "";
      createdSystemIds.push(systemId);

      const openRes = await page.request.get(`/api/systems/${systemId}`);
      expect(openRes.ok()).toBeTruthy();
      const workspace = (await openRes.json() as { workspace: { draft: { revision: number; document: unknown } } }).workspace;

      // Another writer saves first with the current revision.
      const rival = await page.request.put(`/api/systems/${systemId}/draft`, {
        data: { expectedRevision: workspace.draft.revision, document: workspace.draft.document },
      });
      expect(rival.ok()).toBeTruthy();

      // Local edit with a now-stale expectedRevision: the debounced autosave
      // hits 409 and the production banner mounts. Tabbing to the entities
      // tab blurs the contentEditable name so the edit dispatches.
      const name = page.getByTestId("document-editor-name");
      await name.click();
      await page.keyboard.press("Control+A");
      await page.keyboard.type(`Conflict Demo ${width}`);
      await page.getByTestId("document-editor-tab-entities").click();

      const banner = page.getByTestId("conflict-banner");
      await expect(banner).toBeVisible({ timeout: 30_000 });
      // Recovery controls and the message must be on screen: both recovery
      // buttons, the dismiss control, and the message text.
      await expect(banner.locator("p")).toBeVisible();
      await expect(page.getByTestId("conflict-banner-accept-theirs")).toBeVisible();
      await expect(page.getByTestId("conflict-banner-keep-mine")).toBeVisible();
      await expect(page.getByTestId("conflict-banner-dismiss")).toBeVisible();
      await expect(banner).toHaveScreenshot(`conflict-banner-${width}.png`);
    });
  }
});
