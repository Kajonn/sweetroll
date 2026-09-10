import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../src/platform/migrations.js";
import {
  REFERENCE_TEMPLATES,
  seedReferenceTemplates,
} from "../../src/systems/implementation/persistence/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;

describeWithDatabase("runMigrations", () => {
  const schema = `migration_test_${randomUUID().replaceAll("-", "")}`;
  const directory = fileURLToPath(new URL("../fixtures/migrations", import.meta.url));
  let client: Client;

  beforeEach(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
  });

  afterEach(async () => {
    await client.query(`DROP SCHEMA ${schema} CASCADE`);
    await client.end();
  });

  it("applies each migration once and records its checksum", async () => {
    await runMigrations(client, directory);
    await runMigrations(client, directory);

    const tables = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
      [schema],
    );
    const records = await client.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations ORDER BY filename",
    );

    expect(tables.rows.map(({ table_name }) => table_name)).toEqual([
      "migration_probe",
      "schema_migrations",
    ]);
    expect(records.rows).toEqual([{ filename: "0001_create_probe.sql" }]);
  });

  it("applies the production character schema and enforces its storage contracts", async () => {
    const productionDirectory = fileURLToPath(new URL("../../migrations", import.meta.url));
    await runMigrations(client, productionDirectory);

    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = $1
          AND table_name LIKE 'character%'
        ORDER BY table_name`,
      [schema],
    );
    expect(tables.rows.map(({ table_name }) => table_name)).toEqual([
      "character_activity_events",
      "character_audit_records",
      "character_claim_designations",
      "character_command_executions",
      "character_controllers",
      "character_migration_previews",
      "character_migrations",
      "character_placements",
      "character_rolls",
      "characters",
    ]);

    const versionColumn = await client.query<{ column_default: string | null; is_nullable: string }>(
      `SELECT column_default, is_nullable
         FROM information_schema.columns
        WHERE table_schema = $1
          AND table_name = 'system_versions'
          AND column_name = 'compatibility_findings_json'`,
      [schema],
    );
    expect(versionColumn.rows).toEqual([{ column_default: "'[]'::jsonb", is_nullable: "NO" }]);

    const previewColumns = await client.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = $1
          AND table_name = 'character_migration_previews'
          AND column_name IN ('created_at', 'expires_at', 'consumed_at')
        ORDER BY column_name`,
      [schema],
    );
    expect(previewColumns.rows.map(({ column_name }) => column_name)).toEqual([
      "consumed_at",
      "created_at",
      "expires_at",
    ]);

    const constraints = await client.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE connamespace = $1::regnamespace
          AND conrelid IN (
            'characters'::regclass,
            'character_command_executions'::regclass,
            'character_rolls'::regclass
          )`,
      [schema],
    );
    const definitions = constraints.rows.map(({ definition }) => definition);
    expect(definitions).toContain("CHECK ((visibility = 'owner_only'::text))");
    expect(definitions).toContain("CHECK ((lifecycle = ANY (ARRAY['active'::text, 'archived'::text])))");
    expect(definitions).toContain("CHECK ((revision >= 1))");
    expect(definitions).toContain("UNIQUE (actor_id, command_kind, idempotency_key)");
    expect(definitions).toContain("UNIQUE (execution_id)");

    const versionForeignKey = await client.query<{ delete_action: string }>(
      `SELECT rc.delete_rule AS delete_action
         FROM information_schema.referential_constraints rc
         JOIN information_schema.table_constraints tc
           ON tc.constraint_catalog = rc.constraint_catalog
          AND tc.constraint_schema = rc.constraint_schema
          AND tc.constraint_name = rc.constraint_name
        WHERE tc.table_schema = $1
          AND tc.table_name = 'characters'
          AND tc.constraint_name = 'characters_system_version_id_fkey'`,
      [schema],
    );
    expect(versionForeignKey.rows).toEqual([{ delete_action: "RESTRICT" }]);

    const indexes = await client.query<{ indexdef: string }>(
      `SELECT indexdef
         FROM pg_indexes
        WHERE schemaname = $1
          AND indexname IN ('characters_owner_page_idx', 'character_activity_events_page_idx')
        ORDER BY indexname`,
      [schema],
    );
    expect(indexes.rows.map(({ indexdef }) => indexdef)).toEqual([
      expect.stringContaining("(character_id, occurred_at DESC, id DESC)"),
      expect.stringContaining("(owner_id, lifecycle, updated_at DESC, id DESC)"),
    ]);

    const lifecycles = await client.query<{ lifecycle: string }>(
      "SELECT DISTINCT lifecycle FROM system_versions ORDER BY lifecycle",
    );
    // Migration 0010 retires the synthetic placeholder rows; the migrate
    // process reseeds fixture-identical template rows immediately after.
    expect(lifecycles.rows).toEqual([]);
    const seeded = await seedReferenceTemplates(client);
    expect(seeded).toMatchObject({ systemsInserted: 3, versionsReplaced: 3 });
    const reseeded = await client.query<{ id: string; lifecycle: string }>(
      "SELECT id, lifecycle FROM system_versions ORDER BY id",
    );
    expect(reseeded.rows).toEqual(
      [...REFERENCE_TEMPLATES]
        .map(template => ({ id: template.versionId, lifecycle: "published" }))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
    );
  });

  it("applies the production campaign tables and enforces aggregate constraints", async () => {
    const productionDirectory = fileURLToPath(new URL("../../migrations", import.meta.url));
    await runMigrations(client, productionDirectory);
    await runMigrations(client, productionDirectory);

    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = $1
          AND table_name LIKE 'campaign%'
        ORDER BY table_name`,
      [schema],
    );
    expect(tables.rows.map(({ table_name }) => table_name)).toEqual([
      "campaign_audit_records",
      "campaign_command_executions",
      "campaign_invitations",
      "campaign_members",
      "campaigns",
    ]);

    const constraints = await client.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE connamespace = $1::regnamespace
          AND conrelid IN ('campaigns'::regclass, 'campaign_members'::regclass, 'campaign_invitations'::regclass)`,
      [schema],
    );
    const definitions = constraints.rows.map(({ definition }) => definition);
    expect(definitions).toContain("CHECK ((revision > 0))");
    expect(definitions).toContain("CHECK ((access_revision > 0))");
    expect(definitions).toContain("CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text])))");
    expect(definitions).toContain("CHECK ((role = ANY (ARRAY['owner'::text, 'co_gm'::text, 'player'::text])))");
    expect(definitions).toContain("CHECK ((status = ANY (ARRAY['active'::text, 'removed'::text])))");
    expect(definitions).toContain("CHECK ((generation >= 1))");
    expect(definitions).toContain("CHECK ((intended_role = ANY (ARRAY['player'::text, 'co_gm'::text])))");
    expect(definitions).toContain(
      "CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text, 'revoked'::text])))",
    );

    const versionForeignKey = await client.query<{ delete_action: string }>(
      `SELECT rc.delete_rule AS delete_action
         FROM information_schema.referential_constraints rc
         JOIN information_schema.table_constraints tc
           ON tc.constraint_catalog = rc.constraint_catalog
          AND tc.constraint_schema = rc.constraint_schema
          AND tc.constraint_name = rc.constraint_name
        WHERE tc.table_schema = $1
          AND tc.table_name = $2
          AND tc.constraint_name = $3`,
      [schema, "campaigns", "campaigns_system_version_id_fkey"],
    );
    expect(versionForeignKey.rows).toEqual([{ delete_action: "RESTRICT" }]);

    const memberForeignKey = await client.query<{ delete_action: string }>(
      `SELECT rc.delete_rule AS delete_action
         FROM information_schema.referential_constraints rc
         JOIN information_schema.table_constraints tc
           ON tc.constraint_catalog = rc.constraint_catalog
          AND tc.constraint_schema = rc.constraint_schema
          AND tc.constraint_name = rc.constraint_name
        WHERE tc.table_schema = $1
          AND tc.table_name = $2
          AND tc.constraint_name = $3`,
      [schema, "campaign_members", "campaign_members_campaign_id_fkey"],
    );
    expect(memberForeignKey.rows).toEqual([{ delete_action: "CASCADE" }]);

    const indexes = await client.query<{ indexname: string }>(
      `SELECT indexname
          FROM pg_indexes
        WHERE schemaname = $1
          AND tablename LIKE 'campaign%'
          AND indexname NOT IN (
            SELECT c.relname
              FROM pg_constraint con
              JOIN pg_class c ON c.oid = con.conindid
             WHERE con.connamespace = $1::regnamespace
               AND con.contype = 'u'
          )
        ORDER BY indexname`,
      [schema],
    );
    expect(indexes.rows.map(({ indexname }) => indexname)).toEqual([
      "campaign_audit_records_page_idx",
      "campaign_audit_records_pkey",
      "campaign_command_executions_expiry_idx",
      "campaign_command_executions_pkey",
      "campaign_invitations_campaign_page_idx",
      "campaign_invitations_pkey",
      "campaign_members_pkey",
      "campaign_members_user_idx",
      "campaigns_owner_page_idx",
      "campaigns_pkey",
    ]);

    // The actor-scoped idempotency receipt holds exactly one row per key via
    // its UNIQUE constraint; assert the constraint rather than the
    // auto-generated (truncated) backing index name.
    const receiptUnique = await client.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
          FROM pg_constraint
        WHERE connamespace = $1::regnamespace
          AND conrelid = 'campaign_command_executions'::regclass
          AND contype = 'u'`,
      [schema],
    );
    expect(receiptUnique.rows.map(({ definition }) => definition)).toEqual([
      "UNIQUE (actor_id, command_kind, idempotency_key)",
    ]);

    const records = await client.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations WHERE filename = '0012_campaigns.sql'",
    );
    expect(records.rows).toEqual([{ filename: "0012_campaigns.sql" }]);
  });

  it("upgrades a pre-I6 schema without changing standalone data and rolls back invalid campaign writes", async () => {
    const productionDirectory = fileURLToPath(new URL("../../migrations", import.meta.url));
    const filenames = (await readdir(productionDirectory)).sort();
    for (const filename of filenames.filter((name) => name < "0012_campaigns.sql")) {
      await client.query(await readFile(join(productionDirectory, filename), "utf8"));
    }

    const userId = randomUUID();
    const systemId = randomUUID();
    const versionId = randomUUID();
    const characterId = randomUUID();
    await client.query("INSERT INTO users (id, display_name) VALUES ($1, 'Pre-I6')", [userId]);
    await client.query(
      `INSERT INTO systems (id, owner_id, name, access, lifecycle)
       VALUES ($1, $2, 'Pre-I6 system', 'private', 'active')`,
      [systemId, userId],
    );
    await client.query(
      `INSERT INTO system_versions (id, system_id, semantic_version, checksum, package_json, release_notes, lifecycle)
       VALUES ($1, $2, '1.0.0', $3, '{}'::jsonb, '', 'published')`,
      [versionId, systemId, `pre-i6-${randomUUID()}`],
    );
    await client.query(
      `INSERT INTO characters (id, owner_id, system_version_id, entity_definition_id, name, state_json)
       VALUES ($1, $2, $3, 'character', 'Pre-I6 hero', '{}'::jsonb)`,
      [characterId, userId, versionId],
    );
    const before = {
      users: (await client.query("SELECT id, display_name FROM users")).rows,
      systems: (await client.query("SELECT id, owner_id, name FROM systems")).rows,
      versions: (await client.query("SELECT id, system_id, semantic_version FROM system_versions")).rows,
      characters: (await client.query("SELECT id, owner_id, name FROM characters")).rows,
    };

    await client.query(await readFile(join(productionDirectory, "0012_campaigns.sql"), "utf8"));

    expect((await client.query("SELECT id, display_name FROM users")).rows).toEqual(before.users);
    expect((await client.query("SELECT id, owner_id, name FROM systems")).rows).toEqual(before.systems);
    expect((await client.query("SELECT id, system_id, semantic_version FROM system_versions")).rows).toEqual(
      before.versions,
    );
    expect((await client.query("SELECT id, owner_id, name FROM characters")).rows).toEqual(before.characters);

    await expect(
      client.query(
        `INSERT INTO campaigns (owner_id, system_version_id, title) VALUES ($1, $2, 'Bad version')`,
        [userId, randomUUID()],
      ),
    ).rejects.toThrow();
    await expect(
      client.query(
        `INSERT INTO campaigns (owner_id, system_version_id, title, revision) VALUES ($1, $2, 'Bad rev', 0)`,
        [userId, versionId],
      ),
    ).rejects.toThrow();
    await expect(
      client.query(
        `INSERT INTO campaigns (owner_id, system_version_id, title, status) VALUES ($1, $2, 'Bad status', 'draft')`,
        [userId, versionId],
      ),
    ).rejects.toThrow();

    const campaignId = randomUUID();
    await client.query(
      `INSERT INTO campaigns (id, owner_id, system_version_id, title) VALUES ($1, $2, $3, 'Good campaign')`,
      [campaignId, userId, versionId],
    );
    await expect(
      client.query(
        `INSERT INTO campaign_members (campaign_id, user_id, role) VALUES ($1, $2, 'gm')`,
        [campaignId, userId],
      ),
    ).rejects.toThrow();

    await client.query("BEGIN");
    try {
      await client.query(
        `INSERT INTO campaigns (id, owner_id, system_version_id, title) VALUES ($1, $2, $3, 'Rolled back')`,
        [randomUUID(), userId, versionId],
      );
      await client.query(
        `INSERT INTO campaign_members (campaign_id, user_id, role) VALUES ($1, $2, 'gm')`,
        [campaignId, userId],
      );
      await client.query("COMMIT");
    } catch {
      await client.query("ROLLBACK");
    }
    const campaigns = await client.query<{ title: string }>("SELECT title FROM campaigns ORDER BY title");
    expect(campaigns.rows).toEqual([{ title: "Good campaign" }]);

    await client.query(
      `INSERT INTO campaign_members (campaign_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [campaignId, userId],
    );
    const member = await client.query(
      `SELECT m.role, m.status, m.generation, c.revision, c.access_revision
         FROM campaign_members m JOIN campaigns c ON c.id = m.campaign_id
        WHERE m.campaign_id = $1`,
      [campaignId],
    );
    expect(member.rows).toEqual([
      { role: "owner", status: "active", generation: 1, revision: 1, access_revision: 1 },
    ]);
  });

  it("applies the 0013 ownership union, backfills standalone scope and rejects invalid placement", async () => {
    const productionDirectory = fileURLToPath(new URL("../../migrations", import.meta.url));
    const filenames = (await readdir(productionDirectory)).sort();
    // 0013 must be a fresh number: no other migration may claim it.
    expect(filenames.filter((name) => name.startsWith("0013"))).toEqual(["0013_campaign_character_scope.sql"]);
    for (const filename of filenames.filter((name) => name < "0013_campaign_character_scope.sql")) {
      await client.query(await readFile(join(productionDirectory, filename), "utf8"));
    }

    // Seed a full standalone footprint before 0013: user, system, version,
    // character plus history/receipt rows that must backfill to standalone scope.
    const userId = randomUUID();
    const systemId = randomUUID();
    const versionId = randomUUID();
    const characterId = randomUUID();
    await client.query("INSERT INTO users (id, display_name) VALUES ($1, 'Pre-0013')", [userId]);
    await client.query(
      `INSERT INTO systems (id, owner_id, name, access, lifecycle)
       VALUES ($1, $2, 'Pre-0013 system', 'private', 'active')`,
      [systemId, userId],
    );
    await client.query(
      `INSERT INTO system_versions (id, system_id, semantic_version, checksum, package_json, release_notes, lifecycle)
       VALUES ($1, $2, '1.0.0', $3, '{}'::jsonb, '', 'published')`,
      [versionId, systemId, `pre-0013-${randomUUID()}`],
    );
    await client.query(
      `INSERT INTO characters (id, owner_id, system_version_id, entity_definition_id, name, state_json)
       VALUES ($1, $2, $3, 'character', 'Pre-0013 hero', '{"schemaVersion":"1.0","values":{}}'::jsonb)`,
      [characterId, userId, versionId],
    );
    const executionId = randomUUID();
    await client.query(
      `INSERT INTO character_command_executions
         (actor_id, command_kind, idempotency_key, input_hash, character_id, execution_id,
          status, lease_expires_at, result_json, expires_at)
       VALUES ($1, 'character_create', $2, 'hash', $3, $4, 'completed', now(), '{}'::jsonb, now() + interval '1 day')`,
      [userId, `pre-0013-${randomUUID()}`, characterId, executionId],
    );
    await client.query(
      `INSERT INTO character_rolls
         (character_id, actor_id, action_id, execution_id, expression, dice_json, bindings_json,
          total, rendered_output, request_id)
       VALUES ($1, $2, 'check', $3, '1d20', '[]'::jsonb, '{}'::jsonb, 10, '10', $4)`,
      [characterId, userId, randomUUID(), randomUUID()],
    );
    await client.query(
      `INSERT INTO character_activity_events (character_id, character_revision, kind, payload_json, request_id)
       VALUES ($1, 1, 'character_created', '{}'::jsonb, $2)`,
      [characterId, randomUUID()],
    );
    const before = await client.query(
      `SELECT id, owner_id, system_version_id, entity_definition_id, name, revision, state_json, visibility, lifecycle
         FROM characters WHERE id = $1`,
      [characterId],
    );

    await client.query(await readFile(join(productionDirectory, "0013_campaign_character_scope.sql"), "utf8"));

    // Standalone rows survive byte-identical: same IDs, same owner, same state.
    const after = await client.query(
      `SELECT id, owner_id, campaign_id, placement_generation, return_owner_id,
              system_version_id, entity_definition_id, name, revision, state_json, visibility, lifecycle
         FROM characters WHERE id = $1`,
      [characterId],
    );
    expect(after.rows).toEqual([
      {
        ...before.rows[0],
        campaign_id: null,
        placement_generation: 1,
        return_owner_id: null,
      },
    ]);

    // History/receipts backfill to standalone scope (NULL) without rewrites.
    for (const table of ["character_command_executions", "character_rolls", "character_activity_events"]) {
      const scopes = await client.query(`SELECT DISTINCT scope_campaign_id FROM ${table}`);
      expect(scopes.rows).toEqual([{ scope_campaign_id: null }]);
    }

    // The union rejects neither scope and both scopes at once.
    await expect(
      client.query(
        `INSERT INTO characters (id, system_version_id, entity_definition_id, name, state_json)
         VALUES ($1, $2, 'character', 'Neither', '{}'::jsonb)`,
        [randomUUID(), versionId],
      ),
    ).rejects.toThrow();
    await expect(
      client.query(
        `INSERT INTO characters (id, owner_id, campaign_id, system_version_id, entity_definition_id, name, state_json)
         VALUES ($1, $2, $3, $4, 'character', 'Both', '{}'::jsonb)`,
        [randomUUID(), userId, randomUUID(), versionId],
      ),
    ).rejects.toThrow();
    // A return owner without campaign custody is rejected.
    await expect(
      client.query(
        `INSERT INTO characters (id, owner_id, return_owner_id, system_version_id, entity_definition_id, name, state_json)
         VALUES ($1, $2, $3, $4, 'character', 'ReturnWithoutCampaign', '{}'::jsonb)`,
        [randomUUID(), userId, randomUUID(), versionId],
      ),
    ).rejects.toThrow();

    // Campaign attachment works end to end: zero controllers is valid (no
    // dummy owner), controllers must reference same-campaign memberships.
    const campaignId = randomUUID();
    const otherCampaignId = randomUUID();
    await client.query(
      `INSERT INTO campaigns (id, owner_id, system_version_id, title) VALUES ($1, $2, $3, 'Scope campaign')`,
      [campaignId, userId, versionId],
    );
    await client.query(
      `INSERT INTO campaigns (id, owner_id, system_version_id, title) VALUES ($1, $2, $3, 'Other campaign')`,
      [otherCampaignId, userId, versionId],
    );
    await client.query(
      `INSERT INTO campaign_members (campaign_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [campaignId, userId],
    );
    await client.query(
      `INSERT INTO campaign_members (campaign_id, user_id, role) VALUES ($1, $2, 'player')`,
      [otherCampaignId, userId],
    );
    const attachedId = randomUUID();
    await client.query(
      `INSERT INTO characters (id, campaign_id, system_version_id, entity_definition_id, name, state_json)
       VALUES ($1, $2, $3, 'character', 'Unclaimed', '{}'::jsonb)`,
      [attachedId, campaignId, versionId],
    );
    // Zero controllers: valid GM-controlled/unclaimed sheet, NULL owner.
    const attached = await client.query(`SELECT owner_id FROM characters WHERE id = $1`, [attachedId]);
    expect(attached.rows).toEqual([{ owner_id: null }]);
    // A controller must reference a real membership: a user with no
    // membership in the claimed campaign violates the FK. (Same-campaign
    // pairing beyond that is module-enforced and covered in placement tests.)
    const strangerId = randomUUID();
    await client.query("INSERT INTO users (id, display_name) VALUES ($1, 'Stranger')", [strangerId]);
    await expect(
      client.query(
        `INSERT INTO character_controllers (character_id, campaign_id, user_id)
         VALUES ($1, $2, $3)`,
        [attachedId, otherCampaignId, strangerId],
      ),
    ).rejects.toThrow();
    // Same-campaign controller and claim designation succeed.
    await client.query(
      `INSERT INTO character_controllers (character_id, campaign_id, user_id)
       VALUES ($1, $2, $3)`,
      [attachedId, campaignId, userId],
    );
    await client.query(
      `INSERT INTO character_claim_designations (character_id, campaign_id, user_id, designated_by)
       VALUES ($1, $2, $3, $4)`,
      [attachedId, campaignId, userId, userId],
    );
    // Duplicate controller pairs are rejected.
    await expect(
      client.query(
        `INSERT INTO character_controllers (character_id, campaign_id, user_id)
         VALUES ($1, $2, $3)`,
        [attachedId, campaignId, userId],
      ),
    ).rejects.toThrow();

    // Full-directory double-apply (including 0013) is covered by the
    // production-schema tests above; here the file applied once after seeding.
  });

  it("applies the 0014 invitation table with hash-only storage and lifecycle guards", async () => {
    const productionDirectory = fileURLToPath(new URL("../../migrations", import.meta.url));
    const filenames = (await readdir(productionDirectory)).sort();
    // 0014 must be a fresh number: no other migration may claim it.
    expect(filenames.filter((name) => name.startsWith("0014"))).toEqual(["0014_campaign_invitations.sql"]);
    for (const filename of filenames.filter((name) => name < "0014_campaign_invitations.sql")) {
      await client.query(await readFile(join(productionDirectory, filename), "utf8"));
    }

    const userId = randomUUID();
    const systemId = randomUUID();
    const versionId = randomUUID();
    await client.query("INSERT INTO users (id, display_name) VALUES ($1, 'Pre-0014')", [userId]);
    await client.query(
      `INSERT INTO systems (id, owner_id, name, access, lifecycle)
       VALUES ($1, $2, 'Pre-0014 system', 'private', 'active')`,
      [systemId, userId],
    );
    await client.query(
      `INSERT INTO system_versions (id, system_id, semantic_version, checksum, package_json, release_notes, lifecycle)
       VALUES ($1, $2, '1.0.0', $3, '{}'::jsonb, '', 'published')`,
      [versionId, systemId, `pre-0014-${randomUUID()}`],
    );
    const campaignId = randomUUID();
    await client.query(
      `INSERT INTO campaigns (id, owner_id, system_version_id, title) VALUES ($1, $2, $3, 'Invite campaign')`,
      [campaignId, userId, versionId],
    );

    await client.query(await readFile(join(productionDirectory, "0014_campaign_invitations.sql"), "utf8"));

    // Hash-only storage: no plaintext token column exists.
    const columns = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'campaign_invitations'
        ORDER BY column_name`,
      [schema],
    );
    expect(columns.rows.map(({ column_name }) => column_name)).toEqual([
      "accepted_membership_generation",
      "campaign_id",
      "consuming_actor_id",
      "created_at",
      "expires_at",
      "id",
      "intended_role",
      "issued_by",
      "revision",
      "status",
      "token_hash",
      "updated_at",
    ]);

    // The token hash is globally unique: a duplicate hash is rejected.
    const invitationId = randomUUID();
    await client.query(
      `INSERT INTO campaign_invitations (id, campaign_id, issued_by, intended_role, token_hash, expires_at)
       VALUES ($1, $2, $3, 'player', 'hash-one', now() + interval '7 days')`,
      [invitationId, campaignId, userId],
    );
    await expect(
      client.query(
        `INSERT INTO campaign_invitations (campaign_id, issued_by, intended_role, token_hash, expires_at)
         VALUES ($1, $2, 'player', 'hash-one', now() + interval '7 days')`,
        [campaignId, userId],
      ),
    ).rejects.toThrow();
    // Invalid role/status rows are rejected.
    await expect(
      client.query(
        `INSERT INTO campaign_invitations (campaign_id, issued_by, intended_role, token_hash, expires_at)
         VALUES ($1, $2, 'owner', 'hash-two', now() + interval '7 days')`,
        [campaignId, userId],
      ),
    ).rejects.toThrow();
    await expect(
      client.query(
        `INSERT INTO campaign_invitations (campaign_id, issued_by, intended_role, token_hash, expires_at, status)
         VALUES ($1, $2, 'player', 'hash-three', now() + interval '7 days', 'consumed')`,
        [campaignId, userId],
      ),
    ).rejects.toThrow();

    // Deleting the campaign cascades its invitations.
    await client.query("DELETE FROM campaigns WHERE id = $1", [campaignId]);
    const remaining = await client.query("SELECT COUNT(*)::int AS count FROM campaign_invitations");
    expect(remaining.rows).toEqual([{ count: 0 }]);
    // (This test seeds then applies the file directly, so no
    // schema_migrations row exists here; full-directory double-apply
    // including 0014 is covered by the production campaign-tables test.)
  });

  it("normalizes existing active system versions during the 0009 upgrade", async () => {
    const productionDirectory = fileURLToPath(new URL("../../migrations", import.meta.url));
    const filenames = (await readdir(productionDirectory)).sort();
    for (const filename of filenames.filter((name) => name < "0009_create_characters.sql")) {
      await client.query(await readFile(join(productionDirectory, filename), "utf8"));
    }
    const systemId = randomUUID();
    await client.query(
      `INSERT INTO systems (id, owner_id, name, access, lifecycle)
       VALUES ($1, NULL, 'Upgrade fixture', 'link', 'active')`,
      [systemId],
    );
    await client.query(
      `INSERT INTO system_versions
         (system_id, semantic_version, checksum, package_json, release_notes, lifecycle)
       VALUES ($1, '9.0.0', $2, '{}'::jsonb, '', 'active')`,
      [systemId, `upgrade-${randomUUID()}`],
    );

    await client.query(
      await readFile(join(productionDirectory, "0009_create_characters.sql"), "utf8"),
    );

    const version = await client.query<{ lifecycle: string }>(
      "SELECT lifecycle FROM system_versions WHERE system_id = $1 AND semantic_version = '9.0.0'",
      [systemId],
    );
    expect(version.rows).toEqual([{ lifecycle: "published" }]);
  });
});
