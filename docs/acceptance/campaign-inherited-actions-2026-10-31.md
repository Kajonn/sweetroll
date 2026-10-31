# Campaign inherited actions — verification record

Date: 2026-10-31. Status: CI #158 and isolated hosted acceptance pass on deployed application `58c71a1`; both normal and production-worker recovery journeys pass with zero retries. Cleanup is independently verified. C7 is complete; wider G9 release gates remain open.

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

## Second hosted candidate — saved-roll clearing race

The owner applied the preview update. Deployment `7264aa8c-2ba0-468e-8561-02bc13ff3341` reached SUCCESS at 14:43:29 UTC with metadata commit `9f00c6bf8f6d5529044ff74d18a84955448ccc5c`; its application matches `f11e7b9`, configured source pin `f11e7b9`, and no changes remain staged. [CI #155](https://github.com/Kajonn/sweetroll/actions/runs/41211258976) passed all seven jobs on that documentation-only head. Readiness is healthy. A direct Vite rebuild with observed `OFFLINE_BUILD_ID=build-mvwigib5` matched every served artifact byte for byte:

| Artifact | SHA-256 |
| --- | --- |
| `/index.html` | `3cd5967ba61e10f14126782b21b506a5bfe00b43f1a45c09167f85fb841c5612` |
| `/assets/index-CCQNROF8.css` | `26841a98ac12725838c268120d874adb89fbc9449bf3375398de02d667d1ce58` |
| `/assets/index-pehCr_EM.js` | `695638030b75b75a07d21bae151ccfea25da429ac51687029a7ebcc9005b10eb` |
| `/sw.js` | `e7d8de256e96ef3ac4728bf11af945b02a69e63dd08b8de6ee0f30df51220c3d` |
| `/offline-manifest.json` | `a1f1e4e48e7d6320a6c4f04126fcfea6d50908fe83d1d7221f5bcb0be8fe78e9` |

The unchanged canonical runners (Chromium 130, one worker, zero retries, 180-second limit) ran against the new deployment. The normal multi-account journey passed in 31.8 seconds. Offline placement, stale-reference review/discard, value editing, reconnect and committed-push replay now pass the former draft-reset point. That journey then found a saved-roll clearing race after membership removal/character return: reading an inaccessible former-scope roll triggers `forgetRoll`; its delayed store read can replace a newer confirmed returned sheet with an older cached revision. The next fresh action used revision 6 against authoritative 7 and correctly received 409. This is a client snapshot regression, not an assertion/timeout issue.

A deterministic session test holds the old read, confirms the newer returned scope, then releases the old read. It failed with expected revision 2 versus observed 1. The repair rejects reads older than the in-memory account/character generation before adopting the post-clear snapshot. The test also verifies a fresh granted action uses the current revision. All 114 session tests, all 1,166 frontend tests, typecheck and production build pass. CI and deployed verification of this further repair remain pending; no final hosted acceptance is claimed.

Both second-candidate runs completed scoped cleanup, independently read back through fresh authenticated API requests: all run-created resources are archived and systems private.

| Run | System | Campaign | Character | Template |
| --- | --- | --- | --- | --- |
| normal | `5c418cf8-529c-4038-8a6c-e917c2be09af` | `9b0f3c9c-4086-43c9-b24d-38883e7a1215` | `c9b96837-0563-44cf-b36a-01e9e466fdfa` | `7edc0167-1620-4935-a649-7fa09550cff4` |
| offline | `dc99398b-0e2e-49d4-a5e2-11aa75c4eee8` | `39e8cb86-4559-478e-a677-90d65d9c04f1` | `e834476c-0229-4ce8-958e-8aad28d07cdb` | `6a8988e3-43a5-41bd-9fd3-a561dfc389bc` |

## CI #156 — returned-sheet race repaired, deployment staged

Repair `1b85c7507217abb753f9b413a77a2000e0bb3946`, tree `a1ef78fba11a8b213881e887a2e468e2c77fd8c6`, passed every verification job in [CI #156](https://github.com/Kajonn/sweetroll/actions/runs/41212002706). Results: 468 root tests, 333 real PostgreSQL integration tests, 1,166 frontend tests, 60 browser journeys, 28 production-worker offline checks and 10 retained visual checks, plus typechecks, contract identity, production builds and Docker. The deterministic saved-roll clearing regression was observed red → green. Original create/read/bump/roll p95 gates pass at 189/14.3/123.1/99.9 ms, with no threshold, workload, timeout or retry changes.

Only the existing isolated preview service's commit pin is staged from `f11e7b9` to `1b85c75`, patch `bb95d6fe-2d9d-4f76-8926-f534e7369579`. Review confirmed one non-destructive source-field change and no shared-variable, database, volume or other service change. Applying it after green CI again returned "Cancelled — the user did not approve this action. No changes were made." Readback confirms live deployment is still `7264aa8c-2ba0-468e-8561-02bc13ff3341`, commit `9f00c6b`. No alternative bypassed the gate.

The next concrete step is to apply this staged preview update, verify terminal SUCCESS, readiness and exact served assets, then run both canonical hosted journeys and independently read back cleanup. C7 stays open until the repaired return/recovery flow passes on the deployed build. This further repair changes no backend/schema, migration policy, mechanics or product scope; `proactive-expression` remains untouched. Physical-device, provider-authentication and playtest G9 gates remain open.

## Third hosted candidate — incomplete reconciliation exposed

The owner deployed `b766b9acf9c1fabe8a2a5db55fa0c071908bcd66` (application `1b85c75`) to the same isolated preview. Deployment `d9624c09-5faa-42cb-bd59-4d5a037dbeff` reached SUCCESS at 18:16:45 CET on 2026-10-31; source readback shows pin `1b85c75` and no staged changes. [CI #157](https://github.com/Kajonn/sweetroll/actions/runs/41212405310) passed all seven verification jobs on that documentation-only head. Readiness is healthy. A direct rebuild with observed offline build ID `build-mvwnx69u` matched all five served artifacts byte for byte:

| Artifact | SHA-256 |
| --- | --- |
| `/index.html` | `d3be4b084c7a0f6201ce9bb726919a098d6c43d7331ffdef0071cee821a603d6` |
| `/assets/index-C3Ia8aNu.js` | `25dbb7d8d8aa6bb99a24c1f24204dc5df5e9bc594e3d487e19247833b98d77f4` |
| `/assets/index-CCQNROF8.css` | `26841a98ac12725838c268120d874adb89fbc9449bf3375398de02d667d1ce58` |
| `/sw.js` | `499be359c25198cd8511f6c276447a937c858013f44da2b48fec01df6c791147` |
| `/offline-manifest.json` | `ccbe633426afb457495aca5dcbfc993012e0c83d791e4303fe2cda49d3e6127a` |

At 21:26 CET, the canonical runners again used Chromium 130, one worker, zero retries and the existing 180-second limit. Normal hosted acceptance passed in 30.8 seconds. The offline run failed in 27.5 seconds with the same fresh-action revision conflict after return. The previous `1b85c75` repair was incomplete: it prevents a late read from overwriting an already newer in-memory snapshot, but clearing a saved roll can also advance the store generation before the initial GET reconciles. Reconciliation adopted the cached winner and marked the session ready while discarding the newer server sheet.

The prior late-read regression had required two explicit refreshes; strengthening it to one refresh correctly exposed the missing behavior. A new deterministic startup regression holds the GET and post-clear read and asserts that the older revision is never exposed as ready. Both failed with expected revision 2 versus observed 1. Another test changes the generation between reading and persisting a GET result; clearing a roll incorrectly entered conflict. Its paired access-purge case remains terminal and must never repopulate the character.

The complete repair re-fetches authorized state when an adopted cache winner still trails the server view; a read-only confirmation that loses its guard re-evaluates current cache state. It retains the earlier protection against a late old read, respects account/ownership/blocking gates, preserves pending-intent conflicts, and keeps purges terminal. This only repeats read/reconciliation work; frozen mutation attempts, keys and manual conflict review remain unchanged. All 118 session tests and all 1,170 frontend tests, typecheck and production build pass. A lagging re-fetch also remains blocked behind the highest observed revision. The shared reconciliation path covers startup, manual refresh and existing review reads; frozen writes are unchanged. CI and hosted verification of this complete repair remain open until observed.

Fresh authenticated API contexts independently read back cleanup for both runs: every character/template/campaign/system is archived and both systems are private.

| Run | System | Campaign | Character | Template |
| --- | --- | --- | --- | --- |
| normal | `492e8ec7-f0b3-456e-96c4-85e32cae045a` | `b4bc7fb9-9f91-4b61-b2d0-291856e8f54b` | `dcbc1cf0-f190-4109-8d72-2e7b67384fc2` | `bde61082-f988-4413-9a06-3a2dba6eefbe` |
| offline | `ca1f4b23-1222-44b5-85ac-a5fead65901c` | `78e922b5-f0ff-43b0-96ec-161ce2fcaa97` | `7b384f26-aac6-4d6a-ad40-193c58a61cf8` | `7c1dcd2a-b00e-4898-b4ed-b207befaa2da` |

## Final acceptance — CI #158 and deployed `58c71a1`

[CI #158](https://github.com/Kajonn/sweetroll/actions/runs/41239762895) passed all seven verification jobs on application `58c71a173e8e7cc24291ecfda9d2cecc3319363f`, tree `56b6c50d23d126f84ec1c5d93bceb67c200db5a1`: 468 root, 333 real PostgreSQL integration, 1,170 frontend, 60 browser, 28 production-worker offline and 10 retained visual checks, plus typechecks, generated-contract identity, production builds and Docker. Session tests total 118. Original create/read/bump/roll p95 gates pass at 223.1/14.9/32/35.1 ms. No test, workload, assertion, timeout, retry setting or baseline was weakened.

The scoped preview patch was accepted and deployed. Deployment `5a090554-1e7d-4a06-98e2-3a6e1f0a886d` reached SUCCESS at 21:53:05 CET, 2026-10-31. Its commit metadata and configured source pin both identify exactly `58c71a1`, branch `docs/campaign-inherited-actions-plan`; no changes remain staged. Project `sweetroll-items-preview`, environment `8016a027-c65d-4991-a7e8-7f38ff54dbf7`, service `sweetroll-items` (`f75d2a0b-66a6-49b7-95cc-a24ff99ac6f8`), URL https://sweetroll-items-production.up.railway.app. The actual production project `proactive-expression` was untouched, and no database was reset.

Readiness returned `{"status":"ok"}`. A direct Vite rebuild of the exact source with observed `OFFLINE_BUILD_ID=build-mvwvnly0` matched all five served artifacts byte for byte:

| Artifact | SHA-256 |
| --- | --- |
| `/index.html` | `ab0f6052869878ad7bcf556f3e126001b06869aa09598d8f5b25691a236153d2` |
| `/assets/index-CCQNROF8.css` | `26841a98ac12725838c268120d874adb89fbc9449bf3375398de02d667d1ce58` |
| `/assets/index-Dbye9YK4.js` | `f4fccfe0254e922128d3ad6fca7155499b0e1da11e4a6b3352bd030db0b9126e` |
| `/sw.js` | `938b6033fcd21b5ec9e29ec75cb0590b0423af46d21e254b32eded33d3fca6b5` |
| `/offline-manifest.json` | `faefca0d365a3d2c44f7df350ae2fe70657f17a61f15ac6f1a998c52c10f2aa8` |

Both unchanged canonical hosted journeys passed in Chromium 130.0.6723.31, one worker, zero retries, with the existing 180-second limit: normal GM/co-GM/player journey 30.2 seconds; production-worker offline recovery 26.8 seconds; total 57.9 seconds. The GM editor and returned player sheet were checked at 320/360/768/1280 widths in light/dark. Normal coverage includes labeled base authoring, typed defaults, independent copies and values, inherited hit/damage/nominal/entry-resource actions, named-pool pushes, co-GM stale-edit rejection, revised placement defaults, archive, member removal and fresh inherited roll/push without catalog transport. Offline coverage includes frozen placement, reload/reconnect, stale archive/recover reference review and discard, independent value editing, committed-but-unseen push replay with identical frozen bodies and a single child, then returned-sheet roll/push. The former draft reset and incomplete return reconciliation now pass on the deployed build.

The supplemental deployed HTTP boundary checks recorded above remain valid for this identical backend (changes since those checks are frontend/tests/documentation): incompatible target rejection without an entry, removed-action/push denial while saved history remains readable, concurrent edits, stale placement, placement/archive race and revoked-access denial. Real PostgreSQL integration also covers derived return/duplication and competing pushes.

Fresh authenticated API contexts independently read back both final runs after fixture cleanup. Every run-created character, template, campaign and system is archived; systems are private:

| Run | System | Campaign | Character | Template |
| --- | --- | --- | --- | --- |
| normal | `4d52225e-52d7-470e-b531-de7dcddc045f` | `c80f138c-33f4-4b0f-b116-f493852a7a18` | `82e321eb-56a9-4ec3-9dcb-056b4f6c0daa` | `e3c8c91d-8680-4ff5-8da3-590b417799f5` |
| offline | `080c3d0b-cf85-4aed-97f1-91f96c128187` | `ad234915-1afd-41b9-a172-830f2a65ebf0` | `e01b8c8b-9421-4334-a88e-a2c3401364fe` | `572ef32e-7e59-408f-9da9-ba8228fe1c6e` |

C7 CI/deployed acceptance is complete. The implementation can proceed to review/merge. D1 player proposals and D2 restricted audiences remain follow-up slices. Unperformed physical Android/iPad, real-provider sign-in and physical-table/remote playtest G9 gates remain open; this is not a public-release claim. No application/database migration or older-version transition work is introduced before the first application release tag.
