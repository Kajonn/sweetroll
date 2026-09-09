Commit: 6ea9742 (feat/g2-theme-structural; unmerged — acceptance is structural-only, G2 exit still awaits mockup reference)

# G2-structural acceptance (2026-09-09) — structural only

Scope: G2-1 theme tokens/mechanics, G2-2 shared accessible controls
(`web/src/ui/*`), and G2-3 follow-ups + wiring + migration. Structural and
behavioral only: token aliases, device-theme preference plumbing, control
semantics, keyboard operation. No visual restyle of any feature, no Tablefolk
values (mockup unreachable, HTTP 401), no account-level theme (I5).

## What ran (exact commands, all from `web/` unless noted)

- `npm test -- src/ui src/theme src/shell/AppShell src/main.test.tsx` — 6 files, 92/92 pass.
- `npm run typecheck` (web/) — clean, zero errors.
- `git diff --check` (worktree root) — clean.
- Covered: FormField explicit-id association, Dialog aria-describedby linkage,
  Menu disclosure semantics (open/select/Escape/disabled), theme preference
  logic + storage + initTheme listeners, main.tsx startup wiring (data-theme +
  colorScheme + cross-tab storage sync), AppShell Light/Dark/Follow-device
  switcher (data-theme changes, content not remounted, input state kept),
  44px touch targets + `:focus-visible` + reduced-motion + alias consumption
  asserted against authored CSS text (jsdom cannot compute CSS-module layout).

## Explicitly did NOT run / is deferred

- Full unit suite (`npm test` without filter) — controller runs it serially.
- Mockup greens / contrast sign-off — mockup 401; dark set is neutral
  placeholders, marked as such in `global.css`.
- Account-level theme default (I5) — device preference only.
- Visual checkpoint / screenshots — structural tests assert authored CSS text,
  not rendered pixels; no pixel comparison run.
- e2e / offline suites — untouched by this task.
- `Menu` keeps disclosure (not menu/menuitem) semantics: APG menu roles
  require arrow-key/Home/End roving tabindex, which would recreate the custom
  focus management G2-2 exists to avoid. Items stay Tab-reachable native
  buttons; see task-g23-report.md for the recorded choice.

## Known follow-ups

- 44x44 floor enlarges small inline buttons (G2-1 report concern 4); needs
  visual sign-off by controller.
- jsdom never resolves `var()`: alias resolution is proven by chain-walking,
  not computed style (G2-1 report concern 2).
- AppShell renders children during auth `loading`; tests asserting
  no-remount must wait for the settled (authenticated) tree first.
- A later Radix popover swap for `Menu` stays API-invisible if ever wanted.
