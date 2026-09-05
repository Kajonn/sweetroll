import { randomUUID } from "node:crypto";

import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createCharactersModule,
  type CharacterId,
  type Characters,
} from "../../src/characters/index.js";
import { d20Document, d20Package } from "../../src/systems/implementation/package/fixtures/index.js";
import { compileDocument } from "../../src/systems/implementation/rules/compile-document.js";
import type { SystemDocumentV1 } from "../../src/systems/implementation/package/schema/index.js";
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
  CREATE INDEX character_command_executions_expiry_idx
    ON character_command_executions (expires_at);
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
  CREATE INDEX character_migration_previews_expiry_idx
    ON character_migration_previews (expires_at)
    WHERE consumed_at IS NULL;
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

describeWithDatabase("Character migration (preview)", () => {
  const schema = `characters_migration_preview_${randomUUID().replaceAll("-", "")}`;
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

  async function publishV2Version(
    ownerId: string,
    systemId: string,
    opts: { versionLifecycle?: string } = {},
  ): Promise<string> {
    const versionId = randomUUID();
    const document = buildD20V2Document();
    const compiled = compileDocument(document, {
      systemId,
      versionId,
      semanticVersion: "2.0.0",
    });
    if (!compiled.ok) throw new Error(`v2 did not compile: ${JSON.stringify(compiled.diagnostics)}`);
    await pool.query(
      "INSERT INTO system_versions (id, system_id, semantic_version, checksum, package_json, lifecycle) VALUES ($1, $2, '2.0.0', $3, $4::jsonb, $5)",
      [versionId, systemId, compiled.value.integrity.checksum, JSON.stringify(compiled.value), opts.versionLifecycle ?? "published"],
    );
    return versionId;
  }

  async function publishSource(ownerId: string): Promise<{ systemId: string; versionId: string }> {
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

  it("previews a mapped migration without mutating version, state, or revision", async () => {
    const owner = await createUser("Ada");
    const { systemId, versionId } = await publishSource(owner);
    const targetVersionId = await publishV2Version(owner, systemId);
    const characterId = await createCharacter(owner, versionId);

    const result = await characters.previewMigration(ctx(owner), {
      characterId,
      targetVersionId,
      mappings: { ability: "ability_score" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`unexpected: ${JSON.stringify(result.error)}`);
    expect(result.value.characterId).toBe(characterId);
    expect(result.value.sourceVersionId).toBe(versionId);
    expect(result.value.targetVersionId).toBe(targetVersionId);
    expect(result.value.sourceRevision).toBe(1);
    expect(result.value.expiresAt).toBeTruthy();
    expect(result.value.previewId).toBeTruthy();
    expect(result.value.candidateState.values).toMatchObject({
      ability_score: 10,
      modifier: 0,
      ancestry: null,
      health: { current: 10, max: 10 },
      level: 1,
    });
    expect(result.value.candidateProjection.entityId).toBe("character");
    expect(result.value.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("proficient"),
        expect.stringContaining("level"),
      ]),
    );

    const row = await pool.query<{
      revision: number;
      system_version_id: string;
      state_json: unknown;
    }>("SELECT revision, system_version_id, state_json FROM characters WHERE id = $1", [characterId]);
    expect(row.rows[0]!.revision).toBe(1);
    expect(row.rows[0]!.system_version_id).toBe(versionId);
    expect((row.rows[0]!.state_json as { values: Record<string, unknown> }).values.ability).toBe(10);

    const preview = await pool.query<{ consumed_at: string | null }>(
      "SELECT consumed_at FROM character_migration_previews WHERE character_id = $1",
      [characterId],
    );
    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0]!.consumed_at).toBeNull();
  });

  it("applies a literal default to a new target field", async () => {
    const owner = await createUser("Ada");
    const { systemId, versionId } = await publishSource(owner);
    const targetVersionId = await publishV2Version(owner, systemId);
    const characterId = await createCharacter(owner, versionId);

    const result = await characters.previewMigration(ctx(owner), {
      characterId,
      targetVersionId,
      mappings: { ability: "ability_score" },
      defaults: { level: 7 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`unexpected: ${JSON.stringify(result.error)}`);
    expect(result.value.candidateState.values.level).toBe(7);
  });

  it("rejects an explicit mapping whose target field does not exist", async () => {
    const owner = await createUser("Ada");
    const { systemId, versionId } = await publishSource(owner);
    const targetVersionId = await publishV2Version(owner, systemId);
    const characterId = await createCharacter(owner, versionId);

    const result = await characters.previewMigration(ctx(owner), {
      characterId,
      targetVersionId,
      mappings: { ability: "nonexistent_target" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected");
    expect(result.error.code).toBe("invalid_value");
  });

  it("rejects a mapping whose source field does not exist in the character", async () => {
    const owner = await createUser("Ada");
    const { systemId, versionId } = await publishSource(owner);
    const targetVersionId = await publishV2Version(owner, systemId);
    const characterId = await createCharacter(owner, versionId);

    const result = await characters.previewMigration(ctx(owner), {
      characterId,
      targetVersionId,
      mappings: { nonexistent: "level" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected");
    expect(result.error.code).toBe("invalid_value");
  });

  it("rejects a target version from another system", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishSource(owner);
    const otherSystem = await publishSource(owner);
    const characterId = await createCharacter(owner, versionId);

    await pool.query("UPDATE systems SET name = 'Other' WHERE id = $1", [otherSystem.systemId]);

    const result = await characters.previewMigration(ctx(owner), {
      characterId,
      targetVersionId: otherSystem.versionId,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected");
    expect(result.error.code).toBe("invalid_value");
  });

  it("rejects an inaccessible or deprecated target as not_found", async () => {
    const owner = await createUser("Ada");
    const { systemId, versionId } = await publishSource(owner);
    const characterId = await createCharacter(owner, versionId);

    const deprecatedTarget = await publishV2Version(owner, systemId, { versionLifecycle: "deprecated" });
    const depResult = await characters.previewMigration(ctx(owner), {
      characterId,
      targetVersionId: deprecatedTarget,
    });
    expect(depResult.ok).toBe(false);
    if (depResult.ok) throw new Error("unexpected");
    expect(depResult.error.code).toBe("not_found");
  });

  it("rejects migration previews from a non-owner as not_found", async () => {
    const owner = await createUser("Ada");
    const stranger = await createUser("Bob");
    const { systemId, versionId } = await publishSource(owner);
    const targetVersionId = await publishV2Version(owner, systemId);
    const characterId = await createCharacter(owner, versionId);

    const result = await characters.previewMigration(ctx(stranger), {
      characterId,
      targetVersionId,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected");
    expect(result.error.code).toBe("not_found");
  });
});

describeWithDatabase("Character migration (commit)", () => {
  const schema = `characters_migration_commit_${randomUUID().replaceAll("-", "")}`;
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

  async function publishV2Version(
    ownerId: string,
    systemId: string,
  ): Promise<string> {
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

  async function publishSource(ownerId: string): Promise<{ systemId: string; versionId: string }> {
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

  async function preview(owner: string, characterId: string, targetVersionId: string) {
    const result = await characters.previewMigration(ctx(owner), {
      characterId,
      targetVersionId,
      mappings: { ability: "ability_score" },
    });
    if (!result.ok) throw new Error(`unexpected preview failure: ${JSON.stringify(result.error)}`);
    return result.value;
  }

  it("commits the exact candidate state, increments revision once, and consumes the preview", async () => {
    const owner = await createUser("Ada");
    const { systemId, versionId } = await publishSource(owner);
    const targetVersionId = await publishV2Version(owner, systemId);
    const characterId = await createCharacter(owner, versionId);

    const migrationPreview = await preview(owner, characterId, targetVersionId);

    const commit = await characters.commitMigration(ctx(owner), {
      characterId,
      previewId: migrationPreview.previewId,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });

    expect(commit.ok).toBe(true);
    if (!commit.ok) throw new Error(`unexpected: ${JSON.stringify(commit.error)}`);
    expect(commit.value.character.revision).toBe(2);
    expect(commit.value.character.systemVersionId).toBe(targetVersionId);
    expect(commit.value.character.state.values).toMatchObject({
      ability_score: 10,
      modifier: 0,
      ancestry: null,
      health: { current: 10, max: 10 },
      level: 1,
    });
    expect(commit.value.character.reconciliation.replayed).toBe(false);
    expect(commit.value.roll).toBeNull();

    const charRow = await pool.query<{ revision: number; system_version_id: string }>(
      "SELECT revision, system_version_id FROM characters WHERE id = $1",
      [characterId],
    );
    expect(charRow.rows[0]!.revision).toBe(2);
    expect(charRow.rows[0]!.system_version_id).toBe(targetVersionId);

    const previewRow = await pool.query<{ consumed_at: string | null }>(
      "SELECT consumed_at FROM character_migration_previews WHERE id = $1",
      [migrationPreview.previewId],
    );
    expect(previewRow.rows[0]!.consumed_at).not.toBeNull();

    const migrations = await pool.query<{
      source_version_id: string;
      target_version_id: string;
      commit_revision: number;
      before_state_json: unknown;
      after_state_json: unknown;
      rollback_deadline: string | null;
    }>("SELECT source_version_id, target_version_id, commit_revision, before_state_json, after_state_json, rollback_deadline FROM character_migrations WHERE preview_id = $1", [
      migrationPreview.previewId,
    ]);
    expect(migrations.rows).toHaveLength(1);
    expect(migrations.rows[0]!.source_version_id).toBe(versionId);
    expect(migrations.rows[0]!.target_version_id).toBe(targetVersionId);
    expect(migrations.rows[0]!.commit_revision).toBe(2);
    expect((migrations.rows[0]!.before_state_json as { values: Record<string, unknown> }).values.ability).toBe(10);
    expect((migrations.rows[0]!.after_state_json as { values: Record<string, unknown> }).values.ability_score).toBe(10);
    expect(migrations.rows[0]!.rollback_deadline).not.toBeNull();

    const activity = await pool.query<{ kind: string }>(
      "SELECT kind FROM character_activity_events WHERE character_id = $1 AND kind = 'character_migration_committed'",
      [characterId],
    );
    expect(activity.rows).toHaveLength(1);
    const audit = await pool.query<{ kind: string }>(
      "SELECT kind FROM character_audit_records WHERE character_id = $1 AND kind = 'character_migration_committed'",
      [characterId],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it("rejects a second commit of an already-consumed preview", async () => {
    const owner = await createUser("Ada");
    const { systemId, versionId } = await publishSource(owner);
    const targetVersionId = await publishV2Version(owner, systemId);
    const characterId = await createCharacter(owner, versionId);

    const migrationPreview = await preview(owner, characterId, targetVersionId);

    const first = await characters.commitMigration(ctx(owner), {
      characterId,
      previewId: migrationPreview.previewId,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(first.ok).toBe(true);

    const second = await characters.commitMigration(ctx(owner), {
      characterId,
      previewId: migrationPreview.previewId,
      expectedRevision: 2,
      idempotencyKey: randomUUID(),
    });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unexpected");
    expect(second.error.code).toBe("conflict");
  });

  it("rejects a commit with a stale source revision as conflict", async () => {
    const owner = await createUser("Ada");
    const { systemId, versionId } = await publishSource(owner);
    const targetVersionId = await publishV2Version(owner, systemId);
    const characterId = await createCharacter(owner, versionId);

    const migrationPreview = await preview(owner, characterId, targetVersionId);

    // Edit the character after previewing, moving the revision past the preview's source revision.
    const edit = await characters.apply(ctx(owner), {
      kind: "setField",
      characterId,
      fieldId: "ability",
      value: 15,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(edit.ok).toBe(true);

    const commit = await characters.commitMigration(ctx(owner), {
      characterId,
      previewId: migrationPreview.previewId,
      expectedRevision: 2,
      idempotencyKey: randomUUID(),
    });
    expect(commit.ok).toBe(false);
    if (commit.ok) throw new Error("unexpected");
    expect(commit.error.code).toBe("conflict");
  });

  it("resolves two concurrent commits from one revision with exactly one winner", async () => {
    const owner = await createUser("Ada");
    const { systemId, versionId } = await publishSource(owner);
    const targetVersionId = await publishV2Version(owner, systemId);
    const characterId = await createCharacter(owner, versionId);

    const migrationPreview = await preview(owner, characterId, targetVersionId);

    const [a, b] = await Promise.all([
      characters.commitMigration(ctx(owner), {
        characterId,
        previewId: migrationPreview.previewId,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      }),
      characters.commitMigration(ctx(owner), {
        characterId,
        previewId: migrationPreview.previewId,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      }),
    ]);

    const results = [a, b];
    const successes = results.filter((r) => r.ok);
    const conflicts = results.filter((r) => !r.ok);
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(1);

    const row = await pool.query<{ revision: number }>("SELECT revision FROM characters WHERE id = $1", [characterId]);
    expect(row.rows[0]!.revision).toBe(2);
    const migrations = await pool.query(
      "SELECT count(*)::int AS count FROM character_migrations WHERE character_id = $1",
      [characterId],
    );
    expect(migrations.rows[0]!.count).toBe(1);
  });
});

describeWithDatabase("Character migration (rollback)", () => {
  const schema = `characters_migration_rollback_${randomUUID().replaceAll("-", "")}`;
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

  async function publishSource(ownerId: string): Promise<{ systemId: string; versionId: string }> {
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

  async function preview(owner: string, characterId: string, targetVersionId: string) {
    const result = await characters.previewMigration(ctx(owner), {
      characterId,
      targetVersionId,
      mappings: { ability: "ability_score" },
    });
    if (!result.ok) throw new Error(`unexpected preview failure: ${JSON.stringify(result.error)}`);
    return result.value;
  }

  async function commitMigration(migrations: Characters, owner: string, characterId: string, previewId: string) {
    return migrations.commitMigration(ctx(owner), {
      characterId,
      previewId,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
  }

  it("rolls back before the deadline by restoring the source version/state into a new revision", async () => {
    const owner = await createUser("Ada");
    const { systemId, versionId } = await publishSource(owner);
    const targetVersionId = await publishV2Version(owner, systemId);
    const characterId = await createCharacter(owner, versionId);

    const migrationPreview = await preview(owner, characterId, targetVersionId);
    const commit = await commitMigration(characters, owner, characterId, migrationPreview.previewId);
    if (!commit.ok) throw new Error(`unexpected commit: ${JSON.stringify(commit.error)}`);

    const migrationId = (
      await pool.query<{ id: string }>("SELECT id FROM character_migrations WHERE preview_id = $1", [
        migrationPreview.previewId,
      ])
    ).rows[0]!.id;

    const rollback = await characters.rollbackMigration(ctx(owner), {
      characterId,
      migrationId,
      idempotencyKey: randomUUID(),
    });

    expect(rollback.ok).toBe(true);
    if (!rollback.ok) throw new Error(`unexpected: ${JSON.stringify(rollback.error)}`);
    expect(rollback.value.character.revision).toBe(3);
    expect(rollback.value.character.systemVersionId).toBe(versionId);
    expect(rollback.value.character.state.values).toMatchObject({
      ability: 10,
      modifier: 0,
      proficient: false,
      ancestry: null,
      health: { current: 10, max: 10 },
    });

    const migration = await pool.query<{ rollback_revision: number | null; rolled_back_at: string | null }>(
      "SELECT rollback_revision, rolled_back_at FROM character_migrations WHERE id = $1",
      [migrationId],
    );
    expect(migration.rows[0]!.rollback_revision).toBe(3);
    expect(migration.rows[0]!.rolled_back_at).not.toBeNull();

    const activity = await pool.query<{ kind: string }>(
      "SELECT kind FROM character_activity_events WHERE character_id = $1 AND kind = 'character_migration_rolled_back'",
      [characterId],
    );
    expect(activity.rows).toHaveLength(1);
  });

  it("rejects rollback after a subsequent edit as conflict and preserves the edits", async () => {
    const owner = await createUser("Ada");
    const { systemId, versionId } = await publishSource(owner);
    const targetVersionId = await publishV2Version(owner, systemId);
    const characterId = await createCharacter(owner, versionId);

    const migrationPreview = await preview(owner, characterId, targetVersionId);
    const commit = await commitMigration(characters, owner, characterId, migrationPreview.previewId);
    if (!commit.ok) throw new Error(`unexpected commit: ${JSON.stringify(commit.error)}`);

    const migrationId = (
      await pool.query<{ id: string }>("SELECT id FROM character_migrations WHERE preview_id = $1", [
        migrationPreview.previewId,
      ])
    ).rows[0]!.id;

    const edit = await characters.apply(ctx(owner), {
      kind: "setField",
      characterId,
      fieldId: "ability_score",
      value: 15,
      expectedRevision: 2,
      idempotencyKey: randomUUID(),
    });
    expect(edit.ok).toBe(true);

    const rollback = await characters.rollbackMigration(ctx(owner), {
      characterId,
      migrationId,
      idempotencyKey: randomUUID(),
    });
    expect(rollback.ok).toBe(false);
    if (rollback.ok) throw new Error("unexpected");
    expect(rollback.error.code).toBe("conflict");

    const row = await pool.query<{ revision: number }>("SELECT revision FROM characters WHERE id = $1", [characterId]);
    expect(row.rows[0]!.revision).toBe(3);
    const state = await pool.query<{ state_json: unknown }>("SELECT state_json FROM characters WHERE id = $1", [
      characterId,
    ]);
    expect((state.rows[0]!.state_json as { values: Record<string, unknown> }).values.ability_score).toBe(15);
  });

  it("rejects rollback after the deadline as conflict", async () => {
    const owner = await createUser("Ada");
    const { systemId, versionId } = await publishSource(owner);
    const targetVersionId = await publishV2Version(owner, systemId);
    const characterId = await createCharacter(owner, versionId);

    const migrationPreview = await preview(owner, characterId, targetVersionId);
    const commit = await commitMigration(characters, owner, characterId, migrationPreview.previewId);
    if (!commit.ok) throw new Error(`unexpected commit: ${JSON.stringify(commit.error)}`);

    const migrationId = (
      await pool.query<{ id: string }>("SELECT id FROM character_migrations WHERE preview_id = $1", [
        migrationPreview.previewId,
      ])
    ).rows[0]!.id;

    await pool.query("UPDATE character_migrations SET rollback_deadline = now() - interval '1 second' WHERE id = $1", [
      migrationId,
    ]);

    const rollback = await characters.rollbackMigration(ctx(owner), {
      characterId,
      migrationId,
      idempotencyKey: randomUUID(),
    });
    expect(rollback.ok).toBe(false);
    if (rollback.ok) throw new Error("unexpected");
    expect(rollback.error.code).toBe("conflict");
  });
});
