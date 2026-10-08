import { randomUUID } from "node:crypto";

import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createCharactersModule,
  type CharacterCommand,
  type Characters,
} from "./index.js";
import { compileDocument } from "../systems/implementation/rules/compile-document.js";
import { validDocument } from "../systems/implementation/package/schema/test-values.js";
import type {
  SystemDocumentV1,
  SystemPackageV1,
} from "../systems/implementation/package/schema/index.js";
import { createPostgresPublishedPackageLoader } from "../systems/implementation/runtime/package-loader.js";
import { createSystemRuntime, type SystemRuntime } from "../systems/runtime.js";
import { createSystemAuthoringModule, type SystemAuthoring } from "../systems/authoring.js";
import { createSystemPersistenceRepository } from "../systems/implementation/persistence/index.js";

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
    scope_campaign_id  uuid,
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

const SWORD_ENTRY_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const STONE_ENTRY_ID = "cccccccc-3333-4333-8333-333333333333";

function entryDocument(): SystemDocumentV1 {
  const document = validDocument();
  document.expressions = document.expressions.filter((expression) => expression.id !== "title_expr");
  document.templates = [
    {
      id: "longsword",
      label: "Longsword",
      kind: "item",
      fields: [{
        kind: "integer",
        id: "weapon_bonus",
        label: "Bonus",
        default: 1,
        required: true,
        min: 0,
        max: 10,
        step: 1,
      }],
      grantedActions: [{
        kind: "roll",
        id: "longsword_attack",
        label: "Longsword Attack",
        expressionId: "longsword_attack_expr",
        inputs: [],
        outputTemplate: "Longsword: {total}",
      }],
    },
    {
      id: "fireball",
      label: "Fireball",
      kind: "spell",
      fields: [],
      grantedActions: [],
    },
  ];
  document.slots = [{ id: "inventory", label: "Inventory", accepts: ["item"] }];
  document.expressions.push({
    id: "longsword_attack_expr",
    context: "roll",
    resultType: "number",
    source: "d20 + fields.weapon_bonus",
    fallback: 0,
  });
  (document.sheets[0]!.sections[0]!.elements as unknown[]).push({
    kind: "slot",
    id: "inv_element",
    slotId: "inventory",
  });
  return document;
}

function compileEntryPackage(document: SystemDocumentV1): SystemPackageV1 {
  const result = compileDocument(document, {
    systemId: "00000000-0000-4000-8000-000000000001",
    versionId: randomUUID(),
    semanticVersion: "1.0.0",
  });
  if (!result.ok) throw new Error(`Fixture did not compile: ${JSON.stringify(result.diagnostics)}`);
  return result.value;
}

describeWithDatabase("Character entry commands", () => {
  const schema = `character_entries_${randomUUID().replaceAll("-", "")}`;
  let pool: Pool;
  let authoring: SystemAuthoring;
  let runtime: SystemRuntime;
  let characters: Characters;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: databaseUrl,
      application_name: schema,
      max: 5,
    });
    pool.on("connect", (client) => {
      client.query(`SET search_path TO ${schema}`).catch(() => {});
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

  async function publishEntryVersion(ownerId: string): Promise<{ systemId: string; versionId: string }> {
    const systemResult = await pool.query<{ id: string }>(
      "INSERT INTO systems (owner_id, name, access, lifecycle) VALUES ($1, $2, $3, $4) RETURNING id",
      [ownerId, "Entries", "public", "active"],
    );
    const systemId = systemResult.rows[0]!.id;
    const packageValue = compileEntryPackage(entryDocument());
    await pool.query(
      "INSERT INTO system_versions (id, system_id, semantic_version, checksum, package_json, lifecycle) VALUES ($1, $2, '1.0.0', $3, $4::jsonb, $5)",
      [packageValue.versionId, systemId, packageValue.integrity.checksum, JSON.stringify(packageValue), "published"],
    );
    return { systemId, versionId: packageValue.versionId };
  }

  async function createEntryCharacter(owner: string, versionId: string): Promise<string> {
    const created = await characters.create(ctx(owner), {
      systemVersionId: versionId,
      entityDefinitionId: "character",
      name: "Aria",
      idempotencyKey: randomUUID(),
    });
    if (!created.ok) throw new Error(`create failed: ${created.error.code}`);
    return created.value.characterId;
  }

  async function activityKinds(characterId: string): Promise<string[]> {
    const rows = await pool.query<{ kind: string }>(
      "SELECT kind FROM character_activity_events WHERE character_id = $1 ORDER BY occurred_at ASC, id ASC",
      [characterId],
    );
    return rows.rows.map((row) => row.kind);
  }

  function addEntryCommand(characterId: string, entryId: string, expectedRevision: number, idempotencyKey: string) {
    return {
      kind: "addEntry",
      characterId,
      entry: {
        entryId,
        slotId: "inventory",
        templateId: "longsword",
        values: { weapon_bonus: 1 },
      },
      expectedRevision,
      idempotencyKey,
    } as unknown as CharacterCommand;
  }

  it("adds a templated entry, bumps the revision, and stores the entry", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishEntryVersion(owner);
    const characterId = await createEntryCharacter(owner, versionId);

    const added = await characters.apply(ctx(owner), addEntryCommand(characterId, SWORD_ENTRY_ID, 1, randomUUID()));
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error(`addEntry failed: ${added.error.code} ${added.error.message}`);
    expect(added.value.character.reconciliation.revision).toBe(2);
    expect(added.value.character.state.entries?.[SWORD_ENTRY_ID]).toMatchObject({
      entryId: SWORD_ENTRY_ID,
      slotId: "inventory",
      templateId: "longsword",
      values: { weapon_bonus: 1 },
    });
    expect(added.value.roll).toBeNull();
    expect(await activityKinds(characterId)).toEqual(["character_created", "entry_added"]);
  });

  it("fills template field defaults for absent values on add", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishEntryVersion(owner);
    const characterId = await createEntryCharacter(owner, versionId);

    const command = {
      kind: "addEntry",
      characterId,
      entry: { entryId: SWORD_ENTRY_ID, slotId: "inventory", templateId: "longsword", values: {} },
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    } as unknown as CharacterCommand;
    const added = await characters.apply(ctx(owner), command);
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error(`addEntry failed: ${added.error.code} ${added.error.message}`);
    expect(added.value.character.state.entries?.[SWORD_ENTRY_ID]?.values).toEqual({ weapon_bonus: 1 });
  });

  it("rejects a wrong-kind template without changing the revision", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishEntryVersion(owner);
    const characterId = await createEntryCharacter(owner, versionId);

    const command = {
      kind: "addEntry",
      characterId,
      entry: { entryId: SWORD_ENTRY_ID, slotId: "inventory", templateId: "fireball", values: {} },
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    } as unknown as CharacterCommand;
    const rejected = await characters.apply(ctx(owner), command);
    expect(rejected.ok).toBe(false);

    const opened = await characters.open(ctx(owner), characterId);
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("open failed");
    expect(opened.value.revision).toBe(1);
    expect(opened.value.state.entries ?? {}).toEqual({});
    expect(await activityKinds(characterId)).toEqual(["character_created"]);
  });

  it("rejects a custom entry carrying granted actions", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishEntryVersion(owner);
    const characterId = await createEntryCharacter(owner, versionId);

    const command = {
      kind: "addEntry",
      characterId,
      entry: {
        entryId: STONE_ENTRY_ID,
        slotId: "inventory",
        templateId: null,
        values: { name: "Lucky Stone", actions: [{ id: "sneak_attack" }] },
      },
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    } as unknown as CharacterCommand;
    const rejected = await characters.apply(ctx(owner), command);
    expect(rejected.ok).toBe(false);

    const custom = {
      kind: "addEntry",
      characterId,
      entry: {
        entryId: STONE_ENTRY_ID,
        slotId: "inventory",
        templateId: null,
        values: { name: "Lucky Stone" },
      },
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    } as unknown as CharacterCommand;
    const added = await characters.apply(ctx(owner), custom);
    expect(added.ok).toBe(true);
  });

  it("persists personal details under revision, retry, authorization and export", async () => {
    const owner = await createUser("Ada");
    const outsider = await createUser("Outside");
    const { versionId } = await publishEntryVersion(owner);
    const characterId = await createEntryCharacter(owner, versionId);
    const command: CharacterCommand = { kind: "addEntry", characterId,
      entry: { entryId: STONE_ENTRY_ID, slotId: "inventory", templateId: null,
        values: { name: "Ancient key", description: "Opens tower", notes: "Found by Ada" }, quantity: 3 },
      expectedRevision: 1, idempotencyKey: randomUUID() };
    expect(await characters.apply(ctx(outsider), command)).toMatchObject({ ok: false, error: { code: "not_found" } });
    const added = await characters.apply(ctx(owner), command);
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error("personal add failed");
    const replay = await characters.apply(ctx(owner), command);
    expect(replay).toEqual({
      ...added,
      value: {
        ...added.value,
        character: {
          ...added.value.character,
          reconciliation: { ...added.value.character.reconciliation, replayed: true },
        },
      },
    });
    const edit: CharacterCommand = { kind: "updateEntryValues", characterId, entryId: STONE_ENTRY_ID,
      values: { notes: "Used once" }, quantity: 2, expectedRevision: 1, idempotencyKey: randomUUID() };
    expect(await characters.apply(ctx(owner), edit)).toMatchObject({ ok: false, error: { code: "conflict" } });
    const updated = await characters.apply(ctx(owner), { ...edit, expectedRevision: 2, idempotencyKey: randomUUID() });
    expect(updated.ok).toBe(true);
    if (!updated.ok) throw new Error("update failed");
    expect(updated.value.character.state.entries?.[STONE_ENTRY_ID]).toMatchObject({
      values: { name: "Ancient key", description: "Opens tower", notes: "Used once" }, quantity: 2,
    });
    expect(await activityKinds(characterId)).toEqual(["character_created", "entry_added", "entry_updated"]);
    const exported = await characters.exportCharacter(ctx(owner), { characterId });
    expect(exported.ok).toBe(true);
    expect(JSON.stringify(exported)).toContain("Used once");
    const removed = await characters.apply(ctx(owner), { kind: "removeEntry", characterId,
      entryId: STONE_ENTRY_ID, expectedRevision: 3, idempotencyKey: randomUUID() });
    expect(removed.ok).toBe(true);
    expect(await activityKinds(characterId)).toEqual(["character_created", "entry_added", "entry_updated", "entry_removed"]);
  });

  it("removes an entry so granted actions leave the projection while history stays", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishEntryVersion(owner);
    const characterId = await createEntryCharacter(owner, versionId);

    const added = await characters.apply(ctx(owner), addEntryCommand(characterId, SWORD_ENTRY_ID, 1, randomUUID()));
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error("addEntry failed");
    const withSword = added.value.character.projection.sheets.flatMap((sheet) =>
      sheet.sections.flatMap((section) => section.elements),
    );
    expect(
      withSword.filter((element) => element.kind === "action" && "entryId" in element && element.entryId === SWORD_ENTRY_ID),
    ).toHaveLength(1);

    const kindsBefore = await activityKinds(characterId);
    const removed = await characters.apply(ctx(owner), {
      kind: "removeEntry",
      characterId,
      entryId: SWORD_ENTRY_ID,
      expectedRevision: 2,
      idempotencyKey: randomUUID(),
    } as unknown as CharacterCommand);
    expect(removed.ok).toBe(true);
    if (!removed.ok) throw new Error(`removeEntry failed: ${removed.error.code}`);
    expect(removed.value.character.reconciliation.revision).toBe(3);
    expect(removed.value.character.state.entries ?? {}).toEqual({});

    const opened = await characters.open(ctx(owner), characterId);
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("open failed");
    const elements = opened.value.projection.sheets.flatMap((sheet) =>
      sheet.sections.flatMap((section) => section.elements),
    );
    expect(
      elements.filter((element) => element.kind === "action" && "entryId" in element && element.entryId === SWORD_ENTRY_ID),
    ).toHaveLength(0);

    const kindsAfter = await activityKinds(characterId);
    expect(kindsAfter).toEqual([...kindsBefore, "entry_removed"]);
  });

  it("merges entry values on update", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishEntryVersion(owner);
    const characterId = await createEntryCharacter(owner, versionId);

    const added = await characters.apply(ctx(owner), addEntryCommand(characterId, SWORD_ENTRY_ID, 1, randomUUID()));
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error("addEntry failed");

    const updated = await characters.apply(ctx(owner), {
      kind: "updateEntryValues",
      characterId,
      entryId: SWORD_ENTRY_ID,
      values: { weapon_bonus: 3 },
      expectedRevision: 2,
      idempotencyKey: randomUUID(),
    } as unknown as CharacterCommand);
    expect(updated.ok).toBe(true);
    if (!updated.ok) throw new Error(`update failed: ${updated.error.code} ${updated.error.message}`);
    expect(updated.value.character.reconciliation.revision).toBe(3);
    expect(updated.value.character.state.entries?.[SWORD_ENTRY_ID]?.values).toEqual({ weapon_bonus: 3 });
    expect(await activityKinds(characterId)).toEqual(["character_created", "entry_added", "entry_updated"]);
  });

  it("updates item quantity with the entry revision and rejects invalid quantities", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishEntryVersion(owner);
    const characterId = await createEntryCharacter(owner, versionId);
    const added = await characters.apply(ctx(owner), addEntryCommand(characterId, SWORD_ENTRY_ID, 1, randomUUID()));
    expect(added.ok).toBe(true);
    const invalid = await characters.apply(ctx(owner), {
      kind: "updateEntryValues", characterId, entryId: SWORD_ENTRY_ID,
      values: {}, quantity: 0, expectedRevision: 2, idempotencyKey: randomUUID(),
    });
    expect(invalid.ok).toBe(false);
    const updated = await characters.apply(ctx(owner), {
      kind: "updateEntryValues", characterId, entryId: SWORD_ENTRY_ID,
      values: {}, quantity: 3, expectedRevision: 2, idempotencyKey: randomUUID(),
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) throw new Error("quantity update failed");
    expect(updated.value.character.state.entries?.[SWORD_ENTRY_ID]?.quantity).toBe(3);
    expect(updated.value.character.reconciliation.revision).toBe(3);
  });

  it("rejects entry commands with a stale expectedRevision", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishEntryVersion(owner);
    const characterId = await createEntryCharacter(owner, versionId);

    const stale = await characters.apply(ctx(owner), addEntryCommand(characterId, SWORD_ENTRY_ID, 7, randomUUID()));
    expect(stale).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "conflict", latestRevision: 1 }),
    });
  });

  it("replays an addEntry idempotency key without duplication", async () => {
    const owner = await createUser("Ada");
    const { versionId } = await publishEntryVersion(owner);
    const characterId = await createEntryCharacter(owner, versionId);
    const key = randomUUID();

    const first = await characters.apply(ctx(owner), addEntryCommand(characterId, SWORD_ENTRY_ID, 1, key));
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("addEntry failed");

    const replay = await characters.apply(ctx(owner), addEntryCommand(characterId, SWORD_ENTRY_ID, 1, key));
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error("replay failed");
    expect(replay.value.character.reconciliation.revision).toBe(2);
    expect(replay.value.character.reconciliation.replayed).toBe(true);
    expect(Object.keys(replay.value.character.state.entries ?? {})).toEqual([SWORD_ENTRY_ID]);

    const opened = await characters.open(ctx(owner), characterId);
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("open failed");
    expect(opened.value.revision).toBe(2);
    expect(await activityKinds(characterId)).toEqual(["character_created", "entry_added"]);
  });
});
