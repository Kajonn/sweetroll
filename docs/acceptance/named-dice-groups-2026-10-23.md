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

## Required remaining checks

Real PostgreSQL integration tests cover both action sources, once-only stored results, HTTP serialization, same-key replay, rejected supplied outcome metadata, authorized history, campaign audience/export filtering and revoked replay. The 1.0 → 1.1 → rollback journey checks that historical legacy and grouped rows remain unchanged. Migration 0023 adds a nullable JSONB column and never rewrites old rows or receipts.

The canonical named-group browser journey exercises guided authoring and save/reload, preview, publish/create-character, entity and granted-item results, responsive light/dark display and history reload. A production-browser offline test reopens cached grouped history. These require actual execution in CI and a verified deployed preview before B acceptance is claimed.

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

## Isolated deployment approval gate

The dedicated project remains `sweetroll-items-preview` (`f5662fc0-966a-4cc2-ba83-91bf8b0a2280`), environment named `production` (`8016a027-c65d-4991-a7e8-7f38ff54dbf7`), service `sweetroll-items` (`f75d2a0b-66a6-49b7-95cc-a24ff99ac6f8`), separate PostgreSQL, URL <https://sweetroll-items-production.up.railway.app>. `proactive-expression` is untouched.

Reviewed patch `eb9e086b-a72f-423e-8668-707d45b2a8f8` has exactly two non-destructive source changes: branch to `feat/named-dice-groups` and commit pin to the CI-green `aa77d09`. No shared variables, networking, database service or other resources are staged. At 21:23 Europe/Helsinki on 2026-10-23 it was STAGED. The subsequent `accept-deploy` attempt returned **"Cancelled — the user did not approve this action. No changes were made."** Read-back confirmed the same pending patch, with no deployment started. The tool's approval control, rather than CI or a known build failure, blocks activation.

The running preview is still slice A deployment `d16eefbe-3863-4ea1-b83d-33d7bffbde1b`, commit `ad5de63`. **No slice-B live acceptance is claimed.** After approval, activate this exact reviewed patch, observe terminal SUCCESS and migrations/readiness, compare served frontend/worker artifacts, repeat the core named-group and production-offline journeys, then record the actual deployment/commit evidence. PR #22 remains draft until that gate is completed. Documentation-only follow-ups do not alter the staged application commit. Wider G9/device/provider-auth gates and slice C remain open.
