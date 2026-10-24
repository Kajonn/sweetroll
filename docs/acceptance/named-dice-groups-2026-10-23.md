# Named dice groups — slice B acceptance tracking

Branch `feat/named-dice-groups`, based on merged A/main `740204fa9079c15150d89bfa0d1b19c9a0f9fa8e`. Contract: [package 1.1 / grammar 0.2](../superpowers/specs/2026-10-23-named-dice-groups.md). B introduces named dice and structured calculations, not push commands.

## Regression evidence

- Initial focused evaluator run: 3 failed / 2 passed in `src/systems/implementation/rules/groups.test.ts`. Named syntax/evaluation and grouped kept dice failed before implementation; the legacy result/draw-order control passed.
- Initial real editor regression: 1 failed / 23 passed in `web/src/editor/actions/RollActionEditor.test.tsx`. The new group-authoring entry point did not exist. After implementation all 24 passed, including opening the editor without replacing a custom expression.
- Focused green: 23 evaluator/group/legacy-fixture tests, then 8 versioned package/group round-trip tests. Document/package 1.1 preserves group source/version through export and cloning and rejects grouped content in 1.0 and unknown grammar versions.
- Shared breakdown, reducer promotion and durable account-scoped history tests: 69 passed. Mixed operations, text thresholds/success/kept state, empty groups, legacy fallback, no accidental downgrade, account isolation and purge are covered.
- Full local server suite: 435 passed, 10 existing DB-dependent skips. Database skips are not passing integration evidence. The container has no usable PostgreSQL server, and package installation cannot switch OS users in this sandbox.
- Full local frontend suite: 1,170 passed after the former slice-A temporary live harness was moved out of Vitest's discovery tree. No test assertion was relaxed.
- Root/frontend typechecks and production builds passed on the implementation before final evidence edits. Contract generation uses `node --import tsx scripts/generate-system-contracts.ts` locally because the tsx CLI's Unix IPC socket is unavailable; the generated/check workflow itself is unchanged.

## Required checks at the initial checkpoint

Real PostgreSQL integration tests cover both action sources, once-only stored results, HTTP serialization, same-key replay, rejected supplied outcome metadata, authorized history, campaign audience/export filtering and revoked replay. The 1.0 → 1.1 → rollback journey checks that historical legacy and grouped rows remain unchanged. Migration 0023 adds a nullable JSONB column and never rewrites old rows or receipts.

The canonical named-group browser journey exercises guided authoring and save/reload, preview, publish/create-character, entity and granted-item results, responsive light/dark display and history reload. A production-browser offline test reopens cached grouped history. At this checkpoint, these still required actual execution in CI and a verified deployed preview before B acceptance could be claimed.

CI was pending at this historical checkpoint. Final CI and deployment status are recorded below. Physical devices, real-provider authentication and wider G9 gates remain open. Personal character state export continues to exclude roll history; the campaign export and authorized character history carry grouped results. No C push policy, reroll, effect engine or new command queue has been enabled.


## CI run 116 follow-up

Run 116 on `51159ce` passed all 445 server tests with its DB available, 1,170 frontend tests, visual baselines and browser shard 1. The new entity-group persistence and upgrade/rollback PostgreSQL tests passed; the new granted-item fixture was correctly rejected because it reused the entity input ID. The item fixture now uses a distinct `gear_bonus` ID and source reference. This does not relax package uniqueness.

The production offline test exposed initial Activity dialog focus loss: the effect focused Refresh and immediately disabled it during loading. A new unit regression reproduced this (red); starting in the busy state focuses the enabled Close control instead (green: 25 CharacterTools tests). Escape and opener restoration are exercised after the asynchronous load, and the original production-browser Escape assertion is retained.

A retained campaign-template dev journey raced a fresh revision: the trace showed a frozen revision-3 command after GM publication of revision 4, followed by the correct reviewable HTTP 409. The fixture now awaits the fresh catalog response and revision-4 persistence before going offline. Selected-reference retention/product conflict handling, timeouts, retries and visual baselines are unchanged. The remaining delayed browser-install job is not counted as success.


## Final application CI — run 118

[Run 118](https://github.com/Kajonn/sweetroll/actions/runs/40002468608), on application commit `aa77d09d7d35da40f485b4b5ff4b039e78f37099` (tree `c07cf4bdcfeefbfec24fa236b02bdeb5cd9d3200`), passed **all seven verification jobs**. Job statuses and decoded logs were read back:

| Check | Observed result |
|---|---|
| Server | 445 passed, with PostgreSQL available; no DB skips counted |
| PostgreSQL integration | 370 passed, including both grouped action sources, stored dice/breakdown equality, definite same-key replay, forbidden supplied outcomes, audience/history/export checks and 1.0 → 1.1 → rollback |
| Frontend | 1,171 passed; typecheck and production build passed |
| Canonical browser journeys | 53 passed across shards (18 / 19 / 16), including guided groups through publication, entity/item results and history reload |
| Production offline | 25 passed, including grouped-history reopening and the retained coherent service-worker update/queue/privacy journeys |
| Visual checks | 10 passed against unchanged baselines |
| Remaining build/contract checks | Root typecheck, generated-contract identity, root build and Docker build passed |

Run 117 had already passed all 370 PostgreSQL integration cases and all browser shards; its remaining failure was the newly added unit regression's TypeScript declarations (a generic Promise type and Testing Library options). Commit `aa77d09` fixes those declarations without changing the product. The subsequent run above passed the complete matrix. The focus regression preserves a visible, enabled target throughout async loading, Escape closure and opener restoration. No retries, timeouts or visual baselines were relaxed.

## Historical isolated deployment approval gate — 2026-10-23

The dedicated project remains `sweetroll-items-preview` (`f5662fc0-966a-4cc2-ba83-91bf8b0a2280`), environment named `production` (`8016a027-c65d-4991-a7e8-7f38ff54dbf7`), service `sweetroll-items` (`f75d2a0b-66a6-49b7-95cc-a24ff99ac6f8`), separate PostgreSQL, URL <https://sweetroll-items-production.up.railway.app>. `proactive-expression` is untouched.

Reviewed patch `eb9e086b-a72f-423e-8668-707d45b2a8f8` had exactly two non-destructive source changes: branch to `feat/named-dice-groups` and commit pin to the CI-green `aa77d09`. No shared variables, networking, database service or other resources are staged. At 21:23 Europe/Helsinki on 2026-10-23 it was STAGED. The subsequent `accept-deploy` attempt returned **"Cancelled — the user did not approve this action. No changes were made."** Read-back confirmed the same pending patch, with no deployment started. At that checkpoint, the tool's approval control blocked activation; CI had passed and no build had started.

The preview then ran slice A deployment `d16eefbe-3863-4ea1-b83d-33d7bffbde1b`, commit `ad5de63`; B live acceptance had not run and PR #22 remained draft. This historical blocker was resolved by the deployment and observed acceptance below. Wider G9/device/provider-auth gates and slice C remain open.


## Isolated deployed acceptance — 2026-10-24

On the next retry, Railway already had a new build in progress and no staged patch. No new deploy mutation was submitted during this retry. Deployment `87604ee3-6f89-48b3-a86f-585b118fdd0d` was created at `2026-10-24T13:38:18.850Z` and reached terminal **SUCCESS** at `2026-10-24T13:40:15.762Z` (16:40:15 Europe/Helsinki). Logs confirmed completed database migrations at 13:40:05.596Z and server startup; `/health/ready` returned HTTP 200 with `{"status":"ok"}`. This is the same isolated project/service/database identified above; `proactive-expression` was not modified.

The actual deployment metadata identifies branch `feat/named-dice-groups`, commit **`ae7d1e8bfe8011f779642122e6c1688850533dbd`** (tree `f7c80af50ff2bee49f3bea3b0ccc8a413a5e2d5f`). Service configuration still reports source pin `aa77d09d7d35da40f485b4b5ff4b039e78f37099`; the configured pin and observed deployed commit are recorded separately. `git diff --name-only aa77d09 ae7d1e8` contains only this acceptance record, `design_v2.md` and the dice-pool delivery plan. Thus the deployed application code is identical to the application that passed run 118. The documentation-only run 119 (`40003464376`) was cancelled, not a passing run or an application failure.

### Served artifact identity

A local production rebuild of unchanged deployed commit `ae7d1e8`, using the served `OFFLINE_BUILD_ID=build-mvmg3zmv`, was compared with downloaded preview responses. All five files matched byte for byte:

| Served path | Bytes | SHA-256 |
|---|---:|---|
| `/index.html` | 2338 | `a7d9da15db6fa727a0175d3991dfc357fc5041e190929c3a0dc123c6d2cf437e` |
| `/assets/index--rnEHoQw.css` | 77838 | `2649fa90f3974012ee0da3e55916a6a6d44a1fdd96f4fc507f4c41e2bb843504` |
| `/assets/index-wD3FMT-T.js` | 816698 | `1f119accdd8e88b143957cd73d580b19474ce0625dd993815f2c25a0237fdd56` |
| `/sw.js` | 3545 | `92cc81eb0b3930776cbeb959f020b301863729717e8231d4cfa294866e668536` |
| `/offline-manifest.json` | 137 | `336206b6b4f91a11013721c4f4b648ffb8daeee0b1e82f0abc62e3422ea673d9` |

### Live browser results

Temporary harness copies of the canonical `web/tests/e2e/namedDiceGroups.spec.ts`, `web/tests/e2e/dicePoolReliability.spec.ts` and `web/tests/offline/namedGroups.spec.ts` ran against <https://sweetroll-items-production.up.railway.app>. Only target/authentication/import wiring, evidence logging and scoped cleanup were adapted. Core assertions and the canonical per-test timeouts were retained. Command: `node web/node_modules/@playwright/test/cli.js test --config /workspace/scratch/e74dcf13880b/slice-b-live/config.cjs`.

Observed run started at `2026-10-24T13:44:49.155Z`: **3 passed, 0 failed, 0 flaky, 0 skipped, zero retries**, one worker, total 229.960s. Browser: Playwright 1.48, headless Chromium 130 (build 1140), Linux. The harness used this environment's HTTPS proxy and certificate bypass for its proxy CA; canonical repository browser settings were unchanged. Authentication used the isolated preview's existing `/dev/signin` test-provider endpoint because a production build does not expose the development sign-in UI. This does not verify real-provider authentication.

| Live journey | Duration | Observed assertions |
|---|---:|---|
| Named groups | 83.530s | Guided attribute/skill/gear groups, distinct thresholds/die sizes, extra dice and truthful empty sample; 1.0 → 1.1, save/reload, publish/create character; entity and granted-item mixed calculations; text breakdown and history reload; light/dark at 320, 360, 768 and 1280 CSS pixels without overflow |
| Legacy pool reliability | 79.619s | Preserved custom formulas, invalid scalar count assessment, explicit zero/negative-pool review and correction, granted-item parity, responsive/theme/reload checks; legacy 1.0 results gain no fabricated breakdown |
| Production offline history | 65.786s | Actual service worker reports Available offline; grouped roll/history load; Escape closes Activity and restores focus; offline deep-link reload and cached grouped thresholds/history reopening with `navigator.onLine === false` |

### Persistence and cleanup read-back

A separate authenticated API probe fetched the persisted character histories after the live tests. Grouped results retained breakdown version 1.0, calculation-root value equal to total, unique dice IDs, group dice membership/count/order, and subtotals consistent with kept values or kept successes at the recorded threshold. The legacy character returned zero grouped history records.

| Journey | System ID | Character ID | Grouped history records | Final lifecycle |
|---|---|---|---:|---|
| Named groups | `b25ec1f3-6035-4ad7-a321-689365a794a5` | `8173f1e2-eeec-46b1-951d-55e42de5efed` | 2 | Both archived, read back |
| Legacy | `5a1fc9e0-2943-4658-8880-c130007a8fa9` | `f1c1d986-56b5-4f72-866a-49e67aabb4fa` | 0 | Both archived, read back |
| Offline | `3c1fbdaf-8f86-4401-ba28-14a22b56a7ca` | `c2f8516e-2ff0-4c36-99a4-2ae696fe2257` | 1 | Both archived, read back |

Only these test-created resources were cleaned up. Referenced systems correctly reject deletion with HTTP 409, so the systems were archived instead; their published versions and referenced history remain intact. Characters were archived with their current revision and fresh idempotency keys. No system-deletion claim is made.

B's core deployed acceptance is now passed and PR #22 is ready for review. The bundled compatibility checkbox remains open for additional explicit old/new client and service-worker version-skew cases; current CI includes import/export/clone, unsupported-version rejection, database upgrade/rollback and retained worker-update coverage, while this live run adds legacy and current-worker regression evidence. Physical devices, real-provider authentication and wider G9 release gates remain open. No push/reroll/effect capability from slice C is implemented or accepted here.
