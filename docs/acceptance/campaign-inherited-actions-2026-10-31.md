# Campaign inherited actions — verification record

Date: 2026-10-31. Status: application CI complete on `f1fcbd7`; isolated deployment and hosted acceptance await confirmation.

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

## CI #150 findings

On `e8e1d2b`, all 468 root tests (including the ten database-backed tests skipped locally) and all 333 real PostgreSQL integration tests pass. Create p95 is 197.1 ms; reads 12.3 ms, bumps 28.3 ms and rolls 22 ms, with the original assertions unchanged. The derived browser journey and all 28 production-worker offline tests pass, including stale reference review and lost committed-push replay. Frontend and retained visual jobs pass.

Docker then exposed the shared browser fixture importing a root `tests/` file absent from the existing image build context. The fixture is moved into the established Systems package-fixture directory, which the Dockerfile already copies, and all consumers import the same fixture. No Dockerfile scope expansion or test exclusion is used. Final-head CI and isolated deployed acceptance remain open.

## Final-head load investigation

All six frontend/browser/offline/visual jobs on application `e25fb62` passed: 1,164 frontend tests, 60 browser journeys, 28 production-offline checks and 10 retained visual checks. Root tests passed (468), and 332/333 integration assertions passed; create p95 measured 317.4 ms and then 336.3 ms on a single server-job rerun against the unchanged 300 ms limit. No further blind retry was used.

The new slot projection unnecessarily embedded full ObjectTemplate mechanics, contrary to the planned UI-summary boundary. A meaningful red test now asserts inherited action projections omit expression IDs and push policies while preserving typed defaults/constraints. Projection and its HTTP DTO now carry the compact field/action summary; mechanics continue resolving from the pinned package. This removes roughly 680 KB and thousands of lines from the generated HTTP contract and reduces the response serializer graph. The latency improvement remains a hypothesis until the repaired-head integration run passes; no workload, threshold, assertion or timeout is weakened.

The isolated preview source is staged only (patch `314b6694-f876-431c-a364-ab82f6872d2f`). The live all-environment update was rejected by automatic review; a scoped non-destructive patch was prepared and inspected. Railway’s deployment confirmation then returned cancellation, so no new deployment or hosted journey has run.

## CI #152 — verified application candidate

[CI #152](https://github.com/Kajonn/sweetroll/actions/runs/41207415560) passed all seven verification jobs on application commit `f1fcbd745c7cfbbe1a9df7d15770f783fe5a99e5`, tree `bfbbb41accc54677a50909adaa768080549ac193`. Results: 468 root tests, 333 real PostgreSQL integration tests, 1,164 frontend tests, 60 browser journeys, 28 production-worker offline checks and 10 retained visual checks. Typechecks, generated-contract identity, production builds and Docker pass. No tests were skipped in the CI root/integration commands; the ten locally skipped DB tests passed in CI.

The compact projection regression passes and the original load limits pass without a retry on this application revision: create p95 264.1 ms, read 18.2 ms, bump 31.2 ms and roll 31.9 ms. Earlier full-mechanics projection revisions failed creation p95 (317.4/336.3 ms); their failures remain recorded above. No assertion, workload, retry setting or timeout was loosened.

The exact tested commit is staged for the existing isolated preview: project `sweetroll-items-preview` (`f5662fc0-966a-4cc2-ba83-91bf8b0a2280`), environment named `production` (`8016a027-c65d-4991-a7e8-7f38ff54dbf7`), service `sweetroll-items` (`f75d2a0b-66a6-49b7-95cc-a24ff99ac6f8`), patch `314b6694-f876-431c-a364-ab82f6872d2f`. Readback shows only that service's source configuration: branch and commit pin changes, plus no-op repo/image entries. The patch is non-destructive, with no shared-variable, volume, database or other-service change. The real application project `proactive-expression` remains untouched.

The live all-environment switch was rejected by automatic review as insufficiently scoped. After independently verifying isolation, the environment-scoped staged alternative was prepared and inspected. `accept-deploy` then returned "Cancelled — the user did not approve this action. No changes were made." No further deployment attempt bypassed that cancellation. The preview still runs baseline `ba8200b`, deployment `abf9286a-17ad-45a6-a7c2-bfe30409c60d`; readiness/asset identity and hosted journeys have not been claimed for this implementation.

Next: explicitly confirm applying this isolated preview patch; observe terminal SUCCESS/readiness; match served HTML/JS/CSS/worker/manifest to a rebuild of the tested application with its observed offline build ID; run both canonical derived acceptance journeys with two accounts and zero retries; read back scoped cleanup and record results. C7 and implementation readiness remain open until that evidence exists. Physical-device/provider-auth/playtest G9 gates remain separate and open.
