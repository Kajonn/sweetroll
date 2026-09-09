import { randomUUID } from "node:crypto";

import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createCharactersModule,
  type CharacterId,
  type Characters,
} from "../../src/characters/index.js";
import {
  d20Document,
  d20Package,
  d6SuccessPoolPackage,
  pbta2d6Package,
} from "../../src/systems/implementation/package/fixtures/index.js";
import { compileDocument } from "../../src/systems/implementation/rules/compile-document.js";
import { createPostgresPublishedPackageLoader } from "../../src/systems/implementation/runtime/package-loader.js";
import { signSystemPackage } from "../../src/systems/implementation/package/canonical.js";
import type {
  SystemPackageV1,
  UnsignedSystemPackageV1,
} from "../../src/systems/implementation/package/schema/index.js";
import { createSystemRuntime, type SystemRuntime } from "../../src/systems/runtime.js";
import { createSystemAuthoringModule, type SystemAuthoring } from "../../src/systems/authoring.js";
import { createSystemPersistenceRepository } from "../../src/systems/implementation/persistence/index.js";
import { canonicalizeCharacterExport } from "../../src/characters/export.js";

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
    expect(result.value.projection.completionFields).toEqual([
      expect.objectContaining({ fieldId: "proficient" }),
    ]);
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

  it("replays historical create and command receipts without completion metadata or resolution", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishVersion(owner);
    const input = { systemVersionId: versionId, entityDefinitionId: "character", name: "Aria", idempotencyKey: randomUUID() };
    const created = await characters.create(ctx(owner), input);
    if (!created.ok) throw new Error(created.error.code);
    const command = { kind: "setField" as const, characterId: created.value.characterId,
      fieldId: "ability", value: 15, expectedRevision: 1, idempotencyKey: randomUUID() };
    const applied = await characters.apply(ctx(owner), command);
    if (!applied.ok) throw new Error(applied.error.code);
    // Model receipts persisted before completion metadata existed, inside the replay window.
    await pool.query(`UPDATE character_command_executions
      SET result_json = result_json #- '{projection,completionFields}' #- '{value,character,projection,completionFields}'
      WHERE actor_id = $1`, [owner]);
    const before = await pool.query("SELECT result_json FROM character_command_executions ORDER BY id");
    const resolveSpy = vi.spyOn(runtime, "resolve");
    try {
      const createReplay = await characters.create(ctx(owner), input);
      const commandReplay = await characters.apply(ctx(owner), command);
      if (!createReplay.ok || !commandReplay.ok) throw new Error("Replay failed");
      const replayed = createReplay.value;
      expect(replayed.projection).not.toHaveProperty("completionFields");
      expect(commandReplay.value.character.projection).not.toHaveProperty("completionFields");
      expect(replayed.reconciliation.replayed).toBe(true);
      expect(commandReplay.value.character.reconciliation.replayed).toBe(true);
      expect(resolveSpy).not.toHaveBeenCalled();
      expect(createReplay.value).toEqual({ ...created.value, projection: replayed.projection,
        reconciliation: { ...created.value.reconciliation, replayed: true } });
      expect(commandReplay.value).toEqual({ ...applied.value, character: { ...applied.value.character,
        projection: commandReplay.value.character.projection,
        reconciliation: { ...applied.value.character.reconciliation, replayed: true } } });
      expect((await pool.query("SELECT result_json FROM character_command_executions ORDER BY id")).rows).toEqual(before.rows);
    } finally {
      resolveSpy.mockRestore();
    }
    const fresh = await characters.open(ctx(owner), created.value.characterId);
    if (!fresh.ok) throw new Error(fresh.error.code);
    expect(fresh.value.projection.completionFields).toEqual([
      expect.objectContaining({ fieldId: "proficient" }),
    ]);
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
      listAuthorizedVersions: authoring.listAuthorizedVersions,
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

  it("does not finalize a transient runtime failure, leaving the execution reclaimable", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishVersion(owner);
    const characterId = await createCharacter(owner, versionId);

    const flakyRuntime: SystemRuntime = {
      async resolve() {
        return { ok: false, error: { code: "internal", message: "Package loading failed." } };
      },
      async describeVersion() {
        return { ok: false, error: { code: "internal", message: "Package loading failed." } };
      },
    };
    const flakyCharacters = createCharactersModule({
      pool,
      runtime: flakyRuntime,
      authorizeVersionUse: authoring.authorizeVersionUse,
      listAuthorizedVersions: authoring.listAuthorizedVersions,
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
    expect(result.error.code).toBe("temporarily_unavailable");

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

describeWithDatabase("Characters (apply: executeAction)", () => {
  const schema = `characters_action_${randomUUID().replaceAll("-", "")}`;
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

  function repackage(basePackage: SystemPackageV1, versionId: string): SystemPackageV1 {
    const unsigned = structuredClone(basePackage) as unknown as UnsignedSystemPackageV1 & { integrity?: unknown };
    delete unsigned.integrity;
    unsigned.versionId = versionId;
    return signSystemPackage(unsigned);
  }

  async function publishVersion(
    ownerId: string,
    basePackage: SystemPackageV1 = d20Package,
  ): Promise<{ systemId: string; versionId: string }> {
    const systemResult = await pool.query<{ id: string }>(
      "INSERT INTO systems (owner_id, name, access, lifecycle) VALUES ($1, $2, 'public', 'active') RETURNING id",
      [ownerId, "System"],
    );
    const systemId = systemResult.rows[0]!.id;
    const versionId = randomUUID();
    const packageValue = repackage(basePackage, versionId);
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

  function buildD20ActionableCombatPackage(versionId: string): SystemPackageV1 {
    const document = structuredClone(d20Document);
    document.sheets[0]!.sections[2]!.elements.push({ kind: "action", id: "damage_element", actionId: "damage" });
    const result = compileDocument(document, {
      systemId: "a0000000-0000-5000-8000-000000000001",
      versionId,
      semanticVersion: "1.0.0",
    });
    if (!result.ok) throw new Error(`Fixture did not compile: ${JSON.stringify(result.diagnostics)}`);
    return result.value;
  }

  async function publishActionableCombatVersion(ownerId: string): Promise<{ systemId: string; versionId: string }> {
    const systemResult = await pool.query<{ id: string }>(
      "INSERT INTO systems (owner_id, name, access, lifecycle) VALUES ($1, $2, 'public', 'active') RETURNING id",
      [ownerId, "System"],
    );
    const systemId = systemResult.rows[0]!.id;
    const versionId = randomUUID();
    const packageValue = buildD20ActionableCombatPackage(versionId);
    await pool.query(
      "INSERT INTO system_versions (id, system_id, semantic_version, checksum, package_json, lifecycle) VALUES ($1, $2, '1.0.0', $3, $4::jsonb, 'published')",
      [versionId, systemId, packageValue.integrity.checksum, JSON.stringify(packageValue)],
    );
    return { systemId, versionId };
  }

  it("executes a d20 check roll action, persists the roll, and leaves revision unchanged", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishVersion(owner, d20Package);
    const characterId = await createCharacter(owner, versionId);

    const result = await characters.apply(ctx(owner), {
      kind: "executeAction",
      characterId,
      actionId: "check",
      inputs: { bonus: 2 },
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`unexpected: ${JSON.stringify(result.error)}`);
    expect(result.value.character.revision).toBe(1);
    expect(result.value.roll).not.toBeNull();
    const roll = result.value.roll!;
    expect(roll.actionId).toBe("check");
    expect(roll.expression).toBe("d20 + fields.modifier + inputs.bonus");
    expect(roll.dice).toHaveLength(1);
    expect(roll.dice[0]!.sides).toBe(20);
    expect(roll.bindings).toEqual(
      expect.arrayContaining([
        { scope: "fields", definitionId: "modifier", value: 0 },
        { scope: "inputs", definitionId: "bonus", value: 2 },
      ]),
    );
    expect(roll.total).toBe(roll.dice[0]!.value + 0 + 2);
    expect(roll.output).toBe(`Result: ${roll.total}`);

    const rollRow = await pool.query<{
      character_id: string;
      actor_id: string;
      action_id: string;
      audience: string;
      request_id: string;
      total: number;
    }>("SELECT character_id, actor_id, action_id, audience, request_id, total FROM character_rolls WHERE character_id = $1", [
      characterId,
    ]);
    expect(rollRow.rows).toHaveLength(1);
    expect(rollRow.rows[0]).toMatchObject({
      character_id: characterId,
      actor_id: owner,
      action_id: "check",
      audience: "owner_only",
      total: roll.total,
    });

    const activity = await pool.query<{ kind: string; roll_id: string | null; request_id: string }>(
      "SELECT kind, roll_id, request_id FROM character_activity_events WHERE character_id = $1 AND kind = 'character_action_executed'",
      [characterId],
    );
    expect(activity.rows).toHaveLength(1);
    expect(activity.rows[0]!.roll_id).not.toBeNull();

    const row = await pool.query<{ revision: number }>("SELECT revision FROM characters WHERE id = $1", [characterId]);
    expect(row.rows[0]!.revision).toBe(1);
  });

  it("executes a PbtA 2d6 move action and persists normalized dice/bindings", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishVersion(owner, pbta2d6Package);
    const characterId = await createCharacter(owner, versionId);

    const result = await characters.apply(ctx(owner), {
      kind: "executeAction",
      characterId,
      actionId: "make_move",
      inputs: { forward: 1 },
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`unexpected: ${JSON.stringify(result.error)}`);
    expect(result.value.character.revision).toBe(1);
    const roll = result.value.roll!;
    expect(roll.actionId).toBe("make_move");
    expect(roll.dice).toHaveLength(2);
    expect(roll.dice.every((die) => die.sides === 6)).toBe(true);
    expect(roll.total).toBe(roll.dice.reduce((sum, die) => sum + die.value, 0) + 0 + 1);
  });

  it("executes a d6 success pool action and persists normalized dice/bindings", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishVersion(owner, d6SuccessPoolPackage);
    const characterId = await createCharacter(owner, versionId);

    const result = await characters.apply(ctx(owner), {
      kind: "executeAction",
      characterId,
      actionId: "test_pool",
      inputs: { bonus_dice: 1 },
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`unexpected: ${JSON.stringify(result.error)}`);
    expect(result.value.character.revision).toBe(1);
    const roll = result.value.roll!;
    expect(roll.actionId).toBe("test_pool");
    // attribute(1) + skill(1) + bonus_dice(1) = 3 dice
    expect(roll.dice).toHaveLength(3);
    expect(roll.dice.every((die) => die.sides === 6)).toBe(true);
  });

  it("executes a resource-bump action, persists no roll, and increments revision", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishActionableCombatVersion(owner);
    const characterId = await createCharacter(owner, versionId);

    const result = await characters.apply(ctx(owner), {
      kind: "executeAction",
      characterId,
      actionId: "damage",
      inputs: {},
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`unexpected: ${JSON.stringify(result.error)}`);
    expect(result.value.roll).toBeNull();
    expect(result.value.character.revision).toBe(2);
    expect(result.value.character.state.values.health).toEqual({ current: 9, max: 10 });

    const rollCount = await pool.query("SELECT count(*)::int AS count FROM character_rolls WHERE character_id = $1", [
      characterId,
    ]);
    expect(rollCount.rows[0]!.count).toBe(0);

    const activity = await pool.query<{ kind: string; roll_id: string | null }>(
      "SELECT kind, roll_id FROM character_activity_events WHERE character_id = $1 AND kind = 'character_action_executed'",
      [characterId],
    );
    expect(activity.rows).toHaveLength(1);
    expect(activity.rows[0]!.roll_id).toBeNull();
  });

  it("replays an identical action from the idempotency key with identical dice and exactly one roll/activity row", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishVersion(owner, d20Package);
    const characterId = await createCharacter(owner, versionId);
    const key = randomUUID();

    const first = await characters.apply(ctx(owner), {
      kind: "executeAction",
      characterId,
      actionId: "check",
      inputs: { bonus: 2 },
      expectedRevision: 1,
      idempotencyKey: key,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unexpected");

    const replay = await characters.apply(ctx(owner), {
      kind: "executeAction",
      characterId,
      actionId: "check",
      inputs: { bonus: 2 },
      expectedRevision: 1,
      idempotencyKey: key,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error("unexpected");
    expect(replay.value.character.reconciliation.replayed).toBe(true);
    expect(replay.value.roll).toEqual(first.value.roll);

    const rollCount = await pool.query("SELECT count(*)::int AS count FROM character_rolls WHERE character_id = $1", [
      characterId,
    ]);
    expect(rollCount.rows[0]!.count).toBe(1);
    const activityCount = await pool.query(
      "SELECT count(*)::int AS count FROM character_activity_events WHERE character_id = $1 AND kind = 'character_action_executed'",
      [characterId],
    );
    expect(activityCount.rows[0]!.count).toBe(1);
  });

  it("rolls back state, roll, activity, and execution completion when the roll insert fails", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishVersion(owner, d20Package);
    const characterId = await createCharacter(owner, versionId);

    const failingPool = {
      connect: async () => {
        const client = await pool.connect();
        const originalQuery = client.query.bind(client);
        const originalRelease = client.release.bind(client);
        let attempted = false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (client as any).query = (...args: unknown[]) => {
          const text = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string })?.text;
          if (typeof text === "string" && text.includes("INSERT INTO character_rolls") && !attempted) {
            attempted = true;
            return Promise.reject(new Error("injected roll insert failure"));
          }
          return originalQuery(...(args as Parameters<typeof originalQuery>));
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (client as any).release = (...args: unknown[]) => {
          (client as any).query = originalQuery;
          return originalRelease(...(args as Parameters<typeof originalRelease>));
        };
        return client;
      },
      query: pool.query.bind(pool),
    } as unknown as Pool;

    const failingCharacters = createCharactersModule({
      pool: failingPool,
      runtime,
      authorizeVersionUse: authoring.authorizeVersionUse,
      listAuthorizedVersions: authoring.listAuthorizedVersions,
    });

    const idempotencyKey = randomUUID();
    const result = await failingCharacters.apply(ctx(owner), {
      kind: "executeAction",
      characterId,
      actionId: "check",
      inputs: { bonus: 2 },
      expectedRevision: 1,
      idempotencyKey,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected");
    expect(result.error.code).toBe("internal");

    const rollCount = await pool.query("SELECT count(*)::int AS count FROM character_rolls WHERE character_id = $1", [
      characterId,
    ]);
    expect(rollCount.rows[0]!.count).toBe(0);
    const activityCount = await pool.query(
      "SELECT count(*)::int AS count FROM character_activity_events WHERE character_id = $1 AND kind = 'character_action_executed'",
      [characterId],
    );
    expect(activityCount.rows[0]!.count).toBe(0);
    const row = await pool.query<{ revision: number }>("SELECT revision FROM characters WHERE id = $1", [characterId]);
    expect(row.rows[0]!.revision).toBe(1);
    const execution = await pool.query<{ status: string }>(
      "SELECT status FROM character_command_executions WHERE actor_id = $1 AND idempotency_key = $2",
      [owner, idempotencyKey],
    );
    expect(execution.rows[0]!.status).toBe("pending");
  });

  it("replays a restart-safe result from a second Runtime/Characters instance without invoking RNG again", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishVersion(owner, d20Package);
    const characterId = await createCharacter(owner, versionId);
    const key = randomUUID();

    const first = await characters.apply(ctx(owner), {
      kind: "executeAction",
      characterId,
      actionId: "check",
      inputs: { bonus: 2 },
      expectedRevision: 1,
      idempotencyKey: key,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unexpected");

    // A second runtime/module instance with the same secret and database, but whose
    // runtime and execution-ID generator would produce different/incompatible output
    // if actually invoked. A correct replay must never call either.
    const throwingRuntime: SystemRuntime = {
      async resolve() {
        throw new Error("RNG-backed resolve must not be invoked on replay");
      },
      async describeVersion() {
        throw new Error("describeVersion must not be invoked on replay");
      },
    };
    const secondInstanceCharacters = createCharactersModule({
      pool,
      runtime: throwingRuntime,
      authorizeVersionUse: authoring.authorizeVersionUse,
      listAuthorizedVersions: authoring.listAuthorizedVersions,
      newExecutionId: () => "00000000-0000-4000-8000-000000000099",
    });

    const replay = await secondInstanceCharacters.apply(ctx(owner), {
      kind: "executeAction",
      characterId,
      actionId: "check",
      inputs: { bonus: 2 },
      expectedRevision: 1,
      idempotencyKey: key,
    });

    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error("unexpected");
    expect(replay.value.character.reconciliation.replayed).toBe(true);
    expect(replay.value.character.reconciliation.commandExecutionId).toBe(
      first.value.character.reconciliation.commandExecutionId,
    );
    expect(replay.value.character.reconciliation.commandExecutionId).not.toBe("00000000-0000-4000-8000-000000000099");
    expect(replay.value.roll).toEqual(first.value.roll);

    const rollCount = await pool.query("SELECT count(*)::int AS count FROM character_rolls WHERE character_id = $1", [
      characterId,
    ]);
    expect(rollCount.rows[0]!.count).toBe(1);
  });
});


describeWithDatabase("Characters (manage/activity/export)", () => {
  const schema = `characters_manage_${randomUUID().replaceAll("-", "")}`;
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

  it("renames a character, increments revision, and writes activity/audit", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishVersion(owner);
    const characterId = await createCharacter(owner, versionId);

    const result = await characters.manage(ctx(owner), {
      kind: "rename",
      characterId,
      name: "Renamed",
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`unexpected: ${JSON.stringify(result.error)}`);
    expect(result.value.character.name).toBe("Renamed");
    expect(result.value.character.revision).toBe(2);
    expect(result.value.roll).toBeNull();

    const activity = await pool.query<{ kind: string }>(
      "SELECT kind FROM character_activity_events WHERE character_id = $1 AND kind = 'character_renamed'",
      [characterId],
    );
    expect(activity.rows).toHaveLength(1);
    const audit = await pool.query<{ kind: string }>(
      "SELECT kind FROM character_audit_records WHERE character_id = $1 AND kind = 'character_renamed'",
      [characterId],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it("transfers ownership, revokes the old owner immediately, grants the new owner, and denies receipt replay for the old owner", async () => {
    const owner = await createUser("Ada");
    const newOwner = await createUser("Bob");
    const { versionId } = await publishVersion(owner);
    const characterId = await createCharacter(owner, versionId);
    const key = randomUUID();

    const result = await characters.manage(ctx(owner), {
      kind: "transferOwnership",
      characterId,
      toUserId: newOwner,
      expectedRevision: 1,
      idempotencyKey: key,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`unexpected: ${JSON.stringify(result.error)}`);
    expect(result.value.character.ownerId).toBe(newOwner);
    expect(result.value.character.revision).toBe(2);

    const oldOwnerOpen = await characters.open(ctx(owner), characterId);
    expect(oldOwnerOpen).toEqual({
      ok: false,
      error: {
        code: "not_found",
        message: "The requested character does not exist.",
      },
    });

    const newOwnerOpen = await characters.open(ctx(newOwner), characterId);
    expect(newOwnerOpen.ok).toBe(true);
    if (!newOwnerOpen.ok) throw new Error("unexpected");
    expect(newOwnerOpen.value.ownerId).toBe(newOwner);

    const replay = await characters.manage(ctx(owner), {
      kind: "transferOwnership",
      characterId,
      toUserId: newOwner,
      expectedRevision: 1,
      idempotencyKey: key,
    });
    // I6 Task 1: the saved transfer receipt must not be disclosed to the
    // previous owner after ownership moved. The mutation stays committed.
    expect(replay.ok).toBe(false);
    if (replay.ok) throw new Error("unexpected");
    expect(replay.error.code).toBe("not_found");
    expect(replay).not.toHaveProperty("value");

    const stillTransferred = await characters.open(ctx(newOwner), characterId);
    expect(stillTransferred.ok).toBe(true);
    if (!stillTransferred.ok) throw new Error("unexpected");
    expect(stillTransferred.value.ownerId).toBe(newOwner);
    expect(stillTransferred.value.revision).toBe(2);
  });

  it("rejects transfer to a nonexistent destination user without mutating the character", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishVersion(owner);
    const characterId = await createCharacter(owner, versionId);

    const result = await characters.manage(ctx(owner), {
      kind: "transferOwnership",
      characterId,
      toUserId: randomUUID(),
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected");
    expect(result.error.code).toBe("invalid_value");

    const row = await pool.query<{ owner_id: string; revision: number }>(
      "SELECT owner_id, revision FROM characters WHERE id = $1",
      [characterId],
    );
    expect(row.rows[0]).toEqual({ owner_id: owner, revision: 1 });
  });

  it("blocks play commands on an archived character but allows read and export; recover restores play", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishVersion(owner);
    const characterId = await createCharacter(owner, versionId);

    const archived = await characters.manage(ctx(owner), {
      kind: "archive",
      characterId,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(archived.ok).toBe(true);
    if (!archived.ok) throw new Error(`unexpected: ${JSON.stringify(archived.error)}`);
    expect(archived.value.character.lifecycle).toBe("archived");
    expect(archived.value.character.revision).toBe(2);

    const blockedSet = await characters.apply(ctx(owner), {
      kind: "setField",
      characterId,
      fieldId: "ability",
      value: 15,
      expectedRevision: 2,
      idempotencyKey: randomUUID(),
    });
    expect(blockedSet.ok).toBe(false);
    if (blockedSet.ok) throw new Error("unexpected");
    expect(blockedSet.error.code).toBe("conflict");

    const opened = await characters.open(ctx(owner), characterId);
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("unexpected");
    expect(opened.value.lifecycle).toBe("archived");

    const exported = await characters.exportCharacter(ctx(owner), { characterId });
    expect(exported.ok).toBe(true);
    if (!exported.ok) throw new Error("unexpected");
    expect(exported.value.lifecycle).toBe("archived");

    const recovered = await characters.manage(ctx(owner), {
      kind: "recover",
      characterId,
      expectedRevision: 2,
      idempotencyKey: randomUUID(),
    });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error(`unexpected: ${JSON.stringify(recovered.error)}`);
    expect(recovered.value.character.lifecycle).toBe("active");
    expect(recovered.value.character.revision).toBe(3);

    const playAgain = await characters.apply(ctx(owner), {
      kind: "setField",
      characterId,
      fieldId: "ability",
      value: 15,
      expectedRevision: 3,
      idempotencyKey: randomUUID(),
    });
    expect(playAgain.ok).toBe(true);
    if (!playAgain.ok) throw new Error(`unexpected: ${JSON.stringify(playAgain.error)}`);
    expect(playAgain.value.character.state.values.ability).toBe(15);
  });

  it("paginates activity in stable (occurred_at DESC, id DESC) order across tied timestamps with minimized payloads", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishVersion(owner);
    const characterId = await createCharacter(owner, versionId);

    let revision = 1;
    for (let i = 0; i < 4; i += 1) {
      const result = await characters.apply(ctx(owner), {
        kind: "setField",
        characterId,
        fieldId: "ability",
        value: 10 + i,
        expectedRevision: revision,
        idempotencyKey: randomUUID(),
      });
      if (!result.ok) throw new Error(`unexpected: ${JSON.stringify(result.error)}`);
      revision = result.value.character.revision;
    }

    // Force every activity event to the same occurred_at to exercise the (occurred_at, id) tiebreak.
    await pool.query("UPDATE character_activity_events SET occurred_at = now() WHERE character_id = $1", [characterId]);

    const page1 = await characters.listActivity(ctx(owner), { characterId, limit: 3, cursor: null });
    expect(page1.ok).toBe(true);
    if (!page1.ok) throw new Error("unexpected");
    expect(page1.value.events).toHaveLength(3);
    expect(page1.value.nextCursor).not.toBeNull();

    const page2 = await characters.listActivity(ctx(owner), {
      characterId,
      limit: 3,
      cursor: page1.value.nextCursor,
    });
    expect(page2.ok).toBe(true);
    if (!page2.ok) throw new Error("unexpected");
    // 1 create + 4 field-set = 5 events total; page1 took 3, page2 has the remaining 2.
    expect(page2.value.events).toHaveLength(2);
    expect(page2.value.nextCursor).toBeNull();

    const allIds = [...page1.value.events, ...page2.value.events].map((e) => e.id);
    expect(new Set(allIds).size).toBe(5);

    const fieldSetEvent = [...page1.value.events, ...page2.value.events].find(
      (e) => e.kind === "character_field_set",
    );
    expect(fieldSetEvent).toBeDefined();
    expect(fieldSetEvent!.payload).not.toHaveProperty("value");
    expect(fieldSetEvent!.payload).toMatchObject({ fieldId: "ability" });
    for (const event of [...page1.value.events, ...page2.value.events]) {
      const serialized = JSON.stringify(event.payload);
      expect(serialized).not.toMatch(/email|session|idempotencyKey|externalIdentity/i);
    }
  });

  it("exports a canonical, account-data-free document with a stable media type and byte-equivalent replay", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishVersion(owner);
    const characterId = await createCharacter(owner, versionId);

    await characters.apply(ctx(owner), {
      kind: "setField",
      characterId,
      fieldId: "ability",
      value: 15,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });

    const first = await characters.exportCharacter(ctx(owner), { characterId });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(`unexpected: ${JSON.stringify(first.error)}`);
    expect(first.value.mediaType).toBe("application/vnd.sweetroll.character+json;version=1");
    expect(first.value.schemaVersion).toBe("1.0");
    expect(first.value.characterId).toBe(characterId);
    expect(first.value.systemVersionId).toBe(versionId);
    expect(first.value.revision).toBe(2);
    expect(first.value.state.values.ability).toBe(15);
    expect(first.value.migrationLineage).toEqual([]);
    expect(typeof first.value.packageChecksum).toBe("string");
    expect(first.value.packageChecksum.length).toBeGreaterThan(0);

    const serialized = JSON.stringify(first.value);
    expect(serialized).not.toContain(owner);
    expect(serialized).not.toMatch(/ownerId|actorId|requestId|executionId/i);

    const second = await characters.exportCharacter(ctx(owner), { characterId });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unexpected");
    expect(canonicalizeCharacterExport(second.value)).toBe(canonicalizeCharacterExport(first.value));

    const auditRows = await pool.query<{ kind: string }>(
      "SELECT kind FROM character_audit_records WHERE character_id = $1 AND kind = 'character_exported'",
      [characterId],
    );
    expect(auditRows.rows.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects manage commands from a non-owner as not_found with purge cache disposition", async () => {
    const owner = await createUser("Ada");
    const stranger = await createUser("Bob");
    const { versionId } = await publishVersion(owner);
    const characterId = await createCharacter(owner, versionId);

    const result = await characters.manage(ctx(stranger), {
      kind: "rename",
      characterId,
      name: "Nope",
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected");
    expect(result.error.code).toBe("not_found");
    expect(result.error.cacheDisposition).toBe("purge");
  });

  it("rejects listActivity from a non-owner as not_found", async () => {
    const owner = await createUser("Ada");
    const stranger = await createUser("Bob");
    const { versionId } = await publishVersion(owner);
    const characterId = await createCharacter(owner, versionId);

    const result = await characters.listActivity(ctx(stranger), { characterId, limit: 10, cursor: null });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected");
    expect(result.error.code).toBe("not_found");
  });

  it("rejects exportCharacter from a non-owner as not_found", async () => {
    const owner = await createUser("Ada");
    const stranger = await createUser("Bob");
    const { versionId } = await publishVersion(owner);
    const characterId = await createCharacter(owner, versionId);

    const result = await characters.exportCharacter(ctx(stranger), { characterId });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected");
    expect(result.error.code).toBe("not_found");
  });
});
