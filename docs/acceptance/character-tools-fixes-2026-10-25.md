# Character tools acceptance repairs — 2026-10-25

Both UI findings from the [acceptance run](configurable-push-rolls-2026-10-25.md) are repaired. This closes C-ACCEPT-01/02 in source with regression evidence; it does not close the unperformed wider slice C release gates.

## Resulting behavior

- Automatic rollback uses `reconciliation.commandExecutionId` from the authoritative migration commit response. The preview ID remains request correlation data. A response without an execution ID leaves automatic rollback unavailable; it cannot silently substitute a preview ID. Explicit manual rollback remains available.
- An Activity read waits for the session's initial reconciliation before capturing its cache-generation guard. The dialog stays busy while that initial read is pending. Later generation changes still reject stale writes; the UI clears the old page and offers “Activity changed while loading. Refresh activity to try again.” instead of exposing the storage error. No stale write is retried under a newer guard.

## Regression and validation evidence

Five meaningful unit assertions failed before repair: retained migration identity, UI rollback target, missing-identity fallback, early Activity ordering, and readable stale-read recovery. After repair, the full frontend suite passed **1,200 tests in 114 files**, including routed migration controls and existing purge/account/denied-history guards. Frontend typecheck and production build passed.

The routed migration double was corrected to return a distinct command execution ID and now checks that exact rollback path. An existing ambiguous-commit test raced the automatic retry with another deliberate user command; it now observes the scheduled replay and checks the unchanged frozen body and exact send count, without weakening assertions or increasing timeouts.

Two canonical browser regressions passed with zero configured retries on the actual repaired production build (`fix-rollback-activity`), served by an isolated HTTPS harness forwarding real API/dev traffic to the existing preview backend:

| Journey | Observed behavior |
|---|---|
| UI migration → automatic rollback | Publish a second version, select it and preview/confirm/commit through Migration controls. The old saved pool is denied under changed rules. Reopen Migration and click automatic rollback without entering an ID. The request uses the returned command execution ID, differs from the preview ID, restores the original version, and allows pushing the original pool with unchanged bindings/dice identity. |
| Immediate Activity during reconciliation | Cache a real sheet/roll, hold the next initial character GET, reload, and immediately open Activity. The dialog stays busy without an alert and sends zero Activity requests while reconciliation is held. Releasing the GET produces exactly one Activity read, renders the real saved roll, and enables Refresh without a cache error. |

The [structured record](character-tools-fixes-2026-10-25.json) contains build hashes, durations, exact fixture IDs, public results and verified scoped cleanup. Failed initial browser launches were due to the absent local Chromium installation; the installed browser completed both journeys. No response was mocked or RNG outcome manufactured.

This production-build evidence uses the deployed backend but **does not claim a new Railway frontend deployment**. CI on the repair commit supplies the normal retained browser/offline/visual checks. Prior live evidence remains tied to its original application commit.
