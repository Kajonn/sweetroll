# Task 12 report — visual baseline remediation (G2/G3/G9 renderings + geometry guards + re-baselined snapshots)

Plan: `docs/superpowers/plans/2026-09-09-visual-baseline-remediation.md` (all 25 steps
across Tasks 1–4 complete; plan file tracked in `0970290`).
Branch `fix/visual-baseline-remediation` (worktree
`.worktrees/visual-baseline-remediation`, since removed) merged to `main` as a
fast-forward from `79c7c6d`. No subagents. No design change (`design_v2.md` untouched);
acceptance evidence in `docs/acceptance/gui-2026-09-09-g3-shell.md`.

## Commits

- `a8a983c` fix(gui): make metadata controls responsive and visual state deterministic (Task 1)
- `fdb1771` fix(gui): preserve preview canvas width and prevent footer overlap (Task 2)
- `9c2c512` test(gui): assert visual-state and preview geometry before snapshots (Task 3)
- `e118d0b` test(gui): restore preview state before visual capture (review fix, see below)
- `e5b37fc` test(gui): accept reviewed responsive visual baselines (Task 4)

## What changed

- Task 1: new `web/src/editor/MetadataEditor.module.css` (single-column mobile form,
  two-column settings row at ≥1024px, 44px touch targets, G2 semantic tokens);
  `MetadataEditor.tsx` uses module classes and wraps Language/Default dice in
  `metadata-settings-row`; editor visual cases gate on exact `Saved` autosave text.
- Task 2: `PreviewFrame` renders `preview-frame-viewport` (sole horizontal scroll owner)
  around an exact 360/1280px `preview-frame-container` (no `max-width` clamp);
  `AppShell` footer returned to ordinary flow (header stays sticky).
- Task 3: `web/tests/e2e/visual.spec.ts` gains `expectNoPageHorizontalOverflow` (both
  document roots, before every full-page shot), preview geometry assertions (canvas
  width ±1px, viewport scrollWidth, body/app/document overflow, scroll extremes,
  canvas/viewport edge alignment), frame-vs-status-bar and Check-vs-chrome
  zero-intersection assertions, publish-dialog within-viewport assertions, and
  conflict message/buttons visibility assertions.
- Task 4: all ten baselines (`library`, `document-editor`, `sheet-preview`,
  `publish-dialog`, `conflict-banner` × 360/1280) regenerated after review and locked.

## Deviations from the plan (documented in the acceptance record)

- The 1280px geometry read caught the canvas mid CSS-width-transition (0.2s ease).
  The spec now `waitForFunction`s the settled canvas width before measuring — a
  real-state wait, not a timing hack.
- First image review rejected both sheet-preview captures (post-assertion scroll left
  controls clipped under sticky chrome). Capture now restores the preview entry
  state and suppresses unrelated sticky positioning only during the locator shot,
  after the real-layout overlap assertions run (`e118d0b`). Second review: 10/10.
- Pre-existing router creation test flaked once in a full-suite run (observed transient
  `Loading version…` while the test expects `Look up version`); passed 3/3 focused,
  then the full suite green. No product change; noted as timing-sensitive.

## Evidence (fresh, final code unless noted)

- Task 1 RED: 2 new tests failed (missing row/module); GREEN: 37 passed + `typecheck`.
- Task 2 RED: 3 tests failed (no viewport, clamped canvas, sticky footer); GREEN: 43 passed + `typecheck`.
- Task 3 old-code proof: new guards fail against pre-Task-2 production files
  (`preview-frame-viewport` absent → geometry null); restored immediately, no broken commit.
- Task 3 browser run, isolated `sweetroll_visual` DB: all geometry/visibility assertions
  pass; 10 failures screenshot-comparison-only (stale PNGs, as expected).
- Task 4 lock run on recreated DB: **10/10 passed** (Playwright 1.48.0, headless
  Chromium 130.0.6723.31, backend 3110 / web 5174).
- Merged-result verification on `main`: root unit 28 files / **271 passed**; web unit
  68 files / **760 passed**; `web:typecheck`, `contracts:check`, `git diff --check` clean;
  full E2E **19/19** (10 visual + 9 routed) on byte-identical content.
- Review: image review delegated by Jonas (first round 8 approve / 2 reject with cause,
  second round 10/10 approve). Real-device (Android Chrome, iPad Safari), 200% text,
  and long-label checks were NOT run — remain G9 work.

## Notes for other agents

- Running root `npm test` from the repo root while a `.worktrees/` worktree with its own
  `node_modules` exists makes vitest crawl the worktree's dependencies (the config
  `exclude: ["node_modules", ...]` is relative and does not cover nested
  `.worktrees/**/node_modules`). Scope with `--exclude ".worktrees/**"` or run inside
  the worktree. Root `node_modules` in `main` was also stale (missing packages) and
  needed a fresh `npm install` before the merged-result run.
- Worktree postgres (`compose.yaml`, port 5432) conflicts with the main checkout's
  postgres: stop the worktree stack (`docker compose down`) before removing the worktree.
- `sweetroll_visual` was a scratch DB for this work (drop/recreate per run); it is not
  part of any migration path. Full-suite E2E writes timestamped evidence PNGs under
  `web/tests/e2e/evidence/` — run artifacts, not baselines; deleted before commit.
