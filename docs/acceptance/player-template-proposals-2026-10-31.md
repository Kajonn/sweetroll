# Player template proposals — D1 acceptance

Status: implementation and isolated hosted acceptance complete in PR #26; final application CI #164 passed all seven verification jobs. This is not a public-release claim.

Baseline: inherited-actions PR #25 merged as `455f967` and merged into this branch. Current schema is updated directly; no migration or prior-client conversion is added.

## Observed red → green

- Real PostgreSQL HTTP suite first returned missing-route 404 for submissions; implemented strict routes, private self/review scope, membership-generation receipts, decisions and export. Nine tests pass, including all four kinds, hostile content/unknown fields, own-only pagination, cross-scope cursor denial, same-key replay/mismatch, removal/rejoin, competing reviewers, private rejection and archived reads/writes.
- Strict HTTP rejection initially accepted unknown fields because Fastify stripped them. Reuse the existing strict compiler for proposal routes; hostile inputs now return 400 before writes.
- Injected failures at catalog revision insert, terminal update, activity, audit and success receipt prove all-or-nothing rollback. Quotas serialize under the campaign lock. Approved identity and original content survive later template edits/archival and expired receipts cannot republish.
- GUI tests began with a missing proposal component. Frozen submit retries, explicit conflict refresh, direct GM review and delayed GM-response discard on demotion now pass. A caller-cancellation regression was observed red before propagating AbortSignal through ApiClient.
- Canonical new dev-browser journey passed locally: 8.8 seconds, one worker, zero retries. Four identities, independent original personal entry, another player's direct-ID/list denial, GM approval, player placement, lost submit/approve responses with exact retry, lost reject response with reload/no POST, competing GM/co-GM decisions, GM export, removal/rejoin, keyboard primitives, axe and 320/360/768/1280 light/dark overflow checks. Run-created resources archived and read back.

## Final verification

All 342 real PostgreSQL 17 integration tests pass locally (32 files, 87.92s), including unchanged workload/latency limits. Final CI frontend suite: 1,176 pass. Exact final browser/production-worker journeys pass locally in 9.0s/6.6s, one worker, zero retries. The mobile form and desktop GM review were rendered and visually inspected. CI #163 passed all seven verification jobs on `c8cc367`; final application `cc87c7485cb4a3aa5473f047384fb89ec525a635` passed [CI #164](https://github.com/Kajonn/sweetroll/actions/runs/41245666207). Hosted final acceptance and byte identity checks pass; all seven verification jobs are green, including Docker, generated-contract identity, typechecks and builds. Optional sheet prefill shortcut is not implemented: player copies presentation into the campaign suggestion form, which has no source-entry link. Physical-device, real-provider authentication and wider G9 playtests remain open.

## Additional observed fixes

The production-worker journey initially kept the submit button enabled after going offline. Campaign route subscriptions compared identity generation only, although connectivity changes retained that generation. Subscribe to the stable full identity snapshot, preserving actor/generation remount keys. The identical offline-control assertion passes after repair; no timeout, retry, assertion, latency workload or visual baseline was loosened.

Keyboard acceptance exposed missing return focus after Escape because the proposal dialogs open through custom buttons. Track player/reviewer openers and use Radix close autofocus; successful mutations focus the section heading. The new component test and canonical browser Escape → focused opener → Enter regression pass.

## Preview isolation

Use `sweetroll-items-preview`, never `proactive-expression`. A separate `preview-d1-postgres` service holds this schema; the previous preview database remains intact. Record exact application SHA, deployment ID, served assets and hosted journey/cleanup results before claiming completion.


## Exact deployed application and hosted acceptance

Application/source pin: `cc87c7485cb4a3aa5473f047384fb89ec525a635`. Railway project `sweetroll-items-preview` (`f5662fc0-966a-4cc2-ba83-91bf8b0a2280`), service `sweetroll-items` (`f75d2a0b-66a6-49b7-95cc-a24ff99ac6f8`), environment `8016a027-c65d-4991-a7e8-7f38ff54dbf7`, deployment `76f087c3-47a1-4041-8df8-16d4fdd505fa`: terminal **SUCCESS**, readiness `{status:"ok"}`. Source is explicitly pinned to this tested application. `proactive-expression` is unchanged.

The new disposable `preview-d1-postgres` (`53b14b59-f55a-4a80-b7e9-993b9df27562`) is colocated with the application in `sfo`. Initial cross-region creation produced connection timeouts under the existing 250ms pool connection budget; colocating fixes preview infrastructure without loosening application timeouts. The previous `preview-postgres` remains intact. No remote reset, schema migration or old-data conversion was performed.

Served HTML, JS, CSS, service worker, offline manifest and web manifest match a local rebuild of the exact source byte for byte, using the observed build ID `build-mvwxupcq`. Main JS `/assets/index-ABwt28I_.js`: 882,860 bytes, SHA-256 `cbc4e84f69908f5637a5c3f104b2f753d0b9935012810316b36a6786b6ed2fa7`. This verifies actual served assets, rather than trusting only source configuration.

Both canonical hosted journeys pass in Chromium 130, one worker and zero retries:

| Journey | Duration | Character | Campaign | System |
| --- | --- | --- | --- | --- |
| Normal private submission/GM publication | 31.817s | `8e1615bc-572b-43e0-8cff-09b3b4bd8166` | `1ae2bf0e-5f25-4eba-b101-de53f93f2ea2` | `8ca0c8c8-16ee-42d3-a1f2-1ec7adf2d3c8` |
| Production worker/offline authority/recovery | 17.983s | `7963070d-f0c7-42f8-83b9-c413676f6dc5` | `1d68d0e9-37d8-4c86-9a61-4ce7e2ca2746` | `2a8ec459-1fa7-420c-83cb-b1049520ff04` |

Each journey uses GM, co-GM and two players. It proves a private suggestion does not appear in catalog/shared discovery; a different player gets empty lists and direct-ID/export denial; approval creates one ordinary independent template; player placement preserves the original personal entry and its revision; rejection publishes nothing. Committed submit/approve response loss reuses identical requests/keys; committed rejection response loss followed by reload performs no new POST. Competing approve/reject decisions leave one terminal result. GM export includes bounded proposals. Removal/rejoin hides the previous membership's records. The offline journey proves disabled writes and absence of proposal API responses in service-worker caches. Keyboard Escape/focus/Enter, axe and light/dark 320/360/768/1280 layouts retain their assertions; screenshots were visually inspected.

Separate hosted HTTP acceptance in campaign `5539724c-ffae-4c79-accd-a56bbca7f83e` creates exactly 500 bounded templates. Approval at capacity returns 413, leaves revision 1 pending with no link, and adds no publication/activity. The GM export contains exactly 500 templates/500 ordinary publication events plus the private proposal. A stale decision returns 409. Demotion revokes private direct-ID reads and saved GM exports. Rejection remains available at capacity. Removed/rejoined submissions remain inaccessible and cannot be approved. The application backend is identical across the `c8cc367` → `cc87c74` frontend focus-only deployment during this supplemental run.

All run-created characters, templates, campaigns and systems were archived and independently read back through fresh authorized contexts; systems are private. The two journeys archived four templates: `c411b219-7266-4797-9c57-e88a1803e59a`, `073a86b2-e9ce-46bd-a988-8791ffa6931e`, `5a55ae88-d52f-4a6e-9bb5-c7efd529180e`, `03f40b31-1411-42ce-8ec1-cb1bf58fdc7b`. The supplemental campaign's 500 templates were paginated/read back as archived and its campaign was archived. Proposal records remain under the archived campaign's normal private read policy.

Optional personal-entry prefill is deferred; the submitted form copies text without a source link. Physical devices, real-provider authentication, wider G9/playtests and D2 restricted audiences remain open. D1 introduces no durable proposal queue, executable proposal, rules/package format, character conversion or migration work.


CI #164 on the exact application: 468 root tests, 342 real PostgreSQL integration tests, 1,176 frontend tests, 61 canonical browser journeys, 29 production-worker offline checks and 10 retained visual checks pass. Character create/read/bump/roll p95: 262.6/19.0/28.7/30.6 ms with unchanged workloads and limits. Campaign read/content/bump/roll p95: 41.2/76.9/223.3/225.5 ms. Typechecks, contract identity, production builds and Docker pass. Subsequent acceptance-document edits do not change the application/source pin.
