# I4 Completion Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct the audited I4 safety and integration gaps, demonstrate the complete character-play workflow through the production UI, and replace the premature closure claims with verified evidence.

**Architecture:** Keep the existing Characters backend, account-partitioned IndexedDB adapter, character session, browser identity/coordination adapters, pure renderer and route composition. Repair persistence and sequencing before exposing currently unreachable controls. The session remains the sole character mutation authority; components do not become independent synchronization clients.

**Tech Stack:** Existing TypeScript, React 18, TanStack Router, CSS modules, i18n, native IndexedDB/Web Locks/BroadcastChannel/service worker, Vitest/RTL/fake-indexeddb and Playwright with PostgreSQL.

**Spec:** `design_v2.md` section 17.6 and `docs/superpowers/specs/2026-09-06-i4-character-sheet-design.md`. The approved behavioral requirements are binding. Their current "I4 closed" status is disputed by the audit and must be corrected during execution.

## Handoff and Authorization

This file is a future execution task, not evidence of implemented fixes. The audit examined `3dbcae0` on `main`. Recheck the current HEAD and actual files before editing; line numbers below describe that audited tree and may move.

The user requested a task file for another agent. This request does not authorize this authoring session to implement changes. The executing agent should obtain or rely on a separate execution instruction. Do not merge, push, deploy, discard work or reset a database without explicit authorization. The checkpoint commit subjects below are suggestions, not permission to commit.

Use an isolated worktree when executing. Preserve user changes and the running manual-test application. Do not start competing servers on ports 3000/5173 or delete the user's local development database. Browser tests should use a dedicated database/schema and their own documented server ports.

## Global Constraints

- Offline writes are field sets and direct resource bumps only. Actions, creation, archive/recovery, migration and authoritative export require connectivity.
- Conflicts pause only the affected character. No silent merge, rebasing against unrelated server changes, or advancing past rejected commands.
- The user can discard pending intentions or explicitly reapply selected intentions with new keys after reviewing current state.
- Cached reads and queues survive reload/browser restart in account-partitioned IndexedDB.
- One tab per character may edit and synchronize at a time. Other tabs are read-only and can request takeover.
- Preserve the exact body, idempotency key and first-attempt metadata of attempted commands until their outcome is resolved. A new preview, fresh GET, local timeout or elapsed time is not proof of cancellation.
- No old-account attempt may be sent using a new session. Durable generation/tombstone checks protect writes, not just in-memory subscriptions.
- No browser rule evaluator, arbitrary resource-set endpoint, public catalogue, ownership-transfer UI, Player library, install flow or general-purpose sync framework.
- The renderer imports no API client, IndexedDB, auth, router or expression evaluator.
- Private responses never enter CacheStorage. Activity caches are private and participate in account clearing and character purge.
- Preserve historical backend replay receipts. Do not rewrite a stored result to satisfy a newer response schema.
- Correctness tests must fail for the targeted behavior before the fix. A missing import or fabricated assertion is not sufficient red evidence.
- Record full test exit statuses. Do not pipe commands through `tail`, `head`, `grep` or other truncators that can hide failures.
- Do not reduce the spec to match the implementation. Missing route wiring is an I4 defect, not a scope expansion or I5 follow-up.

## Audit Baseline

These are hypotheses supported by source inspection, not a substitute for reproducing them:

| Finding | Evidence in audited tree | Required remediation |
|---|---|---|
| Actions unreachable | `CharacterRoute.tsx:127` omits `onExecuteAction` | Connect action execution and authoritative results in the routed app |
| Tools and conflict review unreachable | `CharacterRoute.tsx:124-142` mounts neither component | Mount tools, blocking-state recovery and takeover controls |
| Creation identity race | `CreateCharacter.tsx:206-268` awaits storage then sends without generation revalidation | Gate before send and after every async response/write boundary |
| Partial recovery silently rebases | `session.ts:679-725` retains unselected entries but clears conflict and `needsFresh` | Only selected reapply may authorize a new base |
| Reapply loses intentions on failure | `session.ts:699-709` retires then enqueues in separate transactions | Atomic durable recovery replacement |
| Uncertain online attempts ignored/deleted | `session.ts:864-893,927-951` | Startup ordering, immutable retention, explicit expired-outcome review |
| Expiry uses stale review state | `session.ts:487-489`; creation retry path | Fetch current state; distinguish unknown outcome from ordinary conflict |
| Resource estimate loses order | `session.ts:208-224`; `CharacterSheet.tsx:29-34` | Apply bounded steps in sequence without rule evaluation |
| Secondary panels incomplete | `CharacterTools.tsx` activity/migration flows | Retained activity, safe preview/commit/rollback and invalid correction |
| Acceptance misses full routed journey | production tests primarily create via HTTP and bump resources | UI creation/completion/roll/conflict/export in one production journey |

## File and Interface Map

Paths below are relative to the repository root. Do not split existing modules or introduce a new framework merely to implement this plan.

| Surface | Files | Responsibility |
|---|---|---|
| Durable state | `web/src/characters/store.ts`, `types.ts`, `store.test.ts` | Atomic recovery, guarded online attempts and private activity cache |
| Sequencing | `web/src/characters/session.ts`, `session.test.ts`, `testing.ts` | Queue order, unresolved outcome gates, explicit recovery, authoritative operation results |
| Creation | `web/src/characters/CreateCharacter.tsx`, `CreateCharacter.test.tsx` | Account-bound pending create and response lifecycle |
| Pure sheet | `web/src/characters/CharacterSheet.tsx`, `FieldControl.tsx`, their tests, `characters.module.css` | Values/status/header/actions and accessible errors |
| Recovery/tools | `web/src/characters/ConflictReview.tsx`, `CharacterTools.tsx`, `dialogTrap.ts`, their tests | Explicit user decisions, activity/export/migration dialogs |
| Composition | `web/src/characters/CharacterRoute.tsx`, `useCharacterSession.ts`, `router.tsx`, their tests | Identity lifetime, reachable controls, no duplicate command authority |
| Copy | `web/src/i18n/messages.ts` | Localized status, warnings and recovery instructions |
| Backend reference | `src/characters/index.ts`, `persistence.ts`, `src/transport/http/characters.ts`, `web/src/api/schema.d.ts` | Inspect existing replay and response contracts before changing client assumptions |
| Browser proof | `web/tests/offline/*.spec.ts`, `web/tests/offline/test-auth.ts`, `web/tests/e2e/character-sheet.spec.ts`, `web/playwright.offline.config.ts` | Production UI journeys and actual browser concurrency |
| Status/evidence | `design_v2.md`, existing I4 spec/plan and acceptance record | Reopen honestly, then close against fresh evidence |

### Required Interface Decisions

Use existing exported types where possible. The following are target contracts for the remediation, not claims about current code. Keep final signatures documented in the execution ledger so subsequent tasks consume the implementation rather than stale examples.

1. **Atomic edit recovery:** add a single store operation equivalent to `resolveEntries(actorId, characterId, { selectedIds, replacements }, guard): Promise<void>`, using the existing `WriteGuard` type. `replacements` contains newly identified, unsent `QueueEntry` records for explicitly selected reapply/correction only. In one transaction, verify identity/character guards and selection validity, retire selected records, insert replacements and advance the generation. Leave unselected records and their provenance unchanged. The session reloads committed state after success.
2. **Explicit online-outcome review:** expose a session command equivalent to `reviewExpiredAttempt({ attemptId, acknowledgeUnknownOutcome: true }): Promise<void>`. It is not an automatic retry or an assertion that the request failed. It may retire that exact expired attempt only after current state has been fetched and the user explicitly accepts the unknown-outcome warning. Any new online mutation is a separate deliberate action with a new key. Creation needs the same distinction, scoped to its account rather than a nonexistent character ID.
3. **Invalid edit correction:** extend the existing conflict-resolution input with optional `correctedIntents: Record<string, EditIntent>` for selected IDs. Use the existing offline-only intent type for corrections: field sets/resource bumps, not lifecycle/actions. Validate selection and supported field value before atomic replacement; never edit a frozen body in place.
4. **Results visible to UI:** expose the last authoritative action result and successful migration identifier via the session snapshot or a typed command return plus retained session state. Derive shapes from existing generated operations. Do not fabricate a roll audience, migration ID or state from intent inputs.
5. **Activity lifetime:** add account/character-scoped read/write activity-page operations to the existing store, or an equally durable existing cache adapter. Include fetched time, page cursor and next cursor. All such records must be deleted atomically with applicable purge/clear operations.

Any change to these decisions during implementation must remain within the spec, be recorded with rationale and cost, and update all dependent call sites/tests. Do not introduce an unguarded compatibility path simply to preserve test fixtures.

## Task 1: Reopen I4 and Establish Reproducible Baselines

**Files:** `design_v2.md`, `docs/superpowers/specs/2026-09-06-i4-character-sheet-design.md`, `docs/superpowers/plans/2026-09-06-i4-character-sheet.md`, `docs/acceptance/i4-2026-09-06.md`; ignored execution ledger.

**Deliverable:** Accurate current status and preserved historical evidence, without changing approved scope.

- [ ] Inspect `git status --short`, `git log --oneline -10`, the current specs and application scripts. Create/verify the isolated worktree and dedicated test DB/server configuration.
- [ ] Update status text to "I4 reopened: completion/remediation in progress" and link this plan. Keep the old tested commit/counts as historical results; explicitly state they did not prove the full routed workflow.
- [ ] Record the original audit commit, execution base, test DB identity, server ports, toolchain and worktree path in a gitignored ledger. Never put secrets in reports.
- [ ] Run baseline `npm test`, `npm run web:test`, `npm run typecheck`, `npm run web:typecheck`, `npm run contracts:check`. Record actual failures, not blanket "pre-existing" waivers.
- [ ] Preserve all user data and historical receipts. Existing task reports accidentally committed in earlier work are not permission to force-add new `.superpowers` artifacts.
- [ ] Review the documentation diff. Optional authorized checkpoint: `docs: reopen I4 for completion remediation`.

## Task 2: Make Edit Recovery Atomic and Selection-Safe

**Files:** `store.ts`, `store.test.ts`, `session.ts`, `session.test.ts`, `types.ts`, `testing.ts` under `web/src/characters/`.

**Consumes:** Existing ordered queue, `WriteGuard`, confirmed revision/checksum and conflict fetch.
**Produces:** Atomic `resolveEntries` contract above; durable explicit-review provenance for remaining intentions; correction support.

- [ ] Add real-store regressions for two offline edits at revision 1 encountering server revision 7. Selecting only the first for discard must not send the second. Selecting only the first for reapply must not silently rebase the second. Reopening between review steps must preserve that block.
- [ ] Define selective behavior explicitly: unselected unresolved entries remain paused; a selected entry cannot jump ahead of an earlier unresolved predecessor. Once the ordered eligible prefix is resolved, later entries still require their own explicit review rather than inheriting an unrelated external revision.
- [ ] Add rollback regressions: inject an abort/quota failure after deleting originals but before the final replacement write. Assert the entire queue, frozen bodies and generation equal their pre-transaction values after reopening.

```ts
const before = await store.read(actorId, characterId);
// Inject failure at the replacement write, not before the transaction starts.
await expect(applyReviewedReplacement()).rejects.toThrow();
store.close();
const after = await reopenedStore.read(actorId, characterId);
expect(after.entries).toEqual(before.entries);
expect(after.generation).toBe(before.generation);
expect(sentRequests).toHaveLength(0);
```

- [ ] Add stale-guard, nonexistent selected ID, empty selection, duplicate selection and account-clear-during-review tests. None may clear the pause or resurrect cleared private state.
- [ ] Run `npm run web:test -- src/characters/store.test.ts src/characters/session.test.ts` and capture behavioral failures.
- [ ] Replace retire-then-enqueue recovery with one guarded IDB transaction. Publish the new UI snapshot only after commit. Keep unresolved selection/provenance durable; setting `error = null` and `needsFresh = false` alone cannot authorize untouched entries.
- [ ] Implement invalid corrections as atomic replacement intentions with new IDs/keys at first send. Preserve original request bytes on every non-correction retry. Explain retained dependent entries through data consumable by the UI.
- [ ] Verify own successful queue progression still uses returned revision (including unchanged revisions), not arithmetic or an external GET. Frozen requests remain untouched.
- [ ] Run focused suites, full `npm run web:test` and `npm run web:typecheck`; independently review both transaction and selection behavior. Optional checkpoint: `fix: make character conflict recovery atomic and explicit`.

## Task 3: Preserve and Sequence All Uncertain Online Outcomes

**Files:** `web/src/characters/session.ts`, `session.test.ts`, `store.ts`, `store.test.ts`, `types.ts`, `api.ts`, `api.test.ts`; inspect backend replay paths in `src/characters/index.ts`.

**Consumes:** Frozen requests, existing online-attempt storage, identity/lock ports and Task 2 recovery guards.
**Produces:** One ordering boundary for edit/action/lifecycle/migration attempts, guarded atomic online acknowledgment and explicit expired-attempt review.

- [ ] Reproduce an archive and migration commit that succeeds on the server but loses its response. Reopen a session with that durable attempt and a newer local intention. Assert exact replay occurs before a fresh-state decision or any newer command.
- [ ] Prove the backend contract: a completed migration commit is replayable by the original key even if a newer preview exists. Use existing backend tests or add a narrowly scoped integration regression; do not infer behavior from preview expiry alone.
- [ ] Add tests showing that obtaining a new preview does not delete or replace an unresolved commit attempt; neither does a fresh GET, timeout, 401, unexpected 500 or elapsed 30 days.

```ts
expect(retried.method).toBe(original.method);
expect(retried.path).toBe(original.path);
expect(retried.body).toEqual(original.body);
expect(retried.firstAttemptAt).toBe(original.firstAttemptAt);
expect(newerMutationRequests).toHaveLength(0);
```

- [ ] Run focused session/store/API tests to establish red evidence. Remove automatic expired/superseded attempt deletion only as part of implementing the replacement safe flow.
- [ ] Load unresolved per-character online attempts on ownership acquisition/startup. Block newer sends across command kinds until the old outcome is resolved. Do not make matching the same newly requested operation the only way to find an old attempt.
- [ ] Acknowledge an online outcome atomically with confirmed-state persistence and retirement of its exact attempt. Guard by actor/identity generation, character generation and ownership lifetime; quiesce before releasing the lock. Keep the attempt if acknowledgment storage fails.
- [ ] Enforce the spec error matrix: `command_in_progress`/temporary unavailable back off with the same request; unexpected 500 pauses with retry guidance; idempotency mismatch is a protocol stop; 401 requires the same account; purge deletes all applicable private records and hides their contents.
- [ ] For locally aged attempts and backend replay-window-expired conflicts, retain the attempt, fetch current authorized state and block ordinary recovery/new sends. If refresh fails, do not pretend a fresh review base exists. Require the explicit unknown-outcome command before retiring an expired attempt; do not automatically create a replacement mutation.
- [ ] Test explicit expiry review cannot execute while offline, stale, under another account, after purge, or while an unexpired uncertain attempt still has a resolvable outcome. Test that an unrelated review does not remove other attempts.
- [ ] Preserve migration IDs/results and authoritative action results for later UI consumption. Keep online operations distinct from offline-only intentions.
- [ ] Run focused/full web tests and both relevant contract/type checks. If backend schemas change, run `npm run contracts:generate`, `npm run contracts:check` and backend integration tests. Optional checkpoint: `fix: retain and resolve uncertain character operations`.

## Task 4: Close Creation Identity, Persistence and Expiry Races

**Files:** `web/src/characters/CreateCharacter.tsx`, `CreateCharacter.test.tsx`, `store.ts`, `store.test.ts`, `router.tsx`, relevant route tests, `i18n/messages.ts`.

**Consumes:** Real identity gate, durable generation guards and immutable account-scoped create attempts.
**Produces:** Creation that cannot reuse another account's request or navigate from a stale completion; explicit expired-create handling.

- [ ] Add deferred-promise tests for account switch/sign-out after reading attempts, after persisting an attempt, before network send and before success cleanup/navigation. In each case assert no old-account send, marker write or `onCreated` call after invalidation.
- [ ] Add a reload test that finds the exact persisted creation request and reuses its body/key, without requiring fresh metadata to rewrite it. Keep fresh metadata selection validation for new creation only.
- [ ] Add tests for durable storage rejection, concurrent/double-click submission, first-submit definitive rejection cleanup and unmount during response handling. Cleanup must target the captured attempt's actor/ID, not whichever account happens to be current later.
- [ ] Run `npm run web:test -- src/characters/CreateCharacter.test.tsx src/characters/store.test.ts` and verify the intended races fail before production changes.
- [ ] Capture actor and identity generation per submission. After each awaited boundary, check operation lifetime and identity; call the gate's durable `isCurrent()` immediately before sending. Use transaction-level identity guards for online-attempt writes/deletes/acknowledgment so delayed broadcasts cannot recreate data after logout.
- [ ] Key or recreate account-specific component state by actor/generation as well as version search input. Ignore late results from old lifetimes; preserve unresolved attempts under their original account unless explicit logout cleared them.
- [ ] Add expiry-specific UI/state for old creation attempts and backend replay-window expiry. Keep the original request for explicit review; do not infinitely retry or auto-mint a fresh create. Explain that a prior character may exist and creating another is a distinct explicit decision. Provide existing cached recovery links where available, without introducing an I5 library.
- [ ] Run focused/full web tests and web typecheck. Optional checkpoint: `fix: bind character creation to durable account identity`.

## Task 5: Correct Sheet Status, Ordered Estimates and Error Presentation

**Files:** `web/src/characters/session.ts`, `session.test.ts`, `CharacterSheet.tsx`, `CharacterSheet.test.tsx`, `FieldControl.tsx`, `FieldControl.test.tsx`, `characters.module.css`, `web/src/i18n/messages.ts`.

**Consumes:** Confirmed snapshot, ordered pending intentions, ownership and structured blocking error.
**Produces:** Pure accessible renderer showing truthful state, ordered resource estimates and usable authoritative action results.

- [ ] Add a resource estimate regression with current 1, min 0, step 2 and intentions down then up. Its displayed estimate is 2, not the net-delta result 1. Also test up/down near max, distinct steps and duplicate controls reflecting the same estimate. These are estimates, not a claim that an invalid backend command will succeed.
- [ ] Add tests for every relevant phase: pending, uncertain, invalid, conflict, reauthenticate, storage-error and purged. A failed persistence operation must not display "Saved"; blocked edits must not remain deceptively enabled. Purged/account-switched state must expose no private field or error detail.
- [ ] Add header assertions for name, pinned version, lifecycle, sync state and offline availability. Render required/unsupported diagnostics and absent completion metadata consistently.
- [ ] Run focused session/sheet/field tests red. Replace aggregated resource counts with sequential bounded estimates derived from ordered intentions over confirmed state. Keep derived values, validations and bounds explicitly last-confirmed; no package/rule evaluation.
- [ ] Catch rejected UI command promises and surface localized errors through the session/route state contract. Preserve numeric drafts when a commit fails; prevent duplicate Enter/blur submissions. Avoid unhandled promise rejections and false saved announcements.
- [ ] Render authoritative action expression/total/audience/dice/bindings from Task 3 result state. Explain disabled action reasons persistently, not via a hover-only title. No automatic application of roll outcomes.
- [ ] Run all web tests/typecheck and check keyboard/ARIA/live-status behavior. Optional checkpoint: `fix: render truthful character sync and ordered estimates`.

## Task 6: Complete Recovery, Activity and Migration Panels

**Files:** `web/src/characters/ConflictReview.tsx`, `ConflictReview.test.tsx`, `CharacterTools.tsx`, `CharacterTools.test.tsx`, `dialogTrap.ts`, `session.ts`, `store.ts`, their tests, `web/src/i18n/messages.ts`.

**Consumes:** Task 2 correction/selection semantics, Task 3 uncertain-outcome review and authoritative migration IDs, Task 5 status contracts.
**Produces:** Complete panels ready for route integration, not test-only stubs.

- [ ] Add component/session integration tests for correction of an invalid field with a new key, partial selection retaining unselected review, explicit dependent-change explanation, repeated conflict, and unknown-outcome warning before expired-attempt review. Keep unexpired uncertain attempts out of ordinary discard/reapply.
- [ ] Add activity tests: open/fetch page, close, go offline, reopen and see the last fetched page marked stale with useful event kind/summary/time. Paginate using server cursors without duplicates; purge/sign-out removes cached activity. Never cache it in the service worker.
- [ ] Add migration tests: preview disabled while offline or queued/blocked; candidate values/warnings visible; stale/expired server response requires a new preview and renewed confirmation; unresolved previous commit blocks newer commit; successful commit exposes its authoritative migration ID for rollback without manual guessing.
- [ ] Add export tests checking online/owner/queue/outcome gates and downloaded JSON equals the documented server document, not an overlay. Include pending online attempts, not just edit entries. Restore focus and clean URLs/anchors after success or failure.
- [ ] Run focused tests red, then implement the activity cache contract with identity/purge guards. Reuse existing projected labels and safe event metadata instead of displaying raw IDs alone.
- [ ] Implement invalid correction controls using projected supported field constraints and Task 2's atomic replacement. A disabled Reapply button without a correction path is not completion of the requirement.
- [ ] Complete migration preview refresh, commit result retention and rollback selection. Do not invent migration IDs or bypass server rollback limits. All mutations go through the session's unified ordering; read-only APIs still honor online/account state.
- [ ] Trap and restore dialog focus, including focus starting outside; localize failure fallbacks. Keep touch targets at least 44x44 at phone width.
- [ ] Run focused/full web tests and typecheck. Optional checkpoint: `fix: complete character recovery and management panels`.

## Task 7: Wire the Complete I4 Surface into Real Routes

**Files:** `web/src/characters/CharacterRoute.tsx`, `CharacterRoute.test.tsx`, `useCharacterSession.ts`, `router.tsx`, `router.test.tsx`, sheet/tools/recovery components as needed.

**Consumes:** Reviewed Tasks 2-6; identity/store/session/coordination lifetime from existing browser adapters.
**Produces:** Reachable creation, action, conflict/error review, takeover and management workflows through `/characters/$characterId`.

- [ ] Write route tests that navigate through the actual router/provider composition rather than rendering tools alone. Assert users can invoke an authored action, see a roll result, open tools, export, archive/recover, preview/commit/rollback and resolve a simulated conflict.
- [ ] Add an explicit takeover-control test for a read-only second tab. Unsupported Web Locks must show a reason and remain read-only. Do not substitute closing the first page for requesting takeover.
- [ ] Add null-identity/account-switch/unmount tests proving no empty-actor session opens, no private cached screen flashes and no duplicate senders/channels survive StrictMode/navigation.
- [ ] Run route tests red. Compose the pure sheet with callbacks from the existing session, mount `CharacterTools`, and conditionally mount the review/error surfaces using the structured session state. Make all listed workflows reachable from visible controls.

```tsx
// Shape illustration: adapt prop names to the reviewed component contracts.
<CharacterSheet
  snapshot={snapshot}
  onSetField={session.setField}
  onBump={session.bumpResource}
  onExecuteAction={session.executeAction}
/>
```

- [ ] Keep one owner responsible for coordination lifetime; takeover quiesces active sends/writes before release. Display the session's ownership state and command errors. Do not create a second API mutation path in the route.
- [ ] Verify required-field focus after creation, navigation search changes, published-version entry links and existing `/systems/$systemId` editor behavior. Prefer SPA navigation within router-owned composition; reusable components may receive navigation callbacks rather than import router internals.
- [ ] Run focused route/shell tests, full web tests, typecheck and web build. Independently review reachability by tracing imports and actual rendered controls. Optional checkpoint: `fix: expose complete I4 character workflows in routes`.

## Task 8: Prove the Full Production UI Journey and Failure Boundaries

**Files:** `web/tests/offline/character.spec.ts`, `coordination.spec.ts`, `privacy.spec.ts`, `update.spec.ts`, `test-auth.ts`, `web/tests/e2e/character-sheet.spec.ts`, `web/playwright.offline.config.ts`; focused regression files for any discovered corrections.

**Consumes:** Actual built app and all reviewed previous tasks. **Produces:** UI-level acceptance plus persisted effects, not component-only/API-only substitutes.

- [ ] Inspect test infrastructure before running. Use a dedicated test DB/schema and explicit test-auth configuration, separate from the user's manual-test backend. Test fixtures may seed/publish systems and simulate an independent writer, but must not perform the UI actions being accepted on behalf of the browser.
- [ ] At 360px, for d20/PbtA 2d6/d6 pool: use UI creation, complete required fields, edit and bump online, execute a roll through the UI, see its authoritative details, wait for offline-ready, go offline, queue multiple ordered edits, close and reopen the same deep link offline, reconnect, then explicitly review a server conflict and export final confirmed state through the UI.
- [ ] If reference fixtures do not expose an omitted required field, publish a minimal authorized fixture variant specifically for completion coverage. Do not pretend editing an already-complete field proves required-field completion.
- [ ] Assert final revision, resource state, activity count and roll count against the server/database. Capture the download and compare its parsed content with the documented authoritative export. Verify pending edits and unknown online outcomes block export.
- [ ] Simulate an **applied-but-unseen** response, not just a pre-request abort. Forward the intercepted request to the real backend, await successful application, then withhold/abort the browser response. Restore connectivity or reopen, capture the retry body/key and assert equality and exactly one effect.

```ts
// In the test route handler, only for the first selected mutation:
const response = await route.fetch();
expect(response.ok()).toBe(true);
// The server has applied it; prevent the page from receiving that response.
await route.abort("failed");
// A later matching request must carry the exact original body/key.
```

- [ ] Repeat unknown-outcome proof for archive or migration across a page restart. Confirm a newer mutation cannot overtake it and a new preview does not erase its request. Test expiry/manual review separately using persisted timestamps/controlled fixtures, not by weakening backend retention policy.
- [ ] Test actual two-page Web Lock takeover via the visible request control while a response is uncertain. Keep the original owner open until it quiesces; assert never two owners/senders. Also preserve the owner-termination recovery test.
- [ ] Test logout/account switch during delayed creation persistence/send/result, cached-owner revocation after offline edits, storage transaction failure during reapply, cold missing-cache visits and actual second-build worker activation with queued writes. Verify no private data in CacheStorage or after purge.
- [ ] Capture screenshots and run axe/keyboard/no-horizontal-overflow checks for all three systems at 360 and 1280px. Store durable evidence outside Playwright's repeatedly cleared results directory, with meaningful filenames/build IDs. Do not indiscriminately rebaseline visual failures.
- [ ] Run production-offline tests red against the pre-fix affected workflows where feasible. For any further production correction, first add a focused failing regression. Then rerun complete browser suites and relevant unit suites.
- [ ] Report exactly which scenarios use real browser controls, real locks, real persisted effects and real builds. A mock control event does not prove actual browser lifecycle behavior. Optional checkpoint: `test: verify complete I4 workflows through production UI`.

## Task 9: Fresh Verification, Independent Audit and Honest Reclosure (complete 2026-09-07, tested commit `8b9f40d`)

**Files:** `docs/acceptance/i4-2026-09-06.md`, `design_v2.md`, original I4 spec/plan status, this plan's completed checklist, ignored execution reports.

- [x] Build a requirement-to-evidence table covering every row in the audit baseline plus spec sections Routes/Presentation, Durable Queue, Errors, Identity, Multi-tab and Fully Offline Loading. Include the **route** that exposes each feature and a **browser test** that exercises it.
- [x] Ask an independent reviewer to compare spec to actual implementation without assuming earlier approvals are valid. Explicitly inspect action/tools/recovery/takeover reachability, creation identity boundaries, partial selection, transaction crash points and uncertain-online-attempt retention. Resolve actionable safety/spec failures before claiming closure.
- [x] Run every command below directly in the isolated worktree. Set `TEST_DATABASE_URL` for the dedicated integration target and `DATABASE_URL` for the dedicated browser backend. Record actual resolved targets without credentials in public docs.

```bash
npm test
npm run test:integration
npm run typecheck
npm run build
npm run contracts:check
npm run web:test
npm run web:typecheck
npm run web:build
npm run web:test:e2e
npm run web:test:offline
git diff --check
```

The integration command must have a real `TEST_DATABASE_URL` exported: skipped database tests are not passing integration evidence. Browser commands need their documented `DATABASE_URL`, `AUTHORITATIVE_ROLL_SECRET` and isolated ports/test-auth setup. Never enable the test-auth seam for a real deployment.

- [x] Record tested commit and tree, commands/exits/counts, browser versions, retained screenshot/download/DB evidence and known limitations. If a documentation commit follows the tested code, distinguish the two precisely; never invent a tested closure SHA.
- [x] Keep historical results in the acceptance record but explicitly supersede the premature I4 closure. Mark I4 closed only when all required routed workflows and safety regressions pass. If any required item is outstanding, leave it reopened with named blockers.
- [x] Confirm I5 scope remains untouched. Preserve browser-eviction/Web Lock support limitations honestly; these are not excuses for missing I4 workflows.
- [x] Review intended documentation changes and, if authorized, checkpoint `docs: reclose I4 with complete workflow evidence`. Do not force-add ignored reports or place scratch task reports at repository root.
- [x] Provide a concise handoff with implementation summary, exact verification, unresolved items (if any), artifact locations and any design decisions. Ask before merge/push; retain evidence and user work.

## Completion Gate (all true 2026-09-07, tested commit `8b9f40d`)

All of the following must be true before reporting success:

- [x] A signed-in user can create, complete, edit, bump, roll, review conflicts, request takeover, view activity, archive/recover, export and migrate/rollback using actual application controls.
- [x] Only explicitly reviewed selections are reapplied; unselected intentions never acquire a new external base silently.
- [x] Recovery and online acknowledgment are transactional; injected failures and restarts do not lose pending work or resurrect purged data.
- [x] Every unresolved attempted operation retains its immutable request and blocks newer commands until replay or explicit expired-outcome review resolves the local decision.
- [x] Creation cannot send or navigate under a changed/disposed account lifetime, including delayed cross-tab notifications.
- [x] Error/status rendering is truthful, localized and accessible; ordered resource estimates are not collapsed deltas.
- [x] Production-browser tests exercise the complete UI journey and applied-but-unseen responses, all reference systems and both widths.
- [x] Full regressions and independent source-to-spec audit pass; closure documentation accurately names tested code and preserved evidence.

## Authoring Self-review

Coverage: status correction (1); partial-selection/atomicity/invalid correction (2); online ordering/retention/expiry/500 handling (3); creation races/expiry (4); status/header/ordered estimates (5); activity/migration/export/recovery panels (6); reachability/takeover/lifetime (7); production journey/evidence (8); fresh reclosure (9).

Dependencies: Task 2 owns atomic edit replacement; Task 3 owns online-outcome sequencing; Task 4 consumes durable identity guards; Tasks 5-6 expose their reviewed contracts; Task 7 composes rather than reimplements them; Task 8 must prove those exact routes, not alternate helper paths. Task 9 consumes successful evidence, never substitutes documentation for missing behavior.

No application code was changed while authoring this plan. Execution and verification remain pending.
