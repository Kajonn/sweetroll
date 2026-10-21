# Sheets reference dropdowns — isolated deployed acceptance (2026-10-14)

Scope: [PR #20](https://github.com/Kajonn/sweetroll/pull/20), branch `feat/sheet-builder-reference-selects`, application commit `59a6e159fd3971dfae7fc8fd9ede70ed0580bf3e`. See the [execution plan](../superpowers/plans/2026-10-14-sheet-builder-reference-dropdowns.md).

## Deployment and artifact identity

The requested PR head was already deployed when this verification started. Railway reported deployment `07263619-c8e4-412e-918b-b4fb4829dc74` as **SUCCESS**, created at `2026-10-14T20:57:03.899Z`, with that exact commit and branch. No redundant deployment was needed.

- Project: `sweetroll-items-preview` (`f5662fc0-966a-4cc2-ba83-91bf8b0a2280`).
- Service: `sweetroll-items` (`f75d2a0b-66a6-49b7-95cc-a24ff99ac6f8`).
- Environment: `production` (`8016a027-c65d-4991-a7e8-7f38ff54dbf7`) inside the isolated preview project, with its own preview PostgreSQL service.
- URL: <https://sweetroll-items-production.up.railway.app>.
- `/health/ready`: HTTP 200. Dockerfile deployment uses `npm run start:migrate` before `node dist/bootstrap/http.js`.
- The JS and CSS actually referenced by the live index are byte-identical to a local production build of the application commit:

| Asset | SHA-256 |
| --- | --- |
| `/assets/index-DNutNTmu.js` | `0630ecb0f8b584bb1e2ab7077ff20dd5360b64e0b4e2be9be148b620ac142366` |
| `/assets/index--rnEHoQw.css` | `2649fa90f3974012ee0da3e55916a6a6d44a1fdd96f4fc507f4c41e2bb843504` |

## Live GUI journey

Playwright Chromium exercised the production-built preview with a fresh browser context. Only sign-in setup used the supported preview test-auth endpoint. Authoring changes used the GUI; API reads checked the persisted document, and the test deleted its cloned system afterward.

1. Sign in and clone the d20 reference system.
2. Add and label an alternate entity and an inventory slot through the creator UI.
3. Open **Sheets** and verify labeled target-entity options.
4. Add a section and field, resource, action and slot elements. Choose Ability Score (`ability`), Health (`health`), Check (`check`) and Journey inventory (`slot_1`) from labeled dropdowns. Already placed definitions remain available.
5. Verify the saved document retains these definition IDs and four distinct generated element IDs, with no editable identity-ID inputs.
6. Switch the sheet to the alternate entity. The original field/resource IDs remain selected as missing references, with explicit alerts and no automatic replacement.
7. Reload, confirm the alternate target and unresolved reference are retained, and select the original entity again. Alerts clear; sheet and element identities and bindings remain unchanged.
8. Reopen both `?tab=sheets` and `?tab=sections`. Both activate the Sheets navigation link.
9. Open the preview and exercise desktop/phone viewports and preview widths at 1280/360 px. Check bound field/resource/action labels and absence of page-level horizontal overflow. No browser JavaScript errors occurred.

The final journey passed with zero retries. Initial temporary harness assertions were corrected to use the current index's assets, the newly added section and the navigation link's actual `aria-current` semantics; these required no application changes.

## Local and CI verification

- Local production build/typecheck passed.
- Focused unit regression run passed **74 tests in 5 files**: sheet selection/editor, document editor, basic workflow and shell navigation.
- [CI on the application commit](https://github.com/Kajonn/sweetroll/actions/runs/38636364816) passed verification, frontend unit/typecheck/build, all **51 browser journeys** and **24 production-offline tests**. Frontend unit coverage was **1,143 tests in 111 files**.
- Its visual job passed 9 of 10 cases and failed the desktop document-editor baseline. Inspection with Playwright's pixel comparator reproduced exactly **344 differing pixels**, confined to coordinates `(387,282)` through `(525,291)`: the intentional Sections → Sheets label and the consequent Advanced-tab shift.
- The 1280 px document-editor baseline was recaptured from the matching deployed build, inspected, and checked in a second fresh browser run. That focused screenshot comparison passed. The other nine baselines and comparison thresholds were preserved.

The acceptance/baseline commit changes documentation and the screenshot expectation only; application code remains identical to the deployed, exercised commit. Full CI for that commit is tracked in the PR checks.

## Limits and remaining work

The creator preview's existing `PreviewElement` supports heading/field/resource/action and does not render slot elements. Slot selection and persistence passed here; a visual slot preview is **not** claimed and needs a separate renderer change. This limitation predates this PR.

Physical Android/iPad, real-provider authentication and publishing a new system version were not exercised in this focused deployed journey. Existing CI creator-to-character and dynamic-object journeys passed. This record verifies the new authoring selectors on an isolated deployment, not general release readiness.
