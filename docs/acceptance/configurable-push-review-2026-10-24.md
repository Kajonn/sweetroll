# Slice C review corrections — 2026-10-24

Scope: the six Copilot findings on [draft PR #23](https://github.com/Kajonn/sweetroll/pull/23#pullrequestreview-5639476374), plus the failing campaign-export assertion in CI 127. This records regression and repair evidence, not deployed slice C acceptance. Follow the remaining [C execution-plan gates](../superpowers/plans/2026-10-24-configurable-push-rolls.md).

| Finding | Repair and regression |
|---|---|
| Source removed after runtime validation; caller predicts the next revision | Pass the actual resolution revision to the transaction and compare it with the locked character revision for push-capable results. The PostgreSQL regression removes the granted item between resolution and commit, then requires 409, zero children and the item still absent. Both standalone and campaign commits use the same check. |
| Private `lastRoll` survives purge/sign-out/scope changes | Erase it during character purge, account clear and snapshot confirmation across owner, campaign, placement, version or entity changes. Invalidate scoped activity too. Store regressions reopen the database and assert absence. |
| A 404-denied result reappears offline | Keep the denial attached to that roll until a successful authorized response. Player, Activity and GM panels invoke the shared session/store handler to remove that chain from durable results and activity pages. A captured storage generation rejects a late activity response; offline reopening cannot restore it. Frozen uncertain commands remain intact. |
| Malformed 2xx retires a push without a recoverable outcome | Validate the complete public roll against shared bounded dice/breakdown/lineage schemas, the frozen parent/path, attempt bounds and receipt execution identity before acknowledging. Missing roll, wrong parent/execution, invalid attempt or out-of-range die retains the exact request. Acknowledgment storage failure also retains it. |
| Takeover/invalidation keeps an obsolete parent at unchanged revision | Adopt the durable result whenever adopting a stored snapshot, including clearing an absent result. Cover ownership takeover and invalidation in both owning and read-only sessions. Preserve same-generation queue notifications for readers. |
| “Reload theirs” leaves obsolete face text/errors in the editor | Synchronize on the supplied face-list content. External changes replace text and clear stale errors; unrelated equal-valued rerenders preserve unfinished invalid input. |
| Campaign export omits public push lineage | Include optional public `push` metadata in the canonical export projection and snapshot type. Keep it absent for legacy rolls. Existing principal/demotion regression verifies the authorized GM export and denied former co-GM reads/replays/export. |

## Observed regression evidence

- [CI 127](https://github.com/Kajonn/sweetroll/actions/runs/40121469268), `775766b`: 463 server tests passed; PostgreSQL integration had 380 passes and one failure because the campaign-export projection omitted `push`. The other six verification jobs passed.
- Test-only commit `5473f18`, [CI 128](https://github.com/Kajonn/sweetroll/actions/runs/40122612499): PostgreSQL reproduced acceptance of a push whose source had been removed (200 instead of 409), alongside the existing export failure. 380 integration tests passed and two failed.
- Before repairs, local cache regressions had four observed failures; recovery/takeover/editor regressions had eight observed failures.
- After repairs, focused store/session/coordination/panel/editor verification passed **192 tests**. The full frontend suite passed **1,197 tests in 114 files**. The server suite passed **453 tests with 10 existing database-dependent skips**; skips are not PostgreSQL acceptance.
- Server TypeScript build, frontend typecheck/production build, and generated-contract identity check passed locally. Full PostgreSQL/Docker/canonical browser verification remains a CI check on the repair commit, separately from these local results.

The broader test run also exposed a pre-existing test synchronization issue: a purge test used a five-millisecond delay to assume a send had started. It now waits for the actual send barrier before purging. Assertions and timeouts were not weakened.

No Railway service or production deployment was changed for these corrections. New slice C canonical browser/worker journeys, remaining compatibility/transition cases and exact-commit isolated deployment evidence remain open. The PR remains draft until those acceptance gates pass.
