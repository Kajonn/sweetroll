# I4 Character Sheet Frontend

Date: 2026-09-06
Status: I4 reclosed 2026-09-07 (Task 9) on tested commit `8b9f40d` with complete routed-workflow evidence (`docs/acceptance/i4-2026-09-06.md` Reclosure section). Previously reopened 2026-09-07 after the `be69809` closure was found not to prove the full routed workflow; remediation completed under `docs/superpowers/plans/2026-09-07-i4-completion-remediation.md`. Scope unchanged; I5 untouched.

## Goal and Scope

Deliver the reusable character play surface described by `design_v2.md` section 17.6, consuming Characters projections rather than interpreting published packages. I3 is merged at `62a482f`. Preserve the existing System Builder and visual language, React 18, TanStack Router/Query, CSS modules, and i18n conventions.

I4 includes online creation, required-field completion, field editing, direct resource bumps, online actions/results, activity, archive/recovery, authoritative export, migration preview/commit/rollback, durable offline edits, conflict recovery, single-editor tab coordination, and fully offline reopening of previously opened characters.

Exclude the I5 personal library/search, onboarding/profile, install prompts, manifest/standalone presentation and Player navigation. Also exclude campaign/GM policy, ownership-transfer UI, image uploads, independent browser rule evaluation, background synchronization workers, general-purpose sync frameworks, and new resource-set commands. Direct numeric entry applies to integer/decimal fields; resource controls use existing up/down commands.

## Approved Decisions

- Offline writes are field sets and direct resource bumps only. Actions, creation, archive/recovery, migration and authoritative export require connectivity.
- Conflicts pause only the affected character. No silent merge, rebasing against unrelated server changes, or advancing past rejected commands.
- The user can discard pending intentions or explicitly reapply selected intentions with new keys after reviewing current state.
- Cached reads and queues survive reload/browser restart in account-partitioned IndexedDB.
- Fully offline reopening requires a minimal application-asset service worker in I4; installation remains I5.
- One tab per character may edit and synchronize at a time. Other tabs are read-only and can request takeover.
- Extend the backend projection for required fields omitted from authored sheets.

## Architecture

Use a character-specific session module, not the existing whole-document draft-sync hook and not a general offline framework.

The session exposes an observable view and commands: open, subscribe, setField, bumpResource, executeAction, resolveConflict, requestEditing, and dispose. The view includes the confirmed character, tentative overlay, pending command summaries, validation freshness, connectivity/auth/storage status, editing ownership and blocking error. React binds to it using a subscription hook; it does not independently send mutations.

The session owns sequencing, persistence, immutable attempts and reconciliation. Its dependencies are a typed Characters transport, durable store, identity gate, clock/ID source and browser coordination. Keep the browser adapters separate enough to test the protocol without React. Do not duplicate confirmed writable state in TanStack Query: it may own read-only catalogue/activity queries, while the session is the sole character mutation authority.

The renderer consumes the projected view and callbacks. It imports no API client, IndexedDB, auth, router or expression evaluator. A route adapter supplies character ID, API/session identity and navigation callbacks, allowing later Player/GM embedding without a second renderer.

## Contract Prerequisites

### Completion metadata

Add optional `completionFields` to projection 1.0. Newly built projections always emit the array; historical 30-day persisted receipts can omit it. Entries reuse the projected editable field shape and include required supported fields absent from every sheet for the entity. Use definition IDs for deduplication and stable entity-definition order. Include these fields even after completion so users can revisit values. Do not include computed or unsupported image fields as editable controls; keep their diagnostics visible.

Do not rewrite historical receipts, recompute their outcomes or rerun runtime resolution during replay. An absent array means metadata unavailable, not no missing fields. Online clients request a fresh GET for metadata; offline clients show a completion-metadata-unavailable notice. Preserve pending attempts while refreshing. Update runtime types/builder, HTTP schemas, generated contracts and tests together. The additive 1.0 field does not change reconciliation literals or ETags; the client must not infer metadata availability from ETag equality.

### Creation metadata

Add `GET /characters/creation-options?systemVersionId=...` through Characters, using the same authorization/version-availability policy as create. Return immutable version identity/checksum and selectable entity IDs/labels. Keep package inspection inside SystemRuntime with a read-only `describeVersion({ versionId })` method returning `RuntimeResult<{ versionId, packageChecksum, entities: { id, label }[] }>`; no mutable character or idempotency receipt is created. Register the static route before the dynamic character route.

The minimal create route accepts a version ID from a published System Builder version or reference-template choice; it is not a public system catalogue. A user may also enter a version ID, but receives no metadata without authorization. Metadata is informational; create rechecks authorization and availability. Unsupported/inaccessible versions produce the same generic inaccessible response as create. Cached metadata never authorizes creation offline.

### Identity and transport

Use `/me` for real identity; remove synthetic authenticated user IDs from the character integration path. Expose the existing Identity `signOut` operation via `POST /signout`, revoke the session and clear the cookie with the existing cookie policy. Document/register/test the route and require a same-origin request (validate Origin against the request origin under the deployment's trusted proxy policy); do not add an account-management subsystem.

Extend ApiError to retain Characters reconciliation/error fields and runtime diagnostics without breaking authoring consumers. A transport failure or malformed successful response is an uncertain mutation outcome, not permission to issue a fresh key. Keep body-field `idempotencyKey` and server-side authorization unchanged.

## Routes and Presentation

Add `/characters/new` and `/characters/$characterId`, preserving existing routes. Provide a small entry link from the current shell and published-version surface. The offline fallback can list locally available character links only; this is recovery navigation, not I5 search/library.

Create online by selecting a published version, choosing an entity from creation metadata, entering a name, and submitting once with a persisted request/key. Retry an uncertain creation with the identical request. Open the resulting incomplete character and focus its completion guidance. Required diagnostics do not prevent saving an otherwise valid incomplete character.

Render all authored sheets sequentially, each with its label and ordered sections/elements. No creator-defined tabs. Use a single readable column at 360 and 1280 px. The character header shows name, pinned version, lifecycle, sync state and availability offline. A completion section renders omitted required fields with the same controls as authored fields.

Use labeled inputs for supported scalars and choices; numeric drafts remain local until valid submission/blur. Resource buttons retain individual up/down intentions; never collapse a sequence into a delta or arbitrary set. Repeated field controls for one definition share the tentative value. Disabled/offline actions explain why. Results show expression, total, audience and expandable dice/modifier details without automatically applying outcomes.

Secondary dialogs/panels provide activity pagination, archive/recovery, export and migration. These mutations wait for the local queue to drain and confirmed state to refresh; archived sheets are read-only until recovered. Migration displays server warnings and candidate state, requires explicit confirmation and re-previews after stale/expired responses. Rollback obeys existing backend limits. Export is the server document, not a tentative overlay; block it while pending changes exist. Activity can show the last fetched page offline, labeled stale.

Follow existing tokens, typography and i18n. All controls work by keyboard; dialogs trap/restore focus, errors associate with fields, busy/live announcements avoid announcing every render, and touch controls remain usable at 360 px. Do not require a new aesthetic or React upgrade.

## Durable State and Queue

Use native IndexedDB through a small character store adapter. Version its schema independently from projection version. Store account identity, versioned confirmed snapshots, account-scoped immutable version metadata, ordered per-character intentions, frozen attempts, and narrowly scoped pending online-operation receipts (including creation). Do not store authentication tokens or cookies. Test the adapter with fake-indexeddb as a development-only dependency and real browser persistence tests.

A queued intention records its ID, actor ID, character ID, local sequence, kind/payload, base revision/checksum and creation time. An attempted record additionally contains the exact request body/key and first-attempt time. Retain an account-partitioned last-account marker only after a confirmed authenticated `/me` response; it is a local cache identity, not proof of live server authorization.

Persist an intention before displaying it as queued. In one IndexedDB transaction, persist the exact frozen attempt before making the network call. On success, atomically replace confirmed state, record acknowledgment and retire that attempt. If the browser crashes before acknowledgment persistence, retry the stored attempt. Never keep an IndexedDB transaction open across a network call.

Unsent intentions initially share the last confirmed server base. Before the first send after reconnect, validate identity and refresh server state. If revision or package pin differs from the queue's confirmed base, pause for conflict review; do not quietly assign the newer revision. Otherwise send in local order. After this queue's own success, assign its returned revision to the next unsent intention. This is sequencing local work, not rebasing across external changes. Pure rolls may not advance revision, so use returned values, not arithmetic. External races still produce backend conflicts.

Retry attempted commands before any fresh-state decision can reinterpret them: a request may already have succeeded. Exact input/key replay resolves that uncertainty. Fresh GET snapshots must not cause the client to discard or mutate an uncertain attempt. Block newer commands until the old outcome is resolved.

Do not coalesce queued commands in I4. Compute tentative display values by applying the unsent/pending field intentions and bounded resource steps over the confirmed snapshot; these are estimates, not rule evaluation. Keep bounds, derived values and validations marked as last-confirmed because authored rules can change their effective values. Server responses always replace the authoritative base.

## Errors and Explicit Recovery

- Network errors, malformed responses and timeouts: retain immutable attempts and retry with bounded exponential backoff/jitter while authenticated and connected. Connectivity events are hints; successful API requests establish reachability.
- `command_in_progress` and `temporarily_unavailable`: retain attempt, back off, do not advance. An unexpected 500 pauses with retry guidance and the same key.
- Revision conflict: keep a review copy of local intentions, fetch latest state, pause the character. Show server value versus intended value or bump direction. Only explicit reapply creates new keys; preserve selected order. A new conflict pauses again.
- Definitive invalid value: pause and let the user correct/discard it. A corrected command has a new key. Explain dependent queued changes before discarding the failed intention.
- `idempotency_mismatch`: stop as a protocol error; never automatically repair with a new key.
- Unauthenticated: retain data/attempts, pause network work and request reauthentication. Resuming requires the same account.
- Inaccessible character or `cacheDisposition: purge`: delete its snapshot, queued intentions, attempts and cached activity across tabs; do not expose their contents in the error UI.
- Replay-window expiry or uncertain attempts older than 30 days: no automatic new-key retry. Fetch current state and require manual review. Age does not prove whether the server applied an effect.
- Storage failure: do not mark the edit saved/queued, block further mutations needing persistence, and explain recovery. Never evict pending writes automatically to make room.

Discarding an uncertain attempted command is not equivalent to cancellation on the server. Resolve its outcome before ordinary conflict recovery; if expiry prevents resolution, show this limitation and require manual review. Online actions/lifecycle/migration use the same durable immutable-attempt mechanism once submitted, but cannot be newly initiated offline. Their lost responses must also be replay-safe.

## Identity, Sign-out and Offline Privacy

On online startup resolve `/me` before exposing a private cache or sending commands. On a genuinely offline startup allow reopening only the last confirmed local account's cache, labeled offline/session unverified. Never invent a new identity on fetch failure. This is device-local privacy, not encryption against someone with access to the browser profile.

On session expiry retain same-account data for reauthentication, but stop all mutation traffic. Account change closes the old session and hides its data; no old-account attempt may be sent using the new session. Broadcast identity changes and gate every send against the current identity generation.

Explicit sign-out warns about unsynchronized edits, clears that account's cache/queue and the last-account marker, and hides data in every tab before navigation. Online sign-out also revokes the cookie session. Offline sign-out clears local data immediately and records a non-sensitive pending logout barrier; on reconnect perform server sign-out before `/me` can silently restore the prior account. Clearly distinguish local sign-out from completed server revocation. Browser-level asset caches contain no private data and need not be deleted per account.

Do not claim offline knowledge of access revocation. Detect and purge it at the next authorized server response. Browser storage may be evicted; show availability as best-effort and offer recaching online, never promise indefinite durability.

## Multi-tab Coordination

Use a Web Lock scoped to actor/character for the entire editing/synchronization ownership period. Use BroadcastChannel for invalidation/status/takeover requests, not authoritative queue data. The store remains authoritative. Only the lock holder can accept edits or send attempts; other tabs view stored confirmed/pending state read-only.

Takeover requests require the current owner to stop accepting edits, finish handling any active request (or leave its exact frozen attempt durable), flush state, and release. A new owner reloads the store and resolves any attempt first. Tab termination releases the browser lock; the frozen request survives. Do not implement timeout-based lock stealing that permits two senders. A hung owner can be closed by the user. Where Web Locks are unsupported, remain read-only with an explanation rather than offer unsafe editing.

Sign-out/access purge uses an identity-generation/tombstone check in storage so an in-flight response cannot repopulate cleared private data. Late responses from a disposed session are ignored; browser fetch cancellation alone is not proof of server cancellation.

## Fully Offline Application Loading

Build a minimal service worker and asset manifest as part of the Vite production build, covering entry HTML, hashed JS/CSS and all required lazy chunks/fonts/icons. Do not cache Vite dev modules. Offline tests use a production build/preview, not the existing dev-server E2E setup.

Cache only same-origin build assets and navigation shell documents for supported application routes. Never intercept/cache `/api`, `/dev`, identity responses, exports or private response bodies. API requests remain network-only; private snapshots use the account-aware store.

Install a complete versioned asset cache before claiming readiness. Mark a character Available offline only after its compatible projection is committed and the controlling worker confirms its build cache. Navigation requests can fall back to the cached shell for known routes. Unknown paths must not disguise API failures as HTML.

Do not force a new worker with skipWaiting during active sessions. Let normal worker lifecycle keep open clients on a coherent build; activate updates after old clients close. Remove obsolete asset caches only when no old build clients require them. New clients migrate IndexedDB transactionally, preserve frozen attempts and fail read-only on unsupported/corrupt versions rather than deleting pending edits. Test an update while writes are queued.

Production serving must support same-origin `/api` forwarding and SPA navigation fallback. The Vite development proxy is not a production deployment configuration. Provide an explicit preview-test configuration with the same forwarding; no public deployment or hosting platform is added by I4. Development and preview proxies forward `/api` and `/dev` without rewriting the Host header so the backend's same-origin check compares the browser Origin against the host the browser actually used; deployments that rewrite the Host header explicitly allow additional origins via the `ALLOWED_ORIGINS` configuration list.

## Verification and Acceptance

Backend tests cover creation metadata authorization and runtime isolation, omitted required fields, deduplication, fresh completion arrays, historical create/command receipts without completion metadata, sign-out revocation/cookies/origin handling and generated contracts.

Session tests cover durable-before-send, immutable retries, crash points before/after HTTP success, conditional revision advancement, reconnect drift, validation/conflict pauses, selected reapply, uncertain expiry, 401/404 purge, storage failure, identity switching and late-response tombstones. Store tests reopen the database and verify transaction rollback. Browser tests prove real Web Locks/tab takeover and IndexedDB/service-worker behavior; mocks alone cannot close these requirements.

Component tests cover every projected element, completion fields, duplicate bindings, input drafts, tentative/stale annotations, dialogs, keyboard/focus, accessible errors, offline actions, archive/export/migration gates and all three reference systems.

Production-browser acceptance at 360 px: create from a published reference version, fill required values, edit/bump/roll online, wait for offline-ready, go offline, queue edits, close the page, reopen the deep link in the same browser profile offline, verify queue/state, reconnect without duplicate bumps, simulate a concurrent revision, explicitly resolve, and export final confirmed state. Assert persisted DB revision/activity effects, not just UI text.

Also test a cold missing-cache visit, two tabs and takeover during an uncertain request, real sign-out/account isolation, access purge after offline use, worker update with pending edits, and failures to store/cache. Cover reference d20, PbtA 2d6 and d6 pool at 360 and 1280 px with accessibility and responsive screenshots. Keep existing System Builder tests green.

Run backend unit/integration, typecheck/build/contracts checks, web unit/typecheck/build, existing E2E and new production-offline E2E. Record exact commands, tested commit, pass counts, browser capabilities and limitations in `docs/acceptance/i4-2026-09-06.md` at closure. Do not claim an acceptance run before it happens.

## Self-review

The approved offline and conflict policies are consistent with I3's ordinary-command replay contract. Persisted receipts justify the optional additive projection field. Creation metadata and sign-out wiring are explicit prerequisites, not hidden frontend scope. Asset caching is the approved I4 exception to the I5 PWA boundary. No browser runtime, automatic conflict merge, arbitrary resource set or background command executor is introduced. Implementation must verify the complete test matrix before marking I4 closed.
