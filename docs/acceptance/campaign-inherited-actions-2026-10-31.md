# Campaign inherited actions — verification record

Date: 2026-10-31. Status: published implementation; CI findings being repaired before deployment.

Scope: [execution plan](../superpowers/plans/2026-10-31-campaign-inherited-actions.md) and [contract](../superpowers/specs/2026-10-31-campaign-inherited-actions.md). The owner approved publication and implementation tree `56e70044` was published as `d720fc3` in PR #25. CI #149 exposed a saved-source schema defect and a load-test threshold failure; deployment has not started.

## Completed local evidence

Node 24: 458 server/unit tests passed; ten database-backed tests in that command were skipped. Frontend: 1,164 tests passed. Backend/frontend typechecks and production builds pass. The canonical contract generator reports identical checked-in output; diff whitespace checks pass. Browser retries, timeout settings, assertions and visual baselines were not weakened.

Observed red → green regressions cover missing derived action projection/execution; pinned base/default validation; GM source selection/publication; typed defaults clearing; returned-copy controls without catalog data; immutable push provenance (cloned source); unsupported template-computed action dependencies; and using the caller transaction for source reads. Shared fixture tests compile the actual integration/browser fixture and exercise metadata/name-field separation, independent copies, hit/damage/nominal/resource parity, saved-pool binding preservation, removal, restoration and changed placed source.

## Not yet executed

- Real PostgreSQL integration and the ten DB-backed root tests, including immutable catalog revisions, permissions, transaction rollback and concurrent pushes.
- Canonical browser shards, production-worker recovery, retained visual suite and Docker build.
- Isolated deployed acceptance of the implementation. New shared browser journeys cover labeled GM authoring, player copies/actions/pushes, offline placement/value edits, archived/recovered stale reference review, committed-but-unseen push replay, co-GM conflicts, revised independent copies and returned play without catalog transport. They include responsive light/dark checks and scoped cleanup/readback, but require successful execution.

## Publication and CI findings

The owner explicitly approved the push. Command-line Git had no write credentials, so the connected GitHub integration published the exact approved tree and verified its identity. CI #149 passed frontend and retained visual checks and two journey shards. The new derived-push database and browser checks exposed `EntrySourceSchema` using an unregistered UUID format under TypeBox's saved-context validator. A new meaningful red test reproduces the saved-context rejection. UUID validation now uses the same strict pattern as the other runtime identities, without relying on global format registration. The source-read/placement and other inherited-action cases passed PostgreSQL coverage in that run.

The existing session-burst load assertion measured create p95 314 ms against 300 ms in #149. The threshold, retries and workload remain unchanged and must pass on the repaired head. The new browser fixture now verifies push availability explicitly and independently archives/reads back its own template during cleanup.

Read-only Railway inspection verified `sweetroll-items` in isolated project `sweetroll-items-preview`, environment `8016a027-c65d-4991-a7e8-7f38ff54dbf7`, service `f75d2a0b-66a6-49b7-95cc-a24ff99ac6f8`. It remains pinned to main `ba8200b3a6dff4a22e3865a7f7db1aeeab59058e`, successful deployment `abf9286a-17ad-45a6-a7c2-bfe30409c60d`. No service configuration, deployment or remote database was changed. `proactive-expression` was untouched.

Await all seven verification jobs on the repaired implementation head, deploy that head to the existing isolated preview, verify terminal success/readiness and served assets, then run `DERIVED_ACCEPTANCE_URL=https://sweetroll-items-production.up.railway.app web/node_modules/.bin/playwright test --config web/playwright.derived-acceptance.config.ts` with the config resolved from the repository root. Record failures/fixes and cleanup before closing C7. Wider physical Android/iPad, real-provider authentication and playtest G9 gates remain open. No migration/version-transition work is added before the first release tag.
