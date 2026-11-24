# Character session: newest view, separate conditions and translated errors

Status: **proposed 2026-11-23; owner decisions E1–E4 recorded 2026-11-24.
Owner instruction 2026-11-24: "Implement with subagents".** Follow-up to the
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
  the next refresh corrects any difference. A purge, account change, sign-out or a saved
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
