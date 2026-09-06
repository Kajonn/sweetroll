# I3 Character Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the production SystemRuntime and a revision-safe, idempotent standalone Characters backend through documented HTTP routes.

**Architecture:** `SystemRuntime.resolve` is the single package-interpretation Interface and returns complete state plus a versioned projection. The deep Characters Module owns authorization, mutable revisioned state, command executions, PostgreSQL transaction ordering, activity, rolls, export, and explicit migration; HTTP maps each route to one Module call.

**Tech Stack:** Node.js 24, TypeScript strict mode, Fastify, TypeBox, PostgreSQL 17 through `pg`, Vitest, existing expression/package implementation, JSON canonicalization, Node `crypto` HMAC.

**Spec:** `docs/superpowers/specs/2026-09-05-i3-character-backend-design.md`

## Global Constraints

- Standalone characters have exactly one transferable owner and fixed `owner_only` visibility.
- Character state is JSONB keyed by stable definition IDs and pinned to one exact immutable system version.
- All package interpretation goes through `SystemRuntime.resolve`; Characters and HTTP never inspect package ASTs or evaluate expressions.
- Every persistent command carries `expectedRevision` where state-sensitive and an actor-scoped idempotency key.
- Completed command executions remain replayable for 30 days; pending leases expire after 60 seconds without changing execution ID.
- Authoritative dice derive from `HMAC-SHA256(authoritativeRollSecret, executionId)`; production never uses `Math.random`.
- Migration previews expire after 24 hours; rollback expires after 30 days and never discards post-migration edits.
- Image fields are initialized to `null`; non-null writes return `unsupported_field_value` until object storage is designed.
- Campaigns, GM policy, shared ownership, client offline queues, event sourcing, workers, and object storage are out of scope.
- Write tests first. Run focused tests red, implement minimally, run green, then run the affected suite before each commit.

---

## File Map

### Runtime

- Modify `src/systems/runtime.ts`: public Runtime Interface, types, result/error contract, and factory.
- Create `src/systems/implementation/runtime/package-loader.ts`: PostgreSQL and fixture immutable-package loaders.
- Create `src/systems/implementation/runtime/state.ts`: field indexing, state decode/defaults, constraints, bindings.
- Create `src/systems/implementation/runtime/projection.ts`: `CharacterProjectionV1` builder.
- Create `src/systems/implementation/runtime/deterministic-rng.ts`: HMAC-backed deterministic RNG.
- Create `src/systems/implementation/runtime/resolve.ts`: intent dispatch and complete resolution.
- Create `src/systems/runtime.test.ts`: Interface tests across all package fixtures.
- Modify `src/systems/implementation/rules/evaluate.ts`: scoped bindings, binding trace, effective dice limits.
- Modify `src/systems/implementation/rules/compile-document.ts`: entity/action scope and derived dependency validation.

### Characters and persistence

- Create `migrations/0009_create_characters.sql`: character tables, constraints, indexes, compatibility findings, lifecycle normalization.
- Create `src/characters/index.ts`: public Characters Interface/types and Module implementation.
- Create `src/characters/persistence.ts`: private SQL/transaction helpers.
- Create `src/characters/idempotency.ts`: private execution claim/lease/finalization protocol.
- Create `src/characters/export.ts`: canonical character export v1.
- Create `src/characters/migration.ts`: mapping and migration-preview helpers.
- Create `tests/integration/characters.test.ts`: PostgreSQL workflow tests.
- Create `tests/integration/character-concurrency.test.ts`: command race/replay tests.
- Create `tests/integration/character-migration.test.ts`: schema and migration workflow tests.
- Create `tests/integration/character-http-acceptance.test.ts`: complete HTTP demonstration.
- Create `tests/integration/character-load.test.ts`: bounded session-burst test.

### Existing system and transport files

- Modify `src/systems/authoring.ts`: version-use authorization and acknowledged breaking publication.
- Modify `src/systems/implementation/persistence/repository.ts`: compatibility findings, access query, stable pinned-delete conflict.
- Modify `src/transport/http/systems.ts`: `acknowledgeBreaking` input and conflict mapping.
- Create `src/transport/http/characters.ts`: schemas, route definitions, thin handlers.
- Create `src/transport/http/characters.test.ts`: Adapter contract tests.
- Modify `src/transport/http/index.ts`, `src/transport/http/openapi.ts`, and `src/transport/http/openapi.test.ts`: export/register character definitions.
- Modify `src/bootstrap/http.ts`: compose package loader, Runtime, Characters, and routes.
- Modify `src/platform/config.ts`, `src/platform/config.test.ts`, and `.env.example`: required authoritative roll secret.
- Modify `scripts/generate-system-contracts.ts`: register fake Characters routes for generation.
- Regenerate `docs/contracts/openapi-v1.json` and `web/src/api/schema.d.ts`.
- Modify `design_v2.md`: mark I3 closed only after acceptance and load checks pass.

---

### Task 1: Runtime Interface and Published-Package Loader

**Files:**
- Modify: `src/systems/runtime.ts`
- Create: `src/systems/implementation/runtime/package-loader.ts`
- Test: `src/systems/runtime.test.ts`

**Interfaces:**
- Consumes: `decodeSystemPackage(input)` from `src/systems/implementation/package/codec.ts` and `Pool` from `pg`.
- Produces: the stable `SystemRuntime.resolve(input): Promise<RuntimeResult<RuntimeResolution>>` type contract and `PublishedPackageLoader(versionId)` adapters. Task 2 implements the factory once it can return complete resolutions.

- [x] **Step 1: Write the failing public-contract and package-loader tests**

Create `src/systems/runtime.test.ts` with fixture-loader tests and a PostgreSQL-loader test using a query fake. Assert an unknown version returns `null`, an invalid package/checksum throws `PublishedPackageCorruptError`, and a valid d20 package returns a decoded `SystemPackageV1`.

```ts
const loadPackage = createFixturePublishedPackageLoader([d20Package]);
expect(await loadPackage(d20Package.versionId)).toEqual(d20Package);
expect(await loadPackage("missing")).toBeNull();
```

- [x] **Step 2: Run the focused test and verify red**

Run: `npx vitest run src/systems/runtime.test.ts`

Expected: FAIL because the Runtime types and package-loader adapters do not exist.

- [x] **Step 3: Define the complete public Runtime contract**

Replace the placeholder in `src/systems/runtime.ts` with Module-local IDs, `RuntimeStoredValue`, `RuntimeStateV1`, five intent variants, `RuntimeValidation`, `NormalizedRoll`, `CharacterProjectionV1`, `RuntimeResolution`, and:

```ts
export type RuntimeErrorCode =
  | "bad_request"
  | "not_found"
  | "invalid_package"
  | "invalid_state"
  | "unsupported_field_value"
  | "budget_exceeded"
  | "internal";

export type RuntimeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: RuntimeError };

export type PublishedPackageLoader = (
  versionId: VersionId,
) => Promise<SystemPackageV1 | null>;

export interface SystemRuntime {
  resolve(input: RuntimeRequest): Promise<RuntimeResult<RuntimeResolution>>;
}
```

Keep `SystemPackageV1`, compiled expressions, and evaluator results out of `RuntimeResolution`.

- [x] **Step 4: Implement package loaders**

In `package-loader.ts`, implement:

```ts
export function createPostgresPublishedPackageLoader(pool: Pool): PublishedPackageLoader;
export function createFixturePublishedPackageLoader(
  packages: readonly SystemPackageV1[],
): PublishedPackageLoader;
```

The PostgreSQL loader selects `package_json, checksum` by version ID, calls `decodeSystemPackage`, verifies decoded `integrity.checksum === row.checksum`, and returns `null` only when no row exists. Throw a typed loader error for corrupt rows so Runtime maps it to `invalid_package` rather than `not_found`.

- [x] **Step 5: Verify loader corruption mapping**

Ensure both adapters return `null` only for absence. The PostgreSQL adapter throws `PublishedPackageCorruptError` when decoding or row/package checksum comparison fails; tests assert the error contains version ID and stable code but not package JSON.

- [x] **Step 6: Run focused and backend tests**

Run: `npx vitest run src/systems/runtime.test.ts src/systems/implementation/package/codec.test.ts`

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add src/systems/runtime.ts src/systems/runtime.test.ts src/systems/implementation/runtime/package-loader.ts
git commit -m "feat: add SystemRuntime interface and package loader"
```

---

### Task 2: Runtime State, Derived Values, Validations, and Projection

**Files:**
- Create: `src/systems/implementation/runtime/state.ts`
- Create: `src/systems/implementation/runtime/projection.ts`
- Create: `src/systems/implementation/runtime/resolve.ts`
- Modify: `src/systems/runtime.ts`
- Modify: `src/systems/implementation/rules/compile-document.ts`
- Test: `src/systems/runtime.test.ts`
- Test: `src/systems/implementation/rules/compile-document.test.ts`

**Interfaces:**
- Consumes: Task 1 Runtime contracts and `PublishedPackageLoader`, package field/sheet/action types, and `evaluate(compiled, bindings, rng?)`.
- Produces: `createSystemRuntime({ loadPackage, authoritativeRollSecret })`, complete `initialize` and pure `observe` resolutions, and `CharacterProjectionV1` version `1.0`.

- [x] **Step 1: Add failing all-field initialize/observe tests**

Build a signed package from `validDocument()` in `schema/test-values.ts`. Assert defaults for text, integer, decimal, boolean, choices, and resource; assert image is `null`; assert computed fields are absent from stored state and present in `derivedValues`; assert `observe` does not mutate its input.

```ts
expect(initialized.value.state.values).toMatchObject({
  name: "Hero",
  modifier: 0,
  ready: false,
  role: null,
  talents: [],
  health: { current: 10, max: 10 },
  portrait: null,
});
expect(initialized.value.state.values).not.toHaveProperty("defense");
```

- [x] **Step 2: Add failing invalid-state tests**

Cover unknown IDs, computed values in state, non-finite numbers, off-step numeric values, invalid option IDs, duplicate multi-choice IDs, resource `current > max`, and non-null image values. Expected codes are `invalid_state` for stored-state corruption and `unsupported_field_value` for non-null image initialization.

- [x] **Step 3: Add failing entity/action scope compilation tests**

Create a two-entity document where one sheet references another entity's field and where one roll expression uses an input owned by another action. Assert `compileDocument` returns diagnostics at the offending paths. Assert computed dependency cycles fail publication.

- [x] **Step 4: Run tests and verify red**

Run: `npx vitest run src/systems/runtime.test.ts src/systems/implementation/rules/compile-document.test.ts`

Expected: FAIL on defaults, state validation, projections, and scope diagnostics.

- [x] **Step 5: Implement state indexing and validation**

In `state.ts`, index only the requested entity. Implement:

```ts
export function initializeState(entity: EntityDefinitionV1, values?: Record<string, unknown>): RuntimeResult<RuntimeStateV1>;
export function decodeRuntimeState(entity: EntityDefinitionV1, input: unknown): RuntimeResult<RuntimeStateV1>;
export function buildFieldBindings(entity: EntityDefinitionV1, state: RuntimeStateV1): Record<string, ScalarValue>;
```

Use field defaults, synthesize `null` for image, reject non-null image, preserve missing required fields as diagnostics rather than structural errors, and bind resources to `current`.

- [x] **Step 6: Implement derived and authored validation evaluation**

In `resolve.ts`, topologically evaluate computed expressions for the requested entity, add their results to field bindings, then evaluate validations whose target belongs to that entity. Arithmetic failures use authored fallback and appear as runtime validations. Budget exhaustion returns `budget_exceeded` without a partial resolution.

- [x] **Step 7: Implement the projection builder**

In `projection.ts`, select sheets with `targetEntityId === entityId`, preserve authored section/element order, and resolve each field/resource/action element to values, constraints, action inputs, and validations. Set `projectionVersion: "1.0"`, exact version/checksum, and no AST/package JSON.

- [x] **Step 8: Implement the Runtime factory and dispatch**

Add:

```ts
export function createSystemRuntime(input: {
  loadPackage: PublishedPackageLoader;
  authoritativeRollSecret: string;
}): SystemRuntime;
```

Load once per request, map absence to `not_found` and `PublishedPackageCorruptError` to `invalid_package`, verify the requested entity, and dispatch initialize/observe to complete state/derived/validation/projection resolution. Validate the secret now even though Task 3 first consumes it for dice.

- [x] **Step 9: Tighten compile-document scope**

Determine an action's target entity from sheet action elements. Reject actions referenced from sheets targeting more than one entity. Compile each computed/validation/roll expression against only its entity's fields and its action's inputs. Reject cyclic computed dependencies. Keep the compile-document symbol private from the browser-facing rules barrel.

- [x] **Step 10: Run focused, package, and type tests**

Run: `npx vitest run src/systems/runtime.test.ts src/systems/implementation/rules/compile-document.test.ts src/systems/implementation/package`

Expected: PASS.

- [x] **Step 11: Commit**

```bash
git add src/systems/runtime.ts src/systems/runtime.test.ts src/systems/implementation/runtime src/systems/implementation/rules/compile-document.ts src/systems/implementation/rules/compile-document.test.ts
git commit -m "feat: resolve character state and projections"
```

---

### Task 3: Runtime Set, Bump, Actions, and Deterministic Dice

**Files:**
- Create: `src/systems/implementation/runtime/deterministic-rng.ts`
- Create: `src/systems/implementation/runtime/deterministic-rng.test.ts`
- Modify: `src/systems/implementation/runtime/resolve.ts`
- Modify: `src/systems/implementation/rules/evaluate.ts`
- Modify: `src/systems/implementation/rules/evaluate.test.ts`
- Modify: `src/platform/config.ts`
- Modify: `src/platform/config.test.ts`
- Modify: `.env.example`
- Test: `src/systems/runtime.test.ts`

**Interfaces:**
- Consumes: complete Task 2 runtime state and projection.
- Produces: `set`, `bump`, and `action` intent resolution plus deterministic `NormalizedRoll`.

- [x] **Step 1: Add failing Runtime command tests**

Across d20, PbtA, and d6 fixtures, test valid set, invalid computed/image set, resource up/down bounds, roll action inputs, resource-bump actions, and unchanged state for roll actions. Assert `changedDefinitionIds` contains exactly changed field/resource IDs.

- [x] **Step 2: Add failing deterministic-roll tests**

Assert two action resolutions with execution ID `exec-a` are deeply equal, `exec-b` changes at least one die across a deterministic sample, and normalized rolls include expression, each die, scoped binding trace, total, and output.

- [x] **Step 3: Add failing evaluator scope/limit tests**

Change evaluator bindings to:

```ts
type EvaluationBindings = {
  fields: Record<string, ScalarValue>;
  inputs: Record<string, ScalarValue>;
};
```

Test that `fields.bonus` and `inputs.bonus` resolve independently and a package effective dice limit lower than the platform maximum is enforced.

- [x] **Step 4: Run tests and verify red**

Run: `npx vitest run src/systems/runtime.test.ts src/systems/implementation/runtime/deterministic-rng.test.ts src/systems/implementation/rules/evaluate.test.ts`

Expected: FAIL on unimplemented intents, RNG, and scoped bindings.

- [x] **Step 5: Implement HMAC RNG**

Derive blocks as `HMAC-SHA256(secret, executionId + ":" + counter)`, consume unsigned 32-bit words, and map each to `[0, 1)` by division by `2 ** 32`. Reject secrets shorter than 32 UTF-8 bytes in the Runtime factory.

- [x] **Step 6: Update evaluator bindings and limits**

Resolve reference nodes by `node.scope`; return an ordered binding trace with `{ scope, definitionId, value }`; accept effective dice/sides limits from Runtime. Preserve existing public evaluator tests by updating all callers explicitly rather than retaining a flattened compatibility path.

- [x] **Step 7: Implement the three command intents**

`set` validates one editable field then rebuilds complete derived/validation/projection output. `bump` adds/subtracts the package step and rejects bounds rather than clamping. `action` validates typed inputs; roll actions use HMAC RNG and do not mutate state, while resource-bump actions apply their authored delta/reset and return no roll.

- [x] **Step 8: Add required configuration**

Add `authoritativeRollSecret` to `AppConfig`, load `AUTHORITATIVE_ROLL_SECRET`, require at least 32 bytes outside tests, and document a non-production value in `.env.example`. Test missing/short/valid values in `config.test.ts`.

- [x] **Step 9: Run Runtime, rules, typecheck, and full backend tests**

Run: `npx vitest run src/systems/runtime.test.ts src/systems/implementation/rules src/platform/config.test.ts`

Run: `npm run typecheck && npm test`

Expected: PASS.

- [x] **Step 10: Commit**

```bash
git add .env.example src/platform src/systems/runtime.ts src/systems/runtime.test.ts src/systems/implementation/runtime src/systems/implementation/rules
git commit -m "feat: execute deterministic runtime commands"
```

---

### Task 4: Character Schema and System-Version Access

**Files:**
- Create: `migrations/0009_create_characters.sql`
- Modify: `src/systems/authoring.ts`
- Modify: `src/systems/implementation/persistence/repository.ts`
- Modify: `src/transport/http/systems.ts`
- Modify: `src/transport/http/systems.test.ts`
- Modify: `tests/integration/migrations.test.ts`
- Modify: `tests/integration/system-authoring.test.ts`

**Interfaces:**
- Consumes: existing SystemAuthoring and PostgreSQL migration patterns.
- Produces: character schema, `SystemAuthoring.authorizeVersionUse`, acknowledged breaking publication, and stable system-delete conflict.

- [x] **Step 1: Write failing production-migration assertions**

Extend `migrations.test.ts` to apply actual migrations through 0009 in an isolated schema. Assert all seven character tables, `owner_only`/lifecycle/revision checks, command uniqueness, execution-ID uniqueness, pagination indexes, migration-preview expiry fields, restrictive version FK, and `compatibility_findings_json` exist.

- [x] **Step 2: Write failing version-access and publication tests**

In `system-authoring.test.ts`, cover owner/private, public/link, inaccessible private, deprecated target, seeded template version, acknowledged breaking major publish, unacknowledged breaking publish, and acknowledged breaking minor publish. Update HTTP tests to require and forward `acknowledgeBreaking`.

- [x] **Step 3: Write failing pinned-delete conflict test**

Insert a character pinned to an owned system version, call `deleteSystem`, and expect `{ code: "conflict" }` rather than `internal`. Assert no character/version/system row is deleted.

- [x] **Step 4: Run integration tests and verify red**

Run: `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npx vitest run tests/integration/migrations.test.ts tests/integration/system-authoring.test.ts`

Expected: FAIL because migration 0009 and new workflows do not exist.

- [x] **Step 5: Create migration 0009**

Create the tables and constraints from spec section 6. Store all result timestamps as ISO strings in JSON. Add `compatibility_findings_json jsonb not null default '[]'::jsonb` to `system_versions`. Normalize existing version lifecycle `active` to `published`, and change both SQL/template seeding paths to write `published` going forward.

- [x] **Step 6: Add version-use authorization**

Add:

```ts
authorizeVersionUse(
  ctx: RequestContext,
  versionId: VersionId,
): Promise<Result<{
  systemId: SystemId;
  versionId: VersionId;
  checksum: string;
}>>;
```

Repository SQL permits use when the system owner matches the actor or access is `public`/`link`, system lifecycle is active, and version lifecycle is published. It returns no package JSON.

- [x] **Step 7: Implement acknowledged breaking publication**

Add required `acknowledgeBreaking: boolean` to authoring and TypeBox inputs and the complete idempotency hash. If comparison is breaking, require acknowledgement and `nextMajor > latestMajor`; persist findings with the version. Preserve the existing invalid-package diagnostic envelope when blocked.

- [x] **Step 8: Map pinned deletes to conflict**

Change `deleteOwnedSystem` to return a discriminated repository result and map PostgreSQL `23503` to `referenced`. Authoring maps it to a stable `conflict`; HTTP returns 409.

- [x] **Step 9: Run migration, integration, HTTP, contracts, and typecheck**

Run: `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npm run test:integration`

Run: `npm test && npm run typecheck && npm run contracts:check`

Expected: PASS after updating all `SystemAuthoring` fakes with `authorizeVersionUse` and all publish fixtures with `acknowledgeBreaking`.

- [x] **Step 10: Commit**

```bash
git add migrations/0009_create_characters.sql src/systems src/transport/http/systems.ts src/transport/http/systems.test.ts tests/integration
git commit -m "feat: add character schema and version access"
```

---

### Task 5: Characters Create, List, and Open

**Files:**
- Create: `src/characters/index.ts`
- Create: `src/characters/persistence.ts`
- Create: `tests/integration/characters.test.ts`

**Interfaces:**
- Consumes: `SystemRuntime.resolve`, `SystemAuthoring.authorizeVersionUse`, migration 0009, pool/clock/ID dependencies.
- Produces: `Characters.create`, `Characters.list`, and `Characters.open` returning complete `CharacterView`.

- [x] **Step 1: Write failing Interface integration tests**

Create two users and published reference versions. Test create applies runtime defaults, pins exact version/entity, starts revision 1, writes create activity/audit, and returns projection. Test list keyset order `(updated_at DESC, id DESC)`. Test owner open calls observe and another user receives `not_found`.

- [x] **Step 2: Add failing create rollback and access tests**

Cover inaccessible private version, unknown entity, deprecated version, invalid initial values, and injected audit insert failure. Assert no partial character/activity/audit/execution rows remain.

- [x] **Step 3: Run tests and verify red**

Run: `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npx vitest run tests/integration/characters.test.ts`

Expected: FAIL because Characters does not exist.

- [x] **Step 4: Define the Characters public contract**

In `src/characters/index.ts`, define Module-local identifier aliases, `CharacterError`, `CharacterResult<T>`, `CharacterRecord`, `CharacterView`, page/activity/export/migration/reconciliation types, the Interface from the spec, and:

```ts
export function createCharactersModule(input: {
  pool: Pool;
  runtime: SystemRuntime;
  authorizeVersionUse: SystemAuthoring["authorizeVersionUse"];
  now?: () => Date;
  newId?: () => string;
  newExecutionId?: () => string;
}): Characters;
```

- [x] **Step 5: Implement create transaction**

Authorize version use, call Runtime initialize, then in one transaction insert character, creation activity, creation audit, and completed create execution. Return revision, state, projection, validation, and reconciliation with 30-day `replayExpiresAt`.

- [x] **Step 6: Implement list/open**

Keep SQL owner predicates in the same query as selection. `open` loads state/version/entity, calls Runtime observe without writing, and returns complete projection. `list` exposes metadata only and opaque base64url cursor values.

- [x] **Step 7: Run focused integration and typecheck**

Run: `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npx vitest run tests/integration/characters.test.ts`

Run: `npm run typecheck`

Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add src/characters tests/integration/characters.test.ts
git commit -m "feat: create and read standalone characters"
```

---

### Task 6: Idempotent Set and Resource Bump Transactions

**Files:**
- Create: `src/characters/idempotency.ts`
- Modify: `src/characters/index.ts`
- Modify: `src/characters/persistence.ts`
- Create: `tests/integration/character-concurrency.test.ts`
- Modify: `tests/integration/characters.test.ts`

**Interfaces:**
- Consumes: `Characters.apply`, Runtime set/bump, execution schema.
- Produces: claim/replay/mismatch/lease protocol and atomic set/bump workflows.

- [x] **Step 1: Write failing set/bump behavior tests**

Assert successful set and bump increment revision, persist Runtime's complete next state, write one activity row, and return replacement reconciliation. Assert bounds/runtime failures persist no state effect. Assert archived or non-owner commands return inaccessible/conflict behavior from the spec.

- [x] **Step 2: Write failing idempotency tests**

Same actor/kind/key/input returns byte-equivalent result with `replayed: true`; same key/different input returns `idempotency_mismatch`; another actor may use the same key. Hash path IDs, expected revision, payload, and command kind.

- [x] **Step 3: Write failing concurrency tests**

Use a pool with at least four connections and explicit barriers. Two different commands at revision 1 yield one success and one 409-style conflict. Concurrent duplicate keys yield one state/activity effect. A reclaimed 61-second pending lease keeps the original execution ID.

- [x] **Step 4: Run tests and verify red**

Run: `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npx vitest run tests/integration/characters.test.ts tests/integration/character-concurrency.test.ts`

Expected: FAIL because apply/idempotency is not implemented.

- [x] **Step 5: Implement execution claiming**

`claimExecution` inserts pending with execution/lease IDs and expiry, returns completed replay for matching hash, rejects mismatch, returns `command_in_progress` for a live lease, and atomically reclaims expired leases while preserving execution ID. Do not reuse authoring receipts.

- [x] **Step 6: Implement apply transaction ordering**

Claim first; read authorized snapshot; call Runtime outside lock; begin transaction; lock execution then character; recheck actor/lifecycle/version/revision; update state/revision; insert activity/audit; finalize exact serialized result; commit. Complete stable business errors on the execution key. Leave transient infrastructure failures reclaimable.

- [x] **Step 7: Implement conflict reconciliation**

Query changed definition IDs from post-base-revision activity. Return latest revision, activity cursor, `cacheDisposition: "replace"`, and no private values from another revision.

- [x] **Step 8: Run focused integration tests three times**

Run three times: `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npx vitest run tests/integration/character-concurrency.test.ts`

Expected: PASS each run with exactly one winner/effect.

- [x] **Step 9: Commit**

```bash
git add src/characters tests/integration/characters.test.ts tests/integration/character-concurrency.test.ts
git commit -m "feat: apply idempotent character commands"
```

---

### Task 7: Authoritative Actions and Roll Activity

**Files:**
- Modify: `src/characters/index.ts`
- Modify: `src/characters/persistence.ts`
- Modify: `tests/integration/characters.test.ts`
- Modify: `tests/integration/character-concurrency.test.ts`

**Interfaces:**
- Consumes: Task 6 command protocol and Runtime action intent.
- Produces: durable action execution, normalized rolls, and exact replay.

- [x] **Step 1: Write failing action tests across all fixtures**

Execute d20 check, PbtA move, d6 success pool, and resource-bump actions. Assert normalized expression, dice, scoped bindings, total/output, audience `owner_only`, actor, timestamp, and request ID are persisted. Assert roll-only action leaves revision unchanged; resource action increments it.

- [x] **Step 2: Write failing retry/atomicity tests**

Simulate response loss after commit and replay the same key; assert identical dice and one roll/activity row. Inject roll/activity insert failure and assert state, roll, activity, and execution completion all roll back.

- [x] **Step 3: Run tests and verify red**

Run: `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npx vitest run tests/integration/characters.test.ts tests/integration/character-concurrency.test.ts`

Expected: FAIL on action persistence and replay.

- [x] **Step 4: Implement action workflow**

Pass the claimed execution ID to Runtime. Under final lock, recheck expected revision before inserting a roll or applying a resource action. Persist normalized roll, action activity, applicable state update, and completed result in one transaction.

- [x] **Step 5: Verify restart-safe determinism**

Construct a second Runtime/Characters instance with the same secret and database after the first commits; replay and assert the stored response is returned without invoking RNG again. Construct with a different process-local ID generator to prove result stability comes from persisted execution ID.

- [x] **Step 6: Run focused and full backend tests**

Run: `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npm run test:integration`

Run: `npm test && npm run typecheck`

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add src/characters tests/integration/characters.test.ts tests/integration/character-concurrency.test.ts
git commit -m "feat: execute authoritative character actions"
```

---

### Task 8: Ownership, Lifecycle, Activity, and Export

**Files:**
- Create: `src/characters/export.ts`
- Modify: `src/characters/index.ts`
- Modify: `src/characters/persistence.ts`
- Modify: `tests/integration/characters.test.ts`

**Interfaces:**
- Consumes: Task 6 management command protocol.
- Produces: `manage`, `listActivity`, and `exportCharacter` workflows.

- [x] **Step 1: Write failing ownership/lifecycle tests**

Transfer to an existing user, assert revision/audit/activity, immediate old-owner `not_found`, new-owner access, and successful old-owner replay of the transfer receipt. Assert archive blocks set/bump/action but allows read/export; recover restores play.

- [x] **Step 2: Write failing activity pagination tests**

Create more than one page of events with tied timestamps. Assert descending `(occurred_at, id)` cursor stability, minimized payloads, and absence of state values, email, external identity, session, and idempotency keys.

- [x] **Step 3: Write failing export tests**

Assert media document fields from spec section 10, canonical byte-equivalence on replay, package/version/checksum pin, and exclusion of owner/actor/request/execution IDs plus activity/roll history.

- [x] **Step 4: Run tests and verify red**

Run: `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npx vitest run tests/integration/characters.test.ts`

Expected: FAIL on management, pagination, and export.

- [x] **Step 5: Implement management commands**

Use the common execution/lock/recheck/finalize protocol. Validate destination user relationally without returning profile data. Transfer/rename/archive/recover each increment revision and write activity/audit in the same transaction.

- [x] **Step 6: Implement activity and canonical export**

Use keyset pagination. Build `CharacterExportV1` in `export.ts`, canonicalize with `json-canonicalize`, and store the exact document in the completed execution result. Use ISO timestamps and media type `application/vnd.sweetroll.character+json;version=1`.

- [x] **Step 7: Run focused integration and typecheck**

Run: `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npx vitest run tests/integration/characters.test.ts`

Run: `npm run typecheck`

Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add src/characters tests/integration/characters.test.ts
git commit -m "feat: manage and export characters"
```

---

### Task 9: Character Migration Preview, Commit, and Rollback

**Files:**
- Create: `src/characters/migration.ts`
- Modify: `src/characters/index.ts`
- Modify: `src/characters/persistence.ts`
- Create: `tests/integration/character-migration.test.ts`

**Interfaces:**
- Consumes: Runtime initialize/observe, version-use authorization, command protocol, stored compatibility findings.
- Produces: `previewMigration`, `commitMigration`, and `rollbackMigration`.

- [x] **Step 1: Write failing preview tests**

Cover compatible same-ID/default migration, removed field with explicit map, literal default, invalid target field, target in another system, inaccessible/deprecated target, and 24-hour expiry. Assert preview leaves version/state/revision unchanged.

- [x] **Step 2: Write failing commit tests**

Assert exact candidate state/projection commit, one revision increment, consumed preview, before/after snapshots, activity/audit, stale-source rejection, expired/consumed rejection, and two concurrent commits yielding one winner.

- [x] **Step 3: Write failing rollback tests**

Assert rollback before 30 days restores source version/state into a new revision. Assert rollback after subsequent edit or after deadline returns conflict and preserves edits.

- [x] **Step 4: Run tests and verify red**

Run: `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npx vitest run tests/integration/character-migration.test.ts`

Expected: FAIL because migration workflows do not exist.

- [x] **Step 5: Implement deterministic mapping**

In `migration.ts`, retain same-ID compatible values; apply explicit `{ sourceFieldId, targetFieldId }` maps; apply literal defaults keyed by target field; reject duplicate targets and type-incompatible values; report dropped source IDs/defaulted target IDs/tightened constraints. Call target Runtime initialize for final validation and projection.

- [x] **Step 6: Persist immutable previews**

Bind preview checksum to character ID, source revision/version/checksum, target version/checksum, mappings/defaults, candidate state, projection, warnings, owner, and expiry. Do not store executable migration code.

- [x] **Step 7: Implement commit and rollback transactions**

Commit locks preview/character/execution, rechecks every binding, Runtime-observes stored candidate, updates pin/entity/state/revision, stores snapshots, and consumes preview atomically. Rollback requires migration commit revision still current and deadline valid, then restores source pin/state while incrementing revision.

- [x] **Step 8: Run migration and all integration tests**

Run: `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npm run test:integration`

Expected: PASS.

- [x] **Step 9: Commit**

```bash
git add src/characters tests/integration/character-migration.test.ts
git commit -m "feat: migrate characters explicitly"
```

---

### Task 10: Character HTTP Adapter, OpenAPI, and Bootstrap

**Files:**
- Create: `src/transport/http/characters.ts`
- Create: `src/transport/http/characters.test.ts`
- Modify: `src/transport/http/index.ts`
- Modify: `src/transport/http/openapi.ts`
- Modify: `src/transport/http/openapi.test.ts`
- Modify: `src/bootstrap/http.ts`
- Modify: `scripts/generate-system-contracts.ts`
- Modify: `docs/contracts/openapi-v1.json`
- Modify: `web/src/api/schema.d.ts`

**Interfaces:**
- Consumes: complete Characters Interface and `createSystemRuntime` composition dependencies.
- Produces: all spec section 9 HTTP routes, generated contract, and running production composition.

- [x] **Step 1: Write failing route-definition and handler tests**

Build a complete fake Characters Module following `systems.test.ts`. For every route, assert TypeBox decoding, exact one-call input, status, response/request ID, auth 401, inaccessible 404, conflict/idempotency/in-progress 409, runtime-invalid 422, and temporary 503.

- [x] **Step 2: Write failing header/media tests**

Assert reads return `Cache-Control: private`, quoted ETag from character revision/checksum/projection version, and `X-Resource-Revision`. Assert export returns `application/vnd.sweetroll.character+json;version=1`. Assert inaccessible known-cache response includes purge reconciliation without existence detail.

- [x] **Step 3: Add failing OpenAPI path expectations**

List all 13 character paths from the spec in `openapi.test.ts`, with stable operation IDs such as `post_characters`, `get_characters_characterId`, and `post_characters_characterId_actions_actionId`. Assert export media type is represented, not generic JSON.

- [x] **Step 4: Run tests and verify red**

Run: `npx vitest run src/transport/http/characters.test.ts src/transport/http/openapi.test.ts`

Expected: FAIL because route definitions are absent.

- [x] **Step 5: Implement character schemas/routes/handlers**

Follow the systems route-definition array and handler-map pattern. Keep response shapes explicit and bounded. Never pass request-provided request IDs. Convert Dates to ISO strings at the Module edge before persistence/replay.

- [x] **Step 6: Extend OpenAPI media representation**

Allow a route response definition to declare a media type. Preserve `application/json` default; set only character/system export operations to their vendor types. Include character definitions in `buildOpenApiDocument`.

- [x] **Step 7: Compose production Modules**

In `bootstrap/http.ts`, construct PostgreSQL package loader, Runtime with `config.authoritativeRollSecret`, Characters with the bound `authoring.authorizeVersionUse`, then register character routes. Ensure shutdown still owns only app/pool lifecycle.

- [x] **Step 8: Regenerate and check contracts**

Run: `npm run contracts:generate`

Run: `npm run contracts:check`

Expected: PASS with character paths in `docs/contracts/openapi-v1.json` and generated web declarations.

- [x] **Step 9: Run transport, backend, web typecheck, and build**

Run: `npm test && npm run typecheck && npm run build`

Run: `npm run web:typecheck`

Expected: PASS.

- [x] **Step 10: Commit**

```bash
git add src/transport src/bootstrap/http.ts scripts/generate-system-contracts.ts docs/contracts/openapi-v1.json web/src/api/schema.d.ts
git commit -m "feat: expose character HTTP workflows"
```

---

### Task 11: Acceptance, Offline-Replay, Load, and I3 Closure

**Files:**
- Create: `tests/integration/character-http-acceptance.test.ts`
- Create: `tests/integration/character-load.test.ts`
- Modify: `design_v2.md`
- Create: `docs/acceptance/i3-2026-09-05.md`

**Interfaces:**
- Consumes: running HTTP app, real PostgreSQL, all three reference templates, generated OpenAPI.
- Produces: executable I3 acceptance proof and closure record.

- [x] **Step 1: Write the complete HTTP acceptance test**

Authenticate two users through the test identity adapter. Through `app.inject` only: create from exact d20 version/entity, observe defaults/projection, set ability, bump health, roll check, replay the roll, race two revision writes, archive/recover, list activity, export, publish an acknowledged breaking major version, preview explicit mapping, commit, and rollback.

- [x] **Step 2: Add offline-replay cases**

Replay an ordered sequence of ordinary commands. Assert duplicate returns original result, stale revision returns replacement metadata, 401 directs pause/reauthentication, transferred-away character returns generic not-found plus purge disposition, and a key after `replayExpiresAt` is rejected rather than executed again.

- [x] **Step 3: Add all-reference-system coverage**

Parameterize create/observe/set/bump/action for d20, PbtA, and d6 success pool. Assert each package's derived field, validation, projection, resource action, and roll family.

- [x] **Step 4: Add bounded session-burst test**

Create 50 characters, then issue a deterministic mix of 500 reads, 200 bumps on distinct characters/revisions, and 200 roll actions with unique keys using a pool sized for concurrency. Assert no lost/duplicate effects and record p95; fail when local p95 exceeds 300 ms for ordinary reads/writes or 500 ms for bounded rule actions under the documented local test profile.

- [x] **Step 5: Run acceptance and load tests red, then fix only discovered I3 defects**

Run: `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npx vitest run tests/integration/character-http-acceptance.test.ts tests/integration/character-load.test.ts`

Expected before fixes: any failure identifies a concrete cross-slice defect. Make the smallest production/test correction and rerun until PASS; do not loosen latency thresholds or delete acceptance assertions.

- [x] **Step 6: Run full verification twice**

Run twice:

```bash
TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npm run test:integration
npm test
npm run typecheck
npm run contracts:check
npm run web:test
npm run web:typecheck
DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npm --prefix web run test:e2e
```

Expected: every command passes both times; e2e cleanup leaves zero owner-created systems/characters beyond fixtures.

- [x] **Step 7: Record acceptance evidence**

Create `docs/acceptance/i3-2026-09-05.md` with tested commit, commands, pass counts, acceptance sequence, p95 measurements, and explicit proof that publication did not mutate a pinned character before migration commit.

- [x] **Step 8: Mark I3 closed in the design**

Update the I3 note in `design_v2.md` from approved design to closed implementation, linking the acceptance record. Do not edit I4 scope.

- [x] **Step 9: Commit closure**

```bash
git add tests/integration/character-http-acceptance.test.ts tests/integration/character-load.test.ts docs/acceptance/i3-2026-09-05.md design_v2.md
git commit -m "test: close I3 character backend"
```

---

## Plan Self-Review

- Spec sections 1-3 map to Tasks 1-5 and Global Constraints.
- Runtime contract, state, projections, scoped expressions, budgets, and deterministic dice map to Tasks 1-3.
- Persistence, ownership, authorization, idempotency, and transaction ordering map to Tasks 4-8.
- Migration preview/commit/rollback and breaking publication map to Tasks 4 and 9.
- HTTP, reconciliation, export media type, OpenAPI, and bootstrap map to Task 10.
- Security, all-reference coverage, concurrency, offline replay, load, and acceptance map to Tasks 5-11.
- No campaign, shared-owner, client queue, object-storage, event-sourcing, worker, or outbox work appears in the task list.

---

## Completion reconciliation (2026-09-05)

Implementation in `main` satisfies every step above. Relevant commits (`2bb33b0`..`23935fd5`, Tasks 1–10):

- `2bb33b0` feat: add SystemRuntime interface and package loader
- `436137f` feat: resolve character state and projections
- `bab4837` fix: preserve runtime validation diagnostics
- `d111eab` feat: execute deterministic runtime commands
- `d701e3b` fix: reject runtime dice budget exhaustion
- `f09cb15` feat: add character schema and version access
- `74d2b6b` fix: serialize breaking-version publication
- `0602660` feat: create and read standalone characters
- `f74b985` feat: apply idempotent character commands
- `400b37b` fix: leave transient runtime errors reclaimable; add conflict reconciliation fields
- `1e0400a` feat: execute authoritative character actions
- `6143d1d` feat: manage and export characters
- `5a69c06` feat: migrate characters explicitly
- `067b253` fix: revalidate preview checksum at commit and surface fresh revisions
- `847cdb9` feat: expose character HTTP workflows
- `23935fd` fix: split character internal/503 codes and move idempotency to body

Task 11 (acceptance, load, closure) sits in the commit that lands this document, `test: close I3 character backend`.

### Step 8 deviation (recorded here by instruction)

Per the task-brief instruction, the closure note is recorded in this plan document instead of `design_v2.md`. `design_v2.md` was **not** modified by this plan; the I3 note there remains "approved design". Acceptance evidence lives in `docs/acceptance/i3-2026-09-05.md` (+ transcript).

### Task 11 notes

- Demo scripts `scripts/i3-character-acceptance-demo.ts` / `.sh` re-run the full documented character HTTP surface against the compose database; the archived transcript is `docs/acceptance/i3-2026-09-05-transcript.log`.
- Full verification ran twice (plan Step 6): `test:integration` 108/108, `npm test` 253/253, `typecheck` pass, `contracts:check` pass, `web:test` 273/273, `web:typecheck` pass, `web:e2e` 13/13. Acceptance + load suites re-run green; load p95 measured well under budget (creates 169 ms, reads 22.5 ms, bumps 22.2 ms, rolls 32 ms vs 300/300/300/500 ms).
- Plan Step 5 discovered and fixed three production defects and two test gaps:
  1. **Authoring publish version-ID mismatch** (root cause of `422 invalid_package` on every character create): `publish` compiled the package with a throwaway UUID while the `system_versions` row id was auto-generated. Fix: `PublishVersionInput` carries `versionId` and the row is inserted with that explicit id.
  2. **Replay beyond `expires_at` re-executed** (200 instead of 409) and expired create keys surfaced as 500 UNIQUE violations: `claimExecution`/create now return `{ status: "expired" }` mapped to `conflict`.
  3. **Create replay was not byte-identical**: the response view used the PostgreSQL row timestamp while the persisted result used the Node `now()`, a 1 ms skew that intermittently failed the offline-replay deep-equal. Fix: the character row is inserted with the module's `createdAt`.
  4. **Web integration gaps** exposed by Step 6 verification: `web/src/api/publish.ts` now sends the required `acknowledgeBreaking` field (the dialog already gates on acknowledged findings), and `web/src/ports/evaluateExpression.ts` now splits flat bindings into the scoped `{ fields, inputs }` `EvaluationBindings` required by the Task 3 evaluator.
- Web e2e cleanup leaves zero owner-created systems/characters beyond fixtures.
