import { Client, Pool } from "pg";
import pino from "pino";
import type { FastifyInstance } from "fastify";

import { createTestOidcClient } from "../../src/identity/adapters/test.js";
import { createIdentityModule, type Identity } from "../../src/identity/index.js";
import { createSystemAuthoringModule, type SystemAuthoring } from "../../src/systems/authoring.js";
import {
  createSystemPersistenceRepository,
} from "../../src/systems/implementation/persistence/index.js";
import { createPostgresPublishedPackageLoader } from "../../src/systems/implementation/runtime/package-loader.js";
import {
  createSystemRuntime,
  type SystemRuntime,
} from "../../src/systems/runtime.js";
import { createCharactersModule, type Characters } from "../../src/characters/index.js";
import type { SystemDocumentV1 } from "../../src/systems/implementation/package/schema/document.js";
import { d20Document } from "../../src/systems/implementation/package/fixtures/index.js";
import { buildHttpApp } from "../../src/transport/http/app.js";
import { buildAuthHook } from "../../src/transport/http/auth-hook.js";
import { buildCharactersRoutes } from "../../src/transport/http/characters.js";
import { buildDevSignInRoutes } from "../../src/transport/http/dev-signin.js";
import { buildIdentityRoutes } from "../../src/transport/http/identity.js";
import { buildSystemsRoutes } from "../../src/transport/http/systems.js";

export const I3_SCHEMA_DDL = `
  CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name text,
    locale text NOT NULL DEFAULT 'en',
    status text NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE external_identities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider text NOT NULL,
    subject text NOT NULL,
    email text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, subject)
  );
  CREATE TABLE sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz
  );
  CREATE INDEX sessions_user_id_idx ON sessions (user_id);

  CREATE TABLE user_preferences (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    theme_default text CHECK (theme_default IN ('light', 'dark', 'system')),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE systems (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    name text NOT NULL,
    access text NOT NULL DEFAULT 'private',
    lifecycle text NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE system_drafts (
    system_id uuid PRIMARY KEY REFERENCES systems(id) ON DELETE CASCADE,
    revision integer NOT NULL DEFAULT 1,
    document_json jsonb NOT NULL,
    source_checksum text NOT NULL,
    updated_by uuid NOT NULL REFERENCES users(id),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE system_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
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
  CREATE TABLE idempotency_receipts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    command_kind text NOT NULL,
    key text NOT NULL,
    input_hash text NOT NULL,
    result_json jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    UNIQUE (actor_id, command_kind, key)
  );
  CREATE TABLE system_audit_records (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    system_id uuid NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
    actor_id uuid NOT NULL REFERENCES users(id),
    kind text NOT NULL,
    summary text NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    request_id text NOT NULL
  );
  CREATE INDEX system_drafts_updated_at_idx ON system_drafts (updated_at DESC);
  CREATE INDEX system_versions_system_id_idx ON system_versions (system_id, created_at DESC);
  CREATE INDEX system_audit_records_system_id_idx ON system_audit_records (system_id, occurred_at DESC);

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

  CREATE TABLE campaigns (
    -- Test-fixture copy pinned to migrations/0012_campaigns.sql: keep the
    -- campaign table/constraint/index definitions below identical to that
    -- production migration. This DDL only seeds historical test schemas.
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id          uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    system_version_id uuid NOT NULL REFERENCES system_versions(id) ON DELETE RESTRICT,
    title             text NOT NULL,
    description       text NOT NULL DEFAULT '',
    status            text NOT NULL DEFAULT 'active',
    revision          integer NOT NULL DEFAULT 1,
    access_revision   integer NOT NULL DEFAULT 1,
    archived_at       timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CHECK (revision > 0),
    CHECK (access_revision > 0),
    CHECK (status IN ('active', 'archived'))
  );
  CREATE INDEX campaigns_owner_page_idx
    ON campaigns (owner_id, created_at DESC, id DESC);
  CREATE TABLE campaign_members (
    campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    role        text NOT NULL,
    status      text NOT NULL DEFAULT 'active',
    generation  integer NOT NULL DEFAULT 1,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (campaign_id, user_id),
    CHECK (role IN ('owner', 'co_gm', 'player')),
    CHECK (status IN ('active', 'removed')),
    CHECK (generation >= 1)
  );
  CREATE INDEX campaign_members_user_idx
    ON campaign_members (user_id, status, campaign_id);
  CREATE TABLE campaign_audit_records (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    actor_id    uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    kind        text NOT NULL,
    summary     text NOT NULL,
    request_id  text NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX campaign_audit_records_page_idx
    ON campaign_audit_records (campaign_id, occurred_at DESC, id DESC);
  CREATE TABLE campaign_command_executions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    command_kind    text NOT NULL,
    idempotency_key text NOT NULL,
    input_hash      text NOT NULL,
    campaign_id     uuid REFERENCES campaigns(id) ON DELETE CASCADE,
    result_json     jsonb NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    UNIQUE (actor_id, command_kind, idempotency_key)
  );
  CREATE INDEX campaign_command_executions_expiry_idx
    ON campaign_command_executions (expires_at);
`;

export async function createI3Schema(databaseUrl: string, schema: string): Promise<void> {
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query(`SET search_path TO ${schema}`);
  await admin.query(I3_SCHEMA_DDL);
  await admin.end();
}

export async function dropI3Schema(databaseUrl: string, schema: string): Promise<void> {
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
}

export function createI3Pool(databaseUrl: string, schema: string, max = 16): Pool {
  return new Pool({
    connectionString: databaseUrl,
    application_name: schema,
    max,
    onConnect: async (client) => {
      await client.query(`SET search_path TO ${schema}`);
    },
  });
}

export type I3Users = {
  ada: { actorId: string; cookie: string };
  bob: { actorId: string; cookie: string };
};

export type I3AppHandle = {
  app: FastifyInstance;
  identity: Identity;
  authoring: SystemAuthoring;
  characters: Characters;
  runtime: SystemRuntime;
  pool: Pool;
  users: I3Users;
};

export type BuildI3AppInput = {
  pool: Pool;
  /** Wraps the runtime (e.g. to count resolve calls); defaults to identity. */
  wrapRuntime?: (runtime: SystemRuntime) => SystemRuntime;
  rollSecret?: string;
};

export async function buildI3App(input: BuildI3AppInput): Promise<I3AppHandle> {
  const rollSecret = input.rollSecret ?? "a".repeat(32);
  const identity = createIdentityModule({
    oidc: createTestOidcClient(
      new Map([
        ["code-ada", { provider: "test", subject: "subAda", email: "ada@example.com", displayName: "Ada" }],
        ["code-bob", { provider: "test", subject: "subBob", email: "bob@example.com", displayName: "Bob" }],
        ["code-cara", { provider: "test", subject: "subCara", email: "cara@example.com", displayName: "Cara" }],
        ["code-dan", { provider: "test", subject: "subDan", email: "dan@example.com", displayName: "Dan" }],
      ]),
    ),
    pool: input.pool,
    sessionTtlMs: 3_600_000,
  });

  const authoring = createSystemAuthoringModule({
    repo: createSystemPersistenceRepository(input.pool),
  });

  const runtime = createSystemRuntime({
    loadPackage: createPostgresPublishedPackageLoader(input.pool),
    authoritativeRollSecret: rollSecret,
  });

  const effectiveRuntime = input.wrapRuntime === undefined ? runtime : input.wrapRuntime(runtime);

  const characters = createCharactersModule({
    pool: input.pool,
    runtime: effectiveRuntime,
    authorizeVersionUse: authoring.authorizeVersionUse,
    listAuthorizedVersions: authoring.listAuthorizedVersions,
  });

  const authHook = buildAuthHook({
    identity,
    cookieName: "session",
    secure: false,
    maxAgeSeconds: 3600,
  });

  const app = buildHttpApp({
    logger: pino({ level: "silent" }),
    pool: input.pool,
    authHook,
  });

  void app.register(buildIdentityRoutes({ identity, cookieName: "session", secure: false }));
  void app.register(buildSystemsRoutes({ authoring }));
  void app.register(buildCharactersRoutes({ characters }));
  void app.register(
    buildDevSignInRoutes({
      identity,
      nodeEnv: "test",
      cookieName: "session",
      secure: false,
      maxAgeSeconds: 3600,
    }),
  );

  await app.ready();

  const users = {} as I3Users;
  for (const [code, key] of [
    ["code-ada", "ada"],
    ["code-bob", "bob"],
  ] as const) {
    const response = await app.inject({
      method: "POST",
      url: "/dev/signin",
      payload: { code, redirectUri: "http://localhost/cb" },
    });
    if (response.statusCode !== 200) {
      throw new Error(`dev/signin (${code}) failed: ${response.statusCode} ${response.body}`);
    }
    const body = response.json<{ userId: string }>();
    users[key] = { actorId: body.userId, cookie: idkCookieFromSetCookieResponse(response) };
  }

  return { app, identity, authoring, characters, runtime, pool: input.pool, users };
}

function idkCookieFromSetCookieResponse(response: {
  headers: { "set-cookie"?: string | string[] };
}): string {
  const setCookie = response.headers["set-cookie"];
  const header = Array.isArray(setCookie) ? setCookie[0] ?? "" : setCookie ?? "";
  return header.split(";")[0] ?? "";
}

/** Builds a d20 document whose v2 breaks the v1 schema (the same
 * transformation used by tests/integration/character-migration.test.ts). */
export function buildD20V2Document(): SystemDocumentV1 {
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