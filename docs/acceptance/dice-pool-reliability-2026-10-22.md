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
- Required CI: pending.
- Isolated Railway preview: connection restored 2026-10-22. Project `sweetroll-items-preview`, service `sweetroll-items`, separate Postgres; pre-change deployment `25f47e4e-4994-47a8-88c2-f2b0db8b5246` is healthy and follows the prior Sheets branch. Dice-pool deployment/journey pending.

## Limits

Physical Android/iPad interaction, real-provider authentication, full G9 playtests and broader release gates remain open. Creator undo/redo controls do not exist in the baseline and are not introduced here. No named groups, pushes, rerolls, new offline action queue or automatic effects are enabled. Production service/source/configuration are unchanged.
