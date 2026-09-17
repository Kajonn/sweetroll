# Acceptance: preview-as-player (content slice, 2026-09-17)

GUI plan G7 box "Make sharing audience persistent and readable;
preview-as-player calls the real policy implementation" — preview half.

## Scope

Content-tab preview-as-member for GMs, per the binding spec
`docs/superpowers/specs/2026-09-17-preview-as-player-design.md`:
dedicated read-only `POST /campaigns/:id/content-preview` projection
(Task 1) + Content-tab preview UI (Task 2) + this two-user proof (Task 3).
Preview stays **content-only**; broader surfaces (Session/Characters/
Members/Settings preview, generic least-privilege view, audit logging,
offline preview) remain future work — recorded, not implemented.

## Tested code

Branch `feat/preview-as-player`. Behavior-affecting code is Tasks 1–2,
already merged on the branch (`325a354` endpoint, `ca6f318` non-member
collapse fix, `b82bf65` preview UI); Task 3 adds only the e2e spec, this
record, and the G7 checkbox — no implementation change. All verification
below ran with the Task 3 spec present (spec file untracked at run time,
then committed unmodified).

## Two-user proof (new e2e)

`web/tests/e2e/previewAsPlayer.spec.ts` (desktop Chromium, `workers: 1`,
`retries: 0` untouched): owner creates a campaign plus a GM-only note and
an all-player note through the UI; code-test-b accepts an invitation in a
second context and sees exactly the all-player note (GM-only title and
"Game Master only" mark absent); the owner enters "Preview as" for the
member and the preview list is row-identical to the member's own view
(same rows, same audience marks, asserted with `toEqual` on the shared
`CampaignContentView` output) plus the persistent
"Previewing as {userId} — read-only" banner with no Save/Edit/picker
control mounted; the preview reader serves the shared note body; Exit
restores picker, create editor, per-note edit controls, and both notes;
then, with the preview still mounted, the member is removed from a second
owner page and the next preview fetch (opening a note) surfaces
"Preview could not be loaded." with the banner intact and no note body.

Isolated run: fresh scratch DB `sweetroll_preview_e2e1` in compose
postgres, dedicated ports, `CI=1`:

`CI=1 DATABASE_URL=…/sweetroll_preview_e2e1
AUTHORITATIVE_ROLL_SECRET=development-only-roll-secret-32-bytes
BACKEND_PORT=3541 WEB_PORT=5713 SWEETROLL_BACKEND_TARGET=http://localhost:3541
npx playwright test previewAsPlayer.spec.ts --reporter=line` from `web/`
→ **1/1 pass (12.1s)**.

## Full verification matrix (2026-09-17, same checkout)

| Command | Result |
| --- | --- |
| Root `npm test` | 29 files / 324 passed |
| `TEST_DATABASE_URL=…/sweetroll AUTHORITATIVE_ROLL_SECRET=… npm run test:integration --no-file-parallelism` | 30 files / 351 passed |
| Root `npm run typecheck` | clean |
| Root `npm run contracts:check` | clean |
| Root `npm run build` | clean |
| Web `npm test` | first run 1046/1047 — one failure in `AppShell > null→actor settle…` (untouched shell area, no Task 3 source change); passes in isolation (19/19) and full-suite re-run **104/104 files, 1047/1047 passed** → load flake, same class as the Task 2 noted flake |
| Web `npm run typecheck` | clean |
| Web `npm run build` | clean (vite build 3.09s) |
| Canonical `E2E_DATABASE_ADMIN_URL=… AUTHORITATIVE_ROLL_SECRET=… npm run web:test:e2e` | journeys **43/43 pass (3.6m)** incl. the new spec; visuals **10/10 pass** |
| `git diff --check` | clean |

## Known variances (recorded, not fixed)

1. The preview banner identifies the target by **userId**
   (`Previewing as {userId} — read-only`): member rows carry no display
   name anywhere in the app, consistent with the Members roster. If display
   names land later, swap the label source.
2. The preview list is **unpaginated** (server drains all pages into one
   200); acceptable for the content slice.
3. Preview is **content-only**; no other tab offers a preview mode.

## Limitations

Chromium-only (Playwright `chromium` project); no real devices, no
phone-viewport preview e2e, no dark-mode preview pass — real-device and
accessibility/device gates stay G9. Scratch DB `sweetroll_preview_e2e1`
dropped after the run; no `data/` runtime leakage (repo has no `data/`
dir; `git status` shows only the three Task 3 files plus the pre-existing
untracked `node_modules` symlinks).
