# Character Backend - Design (I3)

**Status:** Approved for implementation

## 1. Purpose

Implement I3 from `design_v2.md` section 17.5: a standalone character backend pinned to immutable system versions. Through the documented HTTP interface, an authenticated owner can create, read, edit, operate, archive, recover, transfer, export, and explicitly migrate a character. Commands are revision-safe, idempotent, auditable, and suitable for offline replay.

I3 also completes the currently-placeholder `SystemRuntime` Module. Characters delegates every package-dependent operation to `SystemRuntime.resolve`; callers never interpret packages, evaluate expressions, apply runtime patches, or construct render projections.

## 2. Scope

### In scope

- Production `SystemRuntime` for `initialize`, `observe`, `set`, `bump`, and `action` intents.
- Runtime character state decoding, defaults, derived values, authored validations, bounds, deterministic dice, and versioned render projections.
- Standalone characters with exactly one transferable owner and fixed `owner_only` visibility.
- Exact system-version pinning and an explicit entity definition ID at creation.
- Revision-controlled JSONB state, lifecycle, activity, audit, rolls, and idempotency records.
- Atomic field set, resource bump, and action commands.
- Synchronous, documented character JSON export without account data.
- Compatible and explicitly mapped migration preview, commit, and bounded rollback.
- Offline reconciliation metadata using ordinary reads and idempotent command responses.
- PostgreSQL integration, concurrency, authorization, load, HTTP contract, and acceptance tests across all three reference systems.
- A targeted authoring correction that permits acknowledged breaking system publication so mapped migration targets can exist.

### Out of scope

- Campaigns, memberships, GM policy, shared ownership, character assignment, invitations, or campaign roll audiences.
- Player web or PWA interfaces, local caches, background sync, service workers, and client-side conflict UX. These belong to I4 and I5.
- Portrait/image upload and object storage. Image fields remain null-only; file handling remains deferred by `design_v2.md` section 7.6.
- Creator-authored migration scripts, automatic migration on publication, or implicit version upgrades.
- Auto-applying roll outcomes. A roll reports an authoritative result but does not mutate character state.
- Event sourcing, a general command bus, a message broker, an outbox, or a worker.

## 3. Core decisions

### 3.1 Two deep Modules

`SystemRuntime` owns package interpretation. `Characters` owns character workflows and persistence. Their Interfaces are the test surfaces.

- `SystemRuntime` is side-effect-free except for loading an immutable published package. It accepts a complete state plus one intent and returns a complete resolution.
- `Characters` hides authorization, version access, optimistic concurrency, idempotency, transaction ordering, runtime coordination, activity, audit, export, and migration.
- The HTTP Adapter decodes one request, calls one Characters method, and maps the result. It never coordinates repository and runtime calls.

### 3.2 Mutable current state, explicit snapshots

`characters` stores one current JSONB state and monotonic revision. This matches the design's relational selectors plus revision-controlled JSONB state. Migration records retain explicit before/after snapshots for rollback. A complete immutable revision ledger is rejected because it adds storage and head-pointer complexity without an I3 requirement to retrieve arbitrary historical states.

### 3.3 One standalone owner

I3 uses one `owner_id` on `characters`. Ownership transfer atomically replaces it. Multiple owners, GM ownership, campaign policy, and assignment are introduced in I6, where their behavior exists.

### 3.4 Ordinary commands are the offline protocol

Queued clients replay the same command with the same idempotency key and expected revision. Responses include reconciliation metadata. I3 does not add a separate batch mutation protocol; I4 can queue and sequence ordinary commands.

### 3.5 Breaking versions may be published deliberately

Current authoring rejects every breaking package comparison, which makes mapped character migration unreachable. I3 changes publication so an acknowledged breaking release can be published with a major semantic-version increment and stored compatibility findings. Existing pinned characters remain unchanged.

The publish command adds `acknowledgeBreaking: boolean`. When compatibility findings are breaking, publication requires `acknowledgeBreaking: true` and a semantic-version major greater than the latest version's major. Otherwise it returns the existing machine-readable findings without publishing.

## 4. SystemRuntime Module

### 4.1 Interface

```ts
export interface SystemRuntime {
  resolve(input: RuntimeRequest): Promise<Result<RuntimeResolution>>;
}

export type RuntimeRequest = {
  versionId: VersionId;
  entityId: DefinitionId;
  state?: RuntimeStateV1;
  intent:
    | { kind: "initialize"; values?: Record<DefinitionId, unknown> }
    | { kind: "observe" }
    | { kind: "set"; fieldId: DefinitionId; value: unknown }
    | { kind: "bump"; resourceId: DefinitionId; direction: "up" | "down" }
    | {
        kind: "action";
        actionId: DefinitionId;
        inputs: Record<DefinitionId, unknown>;
        executionId: CommandExecutionId;
      };
};

export type RuntimeStateV1 = {
  schemaVersion: "1.0";
  values: Record<DefinitionId, RuntimeStoredValue>;
};

export type RuntimeResolution = {
  versionId: VersionId;
  packageChecksum: string;
  state: RuntimeStateV1;
  derivedValues: Record<DefinitionId, RuntimeScalar>;
  validations: RuntimeValidation[];
  changedDefinitionIds: DefinitionId[];
  roll: NormalizedRoll | null;
  projection: CharacterProjectionV1;
};
```

`RuntimeResolution` is complete, not a patch. Consumers store `state` and return `projection`; they do not duplicate runtime semantics.

### 4.2 Intent behavior

| Intent | Required input state | Behavior |
|---|---|---|
| `initialize` | absent | Apply defaults plus supplied create/migration values, validate, derive, and project. |
| `observe` | present | Validate and project without mutation. |
| `set` | present | Replace one editable field after schema and constraint validation. |
| `bump` | present | Apply the package-defined resource step and enforce current/max bounds. |
| `action` | present | Validate inputs and execute a roll or package action; roll outcomes do not change state. |

Stored state contains editable values only. Computed values remain derived output. Unknown definition IDs, computed-field writes, wrong types, non-finite numbers, invalid choices, invalid resources, and breached package constraints return stable runtime errors; runtime never silently repairs persisted state.

I3 initializes image fields to `null` and rejects non-null image writes with `unsupported_field_value`. Uploads and durable object references remain deferred; this still validates the image field's nullable state shape without inventing an external URL or object-storage contract.

Authored validation diagnostics describe character validity but do not block storage unless a structural field constraint fails. This permits intentionally incomplete newly-created characters while surfacing required-field feedback.

### 4.3 Package and expression semantics

- Creation requires an explicit entity ID; runtime never guesses a `character` entity.
- Production loads `system_versions.package_json` through a private published-package loader and verifies schema plus checksum before use.
- Resource expression bindings expose the resource's current value. Maximum remains available only through an explicit supported binding if the package contract defines one.
- Derived fields are evaluated in compiled dependency order before authored validations.
- Runtime enforces package effective limits and returns `budget_exceeded` without partial output.
- `multiChoice` values are arrays of valid option IDs, not text.
- Action inputs are scoped to their action; expressions cannot bind inputs from another action or fields from another entity.

### 4.4 Authoritative rolls

`NormalizedRoll` contains action ID, normalized expression, ordered dice, field/input binding trace, total, and rendered output. "Modifiers" means the ordered scalar bindings consumed by the expression; it does not claim every expression is additive.

The runtime factory receives an authoritative roll secret. It derives an RNG stream from `HMAC(secret, executionId)`. No production action may reach the evaluator's `Math.random` default. Reusing an execution ID yields the same dice; different IDs yield independent streams.

### 4.5 Versioned projection

`CharacterProjectionV1` contains package/version identity, entity identity, ordered sheet sections, field/resource values and constraints, action input descriptions, derived values, and validation annotations. It exposes no package AST, compiled expression, or implementation-specific node.

## 5. Characters Module

### 5.1 Interface

```ts
export interface Characters {
  create(ctx: RequestContext, input: CreateCharacter): Promise<Result<CharacterView>>;
  list(ctx: RequestContext, input: ListCharacters): Promise<Result<CharacterPage>>;
  open(ctx: RequestContext, characterId: CharacterId): Promise<Result<CharacterView>>;

  apply(ctx: RequestContext, input: CharacterCommand): Promise<Result<CharacterCommandResult>>;
  manage(ctx: RequestContext, input: CharacterManagementCommand): Promise<Result<CharacterCommandResult>>;

  listActivity(ctx: RequestContext, input: ListCharacterActivity): Promise<Result<CharacterActivityPage>>;
  exportCharacter(ctx: RequestContext, input: ExportCharacter): Promise<Result<CharacterExportV1>>;

  previewMigration(ctx: RequestContext, input: PreviewCharacterMigration): Promise<Result<CharacterMigrationPreview>>;
  commitMigration(ctx: RequestContext, input: CommitCharacterMigration): Promise<Result<CharacterCommandResult>>;
  rollbackMigration(ctx: RequestContext, input: RollbackCharacterMigration): Promise<Result<CharacterCommandResult>>;
}
```

`CharacterCommand` is a discriminated union for `setField`, `bumpResource`, and `executeAction`; these share one workflow because authorization, receipt handling, runtime resolution, concurrency, persistence, and reconciliation are identical. `CharacterManagementCommand` covers rename, ownership transfer, archive, and recover.

The Module factory accepts a PostgreSQL pool, `SystemRuntime`, clock, ID generator, and command execution-ID generator. It does not expose a public character repository or transaction protocol.

### 5.2 Authorization

- Only the current owner may list, open, mutate, transfer, archive, recover, export, or migrate a standalone character.
- Missing and inaccessible resources both return `not_found`.
- Standalone visibility and roll audience are fixed to `owner_only`.
- Transfer verifies the destination user exists, atomically replaces `owner_id`, increments revision, and immediately revokes the previous owner.
- A successful transfer response remains replayable by the previous owner because actor-scoped idempotency lookup precedes current-owner authorization.
- Archived characters remain readable and exportable but reject play commands until recovered.

### 5.3 Version access

Creation and migration use a narrow `SystemAuthoring.authorizeVersionUse(ctx, versionId)` workflow. It returns only version/system identity and checksum when the actor may instantiate the published version; it never exposes package JSON. Continued use of an already-pinned character does not re-check the version's current library visibility; ownership of the character grants continued runtime use of that immutable version.

## 6. Persistence

Add migration `0009_create_characters.sql` with these tables.

### `characters`

- `id uuid primary key`
- `owner_id uuid not null references users(id) on delete restrict`
- `system_version_id uuid not null references system_versions(id) on delete restrict`
- `entity_definition_id text not null`
- `name text not null`
- `revision integer not null check (revision >= 1)`
- `state_json jsonb not null`
- `visibility text not null check (visibility = 'owner_only')`
- `lifecycle text not null check (lifecycle in ('active', 'archived'))`
- `archived_at timestamptz null`
- `created_at`, `updated_at`

Index `(owner_id, lifecycle, updated_at desc, id desc)` supports stable cursor pagination. The system-version foreign key prevents deleting pinned versions.

### `character_command_executions`

- Actor ID, command kind, idempotency key, canonical input hash.
- Optional character ID and preallocated resource/result IDs.
- Server-generated deterministic execution ID.
- `pending` or `completed` status, lease timestamps, serialized result, creation and expiry.
- Unique `(actor_id, command_kind, idempotency_key)`.

This table is character-specific rather than reusing authoring receipts. It coordinates pending commands, deterministic rolls, ambiguous commit replay, and atomic completion. Completed executions are retained for 30 days; command responses include `replayExpiresAt`, and clients must not replay after it. Pending leases expire after 60 seconds and are safely reclaimable with the same execution ID.

### `character_rolls`

Stores immutable character, actor, action, execution ID, normalized expression, dice JSON, binding/modifier JSON, total, rendered output, owner-only audience, request ID, and timestamp. Execution ID is unique.

### `character_activity_events`

Stores owner-visible meaningful events with character revision, kind, minimized payload, optional roll ID, request ID, and timestamp. Index `(character_id, occurred_at desc, id desc)` supports stable cursor pagination.

### `character_audit_records`

Stores security and lifecycle events: create, transfer, archive/recover, migration preview/commit/rollback, and export. Summaries exclude state values and account data.

### `character_migration_previews`

Stores character/source revision, source/target version IDs and checksums, mapping input, candidate state, projection, warnings, preview checksum, owner, created/expiry timestamps, and consumed state. Previews expire after 24 hours.

### `character_migrations`

Stores preview ID, source/target versions, before/after state snapshots, commit revision, rollback deadline, actor/request IDs, and optional rollback revision/timestamp. The rollback window is 30 days.

## 7. Transaction and idempotency protocol

For create and every persistent command:

1. Decode the command, canonicalize its complete input, and claim an execution by actor, command kind, and idempotency key.
2. Return a completed stored result for a matching key and input hash with `replayed: true`.
3. Return `idempotency_mismatch` if the key exists with another input hash.
4. Return retryable `command_in_progress` if another non-expired lease owns the pending execution.
5. Load and authorize the character snapshot, including expected revision and pinned version.
6. Call `SystemRuntime.resolve` outside the final transaction. Immutable package/version and snapshot inputs make this safe.
7. Begin a short transaction; lock the execution and character rows.
8. Recheck ownership, lifecycle, pinned version, and expected revision.
9. Persist state/version/lifecycle/ownership changes and increment revision only when character state or metadata changes.
10. Persist roll, activity, audit, migration snapshots, and the exact completed command result in the same transaction.
11. Commit and return the stored result.

Pure roll actions validate the expected revision but do not increment it. A resource-changing action increments revision. A retry uses the same execution ID, so dice are identical after process or response failure.

On stale revision, return `409 conflict` with latest revision, changed definition IDs known from activity after the client's base revision, and replacement reconciliation metadata. A conflict is a terminal result for that idempotency key; retrying against a newer revision uses a new key.

## 8. Migration workflow

### Preview

1. Authorize the owner and read the exact source revision.
2. Verify the target is an accessible published version of the same system.
3. Apply same-ID compatible mappings, explicit source-to-target mappings, and literal defaults supplied by the owner.
4. Invoke target-version `initialize` with mapped values.
5. Report dropped fields, defaults, changed constraints, diagnostics, and warnings.
6. Persist an immutable expiring preview bound to source revision, both version checksums, mappings, candidate state, and projection.
7. Do not mutate the character.

### Commit

Lock preview and character, recheck owner/expiry/unused status/source revision/checksums, validate the stored candidate through runtime, then atomically update pinned version/entity/state/revision and write migration, activity, audit, and receipt rows. Mark the preview consumed.

### Rollback

Rollback is permitted only before its deadline and only while the character remains at the migration's committed revision. It creates a new revision by restoring the source version and before-state; revision never decreases. Subsequent edits cause a `409 conflict` rather than being discarded.

## 9. HTTP contract

All routes are authenticated and map to one Characters call.

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/characters` | Create a standalone character from an exact version/entity. |
| `GET` | `/characters` | List owned characters with cursor pagination. |
| `GET` | `/characters/{id}` | Observe and return state plus projection. |
| `POST` | `/characters/{id}/fields/{fieldId}/set` | Set one editable field. |
| `POST` | `/characters/{id}/resources/{resourceId}/bump` | Apply package-defined up/down step. |
| `POST` | `/characters/{id}/actions/{actionId}` | Execute a server-authoritative action or roll. |
| `PATCH` | `/characters/{id}` | Rename, archive, or recover. |
| `POST` | `/characters/{id}/ownership-transfer` | Transfer sole ownership. |
| `GET` | `/characters/{id}/activity` | List owner-visible activity. |
| `POST` | `/characters/{id}/exports` | Produce synchronous versioned JSON export. |
| `POST` | `/characters/{id}/migration-previews` | Build and persist a non-mutating preview. |
| `POST` | `/characters/{id}/migrations/{previewId}/commit` | Commit an exact preview. |
| `POST` | `/characters/{id}/migrations/{migrationId}/rollback` | Restore the bounded before-state. |

Mutation bodies include `expectedRevision` and `idempotencyKey`. Action bodies additionally include typed inputs. HTTP uses `201` for create/preview, `200` otherwise, `400` for malformed transport input, `404` for missing/inaccessible resources, `409` for revision/idempotency/in-progress/lifecycle conflicts, `422` for runtime-invalid values/actions/mappings, and `503` for temporary infrastructure failures.

Reads emit private cache headers, `ETag`, and `X-Resource-Revision`. Every mutation result includes:

```ts
type Reconciliation = {
  characterId: CharacterId;
  baseRevision: number | null;
  revision: number;
  packageChecksum: string;
  projectionVersion: "1.0";
  commandExecutionId: CommandExecutionId;
  replayExpiresAt: string;
  replayed: boolean;
  changedDefinitionIds: DefinitionId[];
  activityCursor: string | null;
  cacheDisposition: "retain" | "replace" | "purge";
};
```

Unauthenticated responses direct clients to pause and reauthenticate. Inaccessible-character responses use generic `not_found` plus `cacheDisposition: "purge"`; they never reveal whether a guessed ID exists. Clients never auto-merge values or convert a stale bump into an arbitrary delta.

## 10. Export contract

Use `application/vnd.sweetroll.character+json;version=1`. The canonical document contains character identity, display name, entity definition ID, lifecycle/timestamps, exact system/version identity and checksum, current revision, stored state, and migration lineage required to interpret it.

It excludes owner and actor IDs, email, external identities, sessions, idempotency keys, execution IDs, and request IDs. Activity and roll history are excluded from export v1 to keep size bounded. Export creation is idempotent and audited.

## 11. Security and failure behavior

- Authorization predicates remain relational and inside Characters; state JSON never controls access.
- IDOR behavior is tested for every route and always maps inaccessible IDs to `not_found`.
- Logs contain IDs, command kind, revision, duration, and stable error code only; no character state, inputs, roll secret, package body, or export body.
- Runtime inputs and outputs obey package/state size and evaluation budgets.
- System deletion returns a stable conflict while versions are pinned by characters; it must not leak a PostgreSQL foreign-key error.
- Publishing a newer version never mutates a character.
- A disconnected device may retain previously cached private data until it reconnects or signs out; reconciliation then directs it to purge revoked data.

## 12. Testing

### SystemRuntime Interface tests

- Every intent across d20, PbtA 2d6, and d6 success-pool fixtures.
- Defaults, all field kinds, resource bounds/steps, choices, action inputs, and multi-entity isolation.
- Derived ordering, authored validations, projection snapshots, and observe purity.
- Deterministic dice for identical execution IDs and varied results for distinct IDs.
- Unknown/computed fields, invalid state, checksum mismatch, and budget exhaustion.
- Property tests proving no mutation of input state/package and complete output on success.

### Characters Interface tests against real PostgreSQL

- Create/open/list, owner scoping, transfer revocation, archive/recover, activity, and export.
- Set/bump/action atomicity across all fixtures.
- Same-key replay, changed-input mismatch, concurrent duplicate key, ambiguous commit replay, and expired pending lease recovery.
- Two commands from one revision produce exactly one state-changing winner.
- Roll result/activity atomicity and deterministic replay after simulated process failure.
- Preview non-mutation, compatible and mapped migration, stale/expired preview, commit race, rollback, and rollback-after-edit conflict.
- Export account-data exclusion and canonical media contract.
- Offline replay sequences for success, duplicate, stale revision, authentication loss, and ownership revocation.
- Session-burst load tests for reads, bumps, and actions against stated latency targets.

### HTTP Adapter tests

Keep them thin: authentication, TypeBox decoding, one route to one Characters call, stable status/error mapping, required request IDs, ETag/revision/reconciliation headers, export media type, body limits, and OpenAPI conformance.

### Migration tests

Test fresh application, existing-schema upgrade, constraints/indexes/foreign keys, row-lock races, rollback on injected failures, and system-version delete conflicts.

## 13. Delivery sequence

1. **Runtime foundation:** state/projection contracts, package loader, initialize/observe, deterministic evaluator bindings, all-fixture Interface tests.
2. **Create/read slice:** character schema, Characters Interface, create/list/open, exact version/entity pinning, owner authorization, HTTP/OpenAPI.
3. **Mutation slice:** runtime set/bump, idempotent apply workflow, revision conflicts, activity/audit, reconciliation metadata.
4. **Action slice:** runtime action, deterministic execution IDs and dice, rolls, replay, atomic activity.
5. **Management slice:** rename, single-owner transfer, archive/recover, activity pagination, canonical export.
6. **Migration slice:** acknowledged breaking publication, preview, explicit mappings/defaults, commit, snapshots, bounded rollback.
7. **Offline and closure:** cache/replay response contracts, access revocation behavior, load/concurrency/acceptance tests, generated OpenAPI artifact, and design closure record.

Each slice is complete through migration, Module Interface, HTTP Adapter, OpenAPI, and tests before the next slice starts.

## 14. Acceptance demonstration

Through authenticated HTTP only:

1. Publish or select an exact reference-system version.
2. Create a standalone character for an explicit entity.
3. Read its initialized state, derived values, validations, and projection.
4. Set a field and bump a bounded resource.
5. Execute a deterministic server-authoritative roll.
6. Replay the same action key and receive the identical roll without another effect.
7. Submit two writes from one revision and receive one success plus one machine-readable conflict.
8. Archive, recover, read activity, and export the character without account data.
9. Publish a newer acknowledged version, preview a compatible or mapped migration without mutation, commit it atomically, and demonstrate bounded rollback.

The character remains pinned to its original version until migration commit. No campaign, GM, or client-side package interpretation participates.
