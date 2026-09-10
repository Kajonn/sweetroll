import { randomUUID } from "node:crypto";

import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createCharactersModule, type Characters } from "../../src/characters/index.js";
import { claimExecution } from "../../src/characters/idempotency.js";
import { d20Package } from "../../src/systems/implementation/package/fixtures/index.js";
import { createPostgresPublishedPackageLoader } from "../../src/systems/implementation/runtime/package-loader.js";
import { signSystemPackage } from "../../src/systems/implementation/package/canonical.js";
import type {
  SystemPackageV1,
  UnsignedSystemPackageV1,
} from "../../src/systems/implementation/package/schema/index.js";
import { createSystemRuntime, type SystemRuntime } from "../../src/systems/runtime.js";
import { createSystemAuthoringModule, type SystemAuthoring } from "../../src/systems/authoring.js";
import { createSystemPersistenceRepository } from "../../src/systems/implementation/persistence/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;

const DDL = `
  CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE systems (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid REFERENCES users(id) ON DELETE RESTRICT,
    name text NOT NULL,
    access text NOT NULL DEFAULT 'private',
    lifecycle text NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE system_versions (
    id uuid PRIMARY KEY,
    system_id uuid NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
    semantic_version text NOT NULL,
    checksum text NOT NULL UNIQUE,
    package_json jsonb NOT NULL,
    release_notes text NOT NULL DEFAULT '',
    lifecycle text NOT NULL DEFAULT 'published',
    compatibility_findings_json jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (system_id, semantic_version)
  );
  CREATE TABLE characters (
    id                   uuid PRIMARY KEY,
    owner_id             uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    -- 0013 ownership-union columns (standalone-only suite: no campaigns table, so no FK here).
    campaign_id          uuid,
    placement_generation integer NOT NULL DEFAULT 1,
    return_owner_id      uuid,
    system_version_id    uuid NOT NULL REFERENCES system_versions(id) ON DELETE RESTRICT,
    entity_definition_id text NOT NULL,
    name                 text NOT NULL,
    revision             integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
    state_json           jsonb NOT NULL,
    visibility           text NOT NULL DEFAULT 'owner_only' CHECK (visibility = 'owner_only'),
    lifecycle            text NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'archived')),
    archived_at          timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX characters_owner_page_idx
    ON characters (owner_id, lifecycle, updated_at DESC, id DESC);
  CREATE TABLE character_command_executions (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id              uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    command_kind          text NOT NULL,
    idempotency_key       text NOT NULL,
    input_hash            text NOT NULL,
    character_id          uuid REFERENCES characters(id) ON DELETE RESTRICT,
    preallocated_ids_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    execution_id          uuid NOT NULL UNIQUE,
    status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
    lease_expires_at      timestamptz NOT NULL,
    result_json           jsonb,
    created_at            timestamptz NOT NULL DEFAULT now(),
    expires_at            timestamptz NOT NULL,
    UNIQUE (actor_id, command_kind, idempotency_key)
  );
  CREATE TABLE character_rolls (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    character_id       uuid NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
    actor_id           uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    action_id          text NOT NULL,
    execution_id       uuid NOT NULL UNIQUE,
    expression         text NOT NULL,
    dice_json          jsonb NOT NULL,
    bindings_json      jsonb NOT NULL,
    total              double precision NOT NULL,
    rendered_output    text NOT NULL,
    audience           text NOT NULL DEFAULT 'owner_only' CHECK (audience = 'owner_only'),
    request_id         text NOT NULL,
    occurred_at        timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE character_activity_events (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    character_id       uuid NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
    character_revision integer NOT NULL CHECK (character_revision >= 1),
    kind               text NOT NULL,
    payload_json       jsonb NOT NULL,
    roll_id            uuid REFERENCES character_rolls(id) ON DELETE RESTRICT,
    request_id         text NOT NULL,
    occurred_at        timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX character_activity_events_page_idx
    ON character_activity_events (character_id, occurred_at DESC, id DESC);
  CREATE TABLE character_audit_records (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    character_id uuid NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
    actor_id     uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    kind         text NOT NULL,
    summary      text NOT NULL,
    request_id   text NOT NULL,
    occurred_at  timestamptz NOT NULL DEFAULT now()
  );
`;

describeWithDatabase("Character command concurrency", () => {
  const schema = `characters_concurrency_${randomUUID().replaceAll("-", "")}`;
  // Requires at least four connections: two concurrent commands plus incidental pool usage.
  let pool: Pool;
  let authoring: SystemAuthoring;
  let runtime: SystemRuntime;
  let characters: Characters;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: databaseUrl,
      application_name: schema,
      max: 8,
      onConnect: async (client) => {
        await client.query(`SET search_path TO ${schema}`);
      },
    });
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    await admin.query(DDL);
    await admin.end();

    const repo = createSystemPersistenceRepository(pool);
    authoring = createSystemAuthoringModule({ repo });
    runtime = createSystemRuntime({
      loadPackage: createPostgresPublishedPackageLoader(pool),
      authoritativeRollSecret: "a".repeat(32),
    });
    characters = createCharactersModule({
      pool,
      runtime,
      authorizeVersionUse: authoring.authorizeVersionUse,
      listAuthorizedVersions: authoring.listAuthorizedVersions,
    });
  });

  beforeEach(async () => {
    await pool.query(`SET search_path TO ${schema}`);
    await pool.query(
      "TRUNCATE character_audit_records, character_activity_events, character_rolls, character_command_executions, characters, system_versions, systems, users RESTART IDENTITY CASCADE",
    );
  });

  afterAll(async () => {
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    await pool.end();
  });

  const ctx = (actorId: string) => ({ actorId, requestId: randomUUID() });

  async function createUser(displayName: string): Promise<string> {
    const result = await pool.query<{ id: string }>(
      "INSERT INTO users (display_name) VALUES ($1) RETURNING id",
      [displayName],
    );
    return result.rows[0]!.id;
  }

  function repackage(versionId: string): SystemPackageV1 {
    const unsigned = structuredClone(d20Package) as unknown as UnsignedSystemPackageV1 & { integrity?: unknown };
    delete unsigned.integrity;
    unsigned.versionId = versionId;
    return signSystemPackage(unsigned);
  }

  async function publishVersion(ownerId: string): Promise<{ systemId: string; versionId: string }> {
    const systemResult = await pool.query<{ id: string }>(
      "INSERT INTO systems (owner_id, name, access, lifecycle) VALUES ($1, $2, 'public', 'active') RETURNING id",
      [ownerId, "D20"],
    );
    const systemId = systemResult.rows[0]!.id;
    const versionId = randomUUID();
    const packageValue = repackage(versionId);
    await pool.query(
      "INSERT INTO system_versions (id, system_id, semantic_version, checksum, package_json, lifecycle) VALUES ($1, $2, '1.0.0', $3, $4::jsonb, 'published')",
      [versionId, systemId, packageValue.integrity.checksum, JSON.stringify(packageValue)],
    );
    return { systemId, versionId };
  }

  async function createCharacter(ownerId: string, versionId: string) {
    const created = await characters.create(ctx(ownerId), {
      systemVersionId: versionId,
      entityDefinitionId: "character",
      name: "Aria",
      idempotencyKey: randomUUID(),
    });
    if (!created.ok) throw new Error(`unexpected create failure: ${JSON.stringify(created.error)}`);
    return created.value.characterId;
  }

  it("resolves two different commands from revision 1 with exactly one success and one conflict", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishVersion(owner);
    const characterId = await createCharacter(owner, versionId);

    const [a, b] = await Promise.all([
      characters.apply(ctx(owner), {
        kind: "setField",
        characterId,
        fieldId: "ability",
        value: 15,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      }),
      characters.apply(ctx(owner), {
        kind: "bumpResource",
        characterId,
        resourceId: "health",
        direction: "down",
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      }),
    ]);

    const results = [a, b];
    const successes = results.filter((r) => r.ok);
    const conflicts = results.filter((r) => !r.ok);
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    if (conflicts[0]!.ok) throw new Error("unexpected");
    expect(conflicts[0]!.error.code).toBe("conflict");
    expect(conflicts[0]!.error.latestRevision).toBe(2);

    const row = await pool.query<{ revision: number }>("SELECT revision FROM characters WHERE id = $1", [characterId]);
    expect(row.rows[0]!.revision).toBe(2);
  });

  it("produces exactly one state/activity effect for concurrent duplicate idempotency keys", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishVersion(owner);
    const characterId = await createCharacter(owner, versionId);
    const key = randomUUID();

    const command = {
      kind: "setField" as const,
      characterId,
      fieldId: "ability",
      value: 15,
      expectedRevision: 1,
      idempotencyKey: key,
    };

    const [a, b] = await Promise.all([characters.apply(ctx(owner), command), characters.apply(ctx(owner), command)]);

    // Exactly one state-changing effect must occur, however both callers resolve it:
    // both may observe the completed result (one authoritative, one replayed), or the
    // loser of the pending-lease race may observe a retryable command_in_progress.
    const outcomes = [a, b];
    const succeeded = outcomes.filter((r) => r.ok);
    const inProgress = outcomes.filter((r) => !r.ok && r.error.code === "command_in_progress");
    expect(succeeded.length + inProgress.length).toBe(2);
    expect(succeeded.length).toBeGreaterThanOrEqual(1);
    if (succeeded.length === 2) {
      const [first, second] = succeeded as typeof succeeded & { ok: true }[];
      if (!first.ok || !second.ok) throw new Error("unexpected");
      expect(first.value.character.reconciliation.commandExecutionId).toBe(
        second.value.character.reconciliation.commandExecutionId,
      );
      const replayedFlags = [first.value.character.reconciliation.replayed, second.value.character.reconciliation.replayed];
      expect(replayedFlags.filter((flag) => flag === true)).toHaveLength(1);
      expect(replayedFlags.filter((flag) => flag === false)).toHaveLength(1);
    }

    const row = await pool.query<{ revision: number }>("SELECT revision FROM characters WHERE id = $1", [characterId]);
    expect(row.rows[0]!.revision).toBe(2);
    const activity = await pool.query(
      "SELECT count(*)::int AS count FROM character_activity_events WHERE character_id = $1 AND kind = 'character_field_set'",
      [characterId],
    );
    expect(activity.rows[0]!.count).toBe(1);
    const executions = await pool.query(
      "SELECT count(*)::int AS count FROM character_command_executions WHERE idempotency_key = $1",
      [key],
    );
    expect(executions.rows[0]!.count).toBe(1);
  });

  it("reclaims a pending lease after 61 seconds while preserving the original execution ID", async () => {
    const owner = await createUser("Ada");

    const firstClaim = await claimExecution(pool, {
      actorId: owner,
      commandKind: "character_set_field",
      idempotencyKey: "lease-key",
      inputHash: "hash-a",
      newExecutionId: () => randomUUID(),
      now: new Date(),
      leaseMs: 60_000,
      replayTtlMs: 30 * 24 * 60 * 60 * 1000,
    });
    expect(firstClaim.status).toBe("claimed");
    if (firstClaim.status !== "claimed") throw new Error("unexpected");
    const originalExecutionId = firstClaim.executionId;

    // Simulate a crashed worker: the lease expires without the row being finalized.
    await pool.query(
      "UPDATE character_command_executions SET lease_expires_at = now() - interval '61 seconds' WHERE execution_id = $1",
      [originalExecutionId],
    );

    const reclaimed = await claimExecution(pool, {
      actorId: owner,
      commandKind: "character_set_field",
      idempotencyKey: "lease-key",
      inputHash: "hash-a",
      newExecutionId: () => randomUUID(),
      now: new Date(),
      leaseMs: 60_000,
      replayTtlMs: 30 * 24 * 60 * 60 * 1000,
    });
    expect(reclaimed.status).toBe("claimed");
    if (reclaimed.status !== "claimed") throw new Error("unexpected");
    expect(reclaimed.executionId).toBe(originalExecutionId);

    const row = await pool.query<{ status: string; execution_id: string }>(
      "SELECT status, execution_id FROM character_command_executions WHERE idempotency_key = 'lease-key'",
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]!.status).toBe("pending");
    expect(row.rows[0]!.execution_id).toBe(originalExecutionId);
  });

  it("returns command_in_progress for a still-live pending lease", async () => {
    const owner = await createUser("Ada");

    const firstClaim = await claimExecution(pool, {
      actorId: owner,
      commandKind: "character_set_field",
      idempotencyKey: "live-lease-key",
      inputHash: "hash-a",
      newExecutionId: () => randomUUID(),
      now: new Date(),
      leaseMs: 60_000,
      replayTtlMs: 30 * 24 * 60 * 60 * 1000,
    });
    expect(firstClaim.status).toBe("claimed");

    const second = await claimExecution(pool, {
      actorId: owner,
      commandKind: "character_set_field",
      idempotencyKey: "live-lease-key",
      inputHash: "hash-a",
      newExecutionId: () => randomUUID(),
      now: new Date(),
      leaseMs: 60_000,
      replayTtlMs: 30 * 24 * 60 * 60 * 1000,
    });
    expect(second.status).toBe("in_progress");
  });
});
