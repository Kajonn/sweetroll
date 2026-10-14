# Campaign data-only templates — 2026-10-10

Scope: [PR #19](https://github.com/Kajonn/sweetroll/pull/19), slice B of the [adventure items roadmap](../superpowers/plans/2026-10-07-adventure-custom-items.md). Implementation baseline: `54580adb1cdf64b356fbd3011b31784f7fe938c4`. Tested code commit: `fff39e6ccc6dee00ff10636032a211abfc77db62` (Git tree `eb7892d54012adfac3e21b59932a37580c61da6f`, identical to local implementation commit `c66988b`). Documentation follow-ups do not change that code tree.

## Delivered behavior

GM/co-GM create-and-publish, edit, archive and recover bounded Item, Spell, Ability (`talent`) and Effect templates under Campaign → Items & powers. All published templates are visible to active members. Immutable content revisions are separate from lifecycle/concurrency revisions. Placement accepts only a pinned catalog reference, materializes defaults on the server and grants no actions. Local character values and quantity remain independent; catalog edits/archive never rewrite existing snapshots. Returned/duplicated sheets retain permitted snapshots without gaining catalog access.

Character offline placement persists the selected reference and both revisions through reload and frozen retry. A changed/archived template before first commit produces explicit conflict review with intent retained. Catalog authoring requires connectivity. Actor-scoped durable/query caches guard late responses and purge on account/character access changes. Populated entries conservatively block unsafe system upgrades; rollback cannot discard entries added after migration.

## Meaningful regression results

| Regression | Observed failure before repair | Observed passing evidence |
|---|---|---|
| Populated-entry migration | Shared candidate builder could rebuild state and drop personal/system entries. | Two shared migration regressions; PostgreSQL standalone/campaign preview/commit and post-migration rollback denial preserve pin/state/revision. |
| Client-authored definitions | Fastify's default additional-property removal silently accepted a payload carrying forged actions/snapshot. | Strict compiler rejects unknown fields with HTTP 400; campaign reference-only placement rejects overrides. |
| Campaign upgrade feedback | Entry guard was mapped to internal error; dialog showed generic retry text. | Conflict mapping and actionable server message; UpgradeDialog regression passes without destructive cleanup advice. |
| Offline catalog conflict | A real archive race returned API 409, but session feedback used the generic character-revision message. | Session suite 103 passed; production-browser reload/reconnect journey shows the campaign-template conflict and preserves exactly two committed entries. |
| Non-item quantity UI | Editing a campaign spell offered item quantity. | SlotListControl suite 12 passed; non-item update does not add quantity. |

Final template integration suite: 13 tests against PostgreSQL, including all four kinds, owner/co-GM/player/outside policy, scoped pagination, append-only content, exports, kind/capacity, same-revision concurrent writes, receipt identity/mismatch/current authorization, stale selection, a real archive race paused during runtime resolution, return/duplication and guarded migration/rollback. Existing system/personal paths remain covered by the full suites.

## Local verification, 2026-10-09–10

Node 24.19.0, native PostgreSQL 16.15 and Playwright 1.48 Chromium. Root unit: 411 passed in 38 files with a real database. Integration: 363 passed in 31 files before the final added template test; the final focused template suite passed all 13. Frontend: 1,124 passed in 110 files. Root/web TypeScript checks and production builds passed. Contracts regenerated and checked through `node --import tsx scripts/generate-system-contracts.ts` and its `--check` mode. `git diff --check` passed.

Focused Chromium journeys passed: campaign templates plus existing dynamic objects (2 tests), and the production-offline campaign journey (1 test). The three-context campaign fixture uses the supported `code-test-a`, `code-test-b`, `code-journey-p1` identities. It exercises GM publication, co-GM stale edit/refresh with retained text, player read-only discovery, local quantity/notes and reload, old content revision 3 versus new revision 4, archive/recover, offline add/reload/exactly-once reconnect and archive-before-reconnect conflict. The earlier revisions are created by the two-editor conflict scenario. Existing Longsword granted actions still pass their journey.

Catalog overflow probes passed at 320, 360, 768 and 1280 pixels. Dark-mode 360px catalog had zero serious/critical axe violations. This is automated coverage of that view, not full keyboard/contrast/device sign-off for every dialog and long-field permutation.

Local harness adaptations stayed outside committed configuration: built backend JS replaced `tsx` watch for sandbox IPC restrictions; PostgreSQL data used `/dev/shm` after scratch filesystem relation-read failures; browser processes used separate output folders. Canonical CI provides the independent check without those overrides. Docker was unavailable locally.

## Required CI

[CI #91](https://github.com/Kajonn/sweetroll/actions/runs/38057727936), on tested code commit `fff39e6ccc6dee00ff10636032a211abfc77db62`, completed **success** on 2026-10-10. All required jobs passed on their first attempt:

| Job | Observed result |
|---|---|
| verify | 411 server tests, 364 integration tests, TypeScript, canonical contracts check, build and Docker build passed. PostgreSQL 17.11; no skipped DB tests in these counts. |
| web | 1,124 tests, TypeScript and build passed. |
| web-e2e journeys | Three canonical shards: 17 + 18 + 15 = 50 passed. |
| web-e2e visual | 10 passed; existing baselines unchanged. |
| web-offline | 23 passed against the production build and isolated database. |
| Deploy production | Skipped as intended for a pull request; no main deployment is claimed. |

The existing Vite bundle-size warning remains; it does not fail the build.

## Deployed acceptance

Isolated Railway project `sweetroll-items-preview` (`f5662fc0-966a-4cc2-ba83-91bf8b0a2280`), service `sweetroll-items` (`f75d2a0b-66a6-49b7-95cc-a24ff99ac6f8`), environment `8016a027-c65d-4991-a7e8-7f38ff54dbf7`, with its own `preview-postgres`. Source pinned to tested commit `fff39e6ccc6dee00ff10636032a211abfc77db62`. Deployment `003f845c-ea29-46e7-acea-bf1ba614331f` reached **SUCCESS** at 14:03:30 UTC. Runtime logs report completed migrations and production-mode test-auth. `/health/ready` returned HTTP 200 with `{"status":"ok"}`.

The deployed offline manifest identifies `build-mv2grnvn`. Its `/assets/index-Drh_pJeI.js` and `/assets/index--rnEHoQw.css` bytes exactly match the tested local production assets (SHA-256 `4284160cce9369fb31af1f96b1e9b37d5c12d4f77699911da1f6a1de272e52e6` and `2649fa90f3974012ee0da3e55916a6a6d44a1fdd96f4fc507f4c41e2bb843504`). Fresh browser contexts avoided a prior worker retaining an old build; the passed live offline journey also observed the controlling worker via the Available offline readiness badge.

**Live multi-account browser acceptance passed at 14:12:57 UTC:** one Chromium journey, 2.9 minutes, zero retries, using the existing fixture assertions against [the isolated preview](https://sweetroll-items-production.up.railway.app).

1. GM published Tower key with default quantity 3. Co-GM retained their local text after a concurrent edit conflict, refreshed/reviewed and saved a new revision. Player saw the catalog without authoring controls.
2. Player placed content revision 3, edited notes to Player notes and quantity to 1, then reloaded. GM published content revision 4. The old copy kept revision 3 and local values; a new offline placement used the fetched revision 4 and default quantity 3.
3. The player disconnected, added, reloaded while offline and reconnected; exactly two entries were committed, with original versus new snapshots verified in the real API.
4. Archive removed discovery while existing copies remained; recover restored the catalog. A recovered choice was then queued offline and survived reload. GM archived before reconnect; the player received explicit campaign-template conflict review and no third entry was committed.
5. Catalog overflow probes at 320/360/768/1280 and the dark 360px serious/critical axe check also passed in the deployed journey.

The temporary harness used the workspace proxy with its specific CA public key trusted in Chromium and allowed 30-second assertions/10-minute total for remote transport (API setup requests took about six seconds each, while Railway processing was tens of milliseconds). Committed browser timeouts, zero retries and canonical tests are unchanged. Initial local-browser provisioning/DNS/proxy-CA setup failures are harness failures; the successful final run above is the live evidence. This production-built preview uses supported test identities, not a real production identity provider.

Read-only inspection of `proactive-expression` confirmed its existing production and acceptance services; their source/deployments and pre-existing staged patch were not changed. Slice A's historical evidence is unchanged.

## Limits and remaining gates

Inherited actions/system-derived templates, proposals, restricted drafts and explicit instance upgrades remain later slices. No offline catalog authoring or automatic effects were added. A disconnected browser cannot immediately learn remote revocation; current authorization is enforced at server commit and choices revalidate on reconnect/focus.

Physical Android/iPad, real-provider production authentication, full manual keyboard/long-field accessibility review and broader I7/G9 release acceptance remain open. The original execution-plan bundles that ask for additional named race/test permutations remain unchecked unless the complete bundle has evidence; core behavior and required automated CI have passed.

## Follow-up: manual journey defects repaired, 2026-10-10

An additional manual preview journey found three defects: an intermittently empty character template picker after reload, the raw `character.rollResult.audience.campaign` translation key after a Longsword roll, and a retained `Signed out.` message after successful acceptance sign-in. Code fix: `7f04c8752cd32d7f38f55b99be14a183152cfa4f` (tree `458cb4959dd4e121de40c496603c986f830b5443`).

The picker effect now follows replacements of the confirmed character snapshot, including projection-only refreshes that change the durable generation without changing the revision. It cancels the old request and reads a fresh write guard; account/character cache guards and purge handling are retained. Regression cases use the real session and IndexedDB store, defer the character/catalog responses in both orders, assert picker choices and durable cache contents, and verify that a late obsolete catalog cannot overwrite fresh choices. The shell clears logout feedback only once an authenticated actor is confirmed without a pending logout barrier. Both `gm_only` and `campaign` roll audiences have readable messages.

TDD evidence: the five focused cases failed before the fixes (two catalog-order cases, two audience cases, and the existing account-A → sign-out → account-B journey with the added status assertion), then passed. Full frontend suite: **1,128 passed in 110 files**. The three affected suites passed all 68 tests after fixture type correction. TypeScript/product build and `git diff --check` passed; the existing bundle-size warning remains. [CI #93](https://github.com/Kajonn/sweetroll/actions/runs/38077875909) completed **success** for the fix commit, including server/integration/contracts/Docker verification, frontend, all three journey shards, visual and production-offline jobs. Production deployment was skipped for the PR as intended.

The isolated preview service was pinned to the fix commit. Deployment `b5c25175-3ade-4537-9240-517575cf01dd` reached **SUCCESS** at 18:58:47 UTC; `/health/ready` returned HTTP 200 with `{"status":"ok"}`. The live DOM loaded `/assets/index-CJXObh--.js`, matching the locally tested production asset byte-for-byte.

Manual Chromium retest on [the preview](https://sweetroll-items-production.up.railway.app):

1. The existing Nyckelbärare PR19 character's Inventory picker showed Torch, Longsword, Dagger, Tornnyckel PR19 · Campaign and Custom entry on initial open and after three consecutive reloads. No extra recovery reload was needed.
2. Longsword Attack returned `d20 + Might`, total 7, and readable audience **Campaign**.
3. Account → sign out completed with `Signed out.`. Acceptance test sign-in restored the authenticated account and Sign out controls, with zero retained `Signed out.` nodes.

These follow-up live checks used one supported acceptance identity. They do not constitute a new live multi-account or offline run; CI #93 supplies the automated offline/journey regression evidence. Original live multi-account evidence and remaining device/provider/manual accessibility gates above are unchanged. The PR remains open and production infrastructure was not changed.


## Review remediation — 2026-10-14

Implementation commit: `0e61d157c62f622c8a6123ff3164a9b01fa7affe` (tree `8872c5a3368c5c745f37b1a4788431ad78e09fb8`). Implements Task 7 of the execution plan against planning commit `7fbf687`; the three reviewed defects at `6a9b0e1` are repaired.

- **R1, active revocation:** a template-discovery 404 enters the session-owned purge path with a durable generation guard. The sheet, pending/roll feedback and editing ownership clear, and other tabs receive invalidation. Obsolete account or placement denials cannot delete a newer authorized snapshot.
- **R3, durable scope:** snapshot confirmation and queue/online acknowledgment atomically invalidate catalog choices when campaign, placement generation or system/entity scope changes. IndexedDB version 4 discards old unverifiable selector caches while retaining character snapshots and frozen commands. Catalog writes require a current confirmed scope; late old-generation writes are rejected.
- **R2, selection:** the Add dialog retains the complete selected reference through catalog refresh/removal. Submission keeps its original revisions and campaign origin; a changed choice offers explicit **Use latest revision**. No frozen queue request is rewritten.

**Observed TDD:** the real route/session/IndexedDB revocation case failed before R1; the three scope-confirmation paths failed before R3; the revised/missing selection and explicit-review cases failed before R2. These seven focused red cases subsequently passed. Additional regressions cover a denial racing newer placement confirmation, account changes, cache transaction rollback, raw IndexedDB row deletion, safe v3 upgrade and retained frozen work.

Local Node 24.19.0 verification: full frontend **1,140 tests passed in 110 files**; focused route/session/store/slot suites **195 passed**. Frontend typecheck/production build, backend build and `git diff --check` passed. The existing bundle-size warning remains. A local PostgreSQL/browser-server harness was not established, so database and real browser evidence comes from canonical CI, not local skips or mocks.

[Required CI](https://github.com/Kajonn/sweetroll/actions/runs/38596526273) on the implementation commit completed **success**:

| Check | Result |
|---|---|
| verify | 411 server tests, 364 PostgreSQL integration tests, typecheck, contracts, build and Docker passed. |
| web | 1,140 frontend tests, typecheck and production build passed. |
| web-e2e journeys | 17 + 17 + 17 = 51 passed, zero retries. |
| web-e2e visual | 10 passed; existing baselines unchanged. |
| web-offline | 24 passed against the production build, zero retries. |
| Deploy production | Skipped as intended for a PR. |

The new shared review journey runs in both canonical browser and production-offline suites. It uses supported GM/co-GM/player identities and real API membership changes: archive while a player's Add dialog is open, submit the original reference and observe conflict, explicitly review a later revision and place it, remove the player while a catalog request is held, verify two open tabs hide the denied character, and verify raw catalog rows clear. A separately owned/adopted character returns to the player; failed catalog transport cannot retain its old catalog, while its placed snapshot survives. The offline variant also reloads the returned sheet disconnected and confirms no former campaign choice remains.

### Deployment approval history

Read-only Railway inspection confirmed the separate project **sweetroll-items-preview** (`f5662fc0-966a-4cc2-ba83-91bf8b0a2280`), service **sweetroll-items** (`f75d2a0b-66a6-49b7-95cc-a24ff99ac6f8`), with its own **preview-postgres**. Its environment is named `production` (`8016a027-c65d-4991-a7e8-7f38ff54dbf7`); this is distinct from the user's `proactive-expression` project.

Automatic approval review rejected an unscoped source connect because it could trigger a production deployment. After verifying isolation, an environment-scoped staged source update was accepted. Patch `8d705b56-0d66-4f8f-b087-11a065a97a58` contains exactly one nondestructive change: pin this preview service from `7f04c87` to `0e61d15`. The tool did not approve applying that patch, including after explicit approval in chat. At that point no deployment had been triggered and the latest deployment was still `b5c25175-3ade-4537-9240-517575cf01dd` on `7f04c87`. The user subsequently applied the single staged change directly in Railway; the resulting deployment and live evidence are recorded below.

The approval block is resolved by that user action. Task 7's deployed gate is closed by the observed results below. This workflow made no changes to the `proactive-expression` production project. Physical-device and real-provider production-authentication gates remain open.


### Fix-commit deployed verification passed — 2026-10-14

After the user applied the scoped preview patch, deployment `6c54fd6e-27a5-4158-a79a-2a6bdaae6119` reached **SUCCESS** at **17:37:56 UTC**. Runtime logs confirm completed migrations and supported test-auth mode; `/health/ready` returned HTTP 200 with `{"status":"ok"}`. No staged changes remained in the preview environment.

The service source configuration still identifies pinned commit `0e61d15`; Railway deployment metadata identifies `ae71eb4b481a53fbc1babe31c56f47484ca563df`. The Git diff between those commits contains only this acceptance document and the implementation plan. All required checks also passed on `ae71eb4`. The deployed manifest is `build-mv8e52zs`; its assets match the tested local production build byte-for-byte:

| Asset | SHA-256 |
|---|---|
| `/assets/index-CJPnMXjZ.js` | `3d55f21be6c79c9af0e20d16795419b7adbd908232e00ed04083fad19d9d4f69` |
| `/assets/index--rnEHoQw.css` | `2649fa90f3974012ee0da3e55916a6a6d44a1fdd96f4fc507f4c41e2bb843504` |

**Live Chromium result: 2 passed, zero retries, 5.9 minutes**, against [the isolated preview](https://sweetroll-items-production.up.railway.app). Passing run started 17:45:43 UTC and completed approximately 17:51:39 UTC. Both journeys used independent GM/co-GM/player browser contexts with the canonical supported identities.

1. **Full publication/offline journey, 185.2 seconds:** GM published, co-GM resolved concurrent edit conflict with input retained, player placed/edited/reloaded a copy, and later publication preserved the old copy while a new copy used the newer content revision. Offline add/reload/reconnect committed exactly once. Archive/recover preserved copies, and archive before reconnect produced explicit conflict without a third committed entry. Responsive overflow and the catalog's serious/critical axe check also passed.
2. **Review repairs journey, 169.1 seconds:** archiving during an open Add dialog retained the original campaign reference; submission produced the expected conflict. After recovery/revision, only explicit **Use latest revision** adopted and placed the newer content. Real membership removal while template discovery was held caused both open tabs to hide the denied GM-owned character and cleared its raw IndexedDB catalog row. A separately owned/adopted sheet returned to its owner; failed catalog transport cleared the former catalog while preserving the entire placed entry snapshot. Disconnected reload retained that copy and exposed no former campaign choice; raw IndexedDB remained clear.

The temporary live harness reused the committed journey functions, with remote-transport assertion/overall limits and explicit proxy configuration. An initial run was blocked at **Available offline**: Chromium's trace reported an SSL certificate error fetching the service-worker script through the workspace proxy. Trusting that proxy certificate's specific public key allowed service-worker registration, then both complete journeys passed with no retries in the corrected run. Fresh contexts and the Available offline checks proved the controlling worker and disconnected reload behavior. This was a harness certificate repair, not an application or committed test-configuration change. Temporary harness files were removed after verification.

The three review repairs and Task 7's CI/live gates are complete. Historical evidence above remains intact; physical Android/iPad, real-provider authentication, broader manual accessibility and I7/G9 release acceptance remain unclaimed. The PR remains open; no merge or production-source change was performed.
