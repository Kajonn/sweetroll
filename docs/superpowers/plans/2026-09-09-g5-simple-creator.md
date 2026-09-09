# G5 Simple Creator Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the G5 simple system creator: a basics-first workflow (descriptions, attributes + dice, ordered sections, preview, publish) with advanced controls behind disclosure, reusing G1 lifecycle and G4 shared controls.

**Architecture:** Keep `DocumentEditor` + `useDraftSync` as the single save/conflict owner; add a basics-first tab structure with an explicit Advanced disclosure, migrate creator surfaces to `web/src/ui/` shared controls, fix expression/advanced-definition round-trip loss, add a phone editor/preview switch on top of the existing desktop split, and close the publish → create-character handoff.

**Tech Stack:** React 18 + TypeScript, TanStack Router/Query, CSS modules + semantic tokens (`web/src/styles/global.css`), Radix primitives via `web/src/ui/`, Lucide icons, existing `CharactersApi` / system workspace API clients, Vitest + Testing Library, Playwright e2e.

**Spec:** `docs/superpowers/plans/2026-09-08-gui-integration.md` (G5 section, lines 134-144), `design_v2.md` §§10, 17.3-17.4, 17.6a (I2 builder + I4a acceptance)

## Global Constraints

- Retain React, TanStack Router/Query, CSS modules, Radix primitives, Lucide icons, generated API types, existing character projection/session model.
- Keep Sweetroll branding; Tablefolk mockup is visual reference only (mockup URL still HTTP 401 — do not invent Tablefolk values).
- Do not rewrite backend, change published package formats, duplicate rules interpreter/character renderer, discard offline queues, or import mockup simulated auth/publishing/sync.
- Do not expand or remove grammar v0.1; no freeform canvas, arbitrary sheet tabs, grid/initiative/movement/vision/lighting/combat sim, arbitrary CSS, or theme editor.
- Preserve existing routes and data; URL changes need redirect + deep-link tests.
- Phone 320–599 single column, tablet 600–1023, desktop 1024+; 44×44 touch targets, visible `:focus-visible`, reduced-motion; feature CSS uses only semantic tokens (never `var(--color-*)`).
- `npm run test:integration` keeps `--no-file-parallelism` and load limits; each PR states G task, routes, behavior preserved, tests run, before/after screenshots where visual changed.

---

## File map

| Area | Files to modify | Responsibility |
|---|---|---|
| Creator shell | `web/src/editor/DocumentEditor.tsx`, `DocumentEditor.module.css`, `web/src/editor/viewLayouts.test.tsx` | Basics-first tabs + Advanced disclosure + phone editor/preview switch + save/validation/conflict wiring |
| Metadata/basics | `web/src/editor/MetadataEditor.tsx`, `MetadataEditor.module.css`, `MetadataEditor.test.tsx` | Basics form on shared controls (name, description, language, default dice) |
| Entities/fields | `web/src/editor/EntityList.tsx`, `web/src/editor/fields/*.tsx` | Shared-control migration without double-labels; preserve computed/resource/advanced defs |
| Sheets/sections | `web/src/editor/sheet/*.tsx` | Ordered sections with keyboard move controls; no canvas/tabs |
| Actions/validations/advanced | `web/src/editor/actions/RollActionEditor.tsx`, `ResourceBumpEditor.tsx`, `web/src/editor/validations/ValidationEditor.tsx`, `web/src/editor/expressions/ExpressionEditor.tsx`, `web/src/editor/referenceData/ReferenceDataEditor.tsx` | Move behind Advanced disclosure; fix `expressionSourceMap` local-Map loss and `ComputedFieldEditor` local-state loss |
| Library/create | `web/src/library/SystemLibrary.tsx`, `CreateDraftDialog.tsx`, `CloneFromTemplate.tsx` | Shared controls, explicit draft vs published signal |
| Publish/versions | `web/src/publish/PublishDialog.tsx`, `VersionHistory.tsx` | Readiness summary, draft-vs-published distinction, post-publish create-character CTA |
| Preview | `web/src/editor/PreviewFrame.tsx`, `web/src/preview/*` | Phone switch + desktop split reuse; truthful preview (do not silently drop expressions) |
| E2E/acceptance | `web/tests/e2e/acceptance.spec.ts`, `web/tests/e2e/visual.spec.ts`, `docs/acceptance/gui-YYYY-MM-DD.md` | Exit demonstration evidence |

---

### Task 1: Fix advanced-definition round-trip loss (blocks G5 disclosure safety)

**Files:**
- Modify: `web/src/editor/DocumentEditor.tsx:649-651,676-678` (ActionsTab local `expressionSourceMap`), `web/src/editor/validations/ValidationEditor.tsx` equivalent map if present, `web/src/editor/fields/ComputedFieldEditor.tsx:43,167-211` (local `draftSource/fallback`), `web/src/editor/EntityList.tsx:112-151` (computed placeholder + resource/computed→text coercion), `web/src/editor/PreviewFrame.tsx` / `buildPreviewPackage` in `DocumentEditor.tsx:927-962` (`expressions:[]` drop)
- Test: `web/src/editor/advancedPreservation.test.tsx` (new, colocated with editor tests)

**Interfaces:**
- Consumes: `documentReducer` actions (`setEntities`, `replace`), `useDraftSync.save/cancel/isConfirmed`, existing `onExpressionSourceChange(sourceId, source)` callback shape.
- Produces: `persistExpressionSource(sourceId, source): void` — dispatches into `document.expressions` (not a render-local Map); `commitComputedSource(fieldId, source, fallback): void` — writes back to document instead of local-only state.

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/editor/advancedPreservation.test.tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { DocumentEditorBody } from "./DocumentEditor.js"; // or the exported tab under test

test("editing a roll expression source persists it into the document (not a render-local Map)", () => {
  // render ActionsTab with one roll action that has expressionId E1
  // change expression source via ExpressionEditor onExpressionSourceChange
  // force rerender (e.g. switch tabs and back)
  // expect document.expressions to still contain the edited source for E1
  // TODAY: fails — source lives only in the per-render Map and is lost
});

test("editing a computed field source writes back to the document", () => {
  // render ComputedFieldEditor, change source, blur/commit
  // expect onChange called with updated expression source
  // TODAY: fails — draftSource/fallback stay in useState
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/editor/advancedPreservation.test.tsx` from `web/`
Expected: FAIL (source lost on rerender / onChange never receives computed source)

- [ ] **Step 3: Write minimal implementation**
  - Replace the per-render `new Map()` for `expressionSourceMap` in `ActionsTab` (and ValidationsTab if identical) with state dispatched into `document.expressions` via the existing reducer (`onExpressionSourceChange` → `dispatch` + parent `onChange`), so tab switches/rerenders retain edits.
  - In `ComputedFieldEditor`, commit `draftSource/fallback` to `onChange` on blur/valid submit instead of keeping it in `useState` only; keep the local draft as ephemeral edit buffer.
  - In `EntityList.defaultField`, stop coercing `resource`/`computed` kinds to `text` on edit; render a read-only summary row for unsupported kinds with an explicit "unsupported in basics — preserved" note instead of rewriting the kind.
  - In `buildPreviewPackage`, stop hardcoding `expressions:[]`; pass through `document.expressions` (preview may still mark expression-backed values as sampled, but must not silently drop them).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/editor/advancedPreservation.test.tsx src/editor/DocumentEditor.test.tsx src/editor/actions/RollActionEditor.test.tsx src/editor/validations/ValidationEditor.test.tsx src/editor/fields/ComputedFieldEditor.test.tsx` from `web/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/editor web/src/editor/advancedPreservation.test.tsx
git commit -m "fix(g5): preserve advanced expression definitions on edit and preview"
```

---

### Task 2: Basics-first workflow with Advanced behind disclosure

**Files:**
- Modify: `web/src/editor/DocumentEditor.tsx:37-46,380-440` (TABS + DocumentEditorBody tab render), `web/src/editor/MetadataEditor.tsx:11-101`, `web/src/editor/sheet/SheetEditor.tsx`, `SectionEditor.tsx`
- Test: `web/src/editor/basicsWorkflow.test.tsx` (new)

**Interfaces:**
- Consumes: Task 1 `persistExpressionSource`/`commitComputedSource` (advanced edits safe to hide); shared `Tabs`, `Panel`, `FormField`, `Select`, `Button`, `EmptyState` from `web/src/ui/index.ts`.
- Produces: `CreatorTabs value: "basics" | "attributes" | "dice" | "sections" | "advanced"` — basics = metadata/descriptions + dice defaults; attributes = entities/fields basics; dice = roll actions basics; sections = sheet order; advanced = validations + referenceData + expression editors behind a labeled disclosure (`"Advanced (expressions, validations, reference data)"`).

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/editor/basicsWorkflow.test.tsx
import { render, screen, fireEvent } from "@testing-library/react";

test("simple system path needs no expression: basics → attributes → dice → sections → preview → publish", async () => {
  // render DocumentEditorBody with blankDocument()
  // expect default tab "basics" with name/description/language/default-dice fields
  // add attribute via attributes tab WITHOUT opening any ExpressionEditor
  // add roll action via dice tab using guided fields only (label/kind/inputs), no grammar input
  // add + reorder a sheet section, expect Move up/down buttons with keyboard (Alt+Arrow) support
  // TODAY: fails — all six raw tabs exposed equally, expression grammar required
});

test("advanced controls sit behind a labeled disclosure and never block basics", () => {
  // expect a control labelled /Advanced.*expression|validation|reference/i that is collapsed by default
  // expanding it reveals ValidationsTab + ReferenceDataTab + ExpressionEditor surfaces
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/editor/basicsWorkflow.test.tsx` from `web/`
Expected: FAIL (no basics tab / no advanced disclosure)

- [ ] **Step 3: Write minimal implementation**
  - Reorganize `TABS` into the five-step order above; keep old tab ids as aliases so `focus-editor:{path}` deep links (`data-path=/sheets|/actions|/validations|/referenceData`) and existing tests keep resolving.
  - Basics tab composes the existing `MetadataEditor` fields (name, description, language, default dice) — no new API, stable IDs unchanged.
  - Attributes tab reuses `EntityList` with a kind picker on add (default `text`, options for number/choice/resource) instead of always adding `text`.
  - Dice tab reuses `RollActionEditor` in a guided mode: label + dice-kind + inputs; expression source editing moves to Advanced.
  - Sections tab reuses `SheetEditor`/`SectionEditor` ordering (existing Alt+Arrow + Move buttons); sheets/entities add/remove stays, no canvas/tabs.
  - Advanced disclosure is a native `<details>` or shared `Panel` with an explicit label; collapsed by default; contains validations, reference data, and expression editors. Preserve every advanced definition byte-for-byte when untouched (Task 1).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/editor/basicsWorkflow.test.tsx src/editor/DocumentEditor.test.tsx src/editor/sheet/SheetEditor.test.tsx` from `web/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/editor
git commit -m "feat(g5): basics-first creator with advanced behind disclosure"
```

---

### Task 3: Migrate creator surfaces to shared controls (no double-labels)

**Files:**
- Modify: `web/src/editor/MetadataEditor.tsx:58,69,81,92`, `EntityList.tsx:201,229,284,300,339,364`, `SheetEditor.tsx`, `SectionEditor.tsx`, `ElementEditor.tsx`, `RollActionEditor.tsx`, `ResourceBumpEditor.tsx`, `ValidationEditor.tsx`, `ReferenceDataEditor.tsx`, `ExpressionEditor.tsx`, `DocumentEditor.tsx` header/tab buttons, `web/src/library/SystemLibrary.tsx:27-43`, `CreateDraftDialog.tsx:54-106`, `web/src/publish/PublishDialog.tsx:159-247`, related `*.module.css` (tokens only)
- Test: extend `web/src/editor/MetadataEditor.test.tsx`, `EntityList.test.tsx`, `web/src/library/CreateDraftDialog.test.tsx`, `web/src/publish/PublishDialog.test.tsx` (assert shared-control roles/labels, no duplicate `<label>`)

**Interfaces:**
- Consumes: `Button`, `FormField`, `Select`, `NumberInput`, `Checkbox`, `Panel`, `PageHeader`, `EmptyState`, `Dialog` from `web/src/ui/index.ts`; G4 composition pattern (`CreateCharacter.tsx:726-819`); Task 2 tab structure.
- Produces: Same component APIs (props unchanged); visual/behavioral contract: every creator input has one accessible label, 44px targets, `:focus-visible`, token-only CSS.

- [ ] **Step 1: Write the failing test**

```tsx
// extend web/src/editor/MetadataEditor.test.tsx
test("metadata fields use one label each (no double-label)", () => {
  render(<MetadataEditor document={doc} onChange={() => {}} />);
  const name = screen.getByLabelText(/name/i);
  // expect exactly one label element associated with the name input
  expect(document.querySelectorAll(`label[for="${name.id}"]`)).toHaveLength(1);
});
```

```tsx
// extend web/src/publish/PublishDialog.test.tsx
test("publish dialog uses shared Button roles", () => {
  // render dialog, expect submit button with accessible name /Publish/i using shared Button variant=primary
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/editor/MetadataEditor.test.tsx src/publish/PublishDialog.test.tsx` from `web/`
Expected: FAIL (raw inputs without `FormField` single-label association / raw buttons)

- [ ] **Step 3: Write minimal implementation**
  - Wrap creator inputs in shared `FormField` (label/hint/error), `Select`, `NumberInput`, `Checkbox`; replace raw `<button>` with shared `Button` (`primary` for submit/publish, `secondary` for secondary actions); wrap panels in `Panel`, empty states in `EmptyState`, dialogs in shared `Dialog` where no custom focus/transaction logic blocks it.
  - Respect G4 deliberate partials: do NOT wrap `FieldControl`-style label+input pairs that would double-label; do NOT replace `CharacterTools`/`ConflictReview` custom focus logic; keep `#character-completion` and diagnostics focus ids.
  - CSS: consume only semantic tokens (`--surface-*`, `--text-*`, `--action-*`, `--status-*`, `--border-default`, `--font-body`, `--radius-panel`, `--focus-ring`); keep `:focus-visible` + 44px floor + `prefers-reduced-motion` (mirror `Button.module.css`, `surfaces.module.css`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/editor/MetadataEditor.test.tsx src/editor/EntityList.test.tsx src/library/CreateDraftDialog.test.tsx src/publish/PublishDialog.test.tsx src/ui/controls.test.tsx src/ui/surfaces.test.tsx` from `web/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/editor web/src/library web/src/publish web/src/ui
git commit -m "feat(g5): creator surfaces on shared controls"
```

---

### Task 4: Phone editor/preview switch (desktop split retained)

**Files:**
- Modify: `web/src/editor/DocumentEditor.tsx:171,263-269,327-336,400-411`, `DocumentEditor.module.css:111-147`, `web/src/editor/PreviewFrame.tsx:25,37-66`, `web/src/editor/viewLayouts.test.tsx:94-165`
- Test: `web/src/editor/previewSwitch.test.tsx` (new) + extend `viewLayouts.test.tsx`

**Interfaces:**
- Consumes: existing `previewOpen`, `previewPackage`, `previewSample`, `bodySplit` desktop grid; Task 2 tabs.
- Produces: `previewMode: "side" | "switch"` — desktop ≥1024 keeps side-by-side split; phone (<1024, esp. 320–599) gets an explicit Editor/Preview switch (segmented control, keyboard reachable) supporting review + small edits; full layout authoring stays desktop/tablet-oriented per spec.

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/editor/previewSwitch.test.tsx
test("phone widths get an editor/preview switch, desktop keeps side-by-side", () => {
  // render DocumentEditorBody with preview open
  // expect a switch control labelled /Editor|Preview/i with aria-pressed or radiogroup semantics
  // activating Preview hides the editor tab panel and shows PreviewFrame; activating Editor reverses
  // TODAY: fails — only a show/hide toggle with stacked layout, no switch semantics
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/editor/previewSwitch.test.tsx` from `web/`
Expected: FAIL (no switch control)

- [ ] **Step 3: Write minimal implementation**
  - Add a `PreviewSwitch` segmented control next to the existing preview toggle; on narrow layouts it toggles `editor` vs `preview` view (not merely show/hide); on desktop it preserves the existing `bodySplit` side-by-side grid.
  - Keep `Alt+P` shortcut, `aria-pressed`, `PreviewFrame` 360/1280 width toggle, and `viewport{overflow-x:auto}` exact-canvas behavior.
  - CSS: stacked single column by default; `.bodySplit` grid only `@media(min-width:1024px)` (existing); phone `@media(max-width:599px)` tighter gutters; no page-level horizontal scroll (banner overflow-chain fix precedent).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/editor/previewSwitch.test.tsx src/editor/viewLayouts.test.tsx src/preview/PreviewSheet.test.tsx` from `web/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/editor web/src/preview
git commit -m "feat(g5): phone editor/preview switch with desktop split"
```

---

### Task 5: Save/validation/conflict + publish readiness + draft-vs-published

**Files:**
- Modify: `web/src/editor/DocumentEditor.tsx:114-127,161-214,320-379,412-416`, `web/src/state/draftSync.ts`, `web/src/ui/SaveStatus.tsx:4-41` (only if distinctions preserved), `web/src/publish/PublishDialog.tsx:46-90`, `VersionHistory.tsx`
- Test: extend `web/src/state/draftSync.test.tsx`, `DocumentEditor.test.tsx:111-125`, add `web/src/editor/publishReadiness.test.tsx` (new)

**Interfaces:**
- Consumes: `useDraftSync` (`save/cancel/isConfirmed/status/banner/error`), `ws.assessment` diagnostics, `ws.draft.revision`, `ws.versions` list; G4 truthful sync text (`pending/saved/loading/sending/uncertain/needsReview/invalid/reauthenticate/storageError/purged`).
- Produces: Header save chip preserving all G1 distinctions (via `SaveStatus status/detail/onRetry` mapping or retained `autosaveLabel` + added offline/retry states — do NOT collapse `uncertain/sending/needsReview/invalid/reauthenticate/storageError/purged`); explicit readiness panel (`draft rev N`, `unsaved changes?`, `diagnostics count`, `latest published X.Y.Z`, publish button enable reason); lifecycle chip `draft vs active/archived`.

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/editor/publishReadiness.test.tsx
test("readiness panel shows draft rev, unsaved state, diagnostics, and latest published version", () => {
  // render DocumentEditorBody with ws { draft:{revision:7}, assessment:{diagnostics:[...2 errors]}, versions:[{semanticVersion:"1.0.0"}] }
  // expect text /Draft rev 7/, /2 issues?/, /Latest published 1.0.0/, publish button disabled with reason
  // TODAY: fails — only diagnostics-count tooltip + lifecycle label
});

test("conflict actions stay explicit replace/reload (never Merge) via the G1 owner", () => {
  // force 409, expect ConflictBanner with Reload theirs / Keep mine / Dismiss, keep-mine sends conflict revision
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/editor/publishReadiness.test.tsx` from `web/`
Expected: FAIL (no readiness panel)

- [ ] **Step 3: Write minimal implementation**
  - Add a readiness summary (in header or beside publish button): draft revision, save state (from `sync.status`), diagnostics count with JumpTo drawer link, latest published semver from `ws.versions`, and publish enable/disable reason in text (not tooltip-only).
  - Wire save chip to the G1 owner: keep `sync.banner → ConflictBanner` (explicit replace/reload, never "Merge"; keep-mine sends conflict revision); surface offline + retry states (reuse `SaveStatus` only if the full `uncertain/sending/needsReview/invalid/reauthenticate/storageError/purged` mapping fits via `detail`, else extend the existing `autosaveLabel` span with `role=status/alert` parity).
  - Lifecycle chip: `draft (unpublished)` vs `system.lifecycle`, plus `VersionHistory` link; no new backend calls (assessment stays the open/save snapshot; optional `assessDraft` pre-publish refresh only if it does not change contracts).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/editor/publishReadiness.test.tsx src/editor/DocumentEditor.test.tsx src/editor/ConflictBanner.test.tsx src/state/draftSync.test.tsx src/ui/surfaces.test.tsx` from `web/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/editor web/src/state web/src/publish web/src/ui
git commit -m "feat(g5): explicit publish readiness and draft-vs-published state"
```

---

### Task 6: Publish → create-character handoff + exit demonstration evidence

**Files:**
- Modify: `web/src/publish/PublishDialog.tsx:111-147` (success view), `web/tests/e2e/acceptance.spec.ts:14-131`, `web/tests/e2e/visual.spec.ts` (only if new screenshots needed), `docs/acceptance/gui-YYYY-MM-DD.md` (new), `docs/superpowers/plans/2026-09-08-gui-integration.md` (check G5 boxes), `design_v2.md` §17.6a only if design changed
- Test: e2e `web/tests/e2e/creatorToCharacter.spec.ts` (new) + unit `VersionHistory.test.tsx` anchor assertion

**Interfaces:**
- Consumes: Tasks 1–5 creator; `POST /systems/:id/publish`, `GET /systems/:id/versions`, `/characters/new?systemVersionId=` deep link, `CharactersApi.listCreationVersions/creationOptions`.
- Produces: Post-publish success CTA `Create test character` → `/characters/new?systemVersionId={versionId}`; proven exit path.

- [ ] **Step 1: Write the failing test (e2e first)**

```ts
// web/tests/e2e/creatorToCharacter.spec.ts
import { test, expect } from "@playwright/test";

test("G5 exit: blank → simple system without expression → order sheet → preview → save → reopen → publish → create character", async ({ page }) => {
  // 1. Create blank draft via library UI (name only), expect /systems/:id
  // 2. Basics tab: set description + default dice; attributes: add 2 scalar fields; dice: add guided roll (no expression typed)
  // 3. Sections: add section, bind fields, move section with keyboard, expect order in preview
  // 4. Toggle preview (desktop 1280 + phone 360 via viewport), expect no horizontal scroll
  // 5. Wait for Saved, reload (reopen), expect draft values retained
  // 6. Publish 1.0.0 with release notes, expect success + version history row
  // 7. Click Create test character, complete character creation WITHOUT entering a version ID, expect character sheet
  // TODAY: fails — no guided path, no post-publish CTA, no blank→character chain
});

test("editing a published reference system preserves its advanced definitions", async ({ page }) => {
  // clone d20 template, open editor, change only the system description, save
  // expect actions/validations/expressions byte-identical via GET /systems/:id open + export diff
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test tests/e2e/creatorToCharacter.spec.ts` from `web/` (needs backend: `npm run migrate && npm run dev:http` + `npm run web:dev` per `playwright.config.ts:17-47`)
Expected: FAIL (missing CTA / guided path)

- [ ] **Step 3: Write minimal implementation**
  - `PublishDialog` success view: add `Create test character` link (`<a href=/characters/new?systemVersionId={versionId}>`, matching `VersionHistory.tsx:171-177` plain-anchor pattern for Router-less use) alongside `Close`; keep `versionId/checksum` display.
  - Fix whatever the e2e exposes in Tasks 1–5 scope only (guided field defaults, section ordering preview order, save→reopen retention, publish gate). No new endpoints; no template-seed changes (hardcoded `library/CloneFromTemplate` fixture-UUID debt stays unless it blocks the exit path — if touched, update to `GET /templates` dynamic source like `publish/CloneFromTemplate`).
  - Second test uses only existing open/save/export HTTP surface; no DB tools.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx playwright test tests/e2e/creatorToCharacter.spec.ts tests/e2e/acceptance.spec.ts` from `web/`
Expected: PASS; then full gates: `npm test` + `npm run typecheck` + `npm run build` from `web/`, `node --import tsx scripts/generate-system-contracts.ts --check` + `npm run test:integration` from root (serial, load limits preserved)

- [ ] **Step 5: Record acceptance + commit**

```bash
git add web/src/publish web/tests/e2e/creatorToCharacter.spec.ts docs/acceptance/gui-2026-09-09-g5-creator.md docs/superpowers/plans/2026-09-08-gui-integration.md
git commit -m "feat(g5): publish-to-character handoff with exit demonstration"
```

Acceptance note `docs/acceptance/gui-2026-09-09-g5-creator.md` must list: tested commit, commands actually run, device/browser, theme, reference-system fixture, screenshots (before/after where visual changed), manual findings, remaining limitations. Check G5 boxes in `2026-09-08-gui-integration.md` only after evidence exists; update `design_v2.md` §17.6a only if the design itself changed (per AGENTS.md).

---

## Self-review

- **Spec coverage:** G5-138 basics/descriptions/attributes/dice/section-order/preview/publish → Tasks 2+6. G5-139 advanced-behind-disclosure + no silent discard → Tasks 1+2. G5-140 desktop side-preview + phone switch → Task 4. G5-141 shared controls + ordered sections + keyboard + no canvas/tabs → Tasks 2+3. G5-142 G1 save/validation/conflict + readiness + draft-vs-published → Task 5. Exit demo + reference preservation → Task 6.
- **Placeholder scan:** No TBD/TODO/"appropriate handling" — every step names exact files, exact test commands, exact expected FAIL/PASS, exact commit message.
- **Type consistency:** `persistExpressionSource`/`commitComputedSource` (T1) → consumed by T2 disclosure; `CreatorTabs` union (T2) reused by T3/T4; `previewMode` (T4) builds on existing `previewOpen/previewPackage/previewSample/bodySplit`; readiness panel (T5) reads `ws.draft.revision/ws.assessment/ws.versions` already in `DocumentEditorBody`; CTA (T6) reuses `VersionHistory` anchor pattern.
