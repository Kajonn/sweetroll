# Slice C acceptance follow-up — 2026-10-25

Ten bounded software acceptance scenarios passed with zero configured retries. Software acceptance was exercised against the isolated preview and in production-browser compatibility checks. **The PR remains draft:** the automatic rollback UI and an early Activity-loading race need follow-up. Passing the bounded journeys below does not close those findings or the wider device/provider-authentication gates.

## Target and verification

- PR base for these tests: `c2685b1ace02425355814a0f131ddbf43c62f6c3`; application code is unchanged from `f75cb02fe2ee54021338d612f2506b3907264d24`.
- Railway project `f5662fc0-966a-4cc2-ba83-91bf8b0a2280`, environment `8016a027-c65d-4991-a7e8-7f38ff54dbf7`, service `f75d2a0b-66a6-49b7-95cc-a24ff99ac6f8`, deployment `0d776788-110d-403a-8350-3e7dc0e6a4a9`: observed SUCCESS, actual application commit `f75cb02`.
- Direct preview: <https://sweetroll-items-production.up.railway.app>. Readiness returned 200. All five served hashes (HTML, JS, CSS, worker, offline manifest) were rechecked against the previously verified deployment and matched; JS SHA-256 remains `cc7ea6d82b4338af40f985253a30fd387c742a9ba49bb01aad3d4706b124d3d6`.
- Chromium 130 / Playwright 1.48, Linux, explicit preview test identities A/B, zero configured retries. Responsive core coverage used 320/360/768/1280 widths and light/dark. This is browser emulation, not physical-device or provider OAuth evidence.
- [CI 131](https://github.com/Kajonn/sweetroll/actions/runs/40167821058) passed all seven verification jobs before the new acceptance files were added. The acceptance commit's own CI is a separate retained check. Frontend typecheck includes all new test files.

## Observed cases

| Canonical file / case | Observed result and scope |
|---|---|
| `e2e/configurablePush.spec.ts` | Direct preview: creator policy editing/autosave/reopen/publish, entity and granted-item rolls/pushes, immutable original bindings after field edits, parent navigation, maximum attempts, history/reload, responsive themes and Escape/focus restoration passed. |
| `e2e/campaignPush.spec.ts` | Direct preview: GM and co-GM pushes, inherited GM-only visibility, export lineage, demotion/replay denial and offline cache erasure passed. |
| `offline/pushRecovery.spec.ts` | Direct preview: a real committed child with its first response withheld survived offline reload; the exact request replayed, only one child existed, and the confirmed child reopened offline with pushing disabled. |
| `e2e/pushTransitions.spec.ts` — competing actors | Direct preview: simultaneous different-key pushes by two authorized GM actors produced exactly 200/409; same-key replay returned the identical child, history contained one accepted child, and both public results opened for the co-GM. |
| `e2e/pushTransitions.spec.ts` — source/lifecycle | Direct preview: removing the original item disabled pushing; exact restoration re-enabled it. Archive disabled it, recovery restored it, and the eventual child retained the original item pool. |
| `e2e/pushTransitions.spec.ts` — version/rollback | Direct preview: migration disabled the original pool with `rules_changed` and its command returned 422. Rollback using the commit's authoritative `reconciliation.commandExecutionId` restored the exact original version, re-enabled the original pool and produced a child with unchanged original bindings/dice identity. This does not claim the UI's automatic ID selection works. |
| `e2e/pushTransitions.spec.ts` — placement | Direct preview: personal → campaign → returned ownership advanced placement generation twice. Old personal and attached pools remained 404, the former GM lost sheet access, durable old results disappeared, and a fresh returned-character roll/push succeeded. |
| `e2e/pushTransitions.spec.ts` — policy edges | Direct preview: all eligible faces locked, an empty eligible group, and disallowed successful rolls produced disabled UI controls and matching 422 server rejections (`no_eligible_dice` / `successful_roll`). |
| `offline/pushWorkerUpdate.spec.ts` | Two actual current-source production builds (`acceptance-push-a` / `acceptance-push-b`) served by an isolated HTTPS test server forwarding real API/dev traffic to the preview. A committed unseen push survived waiting-worker installation and activation without request changes; replay retained the same child and exactly two history rolls. CacheStorage remained asset-only. Confirmed sign-out erased private results, and another account could not reopen them online or offline. No response or RNG was fabricated. This is controlled worker replacement, not a second Railway deployment. |
| `offline/pushCompatibility.spec.ts` | Browser IndexedDB with the actual preceding store source from `759323a`: a held version-4 connection blocked upgrade with close-tab guidance; closing it allowed version 5. The older archive attempt survived. Reopening the old reader rejected with VersionError and the exact pending push remained. The shallow-checkout version-4 schema fixture also passed separately. This checks storage adapters, not the entire previous application bundle. |

The [structured record](configurable-push-live-2026-10-25.json) contains durations, public sampled rolls, exact fixture/deployment IDs and cleanup read-back. It excludes credentials, live idempotency keys, seeds and private server snapshots.

## Findings that remain open

1. **Automatic migration rollback uses the wrong ID (medium).** Migration persistence uses the command execution ID as `character_migrations.id`. The commit exposes it in `result.character.reconciliation.commandExecutionId`. The session instead records the preview ID for its last commit, and `CharacterTools` selects that preview ID for automatic rollback. A preview-ID rollback returned 404 in the live probe. Correct the recorded/UI migration identity and add a UI commit → automatic rollback regression before closing this gate. Supplying the authoritative execution ID exercises the server contract separately.
2. **Early Activity can show a raw cache-generation error (low).** Opening Activity during initial character reconciliation produced `stale activity save: character generation changed` instead of the requested history. The privacy guard correctly refused the stale cache write. The completed transition journeys wait for editing readiness before opening history; this does not repair the early-click UX. Add bounded retry or a clear loading/reload state while retaining the generation guard, then verify an immediate Activity click.

Migration previews also intentionally reject sheets containing entries with 409 (“cannot yet be safely migrated”). Source/item lifecycle and entry-free version migration are therefore independent scenarios; this run does not claim item-bearing migration support.

## Setup failures, bounds and cleanup

Invalid early edge fixtures reused input IDs and left an unowned expression; the real compiler rejected them. The final fixtures use unique action/input/expression IDs. An initial history probe raced reconciliation (finding 2). A combined item/version journey both encountered the entry-migration restriction and exceeded its fixed remote-run budget, so source/lifecycle and entry-free version cases were split without increasing their 180-second timeouts or weakening assertions. The controlled worker harness needed HTTPS for secure cookies and explicit confirmation plus completion of server sign-out. Failed setup attempts are excluded from the successful-case count.

All 19 run-created systems were read back as archived/private, including failed fixture attempts. Run-created characters and campaigns were also archived; system access was restored to private and read back. The two characters left by the timed-out combined run and the workspace rejected before a fixture could return were explicitly archived and verified. Immutable published versions/history were retained. No unrelated service, deployment or user resource was changed.

## Remaining boundary

Keep the two findings above open. Live changes to the campaign's default roll audience were not performed: the public campaign settings API exposes no mutation for that internal policy; its narrowing/replay cases remain covered by the existing PostgreSQL integration suite. Broader multi-account authoring of both action sources, whole-previous-client compatibility, physical Android/iPad playtests and real provider authentication remain unclaimed. No public-release or all-acceptance-complete claim is made.

The new files run in the normal journey/offline suites. For focused local replay with their documented test database/backend configuration:

```bash
npm --prefix web run test:e2e -- --suite=journeys pushTransitions.spec.ts
npm run web:build
npm --prefix web run test:offline -- pushWorkerUpdate.spec.ts pushCompatibility.spec.ts
```

To test the exact historical adapter in addition to the CI schema fixture, save `git show 759323a:web/src/characters/store.ts` to a temporary `.ts` file and set `PUSH_PREVIOUS_STORE_SOURCE` to its absolute path for the compatibility test.
