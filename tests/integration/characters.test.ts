import { randomUUID } from "node:crypto";

import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createCharactersModule,
  type CharacterId,
  type Characters,
} from "../../src/characters/index.js";
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
  CREATE TABLE character_activity_events (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    character_id       uuid NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
    character_revision integer NOT NULL CHECK (character_revision >= 1),
    kind               text NOT NULL,
    payload_json       jsonb NOT NULL,
    roll_id            uuid,
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

describeWithDatabase("Characters (create/list/open)", () => {
  const schema = `characters_${randomUUID().replaceAll("-", "")}`;
  let pool: Pool;
  let authoring: SystemAuthoring;
  let runtime: SystemRuntime;
  let characters: Characters;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: databaseUrl,
      application_name: schema,
      max: 5,
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
    });
  });

  beforeEach(async () => {
    await pool.query(`SET search_path TO ${schema}`);
    await pool.query(
      "TRUNCATE character_audit_records, character_activity_events, character_command_executions, characters, system_versions, systems, users RESTART IDENTITY CASCADE",
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

  async function publishVersion(
    ownerId: string,
    options: { access?: string; systemLifecycle?: string; versionLifecycle?: string } = {},
  ): Promise<{ systemId: string; versionId: string }> {
    const systemResult = await pool.query<{ id: string }>(
      "INSERT INTO systems (owner_id, name, access, lifecycle) VALUES ($1, $2, $3, $4) RETURNING id",
      [ownerId, "D20", options.access ?? "public", options.systemLifecycle ?? "active"],
    );
    const systemId = systemResult.rows[0]!.id;
    const versionId = randomUUID();
    const packageValue = repackage(versionId);
    await pool.query(
      "INSERT INTO system_versions (id, system_id, semantic_version, checksum, package_json, lifecycle) VALUES ($1, $2, '1.0.0', $3, $4::jsonb, $5)",
      [versionId, systemId, packageValue.integrity.checksum, JSON.stringify(packageValue), options.versionLifecycle ?? "published"],
    );
    return { systemId, versionId };
  }

  it("creates a character, applies runtime defaults, and pins the exact version/entity", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishVersion(owner);

    const result = await characters.create(ctx(owner), {
      systemVersionId: versionId,
      entityDefinitionId: "character",
      name: "Aria",
      idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected");
    expect(result.value.systemVersionId).toBe(versionId);
    expect(result.value.entityDefinitionId).toBe("character");
    expect(result.value.revision).toBe(1);
    expect(result.value.name).toBe("Aria");
    expect(result.value.ownerId).toBe(owner);
    expect(result.value.lifecycle).toBe("active");
    expect(result.value.state.values).toMatchObject({
      ability: 10,
      modifier: 0,
      proficient: false,
      ancestry: null,
      health: { current: 10, max: 10 },
    });
    expect(result.value.projection.projectionVersion).toBe("1.0");
    expect(result.value.projection.entityId).toBe("character");
    expect(result.value.reconciliation.replayed).toBe(false);
    expect(result.value.reconciliation.revision).toBe(1);
    expect(typeof result.value.reconciliation.replayExpiresAt).toBe("string");

    const row = await pool.query("SELECT kind FROM character_activity_events WHERE character_id = $1", [
      result.value.characterId,
    ]);
    expect(row.rows).toEqual([{ kind: "character_created" }]);
    const audit = await pool.query("SELECT kind FROM character_audit_records WHERE character_id = $1", [
      result.value.characterId,
    ]);
    expect(audit.rows).toEqual([{ kind: "character_created" }]);
  });

  it("replays identical creates from the idempotency key and rejects changed input", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishVersion(owner);
    const key = randomUUID();

    const first = await characters.create(ctx(owner), {
      systemVersionId: versionId,
      entityDefinitionId: "character",
      name: "Aria",
      idempotencyKey: key,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unexpected");

    const replay = await characters.create(ctx(owner), {
      systemVersionId: versionId,
      entityDefinitionId: "character",
      name: "Aria",
      idempotencyKey: key,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error("unexpected");
    expect(replay.value.characterId).toBe(first.value.characterId);
    expect(replay.value.reconciliation.replayed).toBe(true);

    const countResult = await pool.query("SELECT count(*)::int AS count FROM characters");
    expect(countResult.rows[0]!.count).toBe(1);

    const mismatch = await characters.create(ctx(owner), {
      systemVersionId: versionId,
      entityDefinitionId: "character",
      name: "Different",
      idempotencyKey: key,
    });
    expect(mismatch).toEqual({
      ok: false,
      error: { code: "idempotency_mismatch", message: "This idempotency key was already used with different input." },
    });
  });

  it("lists owned characters in (updated_at DESC, id DESC) keyset order", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishVersion(owner);

    const created: CharacterId[] = [];
    for (const name of ["First", "Second", "Third"]) {
      const result = await characters.create(ctx(owner), {
        systemVersionId: versionId,
        entityDefinitionId: "character",
        name,
        idempotencyKey: randomUUID(),
      });
      expect(result.ok).toBe(true);
      if (result.ok) created.push(result.value.characterId);
      // Force distinct updated_at ordering.
      await pool.query("UPDATE characters SET updated_at = now() WHERE id = $1", [created[created.length - 1]]);
    }

    const page1 = await characters.list(ctx(owner), { limit: 2, cursor: null });
    expect(page1.ok).toBe(true);
    if (!page1.ok) throw new Error("unexpected");
    expect(page1.value.characters).toHaveLength(2);
    expect(page1.value.nextCursor).not.toBeNull();

    const page2 = await characters.list(ctx(owner), { limit: 2, cursor: page1.value.nextCursor });
    expect(page2.ok).toBe(true);
    if (!page2.ok) throw new Error("unexpected");
    expect(page2.value.characters).toHaveLength(1);
    expect(page2.value.nextCursor).toBeNull();

    const allIds = [...page1.value.characters, ...page2.value.characters].map((c) => c.characterId);
    expect(new Set(allIds)).toEqual(new Set(created));
  });

  it("returns a complete projection for the owner and not_found for another user", async () => {
    const owner = await createUser("Ada");
    const stranger = await createUser("Bob");
    const { versionId } = await publishVersion(owner);

    const created = await characters.create(ctx(owner), {
      systemVersionId: versionId,
      entityDefinitionId: "character",
      name: "Aria",
      idempotencyKey: randomUUID(),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("unexpected");

    const opened = await characters.open(ctx(owner), created.value.characterId);
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("unexpected");
    expect(opened.value.state).toEqual(created.value.state);
    expect(opened.value.projection.projectionVersion).toBe("1.0");
    expect(opened.value.reconciliation.baseRevision).toBe(1);

    const strangerOpen = await characters.open(ctx(stranger), created.value.characterId);
    expect(strangerOpen).toEqual({
      ok: false,
      error: { code: "not_found", message: "The requested character does not exist." },
    });
  });

  it("rejects creation against an inaccessible private version owned by another user", async () => {
    const owner = await createUser("Ada");
    const stranger = await createUser("Bob");
    const { versionId } = await publishVersion(owner, { access: "private" });

    const result = await characters.create(ctx(stranger), {
      systemVersionId: versionId,
      entityDefinitionId: "character",
      name: "Aria",
      idempotencyKey: randomUUID(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected");
    expect(result.error.code).toBe("not_found");

    const countResult = await pool.query("SELECT count(*)::int AS count FROM characters");
    expect(countResult.rows[0]!.count).toBe(0);
  });

  it("rejects creation against an unknown entity definition", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishVersion(owner);

    const result = await characters.create(ctx(owner), {
      systemVersionId: versionId,
      entityDefinitionId: "not-an-entity",
      name: "Aria",
      idempotencyKey: randomUUID(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected");
    expect(result.error.code).toBe("not_found");

    const countResult = await pool.query("SELECT count(*)::int AS count FROM characters");
    expect(countResult.rows[0]!.count).toBe(0);
  });

  it("rejects creation against a deprecated version", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishVersion(owner, { versionLifecycle: "deprecated" });

    const result = await characters.create(ctx(owner), {
      systemVersionId: versionId,
      entityDefinitionId: "character",
      name: "Aria",
      idempotencyKey: randomUUID(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected");
    expect(result.error.code).toBe("not_found");

    const countResult = await pool.query("SELECT count(*)::int AS count FROM characters");
    expect(countResult.rows[0]!.count).toBe(0);
  });

  it("rejects creation with invalid initial values and leaves no partial rows", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishVersion(owner);

    const result = await characters.create(ctx(owner), {
      systemVersionId: versionId,
      entityDefinitionId: "character",
      name: "Aria",
      initialValues: { ability: 999 },
      idempotencyKey: randomUUID(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected");
    expect(result.error.code).toBe("invalid_value");

    const countResult = await pool.query("SELECT count(*)::int AS count FROM characters");
    expect(countResult.rows[0]!.count).toBe(0);
    const executionResult = await pool.query("SELECT count(*)::int AS count FROM character_command_executions");
    expect(executionResult.rows[0]!.count).toBe(0);
  });

  it("rolls back the whole transaction when the audit insert fails", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishVersion(owner);

    const failingPool = {
      connect: async () => {
        const client = await pool.connect();
        const originalQuery = client.query.bind(client);
        let auditAttempted = false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (client as any).query = (...args: unknown[]) => {
          const text = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string })?.text;
          if (typeof text === "string" && text.includes("character_audit_records") && !auditAttempted) {
            auditAttempted = true;
            return Promise.reject(new Error("injected audit failure"));
          }
          return originalQuery(...(args as Parameters<typeof originalQuery>));
        };
        return client;
      },
      query: pool.query.bind(pool),
    } as unknown as Pool;

    const failingCharacters = createCharactersModule({
      pool: failingPool,
      runtime,
      authorizeVersionUse: authoring.authorizeVersionUse,
    });

    const result = await failingCharacters.create(ctx(owner), {
      systemVersionId: versionId,
      entityDefinitionId: "character",
      name: "Aria",
      idempotencyKey: randomUUID(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected");
    expect(result.error.code).toBe("internal");

    const countResult = await pool.query("SELECT count(*)::int AS count FROM characters");
    expect(countResult.rows[0]!.count).toBe(0);
    const activityResult = await pool.query("SELECT count(*)::int AS count FROM character_activity_events");
    expect(activityResult.rows[0]!.count).toBe(0);
    const auditResult = await pool.query("SELECT count(*)::int AS count FROM character_audit_records");
    expect(auditResult.rows[0]!.count).toBe(0);
    const executionResult = await pool.query("SELECT count(*)::int AS count FROM character_command_executions");
    expect(executionResult.rows[0]!.count).toBe(0);
  });
});

describeWithDatabase("Characters (apply: set/bump)", () => {
  const schema = `characters_apply_${randomUUID().replaceAll("-", "")}`;
  let pool: Pool;
  let authoring: SystemAuthoring;
  let runtime: SystemRuntime;
  let characters: Characters;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: databaseUrl,
      application_name: schema,
      max: 5,
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
    });
  });

  beforeEach(async () => {
    await pool.query(`SET search_path TO ${schema}`);
    await pool.query(
      "TRUNCATE character_audit_records, character_activity_events, character_command_executions, characters, system_versions, systems, users RESTART IDENTITY CASCADE",
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

  async function createCharacter(ownerId: string, versionId: string): Promise<CharacterId> {
    const created = await characters.create(ctx(ownerId), {
      systemVersionId: versionId,
      entityDefinitionId: "character",
      name: "Aria",
      idempotencyKey: randomUUID(),
    });
    if (!created.ok) throw new Error(`unexpected create failure: ${JSON.stringify(created.error)}`);
    return created.value.characterId;
  }

  it("sets a field, increments revision, and persists Runtime's complete next state", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishVersion(owner);
    const characterId = await createCharacter(owner, versionId);

    const result = await characters.apply(ctx(owner), {
      kind: "setField",
      characterId,
      fieldId: "ability",
      value: 15,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`unexpected: ${JSON.stringify(result.error)}`);
    expect(result.value.character.revision).toBe(2);
    expect(result.value.character.state.values.ability).toBe(15);
    expect(result.value.character.reconciliation.replayed).toBe(false);
    expect(result.value.character.reconciliation.changedDefinitionIds).toEqual(["ability"]);
    expect(result.value.roll).toBeNull();

    const activity = await pool.query<{ kind: string; character_revision: number }>(
      "SELECT kind, character_revision FROM character_activity_events WHERE character_id = $1 ORDER BY character_revision",
      [characterId],
    );
    expect(activity.rows).toEqual([
      { kind: "character_created", character_revision: 1 },
      { kind: "character_field_set", character_revision: 2 },
    ]);
  });

  it("bumps a resource up and down within bounds and increments revision", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishVersion(owner);
    const characterId = await createCharacter(owner, versionId);

    const bumpDown = await characters.apply(ctx(owner), {
      kind: "bumpResource",
      characterId,
      resourceId: "health",
      direction: "down",
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(bumpDown.ok).toBe(true);
    if (!bumpDown.ok) throw new Error("unexpected");
    expect(bumpDown.value.character.revision).toBe(2);
    expect(bumpDown.value.character.state.values.health).toEqual({ current: 9, max: 10 });

    const bumpUp = await characters.apply(ctx(owner), {
      kind: "bumpResource",
      characterId,
      resourceId: "health",
      direction: "up",
      expectedRevision: 2,
      idempotencyKey: randomUUID(),
    });
    expect(bumpUp.ok).toBe(true);
    if (!bumpUp.ok) throw new Error("unexpected");
    expect(bumpUp.value.character.revision).toBe(3);
    expect(bumpUp.value.character.state.values.health).toEqual({ current: 10, max: 10 });
  });

  it("rejects a bump beyond bounds and persists no state effect", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishVersion(owner);
    const characterId = await createCharacter(owner, versionId);

    const result = await characters.apply(ctx(owner), {
      kind: "bumpResource",
      characterId,
      resourceId: "health",
      direction: "up",
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected");
    expect(result.error.code).toBe("invalid_value");

    const row = await pool.query<{ revision: number }>("SELECT revision FROM characters WHERE id = $1", [characterId]);
    expect(row.rows[0]!.revision).toBe(1);
    const activity = await pool.query(
      "SELECT count(*)::int AS count FROM character_activity_events WHERE character_id = $1 AND kind = 'character_resource_bumped'",
      [characterId],
    );
    expect(activity.rows[0]!.count).toBe(0);
  });

  it("rejects a set with an invalid value and persists no state effect", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishVersion(owner);
    const characterId = await createCharacter(owner, versionId);

    const result = await characters.apply(ctx(owner), {
      kind: "setField",
      characterId,
      fieldId: "ability",
      value: 999,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected");
    expect(result.error.code).toBe("invalid_value");

    const row = await pool.query<{ revision: number }>("SELECT revision FROM characters WHERE id = $1", [characterId]);
    expect(row.rows[0]!.revision).toBe(1);
  });

  it("rejects commands against an archived character with conflict", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishVersion(owner);
    const characterId = await createCharacter(owner, versionId);
    await pool.query("UPDATE characters SET lifecycle = 'archived' WHERE id = $1", [characterId]);

    const result = await characters.apply(ctx(owner), {
      kind: "setField",
      characterId,
      fieldId: "ability",
      value: 15,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected");
    expect(result.error.code).toBe("conflict");
  });

  it("rejects commands from a non-owner as not_found", async () => {
    const owner = await createUser("Ada");
    const stranger = await createUser("Bob");
    const { versionId } = await publishVersion(owner);
    const characterId = await createCharacter(owner, versionId);

    const result = await characters.apply(ctx(stranger), {
      kind: "setField",
      characterId,
      fieldId: "ability",
      value: 15,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected");
    expect(result.error.code).toBe("not_found");
  });

  it("rejects a stale expectedRevision with conflict and the latest revision", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishVersion(owner);
    const characterId = await createCharacter(owner, versionId);

    const first = await characters.apply(ctx(owner), {
      kind: "setField",
      characterId,
      fieldId: "ability",
      value: 15,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(first.ok).toBe(true);

    const stale = await characters.apply(ctx(owner), {
      kind: "setField",
      characterId,
      fieldId: "ability",
      value: 12,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error("unexpected");
    expect(stale.error.code).toBe("conflict");
    expect(stale.error.latestRevision).toBe(2);
    expect(stale.error.changedDefinitionIds).toEqual(["ability"]);
    expect(stale.error.cacheDisposition).toBe("replace");
    expect(typeof stale.error.activityCursor).toBe("string");
    expect(stale.error.activityCursor).not.toBe("");
  });

  it("does not finalize a transient runtime internal error, leaving the execution reclaimable", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishVersion(owner);
    const characterId = await createCharacter(owner, versionId);

    const flakyRuntime: SystemRuntime = {
      async resolve() {
        return { ok: false, error: { code: "internal", message: "Package loading failed." } };
      },
    };
    const flakyCharacters = createCharactersModule({
      pool,
      runtime: flakyRuntime,
      authorizeVersionUse: authoring.authorizeVersionUse,
    });

    const idempotencyKey = randomUUID();
    const result = await flakyCharacters.apply(ctx(owner), {
      kind: "setField",
      characterId,
      fieldId: "ability",
      value: 15,
      expectedRevision: 1,
      idempotencyKey,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected");
    expect(result.error.code).toBe("internal");

    const execution = await pool.query<{ status: string }>(
      "SELECT status FROM character_command_executions WHERE actor_id = $1 AND idempotency_key = $2",
      [owner, idempotencyKey],
    );
    expect(execution.rows[0]!.status).toBe("pending");

    const row = await pool.query<{ revision: number }>("SELECT revision FROM characters WHERE id = $1", [characterId]);
    expect(row.rows[0]!.revision).toBe(1);
  });

  it("replays identical set commands from the idempotency key and rejects changed input", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishVersion(owner);
    const characterId = await createCharacter(owner, versionId);
    const key = randomUUID();

    const first = await characters.apply(ctx(owner), {
      kind: "setField",
      characterId,
      fieldId: "ability",
      value: 15,
      expectedRevision: 1,
      idempotencyKey: key,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unexpected");

    const replay = await characters.apply(ctx(owner), {
      kind: "setField",
      characterId,
      fieldId: "ability",
      value: 15,
      expectedRevision: 1,
      idempotencyKey: key,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error("unexpected");
    expect(replay.value.character.revision).toBe(2);
    expect(replay.value.character.reconciliation.replayed).toBe(true);
    expect(replay.value.character.reconciliation.commandExecutionId).toBe(
      first.value.character.reconciliation.commandExecutionId,
    );

    const row = await pool.query<{ revision: number }>("SELECT revision FROM characters WHERE id = $1", [characterId]);
    expect(row.rows[0]!.revision).toBe(2);

    const mismatch = await characters.apply(ctx(owner), {
      kind: "setField",
      characterId,
      fieldId: "ability",
      value: 16,
      expectedRevision: 1,
      idempotencyKey: key,
    });
    expect(mismatch).toEqual({
      ok: false,
      error: { code: "idempotency_mismatch", message: "This idempotency key was already used with different input." },
    });
  });

  it("allows another actor to use the same idempotency key independently", async () => {
    const owner = await createUser("Ada");
    const other = await createUser("Bob");
    const { versionId } = await publishVersion(owner);
    const characterId = await createCharacter(owner, versionId);
    const otherCharacterId = await createCharacter(other, versionId);
    const key = randomUUID();

    const first = await characters.apply(ctx(owner), {
      kind: "setField",
      characterId,
      fieldId: "ability",
      value: 15,
      expectedRevision: 1,
      idempotencyKey: key,
    });
    expect(first.ok).toBe(true);

    const second = await characters.apply(ctx(other), {
      kind: "setField",
      characterId: otherCharacterId,
      fieldId: "ability",
      value: 12,
      expectedRevision: 1,
      idempotencyKey: key,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unexpected");
    expect(second.value.character.reconciliation.replayed).toBe(false);
  });
});
