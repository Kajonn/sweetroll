# Configurable pushes — isolated live journeys, 2026-10-24

The three core slice C journeys below passed against the actual production build in the isolated `sweetroll-items-preview` project. This is core deployed evidence, not completion of every [C acceptance bundle](../superpowers/plans/2026-10-24-configurable-push-rolls.md), device or provider-authentication gate.

## Deployment and artifact identity

- Application commit: `f75cb02fe2ee54021338d612f2506b3907264d24`, with all seven verification jobs green in [CI 129](https://github.com/Kajonn/sweetroll/actions/runs/40123283251).
- Railway deployment: `0d776788-110d-403a-8350-3e7dc0e6a4a9`, observed terminal **SUCCESS** with the same actual `meta.commitHash` and PR branch. The user applied the staged source after `accept-deploy` was cancelled by the tool.
- Project `f5662fc0-966a-4cc2-ba83-91bf8b0a2280`; environment `8016a027-c65d-4991-a7e8-7f38ff54dbf7`; app service `f75d2a0b-66a6-49b7-95cc-a24ff99ac6f8`. The unrelated `proactive-expression` project was untouched.
- Preview: <https://sweetroll-items-production.up.railway.app>.
- Pre-deploy log reported `database migrations complete`; `/health/ready` returned 200 with `{"status":"ok"}`. Successful new root/child writes exercised the new migration’s storage in that database.
- Served build ID `build-mvms4nlj`. Rebuilding the application commit with that `OFFLINE_BUILD_ID` produced byte-identical HTML, JavaScript, CSS, worker and manifest. The JavaScript SHA-256 is `cc7ea6d82b4338af40f985253a30fd387c742a9ba49bb01aad3d4706b124d3d6`; all five artifact hashes are in the [structured record](configurable-push-live-2026-10-24.json).

## Passed journeys

Chromium 130.0.6723.31 / Playwright 1.48.0, Linux, real HTTP and database; zero configured retries. Separate browser contexts used the preview’s explicit test identities. Production provider OAuth was not exercised. Proxy certificate exceptions were local browser-test configuration only.

| Canonical test | Observed behavior |
|---|---|
| `web/tests/e2e/configurablePush.spec.ts` | Creator enables policy through the UI, edits maximum and reports, autosaves/reopens schema 1.2, publishes and creates a character through the UI. An entity root at attribute 1 remains a one-attribute-die pool after changing the current field to 4. Two pushes retain bindings, IDs and the unlisted skill die; parent navigation works, the maximum disables further pushes and reload preserves the latest child. Adding a system item and rolling/pushing its granted action preserves the same behavior. Five public roll records reopen in Activity; Escape restores opener focus. No horizontal overflow at 320/360/768/1280 in light/dark. |
| `web/tests/offline/pushRecovery.spec.ts` | The intercepted first push genuinely commits, then its response is withheld and connectivity is removed. Offline reload retains the exact durable request. Reconnection sends the same body/key, acknowledges the same child and retires the attempt; history contains exactly root plus child. The acknowledged child reopens offline with pushing disabled and no new attempt. |
| `web/tests/e2e/campaignPush.spec.ts` | Owner rolls GM-only from Session. A co-GM controller pushes through Activity, then pushes the saved child through Session. Authorized campaign export preserves public lineage. After demotion to player, that controller still reads the sheet (200), but child read and old command replay return 404. Options denial removes the saved result; a controlled production worker reload offline does not restore it. |

The creator fixture’s sampled entity dice were `[4,5] → [5,5] → [5,5]`, total 2 throughout; only `attribute:0` was rerolled. Its item pool was `[3,5,6,5,3] → [6,5,4,4,3]`, total 1, retaining the final skill die. The recovery journey captured two identical request bodies and exactly one accepted child. The campaign chain reported attribute face 1 as both combined/newly rolled count 1 in its first child, with no automatic resource mutation. Full public results and resource IDs are in the structured record; no cookies, seeds, private snapshot or idempotency key is included.

The newly added files are canonical tests, not an alternate app implementation. Later commits containing only these tests and acceptance documentation do not change the deployed application; the exact tested product commit remains `f75cb02`.

## Test synchronization and cleanup

An initial creator run lost trace files because two local runners shared an output directory. A subsequent run exposed the pending-edit barrier when Tab focused another number field and clicking Push blurred that field, queuing an edit. The final journey explicitly commits the intended attribute edit with Enter and waits for its server acknowledgment before pushing. Assertions, RNG, baselines and test timeout were not loosened. Final runs used separate output directories and all passed; these setup attempts are not counted as successful journeys.

Each successful fixture archived its own characters and systems (and the test campaign), returned its system to private access, and checked read-back. Both interrupted creator fixtures were also explicitly archived and verified. The structured record contains exact IDs. Published versions and immutable histories were retained. No unrelated records were deleted or altered.

## Remaining gates

This evidence covers the core flows above. Worker replacement during a pending push, previous/current reader compatibility, the remaining source/version/placement/lifecycle browser transition matrix, live competing-key/default-narrowing cases, wider device coverage and production provider authentication remain separate gates. PostgreSQL integration tests already cover atomic rollback, source races, competing actors and principal/default policy, but those do not substitute for unperformed live cases. Keep the PR draft until the required remaining bundles are complete.
