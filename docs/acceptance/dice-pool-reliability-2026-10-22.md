# Dice-pool reliability — slice A acceptance

Branch: `feat/dice-pool-reliability`, based on `dfe3f77` plus the existing planning commit. Scope: R1–R4, Tasks 1–5. Named dice groups (B) and configurable pushes (C) remain planned, following A review as required by the execution plan.

## Implementation and red → green

- R2: scalar, boolean, combined and keep-wrapped success operands failed the new compile/document/assessment regressions before the shared type-check repair. Direct dynamic pools, separately counted sums, d20, PbtA and keep-high/low remain covered.
- R1: negative/fractional entity pools and item-granted negative/partial rolls failed before the runtime guard. Both action boundaries now return a definite typed failure. Zero pools, deterministic outcomes, package budgets and computed/validation fallback regressions pass. Additional legacy-operand and partial-division tests pass.
- R3/R4: three new editor tests failed before custom-pool protection, truthful modifier display and sample binding disclosure. Additional full-preview and client-adapter regressions failed before their repairs. The shared AST interpretation also covers mixed count/sum, scaled, negated and keep rolls.
- Generated OpenAPI and client types expose bounded `actionDiagnostics` separately from sheet validations. Client and session tests preserve failed inputs, retain the rejected frozen command until explicit review, and use a new key only after correction/discard.

Initial focused green: 109 server tests and 67 frontend adapter/editor/preview tests. Subsequent full local runs: 424 server tests passed (10 pre-existing database-dependent tests skipped), 1,161 frontend tests passed. Later additions are verified separately below; these counts are not CI or deployment evidence.

## Verification tracking

- Root/frontend typechecks and generated-contract check: passed on the initial implementation.
- PostgreSQL: new HTTP acceptance covers entity and item errors, receipt replay, changed-key payload mismatch, unchanged state/revision/history, legal zero pool, valid correction and outsider denial. Local database execution remains unclaimed; the environment has no usable PostgreSQL service.
- Browser: canonical `dicePoolReliability.spec.ts` authors and reloads a pool, checks server assessment, inspects truthful samples, publishes and creates a character, reviews a negative-pool failure, rolls a legal zero pool, repeats through an item, checks 320/360/768/1280 widths in both color schemes and reloads.
- Required CI: [PR #21 checks](https://github.com/Kajonn/sweetroll/pull/21/checks) track the current head; historical attempts and limitations are recorded below.
- Isolated Railway preview: connection restored 2026-10-22. Project `sweetroll-items-preview`, service `sweetroll-items`, separate Postgres; pre-change deployment `25f47e4e-4994-47a8-88c2-f2b0db8b5246` is healthy and follows the prior Sheets branch. The dice-pool deployment and live journey passed on 2026-10-23; see the final evidence below.

## Limits

Physical Android/iPad interaction, real-provider authentication, full G9 playtests and broader release gates remain open. Creator undo/redo controls do not exist in the baseline and are not introduced here. No named groups, pushes, rerolls, new offline action queue or automatic effects are enabled. Production service/source/configuration are unchanged.


## Historical follow-up verification

The final local suites passed 427 server tests (10 existing DB-dependent skips) and 1,162 frontend tests. Root/frontend typechecks, production builds and generated-contract identity passed. Remote commit `ca1e5f6` has the exact locally verified tree `f4c155339641843aa21e2c3620c74a04e9fa462c`.

CI run 108 caught test synchronization issues: the new DB assertion compared per-read reconciliation UUIDs/expiry instead of persisted character state; the authoring journey reloaded before the matching formula save response; and an existing campaign-template offline fixture opened a new selector while restoring stale cached choices. The fixes compare all character data except read reconciliation, await the exact saved expression response, and await fresh catalog persistence before opening a new selection. Selected-reference retention behavior is unchanged. No retries, timeouts, screenshot baselines or production configuration were loosened. Follow-up commit `6c184de` changes tests only.

Railway is connected. The isolated preview source switch was rejected by automatic approval review because its environment is named `production` and direct deployment authorization was not considered explicit enough. A safer staged patch `122b2bfc-ece8-4bca-a9e4-774ec123b246` contains only the preview branch and pinned commit, with no destructive fields. At that point it had not been activated and the live journey was blocked on user approval. The owner subsequently explicitly approved the preview deployment. Railway then blocked builds during its platform incident; the successful retry is recorded below.


Run 109 passed server verification (including the two new real PostgreSQL error-receipt journeys), frontend checks, visual baselines, offline tests and two browser shards. The remaining browser assertion caught missing display-label plumbing in the Dice tab's sample bindings. Commit `f1002c2` supplies the document's field labels and input labels; 48 focused editor tests and frontend typecheck pass. The same canonical browser journey remains the acceptance gate for the repaired authoring-to-player path. No unrelated product behavior was changed to resolve the test races.

The staged source was pinned to the exact tested application revision before the owner approved activation. The later successful deployment is separate evidence from the CI browser run.


Run 110 on `f1002c2` passed all seven verification jobs, including the complete pool author-to-player browser journey. The documentation-only follow-up is `6d89187`. A final scalar-port regression then reproduced a distinction required by the plan: generic computed previews must preserve arithmetic fallbacks, while roll previews reject them. The arithmetic guard is confined to the roll-preview adapter; its regression covers both callers with the same failing expression. The corresponding final checks are shown on PR #21.


## Final CI and deployed acceptance — 2026-10-23

Tested application commit: `ad5de639aad8865837e9ee93266a5c114f05b378` (tree `de64c9be485ac2821b63aec32bce48d5a52dc37b`). [CI run 112](https://github.com/Kajonn/sweetroll/actions/runs/39733445139) passed all seven verification jobs: 437 server tests, 366 real PostgreSQL integration tests, 1,163 frontend tests, 52 browser journeys across three shards, 24 production-offline tests and 10 visual checks. Typechecks, generated contracts, production builds and Docker passed; the main-only production deployment job was skipped. Run status and all job conclusions were read back before recording acceptance. Local DB skips are not counted as database evidence.

After explicit owner approval, Railway accepted the source retry on 2026-10-23. Deployment `d16eefbe-3863-4ea1-b83d-33d7bffbde1b` in project `sweetroll-items-preview` (`f5662fc0-966a-4cc2-ba83-91bf8b0a2280`), environment `production` (`8016a027-c65d-4991-a7e8-7f38ff54dbf7`), service `sweetroll-items` (`f75d2a0b-66a6-49b7-95cc-a24ff99ac6f8`) reached terminal **SUCCESS** at 10:43:30 Europe/Stockholm (08:43:30 UTC). The environment name belongs to this isolated preview project. Read-back confirmed branch `feat/dice-pool-reliability` and exact commit `ad5de63`; pushes remain disabled by the source pin. Migrations completed, the container started in explicit test-auth mode, and `/health/ready` returned HTTP 200 with `{"status":"ok"}`. The separate `proactive-expression` production project was untouched.

URL: <https://sweetroll-items-production.up.railway.app>.

### Served artifact identity

The deployed HTML and worker contain timestamp-based offline build id `build-mvkq2ps3`. Rebuilding the unchanged checkout with `OFFLINE_BUILD_ID=build-mvkq2ps3 npm run web:build` reproduced every manifest-listed asset, HTML, worker and manifest byte for byte. An initial comparison correctly found the independently generated timestamp difference; no application-content difference was ignored.

| Served path | SHA-256 |
|---|---|
| `/index.html` | `29c84f19615c6bc77bc5b3757f1db14aa0b6829da60b43a95279b895bf7d332e` |
| `/assets/index--rnEHoQw.css` | `2649fa90f3974012ee0da3e55916a6a6d44a1fdd96f4fc507f4c41e2bb843504` |
| `/assets/index-BCWsfi59.js` | `6d537eaeddba9066fdec9fe87708a91132558155823a041394fdfedd56b9741e` |
| `/sw.js` | `bfa6ee3289169c56727c00eb0a1cfd404b0b727280bb0952dc67280ace66e47d` |
| `/offline-manifest.json` | `f034d018d1323af7824556491bceac31412424e1ee1768b6b20e3dfa03ce0ee9` |

### Live browser results

Playwright 1.48 / headless Chromium 130 on Linux, one worker and zero retries, against the Railway production build and its isolated real PostgreSQL. The canonical `web/tests/e2e/dicePoolReliability.spec.ts` was copied into an ignored temporary live harness. Only the target/configuration, test-auth login and identifier logging differed: the production build does not show the dev sign-in panel, so login posted `code-test-a` to the existing `/dev/signin` endpoint. Product assertions, timeout and save synchronization remained unchanged. The harness used the execution environment's outbound proxy and certificate trust accommodation; no repository test or application security setting changed.

- **Core journey: passed, 53.6 seconds.** Clone the license-neutral seeded pool system, author the item-granted action, reject `countSuccesses(5, 6)` through real assessment, preserve/reload the custom formula, disclose `Attribute: 0`, show zero without fabricated modifiers, publish 1.0.0 and create a character. Negative entity and granted-item pools show a reviewable failure; state/revision remain unchanged; explicit discard/correction succeeds; legal zero and positive pools roll. Widths 320/360/768/1280 in light/dark have no horizontal overflow; the item action survives reload.
- **Production offline reopening: passed, 24.7 seconds.** In a fresh signed-in context, load that character, wait for `Available offline`, disconnect the browser, reload the deep link and verify both pool controls remain accessible while `navigator.onLine` is false. Reconnect and verify state/revision are unchanged. This is reopening evidence, not a new live claim about offline rejected-command replay.
- Cleanup: the canonical journey deleted its cloned system `bbe1f568-08e6-4a58-a010-995ee799f965` through the API. After the offline check, the harness archived its own character `305924e5-b9ad-46d8-aa3d-5295352c5980` with a fresh key and current expected revision (HTTP 200). No pre-existing user data was removed.

Commands: `node web/node_modules/@playwright/test/cli.js test --config web/test-results/dice-live/config.cjs` and the corresponding `offline.config.cjs`. These temporary configurations start no local server. The original canonical test remains the committed source of the core assertions. An ESM-only temporary configuration stalled under the local runtime; switching the temporary config to CommonJS enabled normal discovery, without changing canonical tests.

Slice A has passed required CI and the deployed core acceptance journey and is ready for review. The plan's bundled keyboard/focus and offline failed-action-review requirements retain their unchecked status where this evidence does not close the whole bundle. Physical devices, real-provider authentication, wider G9 playtests and public release remain unclaimed. Slices B and C remain planned. The follow-up commit containing this record changes documentation only; the running application stays pinned to the tested `ad5de63`.
