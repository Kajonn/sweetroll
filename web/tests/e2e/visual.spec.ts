import { test, expect } from "@playwright/test";

// Visual regression baselines at 360 (mobile) and 1280 (desktop) px.
// Baselines land under web/tests/visual/__screenshots__/ (configured in
// web/playwright.config.ts via snapshotPathTemplate). Run `npm run
// web:test:e2e:update` to generate the first baselines; subsequent runs
// diff against the committed PNGs.
//
// Per the design (design_v2.md §17.4 + docs/superpowers/specs/2026-09-04
// -i2-system-builder-design.md §Visual regression): the spec exercises
// the library, the document editor with the d20 fixture loaded, the
// sheet preview frame at both widths, the publish dialog, and the
// conflict-recovery banner.

const WIDTHS = [360, 1280] as const;

test.describe("visual: library", () => {
  for (const width of WIDTHS) {
    test(`at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/");
      await page.getByTestId("dev-signin").click();
      await expect(page.getByTestId("system-library")).toBeVisible();
      await expect(page).toHaveScreenshot(`library-${width}.png`);
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
      await expect(page).toHaveScreenshot(`document-editor-${width}.png`);
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
      const dialog = page.getByTestId("publish-dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveScreenshot(`publish-dialog-${width}.png`);
    });
  }
});

test.describe("visual: conflict banner", () => {
  // The conflict banner is a UI primitive that DocumentEditor renders
  // when useDraftSync detects a server-side revision change. The
  // document editor is not yet wired to mount the banner (draftSync is
  // exercised at the hook level in web/src/state/draftSync.test.tsx),
  // so we render the component statically via setContent for the
  // baseline. i18n strings and structure mirror ConflictBanner.tsx
  // verbatim; the CSS module is inlined so the baseline captures the
  // production look without depending on the editor wire-in. Future
  // wire-ins can swap this for a real conflict-triggered render without
  // touching the test name or screenshot path.
  const BANNER_HTML = `
    <aside role="alert" aria-live="assertive" data-testid="conflict-banner"
      style="display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:flex-start;
             padding:12px 16px;border:1px solid #fcd34d;background:#fffbeb;border-radius:8px;
             color:#92400e;font-family:system-ui,sans-serif;">
      <div aria-hidden="true" style="display:inline-flex;align-items:center;justify-content:center;padding-top:2px;color:#92400e;">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/>
          <line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
      </div>
      <div style="display:grid;gap:8px;min-width:0;">
        <p style="margin:0;font-size:13px;font-weight:500;line-height:1.4;">
          This draft was modified by another save (revision 42). Choose how to resolve the conflict.
        </p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" data-testid="conflict-banner-accept-theirs"
            style="display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:500;
                   padding:6px 12px;border-radius:6px;border:1px solid transparent;cursor:pointer;
                   background:#2563eb;color:#fff;">Reload theirs</button>
          <button type="button" data-testid="conflict-banner-keep-mine"
            style="display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:500;
                   padding:6px 12px;border-radius:6px;border:1px solid transparent;cursor:pointer;
                   background:#dc2626;color:#fff;">Keep mine (force save)</button>
          <button type="button" data-testid="conflict-banner-merge"
            style="display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:500;
                   padding:6px 12px;border-radius:6px;border:1px solid var(--color-border,#e5e7eb);
                   cursor:pointer;background:transparent;color:#111827;">Merge into server</button>
        </div>
      </div>
      <button type="button" aria-label="Dismiss" data-testid="conflict-banner-dismiss"
        style="display:inline-flex;align-items:center;justify-content:center;background:transparent;
               border:1px solid transparent;border-radius:6px;color:inherit;cursor:pointer;padding:4px;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </aside>
  `;

  for (const width of WIDTHS) {
    test(`at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.setContent(`<!DOCTYPE html><html><body style="margin:24px;background:#fff;">${BANNER_HTML}</body></html>`);
      const banner = page.getByTestId("conflict-banner");
      await expect(banner).toBeVisible();
      await expect(banner).toHaveScreenshot(`conflict-banner-${width}.png`);
    });
  }
});
