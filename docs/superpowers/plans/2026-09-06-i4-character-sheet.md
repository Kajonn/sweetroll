# I4 Character Sheet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the reusable projection-driven character sheet with durable offline edits, safe replay and fully offline reopening.

**Architecture:** A character session owns confirmed state, durable intentions, immutable attempts and synchronization. A pure projection renderer sits behind a route adapter. IndexedDB, Web Locks and a minimal asset-only service worker provide browser persistence and coordination without building the I5 Player app.

**Tech Stack:** Existing TypeScript, React 18.3.1, TanStack Router/Query, CSS modules, TypeBox, PostgreSQL, Vitest/RTL/MSW and Playwright; native IndexedDB/Web Locks/BroadcastChannel/service worker. Add fake-indexeddb for tests only.

**Spec:** `docs/superpowers/specs/2026-09-06-i4-character-sheet-design.md`

## Global Constraints

- Read the complete spec before every task; its error/privacy/queue requirements are binding.
- Implementation has not started. Use an isolated worktree at execution time; do not commit user changes from main as part of a task.
- Preserve the existing System Builder and visual language, React 18, TanStack Router/Query, CSS modules, and i18n conventions.
- Offline writes are field sets and direct resource bumps only. Actions, creation, archive/recovery, migration and authoritative export require connectivity.
- No silent merge, rebasing against unrelated server changes, or advancing past rejected commands.
- One tab per character may edit and synchronize at a time. Other tabs are read-only and can request takeover.
- No browser rule evaluator, arbitrary resource-set endpoint, public catalogue, ownership UI, PWA install flow or general-purpose sync framework.
- Preserve historical 30-day receipts exactly; additive completion metadata remains optional in projection 1.0.
- Body-field `idempotencyKey` is distinct from request IDs. Persist exact attempted requests before sending; never mutate them on retry.
- Private API responses never enter service-worker CacheStorage. Cache/queue ownership is account-scoped; purge must survive late responses.
- Test all reference systems at 360 and 1280 px. Production-offline tests must use built assets, not Vite development modules.
- TDD for every behavior: write the named regression, run red for the intended missing behavior, implement, run green and affected suites, then review. Do not accept import errors as the only proof of a protocol regression.
- Task commits below are the intended implementation checkpoints; only create them when execution includes user authorization to commit.

## File and Dependency Map

| Unit | Files | Responsibility |
|---|---|---|
| Projection/creation contract | `src/systems/runtime.ts`, `src/systems/implementation/runtime/projection.ts`, `src/characters/index.ts`, `src/transport/http/characters.ts` | Completion fields and authorized entity metadata |
| Identity boundary | `src/transport/http/identity.ts`, `src/bootstrap/http.ts`, `web/src/shell/AppShell.tsx`, `web/src/characters/identity.ts` | Real identity, sign-out and account gate |
| Transport | `web/src/api/client.ts`, `web/src/characters/api.ts` | Generated wire types and reconciliation-preserving transport |
| Durable protocol | `web/src/characters/store.ts`, `session.ts`, `coordination.ts` | IndexedDB transactions, queue and single-editor ownership |
| Play UI | `web/src/characters/CharacterSheet.tsx`, `FieldControl.tsx`, `CharacterRoute.tsx`, `CreateCharacter.tsx`, `CharacterTools.tsx`, `ConflictReview.tsx`, `characters.module.css` | Projection renderer and application adapters |
| Offline assets | `web/build/offline-assets.ts`, `web/src/offline/register.ts`, `web/src/offline/worker.ts`, `web/vite.config.ts` | Build manifest, worker lifecycle, readiness |
| Tests | Colocated `*.test.ts(x)`, `tests/integration/character-creation-options.test.ts`, `web/tests/offline/*.spec.ts` | Unit, integration, production browser acceptance |

Task order: 1-3 contracts -> 4 store -> 5 session -> 6 browser identity/coordination -> 7 renderer -> 8 routes/creation -> 9 tools/recovery -> 10 offline assets -> 11 browser acceptance -> 12 closure. Backend prerequisite tasks can be reviewed independently, but later tasks must use their shipped contracts rather than mocks with divergent shapes.

## Shared Frontend Types

Task 3 creates `web/src/characters/types.ts`. Derive `CharacterView`, `CreationOptions`, `CommandResult`, `ActivityPage`, `MigrationPreview` and mutation bodies from `web/src/api/schema.d.ts` operation responses/requests, not backend imports. Define these local protocol types there:

```ts
export type EditIntent =
  | { kind: "setField"; fieldId: string; value: unknown }
  | { kind: "bumpResource"; resourceId: string; direction: "up" | "down" };
export type FrozenRequest = {
  method: "POST" | "PATCH";
  path: string;
  body: Record<string, unknown> & { idempotencyKey: string };
  firstAttemptAt: string;
};
export type QueueEntry = {
  id: string; actorId: string; characterId: string; sequence: number;
  baseRevision: number; packageChecksum: string; createdAt: string;
  intent: EditIntent;
  attempt: FrozenRequest | null;
};
export type SessionPhase =
  | "loading" | "ready" | "offline" | "sending" | "conflict"
  | "invalid" | "reauthenticate" | "uncertain" | "storage-error" | "purged";
```

Keep online-operation attempts separate from offline EditIntent; these store the same FrozenRequest but are only initiated while connected. This includes creation with no character ID yet. Never infer a server receipt from a local timestamp.

### Task 1: Completion Projection Without Breaking Replay

**Files:** Modify `src/systems/runtime.ts`, `src/systems/implementation/runtime/projection.ts`, `src/transport/http/characters.ts`; test `src/systems/runtime.test.ts`, `src/transport/http/characters.test.ts`, `tests/integration/characters.test.ts`; regenerate `docs/contracts/openapi-v1.json`, `web/src/api/schema.d.ts`.

**Interfaces:** Consumes CharacterProjectionV1 and existing resolve initialize/observe. Produces optional `completionFields?: Extract<CharacterProjectionElement, { kind: "field" }>[]`; fresh builders always emit an array.

- [ ] Add a runtime fixture with a required editable field omitted from all sheets, a represented required field, a computed field and an image field. Assert omitted editable fields remain in completion metadata after receiving a value; no duplicate represented/computed/image controls. Add old persisted create and command receipt fixtures with no property and spy that replay does not resolve again.

```ts
expect(projection.projectionVersion).toBe("1.0");
expect(projection.completionFields?.map(field => field.fieldId)).toEqual(["unlisted-name"]);
expect(replayed.projection).not.toHaveProperty("completionFields");
expect(resolveSpy).not.toHaveBeenCalled();
```

- [ ] Run red: `npx vitest run src/systems/runtime.test.ts src/transport/http/characters.test.ts` and `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npx vitest run tests/integration/characters.test.ts`. Expect missing completion metadata assertions, not receipt mutation.
- [ ] Implement using the existing field projection helper; gather bound definition IDs across the entity's sheets and project omitted required supported fields in definition order. Add an optional array to TypeBox. Reuse projected field schema rather than maintaining a second shape. Do not alter receipt loading or version literals.

```ts
const bound = new Set(entitySheets.flatMap(sheet => sheet.sections.flatMap(section =>
  section.elements.flatMap(element => element.kind === "field" ? [element.fieldId] : [])
)));
// Completion entries use the same field projection path as authored elements.
```

- [ ] Run the focused commands green, `npm run contracts:generate`, `npm run contracts:check`, `npm run typecheck` and `npm run web:typecheck`.
- [ ] Review the diff and commit intended files: `feat: project omitted required character fields`.

### Task 2: Authorized Creation Metadata

**Files:** Modify `src/systems/runtime.ts`, `src/characters/index.ts`, `src/transport/http/characters.ts`; create `tests/integration/character-creation-options.test.ts`; extend runtime/HTTP tests; regenerate contracts.

**Interfaces:** Add `SystemRuntime.describeVersion(input: { versionId: string }): Promise<RuntimeResult<{ versionId: string; packageChecksum: string; entities: { id: string; label: string }[] }>>`. Add a Characters facade `creationOptions(context, input: { systemVersionId: string })` with the same context/result convention as create. HTTP GET `/characters/creation-options?systemVersionId=...` returns its data through the existing response envelope.

- [ ] Write tests for authenticated permitted versions, missing/unpublished/inaccessible versions, corrupt packages and all reference entity IDs. Confirm no character, command receipt or roll row is created. Pin failure-before-describe for unauthorized callers.

```ts
expect(response.statusCode).toBe(200);
expect(response.json().data.entities).toEqual([{ id: "hero", label: "Hero" }]);
expect(afterCharacterCount).toBe(beforeCharacterCount);
expect(unauthorizedDescribeSpy).not.toHaveBeenCalled();
```

- [ ] Run red: `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npx vitest run tests/integration/character-creation-options.test.ts`.
- [ ] Implement describeVersion behind the runtime's package loader. Share the version-ID/corruption checks with resolve where necessary, without moving interpretation into Characters. Apply create's version authorization policy before describing; register the static route and schema. Update runtime fakes for the new method.

```ts
// The facade authorizes first; runtime returns display metadata, never a package.
const described = await runtime.describeVersion({ versionId: input.systemVersionId });
```

- [ ] Run integration and runtime/HTTP suites green; regenerate/check contracts and both typechecks.
- [ ] Review and commit: `feat: expose authorized character creation options`.

### Task 3: Sign-out and Character Transport

**Files:** Modify `src/transport/http/identity.ts`, `src/bootstrap/http.ts`, `src/transport/http/openapi.ts` if dependency construction requires it, `web/src/api/client.ts`; create `src/transport/http/identity.test.ts`, `web/src/characters/api.ts`, `types.ts`, `api.test.ts`; extend client tests and generated contracts.

**Interfaces:** `createCharactersApi(client: ApiClient)` exposes typed `open(characterId)`, `creationOptions(versionId)`, `activity(characterId, cursor)`, `send(request: FrozenRequest)`, `export(characterId)`, `previewMigration(characterId, body)`; route bodies/results follow generated operations. `POST /signout` returns 204, calls existing Identity.signOut and clears the session cookie. Extend ApiError with optional changedDefinitionIds, activityCursor, cacheDisposition and a representation retaining runtime diagnostics alongside existing authoring diagnostics.

- [ ] Test sign-out revokes the token and clears cookie flags; repeated anonymous sign-out is safe; cross-origin requests are rejected. Test API error retention for 401, 404 purge, 409 replace and 422 definition diagnostics, plus malformed-success uncertainty and authoring regression.

```ts
expect(error.cacheDisposition).toBe("purge");
expect(error.changedDefinitionIds).toEqual(["health"]);
expect(error.activityCursor).toBe("cursor-1");
expect(await identity.resolveSession(token)).toMatchObject({ state: "anonymous" });
```

- [ ] Run red with `npx vitest run src/transport/http/identity.test.ts` and `npm run web:test -- src/characters/api.test.ts`.
- [ ] Wire Identity and cookie configuration into buildIdentityRoutes without weakening auth middleware. Use an explicit same-origin policy; configure preview proxy forwarding consistently rather than trusting arbitrary forwarded headers. Transport send must forward the stored body unchanged and not mint an idempotency key.

```ts
send: (request: FrozenRequest) => client.fetch(request.method, request.path, {
  body: request.body,
})
```

- [ ] Run focused tests green, backend HTTP tests, web API tests, contracts generation/check and typechecks.
- [ ] Review and commit: `feat: add character transport and safe sign-out`.

### Task 4: Durable Character Store

**Files:** Create `web/src/characters/store.ts`, `store.test.ts`; modify web package/lock for test-only fake-indexeddb.

**Interfaces:** `openCharacterStore(name: string): Promise<CharacterStore>`. Store methods: `read(actorId, characterId)`, `enqueue(entry)`, `freeze(actorId, characterId, entryId, request)`, `acknowledge(actorId, characterId, entryId, character, generation)`, `purgeCharacter(actorId, characterId)`, `clearAccount(actorId)`, `close()`. Read returns `{ confirmed: CharacterView | null, entries: QueueEntry[], generation: number }`. Add explicitly typed online-attempt and identity-marker operations to the same adapter; they use account partitions and generation checks, not localStorage.

- [ ] Write database reopen, ordering, rollback, frozen-body immutability, acknowledgment atomicity, quota rejection and cross-account tests. Clear/purge must increment tombstone generation and reject late acknowledgment writes.

```ts
await store.freeze(actor, character, entry.id, request);
store.close();
const reopened = await openCharacterStore(databaseName);
expect((await reopened.read(actor, character)).entries[0]?.attempt).toEqual(request);
await reopened.clearAccount(actor);
await expect(reopened.acknowledge(actor, character, entry.id, view, oldGeneration)).rejects.toThrow();
```

- [ ] Run red: `npm run web:test -- src/characters/store.test.ts`.
- [ ] Implement account/character composite keys, sequence indexes and atomic write transactions. Persist the whole FrozenRequest; reject attempts to change it. Implement tombstones, last-account marker, pending logout barrier and account-scoped creation attempts. Never persist credentials or erase pending data during upgrades.

```ts
// No network await inside this transaction.
const tx = db.transaction(["characters", "queue", "generations"], "readwrite");
```

- [ ] Run focused tests green and `npm run web:typecheck`; test an aborted multi-store transaction leaves both snapshot and queue unchanged.
- [ ] Review and commit: `feat: persist character state and command attempts`.

### Task 5: Sequential Character Session

**Files:** Create `web/src/characters/session.ts`, `session.test.ts`, `testing.ts` (shared typed test fixtures only).

**Interfaces:** `createCharacterSession({ actorId, characterId, api, store, identity, coordination, now, newId }): CharacterSession`. Session exposes `open(): Promise<void>`, `getSnapshot()`, `subscribe(listener)`, `setField(fieldId,value)`, `bumpResource(resourceId,direction)`, `executeAction(actionId,inputs)`, `resolveConflict({ mode: "discard" | "reapply", selectedIds: string[] })`, `requestEditing()`, `dispose()`. Async commands resolve only after durable enqueue/attempt storage. Snapshot includes confirmed view, tentative values, entries, phase, editing ownership and structured blocking error. Define identity/coordination ports now; Task 6 implements them.

- [ ] Test the protocol with a controllable transport and real test store. Cover crash after send/before ack, own revision progression versus external drift, pure-roll unchanged revision, invalid pause, conflict reapply ordering, 401/404, expiry, storage failure and late responses. All send calls must find the same attempt already stored.

```ts
expect(sent[0]?.body).toEqual(sent[1]?.body); // lost response retries exact input/key
expect(sent[0]?.body.idempotencyKey).not.toBe(reapplied.body.idempotencyKey);
expect(session.getSnapshot().phase).toBe("conflict");
expect(sent).toHaveLength(1); // dependent command is not advanced past conflict
```

- [ ] Run red: `npm run web:test -- src/characters/session.test.ts`.
- [ ] Implement one serialized drain loop per session. Resolve frozen attempts before fresh GET drift checks. Freeze unsent intentions only against a checked base or this queue's own acknowledged revision. Use returned revisions. Persist success/retire atomically. Retry transient errors with bounded backoff; pause definitive errors. Do not coalesce resource steps or recompute rules.

```ts
await store.freeze(actorId, characterId, entry.id, frozen);
const result = await api.send(frozen);
await store.acknowledge(actorId, characterId, entry.id, result.character, generation);
```

- [ ] Run focused store/session tests green; verify online actions share immutable attempt handling but cannot be initiated offline. Include legacy projection refresh without losing pending edits.
- [ ] Review and commit: `feat: synchronize revision-safe character sessions`.

### Task 6: Account and Single-editor Browser Coordination

**Files:** Create `web/src/characters/identity.ts`, `identity.test.ts`, `coordination.ts`, `coordination.test.ts`, `useCharacterSession.ts`; modify `web/src/shell/AppShell.tsx`, `web/src/shell/DevSignInPanel.tsx` and shell tests.

**Interfaces:** Identity gate exposes `{ actorId: string | null, verified: boolean, generation: number, pendingLogout: boolean }`, subscribe, refresh and signOut. Coordination exposes acquire/requestTakeover/release/subscribe keyed by actor and character; session only edits/sends while it owns the Web Lock. Hook binds session getSnapshot/subscribe using useSyncExternalStore.

- [ ] Test `/me` real IDs replace synthetic dev identity, offline startup uses only the last confirmed account, sign-out clears/hides before network, pending logout precedes future `/me`, account switch blocks old requests and late writes, and unsupported Web Locks disables editing. Mock lock scheduling in unit tests; reserve actual contention proof for Task 11.

```ts
expect(api.send).not.toHaveBeenCalled(); // new account must not drain old account
expect(secondTab.getSnapshot().editing).toBe(false);
expect(storeReadAfterLogout.confirmed).toBeNull();
```

- [ ] Run red: `npm run web:test -- src/characters/identity.test.ts src/characters/coordination.test.ts src/shell/AppShell.test.tsx`.
- [ ] Implement browser locks without timeout stealing, BroadcastChannel invalidations/takeover, and auth generation checks before every send and writeback. A takeover quiesces the current session before release. A lost tab leaves its frozen attempt for the next owner. Pass actual identity through AuthProvider, retaining existing development sign-in capability.

```ts
await navigator.locks.request(`character:${actorId}:${characterId}`, async () => {
  await holdUntilReleased;
});
```

- [ ] Run tests green, all shell tests and `npm run web:typecheck`; assert BroadcastChannel close and subscriptions dispose on navigation.
- [ ] Review and commit: `feat: isolate offline characters by account and tab`.

### Task 7: Projection-driven Sheet Renderer

**Files:** Create `web/src/characters/CharacterSheet.tsx`, `FieldControl.tsx`, `characters.module.css`, corresponding tests; extend existing `web/src/i18n` catalogues.

**Interfaces:** CharacterSheet receives session snapshot plus callbacks, with no transport/storage/router imports. FieldControl receives a projected field, tentative value, disabled/pending flags and onCommit. Numeric input drafts are component-local; changes become queue intentions on valid commit. Use fieldId for shared values and element IDs for unique labels.

- [ ] Write RTL tests for all element kinds, sequential multiple sheets, required completion fields, duplicates, images unavailable, scalar validation drafts, pending/stale semantics and offline-disabled actions. Include focus/keyboard tests.

```tsx
await user.clear(screen.getByRole("spinbutton", { name: "Strength" }));
await user.type(screen.getByRole("spinbutton", { name: "Strength" }), "15");
await user.tab();
expect(onSetField).toHaveBeenCalledWith("strength", 15);
expect(screen.getByRole("button", { name: "Roll check" })).toBeDisabled();
```

- [ ] Run red: `npm run web:test -- src/characters/CharacterSheet.test.tsx src/characters/FieldControl.test.tsx`.
- [ ] Implement supported field controls, resource step buttons, headings, action forms/results and completion section in authored order. Use existing CSS tokens/dialog conventions and localized text. Do not predict derived values or action effects. Mark validation freshness while tentative values differ.

```tsx
<output aria-live="polite">{pending ? t("character.sync.pending") : t("character.sync.saved")}</output>
```

- [ ] Run focused tests green and all web tests/typecheck; assert no expression evaluator/package import in the new renderer.
- [ ] Review and commit: `feat: render playable character projections`.

### Task 8: Creation and Embeddable Routes

**Files:** Create `web/src/characters/CharacterRoute.tsx`, `CreateCharacter.tsx` and tests; modify `web/src/router.tsx`, shell entry links and published version surface.

**Interfaces:** `/characters/new` accepts optional `systemVersionId` search input; reads permitted metadata from Task 2. `/characters/$characterId` composes identity/store/session/renderer. CreateCharacter accepts API/store/identity and `onCreated(characterId)` callback; it does not own global router state.

- [ ] Test selected version/entity/name creation, denied metadata, online-only creation, double-click suppression and reload after uncertain create with identical body/key. Test required-field focus after navigation and preserved existing System Builder routes.

```ts
expect(firstCreate.body).toEqual(retriedCreate.body);
expect(onCreated).toHaveBeenCalledTimes(1);
expect(screen.getByRole("heading", { name: "Complete Your Character" })).toBeVisible();
```

- [ ] Run red: `npm run web:test -- src/characters/CreateCharacter.test.tsx src/characters/CharacterRoute.test.tsx`.
- [ ] Implement version ID/reference-template entry and entity selection from authorized metadata; no package export parsing. Persist creation attempts by account before send. Add route/session disposal and minimal locally cached-character recovery links; do not add I5 search/recent/library.

```tsx
<CharacterSheet snapshot={snapshot} onSetField={session.setField} onBump={session.bumpResource} />
```

- [ ] Run focused tests green, router/shell tests and web build. Verify deep-link parsing does not expose another account's cache.
- [ ] Review and commit: `feat: create and open standalone character sheets`.

### Task 9: Conflict Review and Character Tools

**Files:** Create `web/src/characters/ConflictReview.tsx`, `CharacterTools.tsx` and tests; extend session online-operation methods/types and tests; update i18n.

**Interfaces:** Add session `archive()`, `recover()`, `commitMigration(previewId)`, `rollbackMigration(migrationId)` using typed existing HTTP commands and durable online attempts. Tools use API activity/preview/export reads, but cannot bypass session mutation sequencing. ConflictReview submits selected queue IDs to resolveConflict.

- [ ] Test server-vs-local comparison for scalar sets and bump intentions, discard/reapply confirmation, repeated conflicts, uncertain-expiry warning, invalid correction, archive read-only behavior, cursor pagination and migration warnings/expired preview. Export must wait for zero pending edits and use the server document.

```ts
expect(exportButton).toBeDisabled(); // pending edit exists
expect(reapplyRequest.body.expectedRevision).toBe(latestRevision);
expect(reapplyRequest.body.idempotencyKey).not.toBe(conflictedKey);
```

- [ ] Run red: `npm run web:test -- src/characters/ConflictReview.test.tsx src/characters/CharacterTools.test.tsx src/characters/session.test.ts`.
- [ ] Implement secondary dialogs with focus restoration. Lifecycle/migration actions refresh confirmed state after the queue drains, freeze the attempt, then send. Export creates a browser download from the documented JSON envelope; clean up object URLs. Show last-fetched activity offline with freshness labeling. Do not add offline management intentions.

```ts
if (snapshot.entries.length > 0 || snapshot.phase !== "ready") return;
// Refresh and freeze before initiating the online-only operation.
```

- [ ] Run focused tests green and web tests/typecheck; include ambiguous archive/migration response replay and rollback limits.
- [ ] Review and commit: `feat: add character recovery and management tools`.

### Task 10: Production Offline Asset Loading

**Files:** Create `web/build/offline-assets.ts`, `web/src/offline/worker.ts`, `register.ts` and tests, `web/playwright.offline.config.ts`; modify `web/vite.config.ts`, web/root package scripts and character availability UI.

**Interfaces:** Build plugin emits `sw.js` and a complete versioned asset list. Register exposes readiness/build ID and update status. Character Available offline requires a compatible durable snapshot plus confirmed controlling-worker cache readiness. Add root `web:test:offline` delegating to the new production-browser config.

- [ ] Test asset manifest includes entry HTML and every lazy chunk/CSS/font dependency; excludes sourcemaps/API/export bodies. Test request routing excludes `/api`, `/dev` and unknown document paths. Test cache installation failure does not report ready.

```ts
expect(shouldHandle(new URL("https://app.test/api/characters/one"), "navigate")).toBe(false);
expect(manifest.assets).toContain("/index.html");
expect(offlineReady({ workerReady: false, snapshotStored: true })).toBe(false);
```

- [ ] Run red: `npm run web:test -- src/offline` and `npm run web:build` with manifest assertions in the plugin test.
- [ ] Implement an asset-only service worker, transactional cache install, known-route shell fallback and non-forced update lifecycle. Build worker separately so it has no DOM-only dependencies. Register only production builds. Configure Vite preview same-origin API forwarding and SPA fallback for production E2E; preserve existing dev E2E config. Exclude `tests/offline/**` from web Vitest discovery.

```ts
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
}
```

- [ ] Run tests/build green; inspect built worker and generated asset list. Add one production smoke test verifying worker control and deep-link reload with cached assets. No install manifest/prompts.
- [ ] Review and commit: `feat: reopen cached character sheets fully offline`.

### Task 11: Real Browser Offline and Tab Acceptance

**Files:** Create `web/tests/offline/character.spec.ts`, `coordination.spec.ts`, `privacy.spec.ts`, `update.spec.ts`; add character responsive/a11y cases under `web/tests/e2e`; reuse reference fixtures; adjust test-only production authentication fixture without enabling dev sign-in in the production UI.

**Interfaces:** Production config starts built web assets plus test-auth backend. Authenticate browser contexts through the existing test identity endpoint/adapter fixture, not a production synthetic user. Use same browser context for close/reopen persistence; use separate contexts for independent users.

- [ ] Write the full spec acceptance at 360 px and parameterize all reference systems; assert final persisted revision/activity/resource values. Add two pages contending for a real Web Lock, takeover with lost response, offline sign-out barrier, account switching, revoked access purge, storage rejection and worker-update tests. Record screenshots at 360/1280 and axe checks.

```ts
await expect(page.getByText("Available offline", { exact: true })).toBeVisible();
await context.setOffline(true);
await page.getByRole("button", { name: "Decrease Health" }).click();
await expect(page.getByText("Pending", { exact: true })).toBeVisible();
const deepLink = page.url();
await page.close();
const reopened = await context.newPage();
await reopened.goto(deepLink);
await expect(reopened.getByRole("heading", { name: characterName })).toBeVisible();
await context.setOffline(false);
// Verify exactly one resource effect through API/DB, including a lost-response retry.
```

- [ ] Run red against real infrastructure: `DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll AUTHORITATIVE_ROLL_SECRET=development-only-roll-secret-32-bytes npm run web:test:offline`.
- [ ] Fix only defects exposed by these agreed scenarios; add focused regression tests before production corrections. Test an actual second build waiting/activating with pending edits, not only a mocked update event. Verify all sensitive URLs are absent from CacheStorage.

```ts
expect(cachedRequests.every(url => !new URL(url).pathname.startsWith("/api/"))).toBe(true);
expect(appliedBumpCount).toBe(1);
expect(secondPageEditingEnabled).toBe(false);
```

- [ ] Run production offline suite, existing browser suite and full web tests/build green. Verify keyboard flows and absence of horizontal overflow at both widths.
- [ ] Review and commit: `test: verify offline character play and recovery`.

### Task 12: I4 Closure and Reconciliation

**Files:** Create `docs/acceptance/i4-2026-09-06.md`; modify `design_v2.md`, this plan and the spec status. Preserve recorded task/review evidence in `.superpowers` without committing it.

**Interfaces:** Consumes passing Tasks 1-11. Produces recorded acceptance and an accurate I4 status; I5 remains untouched.

- [x] Run the complete verification commands below with unfiltered exit status; do not pipe through truncators that hide failures. If running from a repo containing nested worktrees, exclude `.worktrees/**` from Vitest or run in the isolated worktree. Inspect DB cleanup before repeating browser tests.

```bash
npm test
TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npm run test:integration
npm run typecheck
npm run build
npm run contracts:check
npm run web:test
npm run web:typecheck
npm run web:build
DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll AUTHORITATIVE_ROLL_SECRET=development-only-roll-secret-32-bytes npm run web:test:e2e
DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll AUTHORITATIVE_ROLL_SECRET=development-only-roll-secret-32-bytes npm run web:test:offline
```

- [x] Record the exact tested commit/tree, commands, counts, production asset/offline proof, final DB effects and browser support limitations. If evidence predates the closure commit, state that precisely instead of inventing a tested SHA. Do not claim offline persistence is guaranteed against browser eviction.
- [x] Reconcile every requirement to a test/task. Mark I4 closed only if the full acceptance and regression suite pass. Keep historical I3 receipt compatibility explicitly covered.
- [x] Run `git diff --check`, inspect staged/intended changes, and review the closure record for unsupported claims.
- [x] Commit the closure artifacts: `docs: close I4 character sheet frontend`.

> **I4 closed 2026-09-07.** Full verification green on tested commit `be69809`
> (tree `87e80e0`): backend unit 269/269, integration 122/122, web unit 484/484,
> E2E 19/19, production-offline 13/13; typechecks, build, contracts check pass.
> Acceptance: `docs/acceptance/i4-2026-09-06.md`. I5 untouched.

## Plan Self-review

Coverage: backend completion and creation metadata (1-2); sign-out/transport (3); persistence and immutable retry (4-5); identity/tab isolation (6); renderer/accessibility (7); creation/routes (8); conflict/activity/lifecycle/export/migration (9); offline assets/build lifecycle (10); real browser/privacy/worker/visual proof (11); full regression and honest status (12).

Dependency checks: Task 3 owns generated wire/local protocol types; Task 4 owns store transactions; Task 5 owns the observable session and browser ports; Task 6 supplies port implementations; UI tasks cannot introduce competing mutation senders. Task 10 is required before Task 11 can claim fully offline reopening. Historical receipt support cannot be deferred to frontend normalization that mutates replayed results.

Implementation is not authorized by this document alone. Recommended execution is fresh implementer/reviewer agents task by task in an isolated worktree, with Critical/Important findings fixed before advancement. The user has waived repeated design confirmation prompts; do not reinterpret that as permission to push, merge, or expand into I5.
