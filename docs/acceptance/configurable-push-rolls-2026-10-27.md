# Slice C scoped acceptance — 2026-10-27

**Result:** all nine in-scope browser journeys passed against the deployed PR application, with zero configured retries and no weakened assertions, timeouts or visual baselines. No new blocking defect was observed in these journeys. The scope and verification limits below matter when interpreting this result.

## Owner scope and target

The owner confirmed on 2026-10-27 that no release has been made and there are no existing users. Upgrade, migration/rollback and previous-client compatibility are deferred; they are not implementation or merge requirements for this slice. No new implementation or acceptance harness for those capabilities is included in this follow-up. Two such cases from the originally started suite are explicitly excluded from the accepted-case count in the [structured evidence](configurable-push-live-2026-10-27.json).

- Application commit: `dfae37f4a70e2af144a6ee6df98e4acb86e467f5` ([PR #23](https://github.com/Kajonn/sweetroll/pull/23)).
- Isolated Railway project `sweetroll-items-preview` / `f5662fc0-966a-4cc2-ba83-91bf8b0a2280`, environment `8016a027-c65d-4991-a7e8-7f38ff54dbf7`, service `f75d2a0b-66a6-49b7-95cc-a24ff99ac6f8`.
- Deployment `90462834-5fbd-4aea-865c-2f9cdc9680b5` reached terminal **SUCCESS** on the exact commit above. Source configuration was read before deployment; the old source pin was replaced with this exact commit. No production-project source was changed.
- Direct target: <https://sweetroll-items-production.up.railway.app>. `/health/ready` returned 200 and `{ "status": "ok" }`.
- All five served files (HTML, JS, CSS, worker and manifest) matched a current-source production rebuild byte for byte using the observed build ID `build-mvqfany4`. Exact hashes are in the structured evidence.
- Chromium 130 / Playwright 1.48 on Linux, two distinct explicit preview test-provider accounts. Responsive assertions cover 320/360/768/1280 widths and light/dark; screenshot output was inspected. This is not a physical-device or provider-OAuth claim.
- [CI 135](https://github.com/Kajonn/sweetroll/actions/runs/40472655606) passed all seven verification jobs on this application commit: 463 server, 382 real PostgreSQL integration, 1,202 frontend, 61 browser journeys, 28 offline tests, visual checks, typechecks, generated contracts, builds and Docker.

## Accepted journeys

| Case | Duration | Observed scope |
|---|---:|---|
| Creator A | 78.6s | Author policy through the UI, autosave/reopen, publish/create sheet, entity and granted-item pushes, original bindings after edits, stable dice identities, history/reload, limits, responsive themes and focus restoration. |
| Independent creator B | 76.0s | The same complete author/publish/play journey on a separately authenticated second account, with its own private system and character. Item rules are installed by the shared fixture; this does not claim a new item-policy editor. |
| GM/co-GM | 143.1s | Session-board pushes, inherited GM-only visibility, authorized export with public lineage, role demotion, denied replay and erasure of denied cached results. |
| Policy edges | 84.2s | All eligible faces locked, empty eligible pool and success-blocked policy yield disabled controls and matching server denials. |
| Source/lifecycle | 128.0s | Removing the original item blocks its saved pool; exact restoration restores eligibility. Archive/recovery is respected and the child retains the original pool. |
| Early Activity | 59.5s | Immediate opening while initial reconciliation is held sends no Activity request. Releasing it produces exactly one read, the actual saved result and an enabled Refresh button, with no raw cache-generation alert. |
| Competing GM actors | 126.7s | Simultaneous different-key pushes produce 200/409, one accepted child, exact same-key replay and audience-authorized shared history. |
| Placement/return | 164.1s | Adoption and returned ownership advance placement generation; earlier-scope roll IDs are denied, former GM access is removed, old durable results disappear and a fresh returned-character roll can be pushed. |
| Lost response / offline | 74.2s | A real committed child with its response withheld survives offline reload. Reconnect replays the exact frozen request, retains a single child, then reopens it offline with pushing disabled. |

The second-author run initially used a temporary copy of the canonical creator journey with only its sign-in account changed. The retained canonical test now accepts `PUSH_ACCEPTANCE_AUTHOR_CODE`, avoiding duplicated test code. The focused remote config discovers eight core cases; the separate creator-B invocation makes nine.

## Cleanup and verification limits

Independent API read-back verified all **nine run-created systems archived/private, nine characters archived and three campaigns archived**. Only these run-created UUIDs were inspected. Exact states and IDs are recorded in the structured evidence. Immutable published versions and activity are retained.

Changing the campaign's internal default roll audience is **not live-verified**: the current public settings API exposes no mutation for that policy, and the Railway OAuth connection exposes variable names without database credentials. No settings API or credential workaround was added for this acceptance. Existing PostgreSQL integration tests passed on the tested application commit, including default changes, narrowing, receipt replay and principal/demotion checks. This remains a distinction between integration evidence and deployed evidence; it is not an unobserved live success.

Physical Android/iPad playtests and actual identity-provider authentication are unperformed public-release checks. No full-public-release claim is made. Upgrade, migration/rollback and historical-client checks are excluded by the owner's current scope and must not reappear as merge blockers.

## Reproduction

From the repository root, with Playwright Chromium installed and the preview's explicit test provider enabled:

```bash
PUSH_ACCEPTANCE_URL=https://sweetroll-items-production.up.railway.app \
  npx --prefix web playwright test --config=web/playwright.push-acceptance.config.ts

PUSH_ACCEPTANCE_URL=https://sweetroll-items-production.up.railway.app \
PUSH_ACCEPTANCE_AUTHOR_CODE=code-test-b \
PUSH_ACCEPTANCE_OUTPUT_DIR=/tmp/sweetroll-creator-b-acceptance \
  npx --prefix web playwright test --config=web/playwright.push-acceptance.config.ts \
  --grep "creator publishes push rules"
```

The config has one worker and zero retries, excludes migration/rollback, and does not start a local backend or change Railway sources. Override `PUSH_ACCEPTANCE_OUTPUT_DIR` for a distinct evidence directory. Its fixture cleanup archives only its own created resources.
