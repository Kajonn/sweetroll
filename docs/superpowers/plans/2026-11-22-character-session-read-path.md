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
