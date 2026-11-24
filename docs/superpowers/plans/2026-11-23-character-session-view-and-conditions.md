# Character session: newest view, separate conditions and translated errors

Status: **proposed 2026-11-23; owner decisions E1–E4 recorded 2026-11-24.
Owner instruction 2026-11-24: "Implement with subagents". Stages V1–V4 are
implemented locally (2026-11-24); the hosted run of the V4 journey is open, together
with the read-path S5 hosted run.** Follow-up to the
[read-path plan](2026-11-22-character-session-read-path.md). It closes that plan's two
open gaps and the causes behind them.

## The two gaps and what causes them

### Gap 1: an older stored copy replaces a newer view

**Symptom.** In a tab without the editing lock (or in a browser without Web Locks), the
sheet shows a newer server view from S1/D2's refresh. Then the sheet flips back to an
older version until the next refresh.

**Cause.** The `invalidate` handler (`session.ts`, `coordination.subscribe`) rereads the
store. It keeps the in-memory copy only if the stored generation is *older*, or if this
tab owns the lock and the generations are *equal*. A tab without the lock with an equal
generation therefore takes the stored copy.

This happens often. `store.enqueue` writes a queue entry **without bumping the generation**
(`store.ts`, `enqueue`), and the session broadcasts `invalidate` after every enqueue. So
every edit in the owner tab makes every other tab drop the newer view it fetched, for
example a GM's change seen in a second tab before the owner tab has refreshed.

**What is really wrong.**
- **One variable, two meanings.** `confirmed` means "the store's saved copy" (the write path
  compares it with `generation`). It also means "what the sheet shows" (S1/D2 puts a newer
  server view in it without writing the store). `generation` counts store writes. It says
  nothing about how new the view is.
- **Eleven adoption sites.** The session copies a store record into memory
  (`confirmed = fresh.confirmed; entries = …; generation = …`) in 11 places: invalidate,
  reconcile, review, takeover, online recovery and others. Each one can overwrite the
  newer view in the same way. The invalidate handler is just the one the S1 tests found.
- **`view.source` is misleading.** A `stored` view in a tab without the lock may be a server
  copy that was never saved.

### Gap 2: the raw session error next to the S4 status

**Symptom.** After a storage failure the route shows the S4 status ("Can't save this
character in this browser, so it is read-only."). Next to it is a second alert with the
session's own English text, for example "Could not persist the confirmed state. Storage
is unavailable.". The sheet's sync line shows the same condition a third time.

**What is really wrong.**
- **Unlocalised UI text.** The session writes English sentences into `error.message`, and
  `CharacterRoute.tsx` (line 383) and `campaigns/SessionBoard.tsx` (line 323) render them
  as they are. These are the only user-facing session texts that bypass i18n.
- **One `error` slot for two kinds of thing.** It holds lasting conditions (storage
  unavailable, offline, signed out) and events that need review (conflict, invalid,
  expired, protocol). S2 derives `storage` from `error.kind === "storage-error"`. So any
  later `setBlocked` replaces it.

  **Example (found while planning, not yet reproduced in a test).** A `live` view fails to
  save (`storage-error`). The browser goes offline, and the reconnect fetch fails
  (`network-unavailable` replaces it). Connectivity returns and the reconnect handler
  clears `network-unavailable`. The snapshot then reports `storage: "available"` and
  `blockedBy: "locks"`/`"other-tab"`. "Try saving again" disappears and "Request editing
  access" appears, although storage still fails.

  The review paths that set `error = null` (session lines ~1372, ~1553, ~1943) can also
  clear a storage failure that was never retried. The reverse also happens: a storage
  failure hides an open conflict's kind.

## Target model

```ts
type CharacterSnapshot = {
  view: { source: "stored" | "live"; character: CharacterView } | null; // newest authorized view
  storage: "available" | "unavailable";   // own state, no longer derived from error
  editing: { owned: boolean; owner?: string | null; blockedBy?: "storage" | "locks" | "other-tab" };
  error: { kind: BlockingErrorKind; details?: unknown } | null;          // review/pause events only
  // phase, entries, tentative, connected, lastRoll: unchanged
};
```

- **Saved copy and newest view are separate.** The session keeps `saved` (exactly the store
  record: confirmed, entries, generation, account generation) and `latest` (the newest
  server view this tab has fetched, not saved). One function, `adoptSaved(record)`, replaces
  the 11 adoption sites. The view shown is `latest` when its
  `reconciliation.revision` is greater than `saved.confirmed`'s, otherwise `saved.confirmed`.
  When they are equal, the saved copy wins, because the owner saved it from the server and
  the next refresh corrects any difference.
  **Correction (2026-11-24):** at an equal revision the newest observed view wins. A fetched
  view with the same revision stays shown over the saved copy until the store's saved copy
  itself changes after that fetch (a new store write of the confirmed view, not an enqueue
  or metadata write that keeps it). Older revisions never replace newer ones. The reason:
  "the next refresh corrects any difference" is false when no tab ever saves (no Web Locks,
  or no tab holding the lock refreshes), so "saved wins" lost read-path D2's same-revision
  changes (projection or roll-scope changes without a revision bump, such as
  access-dependent content). Editing still uses only the saved copy.
  A purge, account change, sign-out or a saved
  copy that becomes `null` clears `latest` as well. Gaining the lock clears `latest`, and the
  owner's drain persists the newest view as now.
- **`view.source`** is `stored` when a saved copy exists (offline use possible) and `live`
  when none does. With E2, the character shown can be newer than the saved copy.
- **Storage is its own state.** A failed store read or write sets `storageFailed`. Only a
  successful store read under the lock, followed by a successful save, clears it (today's
  "Try saving again" path). No other kind of error replaces or clears it. D3 (release the
  lock) is triggered by this flag, not by `setBlocked("storage-error")`.
- **Errors are codes, not prose.** The session reports `error.kind` (plus details). The UI
  maps each kind to an i18n key. The English text moves out of `session.ts`. An optional
  `diagnostic` string may stay for logs and tests, but it is never rendered.
- **One message per condition.** The route's alert is not shown for conditions that already
  have a surface: storage (S4 status and sync line), `purged` / `not-found` (the
  "unavailable" text) and the review kinds (review panel, as now). It stays, translated,
  for `reauthenticate`, `network-unavailable` and `protocol`. `SessionBoard` uses the same
  mapping.

Unchanged: the queue, attempts, idempotency, generations as write guards, purge rules, D1–D4,
the server API and `/api/v1`.

## Owner decisions (2026-11-24)

The owner chose the proposed answer for all four.

| # | Question | Decision |
| --- | --- | --- |
| E1 | Do the gap 2 fix together with the separate storage state (the example bug above), or only hide the duplicate alert? | Together ("yes"). Hiding the alert alone leaves the wrong status after a reconnect. |
| E2 | Offline, a tab without the lock that has a newer unsaved view: show that newer view, or fall back to the older saved copy? | Show the newer one ("keep"). It is the same authorized projection, and it is cleared on purge and sign-out like a `live` view. |
| E3 | Replace all 11 adoption sites with `adoptSaved`, or fix only the invalidate handler? | All 11 ("all"). Fixing one site leaves the same bug in the other ten. |
| E4 | Move every session error text to i18n keys now? This includes texts only seen in the review panel. | Yes, for all `BlockingErrorKind`s ("yes"), because both surfaces render them. |

## Stages

Tests come first in each stage, as in the read-path plan.

| Stage | First failing test | Change | Acceptance |
| --- | --- | --- | --- |
| V1. Separate storage state | Session test: storage failure, offline, failed reconnect fetch, reconnect. Expect `storage: "unavailable"`, `blockedBy: "storage"` and the retry button. Also: a resolved conflict does not clear a storage failure. | Add `storageFailed`. Derive `storage` and D3 from it. Clear it only on a successful save under the lock. | Read-path S1–S5 tests pass unchanged. |
| V2. Saved copy and newest view | Session test: a tab without the lock refreshes to revision 3 while the store holds 2, then the owner enqueues and sends `invalidate`. The view stays at 3. The same test through each other adoption path that can run in a tab without the lock (forgetRoll, recovery, review). | Add `saved`/`latest` and `adoptSaved`. Derive the view from the revision. | `editAllowed` still needs a saved view plus the lock. No command uses `latest`. The read-path plan's gap note is removed. |
| V3. Error codes and messages | Route test: storage failure shows one storage message and no session-text alert. `SessionBoard` shows translated text. A test fails if `session.ts` error messages are rendered. | Map kinds to i18n keys in a shared helper. Suppress the alert where E1/E4 say so. Remove the UI prose from `session.ts`. | axe at 360/768/1280px, light and dark, for the storage, reauthenticate and network states. |
| V4. Journey | Extend `characterReadPath.spec.ts`: two tabs in one profile (owner and non-owner). The GM edits, the non-owner tab becomes visible, then the owner tab edits. The non-owner tab never shows the older name. | No application change expected. | Passes locally and in CI. Hosted run together with the read-path S5 hosted run. |

Update `design_v2.md` Section 8 (session state) and the GUI integration plan with V1–V3.

## Larger changes considered

- **Recommended, included above:** separating the saved copy from the newest view, giving
  storage its own state and using error codes. These are the causes behind both gaps.
  Fixing only the symptoms would leave the 10 other adoption sites and the
  reconnect bug.
- **Not recommended now: rewriting the session as a reducer or state machine.**
  `session.ts` is 2,361 lines, and about 20 mutable variables are changed in many places.
  That is the general reason bugs like these can happen. A rewrite would touch the queue,
  idempotency and conflict review, which have strong tests and no known bugs, and the
  read-path plan keeps them out of scope. `adoptSaved` plus the separate storage state
  remove the two kinds of duplication that caused these bugs. Reconsider when the next
  session change is needed.
- **Not recommended: probing storage when a tab without the lock opens.** `storage` reports
  only failures seen (read-path S2). A test write would detect failures earlier, but it
  would write to the store from a tab without the lock, which D2 avoids. The status is
  right as soon as a read or write fails.
- **Out of scope:** server push for characters (D1), a storage backend other than IndexedDB,
  and changes to the queue, idempotency, conflict review or the server API.

## Implementation record

Stages are implemented in order on `ccr-bafcadf5-g0ofeb`, one subagent per stage. Each
stage adds its entry below.

### V1. Separate storage state (2026-11-24)

**Change.** `web/src/characters/session.ts` keeps storage failure in its own state, `storageFailed` (with the failure's text in `storageMessage`):

- Every failed store read or write that called `setBlocked("storage-error", …)` still does. `setBlocked` now calls `failStorage(message)`, which sets the flag and applies D3 (in a tab that holds the lock: `editing.owned = false` and `coordination.letGo()`). D3 is triggered by setting the flag.
- `snapshot.storage` is `unavailable` while the flag is set (and the session's account is current), and `editing.blockedBy` is `storage` from it. Neither reads `error` any more. The command gate `editAllowed()` also requires the flag to be clear, so commands stay refused while storage has failed.
- Only `reloadOwned` clears the flag: `requestEditing()` (the route's "Try saving again") is granted, the store is read under the lock, the flag and a `storage-error` error are cleared and the drain retries saving; a new failure sets the flag again and releases the lock again. This is the clearing point S3 used. When the server view equals the stored copy, nothing needs saving and the successful read under the lock is the recovery, as before; the plan's "successful save" is the drain's next save after that read.
- **`error` and `phase`.** The visible behaviour is kept. A storage failure still sets `error` to `storage-error` and the phase to `storage-error`, so the sync line ("Local storage unavailable — changes are not saved") and the session alert are unchanged (their wording is V3). Another error may still take the `error` slot while storage has failed (for example `network-unavailable` after a failed reconnect fetch, `reauthenticate`, `conflict`), but it does not touch the flag. Every place that cleared an error now calls `clearError()`: the reconnect handler (`reauthenticate`/`network-unavailable`), conflict review (`resolveConflict`) and the two expired-attempt review paths. `clearError()` puts `storage-error` (with the remembered text) and its phase back while the flag is set, else clears the error. An account change still clears `error` outright, as before; that session is no longer shown.

The queue, idempotency, conflict review rules, purge, D1, D2, D4, the server API and `/api/v1` are unchanged. `design_v2.md` Section 8 and the GUI integration plan's "Character session read path" paragraph describe the separate storage state.

**First failing tests (written first, all failed before the change):**

- `web/src/characters/session.test.ts`, "CharacterSession storage state (V1)":
  - "keeps a storage failure through offline, a failed reconnect fetch and a later reconnect": a `live` view whose snapshot save fails, then offline, then a reconnect whose fetch fails, then a reconnect whose fetch succeeds. Expects `storage: "unavailable"`, `blockedBy: "storage"`, error and phase `storage-error`, `canEdit` false, no lock and a refused `setField`. It failed at the first `storage` check after the failed reconnect fetch (`network-unavailable` had replaced the error): expected `unavailable`, received `available`.
  - "does not clear a storage failure when a conflict review completes": a conflict, then a store reread after an `invalidate` broadcast fails while `resolveConflict` is saving its review. It failed: after the review `storage` was `available` (the review's `error = null` had cleared the storage failure).
  - "clears a storage failure only after editing is requested and the store works": a 401 at a visibility refresh (`reauthenticate`) and its clearing on the next identity change must keep `storage: "unavailable"`; a retry that fails again releases the lock again; a retry with a working store edits. It failed: `storage` was `available` while `reauthenticate` was shown.
- `web/src/characters/CharacterRoute.messages.test.tsx`, "CharacterRoute storage state (V1)", "keeps offering to try saving again after offline, a failed reconnect fetch and a reconnect": the same sequence through the route with a mutable lock and connectivity. It failed: after the reconnect the status read "Read-only in this tab. Another tab is editing this character." with "Request editing access" instead of the storage message and "Try saving again".

No existing test changed. The read-path S1–S5 tests pass unchanged.

**Results after the change:** `npm run -s web:typecheck` passed. `npm run -s web:test` 145 files, 1377 tests passed (1373 on the parent commit plus the four new cases). Browser journeys `npm run test:e2e -- --suite=journeys character campaign session` 35/35 passed (local PostgreSQL 16 admin database, Node 24; the installed Playwright expects Chromium build 1248, which could not be downloaded here, so the run used the locally installed build 1243 under that name). Offline browser suite (`playwright.offline.config.ts`, fresh `sweetroll_offline` database, after `npm run -s web:build`) 32/32 passed; a first run straight after the journeys had 4 failures, all server `429 rate_limited` responses to test setup requests (clone system, read activity), and the rerun on a fresh database passed.

**Not done in V1.** A storage failure still takes the `error` slot, so it still hides an open review error's kind (the reverse case in gap 2); `error` holds only review and pause events once V3 moves the storage text out of the alert. The flag is not cleared by a purge (`storage` stays `unavailable` with no view, which the route does not show). Gap 1 (V2), error codes and messages (V3) and the journey (V4) are not started. The hosted run was not done for V1.

### V2. Saved copy and newest view (2026-11-24)

**Change.** `web/src/characters/session.ts` keeps the saved copy and the newest view apart:

- **`saved`** (the former internal `confirmed`) is exactly the store's confirmed view. With `entries`, `generation`, `accountGeneration` and `lastRoll` it is the store record the session last adopted, or wrote itself on the owner's write path. Commands, queue entries (`baseRevision`, `packageChecksum`), frozen requests (`expectedRevision`), tentative estimates (`computeTentative`, `resourceBounds`), the archived check, conflict review and reconciliation all read `saved`, as they read `confirmed` before.
- **`latest`** is the newest authorized server view this tab fetched and did not save. **Decision: `liveView` and `latest` are one variable.** Both are "a server view this tab did not save"; only the rule for showing it differs. Without a saved copy it is the `live` view, shown only while online and cleared on going offline, as before. With a saved copy it is shown in place of it (`shownSaved()`) while its `reconciliation.revision` is greater and the tab does not hold the lock. At an equal revision the newest observed view wins (see "Equal-revision correction" below); as first committed (`0abffed`) the saved copy won. Offline it stays shown (E2). `view.source` is `stored` whenever a saved copy exists.
- **`adoptSaved(record, options)`** replaces all 11 adoption sites (`handleAckError`'s stale branch, `reconcileSnapshot`'s generation race, both reads in `resolveConflict` and in `reviewExpiredAttemptInner`, `retiredByConcurrentReview`, `initialize`, `reloadOwned`, the `invalidate` handler and `forgetRoll`) and the two sites that adopted a record whose saved copy is null (`handleAckError`'s purge branch, `reconcileSnapshot`'s purge branch). None was kept. Each site keeps its own guards and side effects (`refreshPendingOnline`, purge and conflict blocks, `emit`, the retry check, `clearError`). The options keep each site's existing rules: `sequence` "advance" (the default, the sites that advanced `nextSequence`), "reset" (`initialize`, `reloadOwned`) or "keep" (`handleAckError`, the `invalidate` handler, `forgetRoll`, which did not touch it), and `account: false` for `handleAckError`'s stale branch, which did not adopt the account generation. The purge-branch sites set `lastRoll = null`; `adoptSaved` takes the record's roll, which the store never keeps with a null saved copy (purge and account clearing delete it).
- **Clearing `latest`.** `adoptSaved` clears it when the saved copy becomes null, when the account generation changes, and when it is no longer newer than the adopted copy. The `invalidate` handler still clears it for a null record (as it cleared `liveView`), so a purge broadcast hides a `live` view as before. `purgeAccess`, sign-out (identity mismatch), `reloadOwned` (gaining the lock) and the owner's `confirmSnapshot` clear it as before. The owner's drain then saves the newest server view on its next refresh.
- **`lastRoll`.** `fetchView` compares roll scope with the view shown (newest or saved), as it compared with `confirmed`. `adoptSaved` takes the store's roll and drops it when the newest view shown has another roll scope than the saved copy, so a reread does not bring back a roll from a scope the sheet no longer shows.
- **Owner tabs.** Only a tab with the lock edits. `fetchView` sets `latest` over a saved copy only while `editing.owned` is false, `reloadOwned` clears it before the tab edits, and `shownSaved()` never shows it while `editing.owned` is true. So the view `canEdit`/`editAllowed` check is always the saved copy, and no command, queue entry, estimate or reconciliation reads `latest`.
- **Same-revision refresh.** Before V2, a tab without the lock also took a server view with the same revision but a different projection or roll scope. As first committed (`0abffed`), V2 let the saved copy win at an equal revision, as the target model then said. That was corrected the same day (below).

`design_v2.md` Section 8 and the GUI integration plan's "Character session read path" paragraph describe the newest view. The read-path plan's S1–S5 gap note points to this entry. The queue, idempotency, conflict review, purge rules, D1–D4, the server API and `/api/v1` are unchanged.

**Which adoption paths can run in a tab without the lock.** The `invalidate` handler and `forgetRoll` (no ownership check), and `initialize` (before the tab asks for the lock; nothing is fetched yet, except a visibility refresh racing the first read, which `adoptSaved` now keeps). The reconnect refresh is not an adoption site, but it decides whether the newest view survives going offline. The other sites run only with the lock: `handleAckError` (owner sends, acknowledgments and saves), `reconcileSnapshot` and its purge branch (`storeFresh`, `fetchLatestForConflict` and `enterExpiredAttempt` all require `coordination.isOwner()`), `resolveConflict` and `reviewExpiredAttemptInner` (both refuse a tab without the lock), `retiredByConcurrentReview` (owner online sends) and `reloadOwned` (gaining the lock). They use `adoptSaved` too, so a tab that loses the lock while one of them is in flight follows the same rule, but there is no tab without the lock to test them in.

**First failing tests (written first):** `web/src/characters/session.test.ts`, "CharacterSession saved copy and newest view (V2)", nine cases. A tab without the lock has revision 2 saved and fetches revision 3.

- "keeps the newer view when the owner tab enqueues an edit and broadcasts invalidate": the store gets a queue entry without a new generation and an `invalidate` broadcast. Expects revision 3 shown, the queue entry adopted with base revision 2, the store still at 2 and a refused `setField`. Failed: revision 2 was shown.
- "keeps the newer view when clearing a roll rereads the store" (`forgetRoll`). Failed: revision 2.
- "does not bring back a saved roll from another scope with the saved copy": the saved copy has a roll in campaign A; the fetched revision 3 has left the campaign. After the owner's enqueue the roll stays cleared. Failed: revision 2 (with the old roll).
- "keeps showing the newer view offline, also after the owner queues an offline edit (E2)". Failed after the offline enqueue: revision 2.
- "shows the saved copy when the refresh has the same revision" (a projection that differs only in its entity label). Failed: the fetched view ("Same revision") was shown. This case was replaced by the equal-revision correction below.
- Four guards passed before the change and pass after: "clears the newer view when another tab purges the saved copy", "clears the newer view when a refresh purges access", "clears the newer view on sign-out" (signing in again with the fetch pending shows nothing) and "drops the newer view on gaining the lock and the owner's refresh saves it" (the store then holds revision 3 and the next edit sends `expectedRevision: 3`).

No existing test changed.

**Results after the change:** `npm run -s web:typecheck` passed. `npm run -s web:test` 145 files, 1386 tests passed (1377 after V1 plus the nine new cases). Browser journeys `npm run test:e2e -- --suite=journeys character campaign session` 35/35 passed (local PostgreSQL 16, Node 24, the Chromium build substitution described in V1). Offline browser suite (`playwright.offline.config.ts`, fresh `sweetroll_offline` database, after `npm run -s web:build`) 32/32 passed on the third run. The first run, right after the journeys, had one failure: the pool-system character journey at 360px ("journey at 360px (pool)") showed "This character is unavailable." after creating its character through the UI. Its trace was overwritten, so the cause was not confirmed. `tests/offline/character.spec.ts` alone then passed 5/5 twice on fresh databases. A second full run straight after those runs had 4 failures, all `429 rate_limited` responses to test setup requests (clone system, create character), as in V1. A full run on a fresh database after a pause passed.

**Not done in V2.** A `stored` view in a tab without the lock still shows the queued entries and pending estimates of the saved copy (computed against the saved copy, as before), also when a newer view is shown. A storage failure still takes the `error` slot (V1's note). Error codes and messages (V3) and the journey (V4) are not started. The hosted run was not done for V2.

#### Equal-revision correction (2026-11-24, after `0abffed`)

**Why.** As first committed, V2 let the saved copy win at an equal revision, relying on "the next refresh corrects any difference". That is false when no tab ever saves: in a browser without Web Locks, or when no tab holding the lock refreshes. It lost read-path D2's same-revision changes (projection or roll-scope changes without a revision bump, such as access-dependent content). The Target model bullet carries the correction.

**Change.** `web/src/characters/session.ts`: the newest observed view wins at an equal revision.
- `fetchView` in a tab without the lock keeps a fetched view whose revision is at least the saved copy's, unless it equals the view shown (same revision, projection and roll scope). Older revisions are still ignored.
- `shownSaved()` shows `latest` while its revision is at least the saved copy's (still never in a tab holding the lock).
- `adoptSaved` drops `latest` when it is older than the adopted copy, or equal and the adopted saved copy differs from the one held before (a new store write of the confirmed view). An enqueue or a metadata write that keeps the same confirmed view keeps `latest`. Editing, the queue, estimates and reconciliation still use only the saved copy.

**First failing test.** "shows the saved copy when the refresh has the same revision" was replaced by "shows a same-revision fetched view until the store saves a new copy" (`session.test.ts`, V2 block). A tab without the lock has revision 2 with projection A saved and fetches revision 2 with projection B: B is shown, read-only. The owner tab enqueues and broadcasts: B is still shown. The owner saves revision 2 with projection C: C is shown. A lagging fetch of revision 1 does not replace it. On `0abffed` it failed at the first check (expected "Fetched B", received "Saved A"). The old case expected the opposite rule, so it was removed, not kept.

**Results:** `npm run -s web:typecheck` passed. `npm run -s web:test` 145 files, 1386 tests passed (the replaced case keeps the count). Browser journeys `npm run test:e2e -- --suite=journeys character campaign session` 35/35 passed.

**The offline failure investigated.** The one failure in V2's first offline run ("journey at 360px (pool)" showed "This character is unavailable." right after creating its character through the UI; the page had no other alert, so the session reported no view, no error and a phase other than `loading`) did not reproduce:
- `tests/offline/character.spec.ts` (5 tests) with `--trace on`, a fresh `sweetroll_offline` database per run and a pause between runs: 5 runs on the V2 code with this correction, 25/25 passed, 25 traces kept.
- The full offline suite on fresh databases after 4-minute pauses: 2 runs, 32/32 passed each.
- For comparison, the same spec 5 times on the V1 commit `0e15851` (a separate worktree with its own build): 25/25 passed.

No run reproduced it, so its cause is not known and no fix was made. Reading the code, no V2 change applies to a tab that holds the lock with no saved copy, which is the state right after creation: the owner never sets `latest` over a saved copy, gaining the lock clears it as `liveView` was cleared, and the adoption sites keep the previous field-by-field behaviour there. It is recorded as an unexplained intermittent failure; the 429 failures seen right after other runs are separate.


### V3. Error codes and messages (2026-11-24)

**Change.**

- **Codes, not prose.** `web/src/characters/session.ts`: `BlockingError` is `{ kind, reason?, serverMessage?, details?, diagnostic }`. The session writes no user-facing text. `diagnostic` keeps the former English sentence for logs, tests and the message of a refused command's `Error`; it is never rendered. `serverMessage` is the server's own message (a rejected value's `ApiError` message, a 409 `conflict` message, a physical-roll 404), which is server data and is shown as before. `reason` keeps the distinctions that had different texts within one kind: `request-in-flight` and `newer-version` (conflict), `roll-preparation` (invalid, a local preparation failure), `unknown-outcome` (expired online attempt) and `review-base-unavailable` (network-unavailable: the latest state is not available yet, as opposed to a failed refresh). `details` (invalid diagnostics, retained ids, attempt id) are unchanged. A refused command throws an `Error` whose `message` is the diagnostic, with `kind`, `reason`, `serverMessage` and `blocked: true` when the refusal comes from the open error or a storage failure.
- **Decision: `error` no longer holds storage.** `snapshot.error.kind` is a `SessionErrorKind` (every `BlockingErrorKind` except `storage-error`), so `error` holds review and pause events only, as in the Target model. A failed store read or write calls `failStorage(diagnostic)` (V1's flag and D3) and never touches `error`. The phase reports storage: `failStorage`, `clearError` and `refreshPhase` give `storage-error` while storage has failed and no review or pause error is set, otherwise the error's phase. The sync line (`CharacterSheet.syncStatusText`) reads `storage === "unavailable"` after the review and pause kinds (`network-unavailable` falls through to it, as before). Inside the session every check that read "storage in the error slot" now reads the flag with the same meaning: `isBlocked()` is `error !== null || storageFailed` (drain, refresh and manage-command gates), the conflict-refresh and expired-review guards treat "no error" as `error === null && !storageFailed`, the `live` view after a failed save checks `storageFailed`, and `reloadOwned` clears the flag and recomputes the phase. Commands are refused with the open error, else with a `storage-error` refusal while storage has failed. So V1's left-over is closed: a storage failure no longer hides an open conflict, invalid value or expired attempt, and the review panel stays.
- **One shared mapping.** New `web/src/characters/sessionErrors.ts`: `sessionErrorKey(code)`, `sessionErrorText(error)` (the server message when present, else the translated key), `routeShowsErrorAlert(error)` and `describeCommandFailure(error)`. The mapping (reason first, else kind):

  | Kind / reason | i18n key |
  | --- | --- |
  | `conflict` | `character.error.conflict` |
  | `conflict` / `request-in-flight` | `character.error.conflictInFlight` |
  | `conflict` / `newer-version` | `character.error.conflictNewerVersion` |
  | `invalid` (no server message) | `character.error.invalid` |
  | `invalid` / `roll-preparation` | `character.error.rollPreparation` |
  | `expired-attempt` | `character.error.expiredAttempt` |
  | `expired-attempt` / `unknown-outcome` | `character.error.expiredAttemptUnknownOutcome` |
  | `reauthenticate` | `character.error.reauthenticate` |
  | `network-unavailable` | `character.error.refreshFailed` |
  | `network-unavailable` / `review-base-unavailable` | `character.error.reviewBaseUnavailable` |
  | `protocol` | `character.error.protocol` |
  | `not-found` | `character.error.notFound` |
  | `purged` | `character.sync.purged` (existing) |
  | `storage-error` (storage state, refused commands) | `character.detail.storageUnavailable` (existing) |

  The twelve `character.error.*` keys are new in `web/src/i18n/messages.ts`. Their English keeps the meaning of the former sentences; a few are plainer (for example the protocol text no longer names the idempotency key, and both sign-in texts are one: "Your session expired. Sign in again with the same account to continue.").
- **Surfaces.** `CharacterRoute` shows the alert only for `reauthenticate`, `network-unavailable`, `protocol` and `not-found` (translated). Storage has the S4 status and the sync line, `purged` the "unavailable" text (the route shows no sheet then) and the review kinds the review panel; a closed review keeps its reopen button and the sync line, and no longer adds an alert. **Deviation from the Target model's list:** `not-found` keeps the alert. It is set by a non-purge 404 while the sheet stays on screen (a send, a conflict fetch or an online attempt), where the route shows no "unavailable" text and no review panel; without the alert only the sync line "Needs review before continuing" would remain. `ConflictReview` shows `sessionErrorText(error)` where it showed `error.message` (so a rejected value still shows the server's message). The campaign `SessionBoard` push panel has no status, sync line or review panel, so it shows the error and, separately, a storage failure as one translated alert each. The sheet's, slot list's and field's command-failure alerts use `describeCommandFailure`: a refusal from the open error or storage is translated, any other failure keeps its message as before. The route's recovery links still appear after a storage failure (`showRecovery` now also reads `storage`), and the sheet stays disabled while storage has failed, as before.

The queue, idempotency, conflict review rules, purge, D1–D4, the server API and `/api/v1` are unchanged.

**First failing tests (written first, run before the change):**

- `web/src/characters/sessionErrorMessages.test.tsx` (new guard, 29 cases). A fake session returns a snapshot per case with the same sentence in `message` and `diagnostic`; a test locale replaces every expected key with a marker. For every kind and reason, on the character route (12 cases: an alert for the alert kinds, the review panel's text for the review kinds) and on the session board (14 cases, also `purged` and a storage failure), the marker must show and the sentence must not. Also: a rejected value shows the server's message; a storage failure gives the route no alert; a purged character shows only the "unavailable" text. Before the change 27 failed: the 12 route cases rendered the session sentence, the server-message case found no server text, and the 14 board cases found no marker (the board rendered the sentence or nothing for storage). The two route guards for storage and purged passed before and after.
- `web/src/characters/session.test.ts`, "CharacterSession error codes (V3)", 4 cases: "reports a storage failure through storage and the phase, not the error" (failed: `error` was `storage-error`), "keeps an open conflict's kind when storage also fails" (failed: the kind became `storage-error`), "reports a code, a reason and a non-rendered diagnostic instead of a sentence" (failed: the error had `message`), "keeps a server's conflict message as server data" (failed: no `serverMessage`).
- `web/src/characters/CharacterRoute.messages.test.tsx`, "CharacterRoute error messages (V3)", 3 cases: "shows one storage message, the sync line and no session-text alert after a storage failure" (failed: one `alert`, the session sentence); "shows a failed refresh as one translated alert" and "shows an expired sign-in as one translated alert" with a marker locale (failed: the alerts read "Could not refresh the character. Cached data is unchanged; retry when connected." and "Your session expired. Sign in again to continue.").
- `web/src/characters/CharacterRoute.snapshot.test.tsx`, "keeps the conflict review visible when storage also fails" (failed: the "Review conflicts" panel disappeared once storage failed).

**Existing tests changed:**

- `session.test.ts`: six assertions that a storage failure sets `error.kind` to `storage-error` now expect `storage: "unavailable"`, `error` null and (where checked) the phase `storage-error` ("enters storage-error and blocks further mutations when enqueue persistence fails", "enters storage-error when freezing fails…", "does not offer conflict reapply when persisting the latest GET fails" and the three V1 cases). Four reads of `error.message` now read `serverMessage` (the server's validation and conflict texts) or check the whole error for private text (the two purge privacy cases). This is the decision above, not a behaviour change of the session.
- `CharacterSheet.test.tsx`: the `storage-error` sync-line case gives `storage: "unavailable"` with no error; error fixtures carry `diagnostic` instead of `message`.
- `ConflictReview.test.tsx`: fixtures carry `diagnostic` instead of `message`; the invalid-value fixtures also carry the same text as `serverMessage`, which is what the session now reports for a server rejection.
- `web/tests/e2e/characterReadOnlyMessages.spec.ts`: the storage state also checks one status, one sync line and no alert.

**Accessibility.** New journey in `web/tests/e2e/characterReadOnlyMessages.spec.ts`, "a failed refresh and an expired sign-in show one translated alert and pass axe": a saved sheet reloaded while the character GET fails at the network, then while it answers 401, shows exactly one alert with the translated text. Both states, and the storage state of the existing S4 test, pass axe (no serious or critical findings) with no horizontal scroll at 360, 768 and 1280px in light and dark.

**Results after the change:** `npm run -s web:typecheck` passed (root `npm run -s typecheck` was not needed: no shared types changed). `npm run -s web:test` 146 files, 1423 tests passed (1386 after V2 plus 37 new cases). Browser journeys `npm run test:e2e -- --suite=journeys character campaign session` 36/36 passed (35 plus the new journey; local PostgreSQL 16, Node 24, the Chromium build substitution described in V1).
Offline browser suite (`playwright.offline.config.ts`, fresh `sweetroll_offline` database, after `npm run -s web:build` and a pause of a few minutes after the journeys) 32/32 passed on the first run.

**Not done in V3.** Refused or failed commands that do not come from the session's open error or storage failure (for example "Session closed.", "Account changed. Reopen this character.", the ownership refusal, or the retained 5xx retry notice the session builds around a server message) still carry English `Error` messages that the command-failure alerts show; they are not `BlockingErrorKind` texts and were left as they are. The guard test checks the route, the review panel and the session board with a fake session; it does not drive every session path to each kind. Gap 1's journey (V4) is not started. The hosted run was not done for V3.

### V4. Journey (2026-11-24, local and CI parts)

**Change.** A second journey in `web/tests/e2e/characterReadPath.spec.ts` (journeys suite), "a tab without the editing lock keeps the GM's newer name when the owner tab edits". It is in the S5 spec rather than a new file because it uses the same campaign set-up (GM, invited player, GM-created campaign character with the player as controller), the same `visibilitychange` trigger and the same command recording. That set-up and the cleanup moved into two helpers in the spec, `createCampaignCharacter` and `archiveCreated`; the S5 journey uses them with the same steps and assertions. No application code changed, and the journey found no bug in V1–V3.

**Journey steps.** One healthy player browser context (`code-journey-p1`; Web Locks, BroadcastChannel and IndexedDB working) and the GM (`code-journey-gm`).

1. **Set-up.** As in S5: the GM creates a d20 campaign, invites the player, who accepts, and creates the player's character in the campaign.
2. **Owner tab.** The first tab opens `/characters/:id`, takes the editing lock and saves its copy ("Saved", no read-only status, "Decrease Health" enabled).
3. **Non-owner tab.** A second tab in the same context opens the character. It shows "Read-only in this tab. Another tab is editing this character." (`blockedBy: "other-tab"`), "Saved" and a disabled "Decrease Health". Every non-GET request it sends to `/api/characters…` is recorded.
4. **GM edit.** The GM renames the character over the API. After one second the non-owner tab still shows the old name (no push, D1). A `visibilitychange` event dispatched on its `document` starts its refresh; the journey waits for the `GET /api/characters/:id` (200) and the GM's name replaces the old one. The owner tab still shows the old name and has sent no character GET since the rename.
5. **Owner edit.** The owner tab clicks "Decrease Health". Its command request is held by a route. The enqueue writes a queue entry to the store without a new saved copy and broadcasts `invalidate`; the non-owner tab rereads the store and shows "Changes pending" (the adopted queue entry), and still shows the GM's name, the other-tab status and a disabled button. The owner tab still shows the old name.
6. **Owner conflict save.** The held command is released. It carries the old revision, so the server answers 409. The owner tab fetches and saves the GM's version (a new saved copy and another `invalidate`) and shows "Review conflicts" with the GM's name.
7. **Owner sync.** The owner selects the queued change, reapplies it and confirms; the sheet is saved and the review closes. A `visibilitychange` event in the owner tab then runs its drain refresh (`GET` 200). The server has the GM's name at the GM's revision plus one.
8. **Non-owner afterwards.** The non-owner tab shows "Saved" and the GM's name, then refreshes once more through `visibilitychange` (`GET` 200) and still shows the GM's name, the other-tab status and a disabled button. It sent no character command.

From step 4 on, a `MutationObserver` in the non-owner tab records whether the page text ever contains the old name after the GM's name was shown. The journey checks it after the owner's enqueue, after the owner's conflict save and at the end; it stayed false, so the older name was never rendered, not only absent at the checks.

**Determinism.**
- **Refresh triggers.** Only the triggers the journey drives run: `visibilitychange` events dispatched on one tab's `document` (as in S5), and the owner's command, conflict fetch and reapply. A saved sheet has no timer refresh (the 30-second timer runs only for a `live` view), the context never goes offline, and Playwright keeps both pages visible (the journey checks that both report `document.visibilityState` "visible"), so no real `visibilitychange` reaches the owner tab. The owner tab therefore cannot refresh between the GM's rename and its own edit. The journey does not rely on that: it counts the owner tab's character GETs and asserts none happened in that window, and that the owner still shows the old name.
- **Ordering of the broadcast.** The owner's command is held by `page.route` until the non-owner tab shows "Changes pending", the visible sign that it has processed the enqueue's `invalidate` (it adopted the store record holding the old saved copy and the new queue entry). So the gap-1 moment is checked before any later save can mask it.
- **Sensitivity check (not committed).** With the `invalidate` handler temporarily changed to drop the newer view on every reread (the behaviour before V2), the journey failed at step 5: the non-owner tab showed the old name after "Changes pending". With the code restored it passes.

**Equal-revision correction.** Covered by `session.test.ts` only ("shows a same-revision fetched view until the store saves a new copy"). The journey cannot drive it in a way that tells the rules apart: every change it can make to the character over the API (rename, resource change) bumps the revision, and the same-revision step it does reach (the owner saving the revision the non-owner tab already shows, step 6) shows the same content under either rule. A same-revision projection or roll-scope change visible to the player was not found as a deterministic browser step.

**CI.** The journeys suite runs every `tests/e2e/*.spec.ts` except `visual.spec.ts` (`web/playwright.config.ts`), sharded 1/3–3/3 in `.github/workflows/ci.yml`; the journey is in an existing spec, so no workflow change is needed.

**Results.** Local PostgreSQL 16, Node 24, the Chromium build substitution described in V1.
- The new journey alone (`npm run test:e2e -- --suite=journeys characterReadPath -g "editing lock"`) passed in every run, 9 in a row, with no failure. Runs 1–3 (dot reporter): 22.7 s, 23.2 s and 22.6 s total runner time. Runs 4–6 (list reporter): 14.0 s, 14.4 s and 13.7 s for the test (23.9 s, 24.3 s, 22.7 s total). Runs 7–9, after adding the check that both tabs report `visibilityState` "visible": 13.4 s, 14.0 s and 13.1 s for the test (22.4 s, 22.9 s, 21.9 s total). The whole spec (S5 and V4) then passed 2/2 (9.5 s and 10.1 s).
- `npm run test:e2e -- --suite=journeys character campaign session` 37/37 passed (36 after V3 plus the new journey), twice: before and after the visibility check (3.6 and 3.4 minutes).
- `npm run -s web:typecheck` passed. `npm run -s web:test` 146 files, 1423 tests passed (unchanged; no unit test was added).

**Open.** The hosted acceptance run on the Railway build, with its deployed SHA recorded, to be done together with the read-path S5 hosted run; it cannot be run from this environment. CI on the pushed branch is still to be observed.
