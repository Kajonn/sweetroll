# Separate viewing from local storage and editing in the character session

Design plan · 22 November 2026  
Based on Sweetroll `9ead9cd` and PR #93 (`1804771`). **The owner answered D1–D4 and authorized implementation on 2026-11-22.**

## Why

PR #93 fixed a hosted acceptance failure where the server returned HTTP 200 for a character, but the browser showed "This character is unavailable." It happened when IndexedDB could not save the first local copy, or when the browser had no editing lock. Review found that the failure comes from the session model, not from one missing branch.

`web/src/characters/session.ts` uses one field, `confirmed`, for three separate facts:

| Fact | Who decides it | Today |
| --- | --- | --- |
| The user may see this sheet | The server (`GET /characters/:id`) | Shown only after the response is saved locally |
| This browser holds a durable copy | IndexedDB (`store.confirmSnapshot`) | Required before anything is shown |
| This tab may edit | The Web Lock (`coordination`) | A tab without the lock shows only what another tab saved |

Saving before confirming is correct for writes. It makes the offline queue, idempotent replays and coordination between tabs safe (Section 8). Reads inherited the same rule, with three effects:

- **Wrong failure.** A storage fault or a missing Lock API hides a sheet the user may read, and shows the same message as revoked access.
- **Workarounds spread.** PR #93 adds a parallel `onlinePreview`. Five places clear it, while 18 places assign `confirmed`. It sits outside the refresh and revocation logic, so it needed a follow-up fix to reopen after a reconnect (`1804771`).
- **Stale view.** The online-only view is fetched once. It does not show other devices' changes. Access loss is noticed only at the next reconnect or reload, short of Section 9.1's "removed members lose HTTP and cached-content access promptly."

## Target model

The session snapshot reports three independent things, and the UI derives its state from them:

```ts
type CharacterSnapshot = {
  view: { source: "stored" | "live"; character: CharacterView } | null; // what to show
  storage: "available" | "unavailable";                                 // can this browser keep a copy?
  editing: { owned: boolean; owner?: string | null; blockedBy?: "storage" | "locks" | "other-tab" };
  // phase, entries, tentative, error, connected, lastRoll: unchanged
};
```

- **One read path.** A single `refreshView()` fetches the server view. It runs on open, on reconnect, on becoming visible, after a successful command and on a bounded timer while the view is `live`. It works whatever the storage and lock state. A 404 with `cacheDisposition: "purge"` goes through the existing `purgeAccess()` for both sources.
- **Storage is an optimization of the read path.** After a successful fetch, the session tries `confirmSnapshot`. Success makes the view `stored` and allows offline use. Failure leaves it `live`, and the sheet stays visible while online.
- **Editing is derived.** `canEdit = editing.owned && view?.source === "stored"`. Commands check the same predicate as the UI. A tab without the lock, or with a `live` view, stays read-only, with a reason from `blockedBy`.
- **Offline needs a stored copy.** Going offline hides a `live` view, as PR #93 does now. A `stored` view keeps its current offline behaviour.
- **Specific messages.** "Unavailable" is kept for not-found or revoked access. Storage and lock problems get "Can't save this character in this browser" and "Read-only in this browser" (PR #93 added the second).

Unchanged: the queue, attempts, generations, account guards, purge rules, the server API and the `/api/v1` contract.

## Owner decisions (2026-11-22)

The owner chose the proposed answer for all four.

| # | Question | Decision |
| --- | --- | --- |
| D1 | How often should a `live` view be refreshed? | On reconnect, on becoming visible and after commands, plus every 30 seconds while visible. No server push. |
| D2 | Should a non-owner tab with a `stored` view also refresh from the server, rather than only from the owner tab's saves? | Yes, using the same read path. This also covers browsers without the Lock API, where no tab ever becomes owner. |
| D3 | Should a tab that holds the lock but cannot save keep the lock? | Release it, so a tab or browser profile that can save is able to take over. |
| D4 | Is a `live` view acceptable for campaign sheets with GM-only content? | Yes. It is the same authorized server projection, never cached, and hidden offline and on sign-out. |

## Stages

Each stage starts with a failing test, makes the smallest passing change and reruns the character session, route and offline suites (`web/src/characters/*.test.ts*`, `npm --prefix web run test:offline`).

| Stage | First failing check | Change | Acceptance |
| --- | --- | --- | --- |
| S1. One read path | With storage unavailable, a second device's edit appears in an open online view without a reload. | Add `refreshView()` with the D1 triggers. Route `openReadOnly`, `reconcileFresh` and the reconnect handler through it. | The PR #93 tests still pass. Revocation during a `live` view hides it at the next refresh. |
| S2. Snapshot shape | A route test reads `view.source`, `storage` and `editing.blockedBy` for the four storage/lock combinations. | Replace `confirmed`/`onlinePreview` in the snapshot with `view`, keeping `confirmed` internal to the write path. Update `CharacterRoute`, `CharacterSheet`, `CharacterTools`, `ConflictReview` and the campaign `SessionBoard`. | No component reads `onlinePreview`. `onlinePreview` is deleted. |
| S3. Derived editing | A command issued in a `live` view is refused by the session, not only by disabled controls. | Have commands and the UI use the same `canEdit` predicate. Apply D3. | `api.send` is never called without a stored view and the lock. |
| S4. Messages | Storage failure shows the storage message, and a revoked character shows "unavailable". | Split the messages and add i18n keys. | axe passes at 360/768/1280 px, light and dark. |
| S5. Journeys | A browser journey with Web Locks disabled and an incomplete IndexedDB profile creates, opens, edits on another device, reconnects and is removed from a campaign. | Add the journey alongside the existing character specs. | Passes locally and in CI, then on the hosted acceptance build with its deployed SHA recorded. |

Update `design_v2.md` Sections 8 and 10.2 and the GUI integration plan with S2 and S4.

## Out of scope

- Offline editing without IndexedDB, or any other storage backend.
- Server push for character changes. D1 uses fetching only; the campaign SSE streams are not extended.
- Changes to the queue, idempotency, conflict review or the server API.
- Application-version migration of stored sessions. The app is unreleased (Section 17.0).

## Implementation record

Stages are implemented in order on `claude/vibrant-hopper-xoftei` (PR #96). Each stage adds its entry below.

### S1. One read path (2026-11-22)

**Change.** `web/src/characters/session.ts` has one `refreshView(trigger)` read path. `openReadOnly`/`fetchReadOnly` are removed and `reconcileFresh` became `storeFresh`, the owner's guarded write branch of `refreshView`.

- Triggers (D1): open, reconnect (a disconnected → connected change, or a missing live view), `visibilitychange` to visible, a 30-second `setInterval` (`LIVE_REFRESH_MS`) that runs only while a `live` view is shown and the page is visible, and commands. For commands the authoritative command response is the refreshed view; `session.refresh()` (called by the route after the apply-roll, portrait and push commands) and online operations use the `command` trigger. No extra GET follows each queued command.
- An owner tab with a healthy write path (lock held, not blocked) refreshes through the serialized drain (`needsFresh` plus a drain pass, or a pass after the running one), so the queue, ordering and conflict rules are unchanged.
- Every other tab (D2: no lock, no Lock API, or blocked, for example by a storage failure) fetches the server view. A `live` view replaces `onlinePreview`. A `stored` view in a tab without the lock adopts a newer server view in memory only. Non-owner tabs never write the store, so the owner's queue is never rebased underneath it. A blocked owner keeps its stored view and review state, and its refresh only acts on a purge.
- A 404 with `cacheDisposition: "purge"` calls `purgeAccess()` for both sources. A `live` view also reports a non-purge 404 or a 401 at any refresh. Other failures keep the current view, except on open and reconnect of a `live` view, which report them as before.
- Fetches outside the drain are coalesced, with one follow-up fetch if a trigger arrives during a fetch. The timer is cleared when the view stops being `live`, when the page is hidden, on purge, on sign-out and on dispose. The `visibilitychange` listener is removed on dispose.
- The snapshot shape (`confirmed`, `onlinePreview`, `onlineOnly`) is unchanged for S2. The queue, idempotency, conflict review and server API are unchanged.
- `design_v2.md` Sections 8 and 10.2 describe the refresh triggers.

**First failing tests (written first, all failed before the change):**

- `CharacterRoute.test.tsx`: "shows another device's edit in an open online sheet after no editing lock / snapshot write failure without a reload" (2 cases; the edited heading never appeared), and "hides an open online sheet when a refresh reports the access was revoked" (the sheet stayed visible).
- `session.test.ts`, "CharacterSession read path": "refreshes a live view every 30 seconds while visible and stops on dispose" (revision stayed 1), "does not poll while the page is hidden and refreshes when it becomes visible" (revision stayed 1), "hides a live view and purges at the next refresh after access is revoked" (phase stayed `storage-error`), and "refreshes a stored view in a tab without the editing lock without writing the store" (revision stayed 1). The timer tests use fake `setInterval` and check that no timer is left after dispose or purge.

**Results after the change:** `npm run -s web:typecheck` passed. `web/src/characters/session.test.ts` and `CharacterRoute.test.tsx` 153/153, including both PR #93 cases. `npm run -s web:test` 143 files, 1345 tests passed. Offline browser suite (`playwright.offline.config.ts`, fresh `sweetroll_offline` database, after `npm run -s web:build`) 32/32 passed.

**Not done in S1.** A tab that holds the lock but cannot save does not retry `confirmSnapshot` on refresh and keeps the lock; D3 and the storage retry belong to S3. A stored view's in-memory refresh in a tab without the lock can still be replaced by an older stored copy on an `invalidate` broadcast that carries no newer store generation, until its next refresh.

### S2. Snapshot shape (2026-11-22)

**Change.** `CharacterSnapshot` in `web/src/characters/session.ts` no longer has `confirmed` or `onlineOnly`. It reports:

- `view: { source: "stored" | "live"; character } | null`. `stored` is the session's saved copy (in a tab without the lock it may have been refreshed in memory from the server, as in S1); `live` is the unsaved server view, shown only while connected, as before.
- `storage: "available" | "unavailable"`. It is `unavailable` while the session's error is `storage-error`, the same condition the route used before.
- `editing: { owned, owner?, blockedBy? }`. `blockedBy` is set only when a view is shown and the tab does not edit: `storage` when storage is unavailable, else `locks` when the browser has no Web Locks, else `other-tab`. `owned` is computed as before (false while a `live` view is shown).

`confirmed` stays internal to the write path. The internal `onlinePreview` variable is now `liveView` (and `previewShown` is `liveShown`). The session takes an optional `locksSupported` input (default `true`); the route passes its `locksSupported` prop or the browser check, and the campaign session factory in `router.tsx` passes the browser check. That check moved from `CharacterRoute.tsx` to `coordination.ts` as `browserSupportsLocks()`.

Consumers read `view` instead of `confirmed`/`onlineOnly`: `CharacterRoute` (offline availability uses only a `stored` view; the read-only status text uses `editing.blockedBy`; the storage check uses `storage`), `CharacterSheet` (the "Available online only" text uses `view.source === "live"`), `CharacterTools`, `ConflictReview`, the campaign `SessionBoard` push panel and the hook's loading snapshot. Visible text, editing rules, the queue, idempotency, conflict review and the server API are unchanged; messages and the shared `canEdit` predicate stay for S3/S4. No component reads `onlinePreview`, and the name no longer exists in `web/src`. The `character.sync.onlineOnly` i18n key is unchanged (S4).

**First failing test (written first, failed before the change):** `web/src/characters/CharacterRoute.snapshot.test.tsx`, "reports view, storage and editing for …", six cases: storage available with the lock held, with another tab holding it, and with no Lock API; storage unavailable (snapshot write failure) with the lock held; and storage unavailable (a failed store reread after an `invalidate` broadcast) in a tab without the lock, with and without a Lock API. Expected `stored`/`available`/none, `stored`/`available`/`other-tab`, `live`/`available`/`locks`, `live`/`unavailable`/`storage`, and `stored`/`unavailable`/`storage` twice. Before the change all six failed (`view` was undefined); the test wraps `createCharacterSession` with a pass-through `vi.mock` to read the route's session snapshot. Existing tests now read `view?.character` or `view.source` where they read `confirmed` or `onlineOnly` on a snapshot; store-record assertions are unchanged.

**Results after the change:** `npm run -s web:typecheck` passed. `npm run -s web:test` 144 files, 1351 tests passed (1345 before plus the six new cases). Offline browser suite (`playwright.offline.config.ts`, fresh `sweetroll_offline` database, after `npm run -s web:build`) 32/32 passed. Browser journeys `npm run test:e2e -- --suite=journeys character campaign session` 33/33 passed.

**Not done in S2.** S1's gap is unchanged: a `stored` view refreshed in memory in a tab without the lock can still be replaced by an older stored copy on an `invalidate` broadcast that carries no newer store generation, until its next refresh. It did not fall out of the shape change. `storage` reflects only failures this session has seen, so a tab without the lock reports `available` until it fails to read the store. D3 and the shared `canEdit` predicate are S3.

### S3. Derived editing (2026-11-22)

**Change.** `web/src/characters/session.ts` exports `canEdit(snapshot)`, which is `editing.owned && view?.source === "stored"`. The session and the UI use it:

- Commands. The session's gate `editAllowed()` is `canEdit` over the same derived view and ownership as the snapshot (computed without the snapshot cache), plus `coordination.isOwner()`. The offline-capable edits and actions (`assertMutationAllowed`), online operations, refresh and push (`assertOnlineOperationAllowed`, checked again after the pre-command refresh and before the attempt is saved), conflict review, expired-outcome review (before it fetches and saves) and the drain's send points (before freezing, and before `api.send` for queued entries and for online attempts) all check it. A refused command throws the existing errors, and nothing is enqueued, frozen, saved or sent.
- UI. `CharacterRoute` (read-only status, takeover section, portrait editing), `CharacterSheet` (editable controls, the read-only action reason, item art), `CharacterTools` (manage and export dialogs, the push panel) and the campaign `SessionBoard` push panel call `canEdit(snapshot)` instead of reading `editing.owned`. Visible text is unchanged.
- D3. `setBlocked("storage-error")` in a tab that holds the lock sets `editing.owned` to false and calls `coordination.letGo()`. The snapshot then reports `storage: "unavailable"` and `editing.blockedBy: "storage"`, and the view (`live`, or the `stored` copy it had) keeps refreshing through the read path as in a tab without the lock. The tab never reacquires the lock on its own. When `requestEditing()` is granted again, `reloadOwned` clears a `storage-error` after a successful store read, so the drain retries saving; a new failure releases the lock again. The route still hides the "Request editing access" control while storage is unavailable (S4 handles the messages).
- Test fixtures changed with the behaviour: "retries the exact frozen request after crash-after-send-before-ack across reopen" now seeds a stored copy before the frozen queue entry, because a queue entry is never sent without a stored view. "keeps the attempt when persisting an online acknowledgment fails" now checks that the failed acknowledgment released the lock, then requests editing, and the drain replays the retained attempt verbatim.
- `design_v2.md` Sections 8 and 10.2 and the GUI integration plan describe derived editing and D3. The queue format, idempotency, conflict review and server API are unchanged.

**First failing tests (written first):** `web/src/characters/session.test.ts`, "CharacterSession derived editing (S3)", five cases. Each wraps `api.send` to record `canEdit(snapshot)` and `coordination.isOwner()` at every call and asserts no call happened without both.

- "refuses every command in a live view and releases the lock after a snapshot write failure (D3)": runs 15 commands and checks that none enqueues, freezes, saves an online attempt or sends. Before the change it failed: first on the missing `canEdit` export, then (with only the export added) because the tab still held the lock.
- "refuses every command in a tab without the lock": failed only on the missing `canEdit` export. With the export alone it passed, because the commands already refused a tab without the lock.
- "releases the lock when a stored view cannot be saved again and keeps showing it read-only (D3)": failed (the snapshot reported `editing.owned: true` with storage unavailable, and the lock was held).
- "edits again only after editing is requested once storage works (D3)": failed (the lock was still held without a request).
- "does not save or send an online command when the lock is lost while it refreshes": failed. Without the export, `archive()` saved an online attempt after another tab took the lock during its refresh; with the export, it also called `api.send` without the lock.

**Results after the change:** `npm run -s web:typecheck` passed. `npm run -s web:test` 144 files, 1356 tests passed (1351 before plus the five new cases). Offline browser suite (`playwright.offline.config.ts`, fresh `sweetroll_offline` database, after `npm run -s web:build`) 32/32 passed. Browser journeys `npm run test:e2e -- --suite=journeys character campaign session physicalDice` 33 passed, 3 skipped. With `SWEETROLL_PHYSICAL_DICE=true` 32 passed and 4 failed (`campaignDerivedTemplates`, `campaignPush`, and `gmSessionJourney` at 360×640 and 1280×800, all waiting for a POST response or request); the same four fail the same way on the S2 commit `a29087f` without these changes, so they are not caused by S3. `physicalDiceAcceptance.spec.ts` passed.

**Not done in S3.** S1's gap is unchanged: a `stored` view refreshed in memory in a tab without the lock can still be replaced by an older stored copy on an `invalidate` broadcast that carries no newer store generation, until its next refresh. `storage` still reflects only failures this session has seen. Neither was needed for S3's acceptance. Messages are S4.

### S4. Messages (2026-11-22)

**Change.** `CharacterRoute`'s read-only status follows `editing.blockedBy` (`readOnlyMessage()`):

- `storage`: "Can't save this character in this browser, so it is read-only." (new key `character.detail.storageUnavailable`).
- `locks`: "Read-only in this browser." (`character.detail.readOnlyHere`, unchanged; before S4 it was also shown for `storage`).
- `other-tab`: "Read-only in this tab. Another tab is editing this character." (`character.detail.readOnly`, unchanged).
- "This character is unavailable." (`character.detail.unavailable`) stays for a character that is not found or whose access was revoked, including a `live` view revoked at a refresh.

The sync status keys are kept: `character.sync.onlineOnly` ("Available online only") still describes a `live` view in a browser without Web Locks, and a storage failure keeps `character.sync.storageError` ("Local storage unavailable — changes are not saved"), which the session error sets before the `live` check. Both agree with the new read-only status, so neither text changed.

**Decision on regaining editing after D3.** Implemented, confined to the route. While storage is unavailable and the browser has Web Locks, the route shows a "Try saving again" button (new keys `character.detail.retryStorage`, and `character.detail.retryingStorage` "Trying again…" while busy) under the status, in place of the hidden "Request editing access" section. It calls the session's existing `requestEditing()` through the same handler as takeover: on a grant `reloadOwned` rereads the store, clears the storage error and the drain retries saving; a new failure releases the lock again and the message returns. A refused request shows the existing `character.detail.takeoverFailed` alert. Without Web Locks no button is shown, because no tab can take the lock. No session, queue, idempotency, conflict review, server API or editing rule changed.

**First failing tests (written first):** `web/src/characters/CharacterRoute.messages.test.tsx`, 10 cases. Before the change 6 failed (the storage message and the "Try saving again" button did not exist): "names the reason after" a snapshot write failure with the lock held, a failed store read in a tab without the lock, and a failed store read without a Lock API; "offers to try saving again after a storage failure and edits once saving works"; "offers no retry when storage fails in a browser without a Lock API"; and "shows unavailable when access to an open online sheet is revoked after a storage failure". 4 passed before and guard the unchanged texts: "names the reason after" no Lock API and another tab holding the lock, "shows unavailable, not a storage message, for a character that is not found or revoked", and the revocation case after no Lock API. The PR #93 route test "opens a fresh online sheet read-only after snapshot write failure …" now expects the storage message for that case.

**Accessibility.** `web/tests/e2e/characterReadOnlyMessages.spec.ts` (journeys suite) creates a d20 character, then opens it in two new profiles that keep the sign-in cookie and localStorage but no IndexedDB copy: one whose `characters` object store rejects every `put` (an incomplete profile), and one without `navigator.locks`. Each shows its message and passes axe (no serious or critical findings) with no horizontal scroll at 360, 768 and 1280px in light and dark.

**Results after the change:** `npm run -s web:typecheck` passed. `npm run -s web:test` 145 files, 1366 tests passed (1356 before plus the ten new cases). Offline browser suite (`playwright.offline.config.ts`, fresh `sweetroll_offline` database, after `npm run -s web:build`) 32/32 passed. Browser journeys `npm run test:e2e -- --suite=journeys character campaign session` 34/34 passed (33 before plus the new axe journey). The visual suite (`--suite=visual`) failed 10/10 (library, document editor, sheet preview, publish dialog and conflict banner at 360 and 1280px, 1–7% of pixels); the same 10 fail the same way with these changes stashed, none of those views shows the character route, and no baseline was updated.

**Not done in S4.** The session error alert (for example "Could not persist the confirmed state. Storage is unavailable.") is still shown next to the new status; its wording is the session's and was not changed. S1's gap is unchanged. Browser journeys with Web Locks disabled and an incomplete profile across devices and campaign removal are S5.

### S5. Journeys (2026-11-22, local and CI parts)

**Change.** New browser journey `web/tests/e2e/characterReadPath.spec.ts` (journeys suite). The fault init script from the S4 spec moved to a shared fixture, `web/tests/fixtures/faultyProfile.ts` (`armProfileFaults(context, ["locks", "storage"])`); `characterReadOnlyMessages.spec.ts` now uses it, with the same behaviour. No application code changed, and the journey found no bug in S1–S4.

The journey has three browser contexts: the GM (`code-journey-gm`), the player's normal device (`code-journey-p1`) and the player's faulty profile. The faulty profile copies the normal device's cookies and localStorage (no IndexedDB copy), has no `navigator.locks`, and its `characters` object store throws `QuotaExceededError` on every `put`.

1. **Create.** The GM creates a d20 campaign, invites the player (who reviews and accepts on the normal device) and creates the player's character in the campaign with the player as controller (`POST /api/campaigns/:id/characters`), as a GM does at the table. An adopted character was not used, because on removal it returns to its owner instead of losing access.
2. **Open.** The faulty profile opens `/characters/:id`. The sheet shows with "Read-only in this browser." and "Available online only", and "This character is unavailable." is absent. With both faults the reason is `locks`: without Web Locks no tab owns the character, so nothing writes the store and the storage fault is never reached at open (D2; `storage` reports only failures seen, S2).
3. **Edit on another device.** The GM renames the character over the API. After one second the faulty profile still shows the old name (no push, D1). The trigger is a `visibilitychange` event dispatched on `document` while the page is visible; the journey waits for its `GET /api/characters/:id` (200) and the new name replaces the old one without a reload.
4. **Reconnect.** `context.setOffline(true)` hides the live sheet. The GM renames it again while the profile is offline. `context.setOffline(false)` fires the browser `online` event, the reconnect refresh runs, and the sheet returns with the latest name and the same read-only reason.
5. **Removal.** The GM removes the player from the campaign (`DELETE /api/campaigns/:id/members/:userId`). After one second the sheet is still shown. The page's clock is installed before load (`page.clock.install()`), and `page.clock.fastForward(30_000)` runs the 30-second live-view timer; its `GET /api/characters/:id` returns 404 and the page shows "This character is unavailable." None of the three names is left in the page. The purge's attempt to write the character store fails in this profile, which `purgeAccess()` already tolerates, and the sheet is hidden.

Throughout, the faulty context records every non-GET request to `/api/characters…`; the journey asserts there were none. Outside the disposable runner database it archives the character and the campaign at the end.

**CI.** The journeys suite runs every `tests/e2e/*.spec.ts` except `visual.spec.ts` (`playwright.config.ts`), sharded 1/3–3/3 in `.github/workflows/ci.yml`, so the new spec is included without a workflow change.

**Results.** `npm run test:e2e -- --suite=journeys characterReadPath` passed 3 times in a row (19.4 s, 18.3 s, 18.9 s), after one earlier passing run. `npm run test:e2e -- --suite=journeys character campaign session` 35/35 passed (34 before plus the new journey). `npm run -s web:typecheck` passed. `npm run -s web:test` 145 files, 1366 tests passed.

**Open.** The hosted acceptance run on the Railway build, with its deployed SHA recorded, has not been done; it cannot be run from this environment. CI on the pushed branch is also still to be observed. S1's gap (an older stored copy replacing an in-memory refresh on an `invalidate` broadcast) and S4's remaining session error alert are unchanged.

**Resolved later (2026-11-24).** S1's gap (noted under S1–S5 above) is closed by V2 of the [session view plan](2026-11-23-character-session-view-and-conditions.md#v2-saved-copy-and-newest-view-2026-11-24).
