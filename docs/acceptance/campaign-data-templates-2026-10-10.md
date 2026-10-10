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
