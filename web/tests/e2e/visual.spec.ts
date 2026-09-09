import { test, expect } from "@playwright/test";

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
      page.getByTestId("document-editor-tab-sheets").click();
      await page.getByTestId("document-editor-preview-toggle").click();
      createdSystemIds.push(page.url().split("/").pop() ?? "");
      const frame = page.getByTestId("preview-frame");
      // PreviewFrame defaults to 360; toggle once to land on 1280 when needed.
      if (width === 1280) {
        await page.getByTestId("preview-frame-toggle").click();
      }
      await expect(frame).toHaveAttribute("data-width", String(width));
      await expect(frame).toHaveScreenshot(`sheet-preview-${width}.png`);
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
      await expect(banner).toHaveScreenshot(`conflict-banner-${width}.png`);
    });
  }
});
