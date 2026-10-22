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
- Isolated Railway preview: connection restored 2026-10-22. Project `sweetroll-items-preview`, service `sweetroll-items`, separate Postgres; pre-change deployment `25f47e4e-4994-47a8-88c2-f2b0db8b5246` is healthy and follows the prior Sheets branch. Dice-pool deployment/journey pending.

## Limits

Physical Android/iPad interaction, real-provider authentication, full G9 playtests and broader release gates remain open. Creator undo/redo controls do not exist in the baseline and are not introduced here. No named groups, pushes, rerolls, new offline action queue or automatic effects are enabled. Production service/source/configuration are unchanged.


## Follow-up verification

The final local suites passed 427 server tests (10 existing DB-dependent skips) and 1,162 frontend tests. Root/frontend typechecks, production builds and generated-contract identity passed. Remote commit `ca1e5f6` has the exact locally verified tree `f4c155339641843aa21e2c3620c74a04e9fa462c`.

CI run 108 caught test synchronization issues: the new DB assertion compared per-read reconciliation UUIDs/expiry instead of persisted character state; the authoring journey reloaded before the matching formula save response; and an existing campaign-template offline fixture opened a new selector while restoring stale cached choices. The fixes compare all character data except read reconciliation, await the exact saved expression response, and await fresh catalog persistence before opening a new selection. Selected-reference retention behavior is unchanged. No retries, timeouts, screenshot baselines or production configuration were loosened. Follow-up commit `6c184de` changes tests only.

Railway is connected. The isolated preview source switch was rejected by automatic approval review because its environment is named `production` and direct deployment authorization was not considered explicit enough. A safer staged patch `122b2bfc-ece8-4bca-a9e4-774ec123b246` contains only the preview branch and pinned commit, with no destructive fields. It has not been activated. A live journey remains blocked on user approval; no production source, data or running preview deployment was changed.


Run 109 passed server verification (including the two new real PostgreSQL error-receipt journeys), frontend checks, visual baselines, offline tests and two browser shards. The remaining browser assertion caught missing display-label plumbing in the Dice tab's sample bindings. Commit `f1002c2` supplies the document's field labels and input labels; 48 focused editor tests and frontend typecheck pass. The same canonical browser journey remains the acceptance gate for the repaired authoring-to-player path. No unrelated product behavior was changed to resolve the test races.

The staged preview commit will be updated to the exact tested application revision before activation is requested. The live deployment/journey is still unclaimed until approval and execution. This document does not turn either the staged change or a CI browser run into deployed evidence.


Run 110 on `f1002c2` passed all seven verification jobs, including the complete pool author-to-player browser journey. The documentation-only follow-up is `6d89187`. A final scalar-port regression then reproduced a distinction required by the plan: generic computed previews must preserve arithmetic fallbacks, while roll previews reject them. The arithmetic guard is confined to the roll-preview adapter; its regression covers both callers with the same failing expression. The corresponding final checks are shown on PR #21.
