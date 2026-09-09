# Visual Baseline Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four rejected editor/preview renderings, make all visual tests assert meaningful geometry and stable product state, then review and replace the ten stale baselines.

**Architecture:** Keep responsive ownership where G3 placed it: `AppShell` owns non-overlaying chrome, `DocumentEditor` owns its panels, and `PreviewFrame` owns a constrained scrolling viewport around an exact-width preview canvas. Apply targeted metadata styling without starting the broader G5 creator migration. Browser assertions verify real geometry; component tests verify structure and authored CSS.

**Tech Stack:** React, TypeScript, CSS modules, Vitest + React Testing Library, Playwright, PostgreSQL 17.

**Spec:** `design_v2.md` Sections 10.1, 10.4, and 10.5; `docs/superpowers/plans/2026-09-08-gui-integration.md` G2, G3, and G9.

## Global Constraints

- Keep existing routes, APIs, document state, autosave, conflict, and character-session behavior unchanged.
- Phone layouts at 320-599px have no page-level horizontal scroll and use at least 44x44 CSS-pixel interactive targets.
- Tablet is 600-1023px; desktop is 1024px and wider.
- Sticky chrome must not cover focused controls, errors, or preview content.
- Do not migrate the complete creator to shared controls; that remains G5.
- Do not update a snapshot to hide a functional or layout error.
- Record only checks actually run; human inspection is required before accepting new PNGs.
- The Tablefolk reference remains unavailable (HTTP 401); do not invent its palette, typography, or spacing.

---

### Task 1: Responsive Metadata Controls And Stable Editor Capture

**Files:**
- Create: `web/src/editor/MetadataEditor.module.css`
- Modify: `web/src/editor/MetadataEditor.tsx`
- Modify: `web/src/editor/MetadataEditor.test.tsx`
- Modify: `web/tests/e2e/visual.spec.ts`

**Interfaces:**
- Consumes: existing `MetadataEditorProps`, blur-driven `flush()`, semantic G2 CSS tokens, and `data-testid="document-editor-autosave"`.
- Produces: locally styled metadata fields with a 44px minimum input height, an explicit `metadata-settings-row`, and a deterministic editor screenshot gate that waits for `Saved`.

- [ ] **Step 1: Write failing component tests for grouping and authored CSS**

Add tests to `MetadataEditor.test.tsx` that require the new grouping and stylesheet contract:

```tsx
it("groups language and default dice in a compact settings row", () => {
  render(<MetadataEditor document={doc} onChange={vi.fn()} />);
  const settings = screen.getByTestId("metadata-settings-row");
  expect(within(settings).getByLabelText("Language")).toBeInTheDocument();
  expect(within(settings).getByLabelText("Default dice")).toBeInTheDocument();
  expect(settings).not.toContainElement(screen.getByLabelText("Name"));
  expect(settings).not.toContainElement(screen.getByLabelText("Description"));
});

it("authors touch-sized responsive metadata controls", () => {
  const css = readFileSync(resolve(process.cwd(), "src/editor/MetadataEditor.module.css"), "utf8");
  expect(css).toMatch(/min-height:\s*44px/);
  expect(css).toMatch(/width:\s*100%/);
  expect(css).toMatch(/min-width:\s*0/);
  expect(css).toMatch(/@media\s*\(min-width:\s*1024px\)/);
  expect(css).toMatch(/grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
});
```

- [ ] **Step 2: Run the metadata tests and verify red**

Run: `npm test -- src/editor/MetadataEditor.test.tsx` from `web/`.

Expected: FAIL because `metadata-settings-row` and `MetadataEditor.module.css` do not exist.

- [ ] **Step 3: Add targeted metadata markup and styles**

Import `MetadataEditor.module.css`; replace the unwired global class strings with module classes; wrap only Language and Default dice in:

```tsx
<div className={styles.settingsRow} data-testid="metadata-settings-row">
  {/* existing Language and Default dice labels, unchanged */}
</div>
```

Implement a single-column mobile form and a two-column settings row from 1024px. Inputs and textarea use `width: 100%`, `min-width: 0`, inherited fonts, semantic surface/border/text/focus tokens, and `min-height: 44px` for text inputs. Keep reducer and blur/submit behavior unchanged.

- [ ] **Step 4: Make editor screenshots wait for an actual save**

In both document-editor visual cases, immediately before `toHaveScreenshot`, add:

```ts
await expect(page.getByTestId("document-editor-autosave")).toHaveText("Saved", {
  timeout: 30_000,
});
```

Use exact text so `Not saved yet` cannot satisfy the gate. Do not change production autosave timing.

- [ ] **Step 5: Run focused verification**

Run from `web/`:

```bash
npm test -- src/editor/MetadataEditor.test.tsx src/editor/DocumentEditor.test.tsx src/editor/viewLayouts.test.tsx
npm run typecheck
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add web/src/editor/MetadataEditor.tsx web/src/editor/MetadataEditor.module.css web/src/editor/MetadataEditor.test.tsx web/tests/e2e/visual.spec.ts
git commit -m "fix(gui): make metadata controls responsive and visual state deterministic"
```

---

### Task 2: Exact-Width Preview Canvas And Non-Overlaying Footer

**Files:**
- Modify: `web/src/preview/PreviewFrame.tsx`
- Modify: `web/src/preview/PreviewFrame.module.css`
- Modify: `web/src/preview/PreviewSheet.test.tsx`
- Modify: `web/src/editor/viewLayouts.test.tsx`
- Modify: `web/src/shell/AppShell.module.css`
- Modify: `web/src/shell/AppShell.test.tsx`

**Interfaces:**
- Consumes: `PreviewWidth = 360 | 1280`, existing `preview-frame-container`, editor pane containment, and `StatusBar` in `AppShell`.
- Produces: `preview-frame-viewport` as the sole horizontal scroll owner around an exact 360px/1280px `preview-frame-container`; footer remains in ordinary flow and cannot overlay content.

- [ ] **Step 1: Write failing structural tests**

In `PreviewSheet.test.tsx`, require this nesting:

```tsx
const viewport = screen.getByTestId("preview-frame-viewport");
const canvas = screen.getByTestId("preview-frame-container");
expect(viewport).toContainElement(canvas);
expect(canvas).toHaveStyle({ width: "360px" });
```

Replace the old `max-width: 100%` canvas assertion in `viewLayouts.test.tsx` with authored-CSS checks requiring `.viewport` to have `width/max-width: 100%`, `min-width: 0`, and `overflow-x: auto`, while `.container` is not clamped by `max-width: 100%`.

In `AppShell.test.tsx`, assert the header remains sticky and `.shell > footer` contains neither `position: sticky` nor `position: fixed`.

- [ ] **Step 2: Run the preview/shell tests and verify red**

Run from `web/`:

```bash
npm test -- src/preview/PreviewSheet.test.tsx src/editor/viewLayouts.test.tsx src/shell/AppShell.test.tsx
```

Expected: FAIL because there is no separate preview viewport, the canvas is clamped, and the footer is sticky.

- [ ] **Step 3: Separate viewport and canvas**

Change the `PreviewFrame` DOM to:

```tsx
<div className={styles.viewport} data-testid="preview-frame-viewport">
  <div
    className={styles.container}
    data-testid="preview-frame-container"
    data-width={width}
    style={{ width: `${width}px` }}
  >
    {children}
  </div>
</div>
```

Give `.frame` and `.viewport` `width: 100%`, `min-width: 0`, and `max-width: 100%`. Put `overflow-x: auto` on `.viewport`. Remove `max-width: 100%` and overflow ownership from `.container`; keep the canvas left-aligned and exactly as wide as the inline width.

- [ ] **Step 4: Return the status footer to ordinary flow**

In `AppShell.module.css`, remove `position: sticky`, `bottom`, and overlay `z-index` from `.shell > footer`; retain safe-area padding and background. Update comments and tests to state that the header is sticky while the footer is ordinary flow.

- [ ] **Step 5: Run focused verification**

Run from `web/`:

```bash
npm test -- src/preview/PreviewSheet.test.tsx src/editor/viewLayouts.test.tsx src/shell/AppShell.test.tsx
npm run typecheck
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add web/src/preview/PreviewFrame.tsx web/src/preview/PreviewFrame.module.css web/src/preview/PreviewSheet.test.tsx web/src/editor/viewLayouts.test.tsx web/src/shell/AppShell.module.css web/src/shell/AppShell.test.tsx
git commit -m "fix(gui): preserve preview canvas width and prevent footer overlap"
```

---

### Task 3: Browser Geometry Acceptance Guards

**Files:**
- Modify: `web/tests/e2e/visual.spec.ts`

**Interfaces:**
- Consumes: Task 1's stable `Saved` gate and Task 2's `preview-frame-viewport`/exact-width canvas.
- Produces: reusable browser assertions for page overflow, preview canvas geometry, reachable scroll extremes, and chrome overlap.

- [ ] **Step 1: Add a page-overflow assertion helper**

Add a helper that evaluates both document roots:

```ts
async function expectNoPageHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - window.innerWidth,
    body: document.body.scrollWidth - window.innerWidth,
  }));
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.body).toBeLessThanOrEqual(1);
}
```

Call it before every full-page screenshot.

- [ ] **Step 2: Add preview geometry assertions before its screenshot**

After awaiting the Sheets-tab click and selecting the intended width, evaluate viewport/canvas/body geometry. Assert:

- canvas bounding width is within 1px of 360 or 1280;
- viewport `scrollWidth` is within 1px of the declared width;
- editor body, app content, and document have no horizontal overflow;
- setting `viewport.scrollLeft = viewport.scrollWidth` reaches `scrollWidth - clientWidth` and resetting it reaches zero;
- at zero, canvas and viewport left edges differ by no more than 1px.

The 360 case may have `clientWidth === width`; require a positive scroll range only when `clientWidth < width`.

- [ ] **Step 3: Add overlap assertions**

Before preview screenshots, compare `preview-frame` and `status-bar` rectangles and assert zero intersection. Scroll the `Check` action into view and assert its rectangle does not intersect `app-header` or `status-bar`. For publish dialogs, assert the content rectangle is within the viewport. For conflict cases, assert message, both recovery buttons, and close control are visible before screenshotting.

- [ ] **Step 4: Prove the old implementation fails the new guards**

Run the preview tests before applying Task 2 (or temporarily stash Task 2 only), and record that canvas width assertions fail with approximately 278/566px actual widths or that the sticky-footer overlap assertion fails. Restore Task 2 immediately; do not commit a broken tree.

- [ ] **Step 5: Run browser verification without updating snapshots**

Use an isolated PostgreSQL database and run:

```bash
CI=1 \
DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll_visual \
AUTHORITATIVE_ROLL_SECRET=development-only-roll-secret-32-bytes \
BACKEND_PORT=3110 WEB_PORT=5174 \
SWEETROLL_BACKEND_TARGET=http://localhost:3110 \
npx playwright test tests/e2e/visual.spec.ts --reporter=list
```

Expected: all new functional/geometry assertions pass; screenshot comparisons still fail only because the committed PNGs are stale.

- [ ] **Step 6: Commit**

```bash
git add web/tests/e2e/visual.spec.ts
git commit -m "test(gui): assert visual-state and preview geometry before snapshots"
```

---

### Task 4: Review And Replace Visual Baselines

**Files:**
- Modify after review: `web/tests/visual/__screenshots__/visual.spec.ts/*.png`
- Modify: `docs/acceptance/gui-2026-09-09-g3-shell.md`

**Interfaces:**
- Consumes: Tasks 1-3 with all functional/geometry assertions green.
- Produces: ten reviewed snapshots and an acceptance record naming the exact commit, commands, browser, database, reviewer, findings, and limitations.

- [ ] **Step 1: Recreate the isolated database**

```bash
docker compose up -d postgres
docker compose exec -T postgres psql -U sweetroll -d postgres -c "DROP DATABASE IF EXISTS sweetroll_visual WITH (FORCE);"
docker compose exec -T postgres psql -U sweetroll -d postgres -c "CREATE DATABASE sweetroll_visual;"
```

- [ ] **Step 2: Generate candidate snapshots**

Run from `web/` with the Task 3 environment:

```bash
npx playwright test tests/e2e/visual.spec.ts --update-snapshots --reporter=list
```

Expected changed set: library, document-editor, sheet-preview, publish-dialog, and conflict-banner at 360px and 1280px. No other snapshot directory changes.

- [ ] **Step 3: Perform human visual inspection**

Inspect all ten candidate PNGs. Reject any image with missing/error/leaked content, page-level horizontal overflow, clipped controls, undersized metadata fields, `Not saved yet` editor state, compressed preview canvas evidence, or header/footer overlap. Record approval per image; do not infer approval from Playwright exit status.

- [ ] **Step 4: Lock the reviewed baselines**

Recreate `sweetroll_visual`, rerun without `--update-snapshots`, and require 10/10 pass:

```bash
npx playwright test tests/e2e/visual.spec.ts --reporter=list
```

- [ ] **Step 5: Update acceptance evidence**

Append a rendered-pixel review section to `docs/acceptance/gui-2026-09-09-g3-shell.md` containing the tested commit, exact environment/commands, Chromium version, 10-file result, named human approval, findings closed, and remaining real-device limitations. Do not claim Android Chrome or iPad Safari testing unless actually performed.

- [ ] **Step 6: Run final verification**

```bash
npm run web:typecheck
npm run web:test
npm run web:test:e2e
npm run contracts:check
git diff --check
```

Expected: all pass. `web:test:e2e` includes the ten visual checks and the existing routed flows.

- [ ] **Step 7: Commit**

```bash
git add web/tests/visual/__screenshots__/visual.spec.ts docs/acceptance/gui-2026-09-09-g3-shell.md
git commit -m "test(gui): accept reviewed responsive visual baselines"
```
