# Campaign inherited actions — verification record

Date: 2026-10-31. Status: hosted normal journey passed on `5d3bb88`; offline acceptance exposed a draft-reset defect. Fix `f11e7b9` passes all CI #154 checks and is staged for isolated redeployment; final hosted acceptance remains open.

Scope: [execution plan](../superpowers/plans/2026-10-31-campaign-inherited-actions.md) and [contract](../superpowers/specs/2026-10-31-campaign-inherited-actions.md). The owner approved publication and implementation tree `56e70044` was published as `d720fc3` in PR #25. CI #149 exposed a saved-source schema defect and a load-test threshold failure; deployment has not started.

## Completed local evidence

Node 24: 458 server/unit tests passed; ten database-backed tests in that command were skipped. Frontend: 1,164 tests passed. Backend/frontend typechecks and production builds pass. The canonical contract generator reports identical checked-in output; diff whitespace checks pass. Browser retries, timeout settings, assertions and visual baselines were not weakened.

Observed red → green regressions cover missing derived action projection/execution; pinned base/default validation; GM source selection/publication; typed defaults clearing; returned-copy controls without catalog data; immutable push provenance (cloned source); unsupported template-computed action dependencies; and using the caller transaction for source reads. Shared fixture tests compile the actual integration/browser fixture and exercise metadata/name-field separation, independent copies, hit/damage/nominal/resource parity, saved-pool binding preservation, removal, restoration and changed placed source.

## Initial local verification limitations (superseded by CI and hosted evidence below)

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

## Hosted acceptance — 2026-10-31, first deployed candidate

The owner deployed `5d3bb889725bf2034819cd07411d9c520610a48c` to the existing isolated preview. Railway deployment `a24234ff-d94c-441a-9649-d02d2717c10a` reached SUCCESS at 14:21:46 UTC. That commit differs from tested application `f1fcbd7` only in four Markdown files; [CI #153](https://github.com/Kajonn/sweetroll/actions/runs/41207954049) also passed all seven verification jobs. Service readback has the expected branch, configured application pin `f1fcbd7`, no staged changes and the same preview domain. The actual deployment metadata records `5d3bb88`; these identities are deliberately distinguished. No production-project or database reset was performed.

`/health/ready` returned `{"status":"ok"}`. Rebuilding the same source with observed `OFFLINE_BUILD_ID=build-mvwhogfg` matched all five served artifacts byte for byte:

| Artifact | SHA-256 |
| --- | --- |
| `/index.html` | `c244b174a6f507f9eed21514da1eb3f43e8735732b0b5e3a9b6a5af40323d00e` |
| `/assets/index--CkVp4P6.js` | `a82f14b2a2dfd73617513ef278a51f13c5083bbfb27db835bf87dc2f132942df` |
| `/assets/index-CCQNROF8.css` | `26841a98ac12725838c268120d874adb89fbc9449bf3375398de02d667d1ce58` |
| `/sw.js` | `1c6ef995393f77aa06045e9649b25e8b56aa67e36e63ce2421b84497be9d2ccd` |
| `/offline-manifest.json` | `0a22ddc295cf884eaf742649b459a4dac782467cd79a621ab2d0173a9513c75c` |

The first local hosted attempt timed out both journeys: the installed Playwright API client creates a fresh required-proxy tunnel for every request, adding several seconds per API call and exceeding existing five-second polling deadlines. A local runner-only standard HTTPS agent pool reused those same proxy tunnels (successive readiness requests: 3,424 ms, 38 ms, 45 ms). The application, canonical fixtures, assertion deadlines, 180-second test limits and zero retries remained unchanged. With that transport correction the normal hosted journey passed in 25.8 seconds.

The offline journey then exposed a real UI failure after stale-placement discard and reload: a fresh sheet projection reset the open typed-value draft from 6 to persisted 4, leaving Save values disabled. `TemplateEntryForm` synchronized draft state on every `entry.values` object identity change. A new regression reproduces the loss on an equal-content sheet refresh (expected 3, observed 1) and verifies cancellation/reopening uses the current authoritative value. The fix initializes the draft when opening Edit values and preserves it while editing. This is not a timeout/assertion relaxation. Final-head CI, deployment and both hosted journeys must pass before readiness is claimed.

Scoped cleanup was independently read back for all four first-candidate attempts. Interrupted offline cleanup was completed using only its run-created IDs; every character/template/campaign/system is archived and each system is private. No unrelated resource was changed.

| Run | System | Campaign | Character | Template |
| --- | --- | --- | --- | --- |
| pooled offline before draft fix | `194f6325-3c58-4e78-ada3-a4e6aa1ad6fb` | `06ca2fa7-1776-4e85-b3aa-130f784ca16d` | `cbc4e3db-2f3c-4dba-bd00-d3ae3a9d9790` | `9133c4de-de87-428c-b0e3-7c80dc078523` |
| initial online | `4f476f5c-f8ef-4ada-a185-802399466f73` | `e41dde42-a218-4ba1-9015-38355f941681` | `58f14b4d-5bce-4838-81d6-917df65f6141` | `22acc3ad-1363-4714-98f9-a6b7228a089f` |
| initial offline | `cb895ede-6095-4cfa-85ed-490c63211383` | `9a818790-6996-4b80-9ad1-d32bb2aa1245` | `9bc1272b-9cfd-412f-a3f5-921fd3e6af3e` | `bb249688-31e3-4596-9ad5-e507ea4b6af8` |
| derived campaign template authoring, independent copies, actions, pushes and returned play | `3af42f78-596a-49fb-bd88-503f1e6a106f` | `30664843-0bb0-483f-9449-4d1bbd2363ae` | `dca803bd-cc5b-4717-a469-553a876b69d7` | `fc478c1c-805f-4c32-8066-336ac568f0cf` |

## CI #154 — hosted finding repaired, redeployment blocked

Application fix `f11e7b917c5c495dc4dcd42ddbfcb00556e9eb29`, tree `79fd2efccd3b61f0c990e6fc652da088e24df1d1`, passed all seven verification jobs in [CI #154](https://github.com/Kajonn/sweetroll/actions/runs/41210765171): 468 root, 333 real PostgreSQL integration, 1,165 frontend, 60 browser, 28 production-worker offline and 10 retained visual checks, plus typechecks, contract identity, production builds and Docker. The new draft-preservation test was observed red before the fix and green afterward. Original load limits pass: create/read/bump/roll p95 278.9/19.4/30.3/32.3 ms. No test or workload was weakened.

After this successful CI, only the preview service's commit pin was staged from `f1fcbd7` to `f11e7b9` in patch `61be70ec-b7f7-49ef-b859-98442bbf003b`. Inspection confirmed exactly one non-destructive source field change, no shared variables, database, volume or other service changes. The deployment action again returned "Cancelled — the user did not approve this action. No changes were made." Live deployment readback remains `a24234ff-d94c-441a-9649-d02d2717c10a` / `5d3bb88`. No alternate path bypassed this gate.

Supplemental real HTTP acceptance passed against that live candidate. Its backend is byte-identical in Git to `f11e7b9` (the repair changes only the sheet value editor, its frontend test and this record). These results verify the deployed backend; they do not substitute for redeploying and testing the repaired GUI:

| Boundary | Observed result |
| --- | --- |
| NPC without a compatible target slot/fields | Derived catalog choice absent; direct placement 422; no entry |
| Removed derived copy | Action 422, push 422; original saved roll remains readable (200) |
| Concurrent GM/co-GM catalog edits | Exactly one 200 and one 409 |
| Frozen stale catalog reference | Placement 409; no entry |
| Placement racing archive | Archive 200, placement 409; no entry |
| Revoked campaign member | Former controlled sheet and campaign catalog both 404 |

Supplemental run resources: system `bee57369-943c-4bc4-92be-8b7f68674f92`, campaign `7b756f0c-57fb-4a6f-bafc-8c1db8e1d74d`, template `43ea89db-c9b3-45c0-8e92-4ffd7da30463`, characters `8aad0558-0530-4750-af58-73e9fb1dc6b7`, `5efc9e58-7d08-49ec-b9eb-4a32d2f6d8c2`. Each was archived and independently read back; the system is private. All earlier run cleanup is also recorded above.

Next: apply the staged `f11e7b9` update in the isolated preview, verify terminal success/readiness and the new build identity, rerun both canonical hosted journeys with the same limits and zero retries, and read back scoped cleanup. C7 remains open until the repaired GUI passes hosted acceptance. Wider G9 device/provider-auth/playtest gates remain open.
