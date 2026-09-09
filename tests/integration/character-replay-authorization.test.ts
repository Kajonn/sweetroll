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
} from "../../src/systems/implementation/package/fixtures/index.js";
import { compileDocument } from "../../src/systems/implementation/rules/compile-document.js";
import { createPostgresPublishedPackageLoader } from "../../src/systems/implementation/runtime/package-loader.js";
import { signSystemPackage } from "../../src/systems/implementation/package/canonical.js";
import type {
  SystemPackageV1,
  UnsignedSystemPackageV1,
} from "../../src/systems/implementation/package/schema/index.js";
import type { SystemDocumentV1 } from "../../src/systems/implementation/package/schema/index.js";
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
  CREATE TABLE character_migration_previews (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    character_id             uuid NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
    owner_id                 uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    source_revision          integer NOT NULL CHECK (source_revision >= 1),
    source_version_id        uuid NOT NULL REFERENCES system_versions(id) ON DELETE RESTRICT,
    source_checksum          text NOT NULL,
    target_version_id        uuid NOT NULL REFERENCES system_versions(id) ON DELETE RESTRICT,
    target_checksum          text NOT NULL,
    mapping_json             jsonb NOT NULL,
    candidate_state_json     jsonb NOT NULL,
    candidate_projection_json jsonb NOT NULL,
    warnings_json            jsonb NOT NULL,
    preview_checksum         text NOT NULL,
    created_at               timestamptz NOT NULL DEFAULT now(),
    expires_at               timestamptz NOT NULL,
    consumed_at              timestamptz
  );
  CREATE TABLE character_migrations (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    character_id          uuid NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
    preview_id            uuid NOT NULL UNIQUE REFERENCES character_migration_previews(id) ON DELETE RESTRICT,
    source_version_id     uuid NOT NULL REFERENCES system_versions(id) ON DELETE RESTRICT,
    target_version_id     uuid NOT NULL REFERENCES system_versions(id) ON DELETE RESTRICT,
    before_state_json     jsonb NOT NULL,
    after_state_json      jsonb NOT NULL,
    commit_revision       integer NOT NULL CHECK (commit_revision >= 2),
    rollback_deadline     timestamptz NOT NULL,
    actor_id              uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    request_id            text NOT NULL,
    committed_at          timestamptz NOT NULL DEFAULT now(),
    rollback_revision     integer CHECK (rollback_revision >= 1),
    rolled_back_at        timestamptz
  );
`;

describeWithDatabase("Character replay authorization (I6 Task 1)", () => {
  const schema = `characters_replay_auth_${randomUUID().replaceAll("-", "")}`;
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
      "TRUNCATE character_migrations, character_migration_previews, character_audit_records, character_activity_events, character_rolls, character_command_executions, characters, system_versions, systems, users RESTART IDENTITY CASCADE",
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

  function buildD20V2Document(): SystemDocumentV1 {
    const document = structuredClone(d20Document);
    const fields = document.entities[0]!.fields;
    const abilityIndex = fields.findIndex((f) => f.id === "ability");
    fields[abilityIndex]!.id = "ability_score";
    fields.splice(
      fields.findIndex((f) => f.id === "proficient"),
      1,
    );
    fields.push({
      kind: "integer",
      id: "level",
      label: "Level",
      default: 1,
      required: true,
      min: 1,
      max: 20,
      step: 1,
    });
    const abilityElement = document.sheets[0]!.sections[1]!.elements.find(
      (e) => e.kind === "field" && e.fieldId === "ability",
    );
    if (abilityElement?.kind === "field") abilityElement.fieldId = "ability_score";
    const abilityValid = document.expressions.find((e) => e.id === "ability_valid_expr");
    if (abilityValid) abilityValid.source = "fields.ability_score >= 3 && fields.ability_score <= 18";
    const validation = document.validations.find((v) => v.id === "ability_valid");
    if (validation) validation.targetId = "ability_score";
    return document;
  }

  async function publishV2Version(ownerId: string, systemId: string): Promise<string> {
    const versionId = randomUUID();
    const document = buildD20V2Document();
    const compiled = compileDocument(document, { systemId, versionId, semanticVersion: "2.0.0" });
    if (!compiled.ok) throw new Error(`v2 did not compile: ${JSON.stringify(compiled.diagnostics)}`);
    await pool.query(
      "INSERT INTO system_versions (id, system_id, semantic_version, checksum, package_json, lifecycle) VALUES ($1, $2, '2.0.0', $3, $4::jsonb, 'published')",
      [versionId, systemId, compiled.value.integrity.checksum, JSON.stringify(compiled.value)],
    );
    return versionId;
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

  async function transferOwnership(ownerId: string, characterId: string, toUserId: string): Promise<number> {
    const opened = await characters.open(ctx(ownerId), characterId);
    if (!opened.ok) throw new Error(`unexpected open failure: ${JSON.stringify(opened.error)}`);
    const transferred = await characters.manage(ctx(ownerId), {
      kind: "transferOwnership",
      characterId,
      toUserId,
      expectedRevision: opened.value.revision,
      idempotencyKey: randomUUID(),
    });
    if (!transferred.ok) throw new Error(`unexpected transfer failure: ${JSON.stringify(transferred.error)}`);
    return transferred.value.character.revision;
  }

  it("keeps same-owner action replay byte-stable before any transfer", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishVersion(owner);
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
    if (!first.ok) throw new Error(`unexpected: ${JSON.stringify(first.error)}`);

    const replay = await characters.apply(ctx(owner), {
      kind: "executeAction",
      characterId,
      actionId: "check",
      inputs: { bonus: 2 },
      expectedRevision: 1,
      idempotencyKey: key,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error(`unexpected: ${JSON.stringify(replay.error)}`);
    expect(replay.value.character.reconciliation.replayed).toBe(true);
    expect(replay.value.roll).toEqual(first.value.roll);
    expect(replay.value.character.state).toEqual(first.value.character.state);

    const rolls = await pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM character_rolls WHERE character_id = $1",
      [characterId],
    );
    expect(rolls.rows[0]!.count).toBe("1");
  });

  it("denies action replay to the previous owner after transfer without re-executing", async () => {
    const ownerA = await createUser("Ada");
    const ownerB = await createUser("Bob");
    const { versionId } = await publishVersion(ownerA);
    const characterId = await createCharacter(ownerA, versionId);
    const key = randomUUID();

    const first = await characters.apply(ctx(ownerA), {
      kind: "executeAction",
      characterId,
      actionId: "check",
      inputs: { bonus: 2 },
      expectedRevision: 1,
      idempotencyKey: key,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(`unexpected: ${JSON.stringify(first.error)}`);
    const firstTotal = first.value.roll!.total;

    await transferOwnership(ownerA, characterId, ownerB);

    const resolveSpy = vi.spyOn(runtime, "resolve");
    try {
      const replay = await characters.apply(ctx(ownerA), {
        kind: "executeAction",
        characterId,
        actionId: "check",
        inputs: { bonus: 2 },
        expectedRevision: 1,
        idempotencyKey: key,
      });
      expect(replay.ok).toBe(false);
      if (replay.ok) throw new Error("previous owner replay must be denied");
      expect(replay.error.code).toBe("not_found");
      expect(replay).not.toHaveProperty("value");
      expect(resolveSpy).not.toHaveBeenCalled();
    } finally {
      resolveSpy.mockRestore();
    }

    const asNewOwner = await characters.open(ctx(ownerB), characterId);
    expect(asNewOwner.ok).toBe(true);
    if (!asNewOwner.ok) throw new Error("unexpected");
    expect(asNewOwner.value.ownerId).toBe(ownerB);

    const rolls = await pool.query<{ count: string; total: number }>(
      "SELECT count(*) AS count, max(total) AS total FROM character_rolls WHERE character_id = $1",
      [characterId],
    );
    expect(rolls.rows[0]!.count).toBe("1");
    expect(rolls.rows[0]!.total).toBe(firstTotal);
  });

  it("denies setField replay to the previous owner after transfer", async () => {
    const ownerA = await createUser("Ada");
    const ownerB = await createUser("Bob");
    const { versionId } = await publishVersion(ownerA);
    const characterId = await createCharacter(ownerA, versionId);
    const key = randomUUID();

    const first = await characters.apply(ctx(ownerA), {
      kind: "setField",
      characterId,
      fieldId: "ability",
      value: 15,
      expectedRevision: 1,
      idempotencyKey: key,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(`unexpected: ${JSON.stringify(first.error)}`);

    await transferOwnership(ownerA, characterId, ownerB);

    const replay = await characters.apply(ctx(ownerA), {
      kind: "setField",
      characterId,
      fieldId: "ability",
      value: 15,
      expectedRevision: 1,
      idempotencyKey: key,
    });
    expect(replay.ok).toBe(false);
    if (replay.ok) throw new Error("previous owner replay must be denied");
    expect(replay.error.code).toBe("not_found");
    expect(replay).not.toHaveProperty("value");

    const asNewOwner = await characters.open(ctx(ownerB), characterId);
    expect(asNewOwner.ok).toBe(true);
    if (!asNewOwner.ok) throw new Error("unexpected");
    expect(asNewOwner.value.state.values.ability).toBe(15);
  });

  it("denies recover replay to the previous owner after transfer", async () => {
    const ownerA = await createUser("Ada");
    const ownerB = await createUser("Bob");
    const { versionId } = await publishVersion(ownerA);
    const characterId = await createCharacter(ownerA, versionId);

    const archived = await characters.manage(ctx(ownerA), {
      kind: "archive",
      characterId,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(archived.ok).toBe(true);
    if (!archived.ok) throw new Error(`unexpected: ${JSON.stringify(archived.error)}`);

    const recoverKey = randomUUID();
    const recovered = await characters.manage(ctx(ownerA), {
      kind: "recover",
      characterId,
      expectedRevision: 2,
      idempotencyKey: recoverKey,
    });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error(`unexpected: ${JSON.stringify(recovered.error)}`);

    await transferOwnership(ownerA, characterId, ownerB);

    const replay = await characters.manage(ctx(ownerA), {
      kind: "recover",
      characterId,
      expectedRevision: 2,
      idempotencyKey: recoverKey,
    });
    expect(replay.ok).toBe(false);
    if (replay.ok) throw new Error("previous owner recover replay must be denied");
    expect(replay.error.code).toBe("not_found");
    expect(replay).not.toHaveProperty("value");

    const asNewOwner = await characters.open(ctx(ownerB), characterId);
    expect(asNewOwner.ok).toBe(true);
    if (!asNewOwner.ok) throw new Error("unexpected");
    expect(asNewOwner.value.lifecycle).toBe("active");
    expect(asNewOwner.value.ownerId).toBe(ownerB);
  });

  it("denies export to the previous owner after transfer", async () => {
    const ownerA = await createUser("Ada");
    const ownerB = await createUser("Bob");
    const { versionId } = await publishVersion(ownerA);
    const characterId = await createCharacter(ownerA, versionId);

    const before = await characters.exportCharacter(ctx(ownerA), { characterId });
    expect(before.ok).toBe(true);

    await transferOwnership(ownerA, characterId, ownerB);

    const after = await characters.exportCharacter(ctx(ownerA), { characterId });
    expect(after.ok).toBe(false);
    if (after.ok) throw new Error("previous owner export must be denied");
    expect(after.error.code).toBe("not_found");
    expect(after).not.toHaveProperty("value");

    const asNewOwner = await characters.exportCharacter(ctx(ownerB), { characterId });
    expect(asNewOwner.ok).toBe(true);
  });

  it("denies migration commit replay to the previous owner after transfer", async () => {
    const ownerA = await createUser("Ada");
    const ownerB = await createUser("Bob");
    const { systemId, versionId } = await publishVersion(ownerA);
    const targetVersionId = await publishV2Version(ownerA, systemId);
    const characterId = await createCharacter(ownerA, versionId);

    const preview = await characters.previewMigration(ctx(ownerA), {
      characterId,
      targetVersionId,
      mappings: { ability: "ability_score" },
    });
    if (!preview.ok) throw new Error(`unexpected preview failure: ${JSON.stringify(preview.error)}`);

    const commitKey = randomUUID();
    const commit = await characters.commitMigration(ctx(ownerA), {
      characterId,
      previewId: preview.value.previewId,
      expectedRevision: 1,
      idempotencyKey: commitKey,
    });
    expect(commit.ok).toBe(true);
    if (!commit.ok) throw new Error(`unexpected: ${JSON.stringify(commit.error)}`);

    await transferOwnership(ownerA, characterId, ownerB);

    const replay = await characters.commitMigration(ctx(ownerA), {
      characterId,
      previewId: preview.value.previewId,
      expectedRevision: 1,
      idempotencyKey: commitKey,
    });
    expect(replay.ok).toBe(false);
    if (replay.ok) throw new Error("previous owner commit replay must be denied");
    expect(replay.error.code).toBe("not_found");
    expect(replay).not.toHaveProperty("value");

    const asNewOwner = await characters.open(ctx(ownerB), characterId);
    expect(asNewOwner.ok).toBe(true);
    if (!asNewOwner.ok) throw new Error("unexpected");
    expect(asNewOwner.value.systemVersionId).toBe(targetVersionId);

    const migrations = await pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM character_migrations WHERE character_id = $1",
      [characterId],
    );
    expect(migrations.rows[0]!.count).toBe("1");
  });

  it("enumerates the Characters public method inventory for later campaign extension", async () => {
    expect(Object.keys(characters).sort()).toEqual(
      [
        "apply",
        "commitMigration",
        "create",
        "creationOptions",
        "duplicate",
        "exportCharacter",
        "list",
        "listActivity",
        "listCreationVersions",
        "manage",
        "open",
        "previewMigration",
        "rollbackMigration",
      ].sort(),
    );
  });
});
