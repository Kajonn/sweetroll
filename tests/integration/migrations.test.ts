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
      "character_command_executions",
      "character_migration_previews",
      "character_migrations",
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
      "campaign_members",
      "campaigns",
    ]);

    const constraints = await client.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE connamespace = $1::regnamespace
          AND conrelid IN ('campaigns'::regclass, 'campaign_members'::regclass)`,
      [schema],
    );
    const definitions = constraints.rows.map(({ definition }) => definition);
    expect(definitions).toContain("CHECK ((revision > 0))");
    expect(definitions).toContain("CHECK ((access_revision > 0))");
    expect(definitions).toContain("CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text])))");
    expect(definitions).toContain("CHECK ((role = ANY (ARRAY['owner'::text, 'co_gm'::text, 'player'::text])))");
    expect(definitions).toContain("CHECK ((status = ANY (ARRAY['active'::text, 'removed'::text])))");
    expect(definitions).toContain("CHECK ((generation >= 1))");

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
        ORDER BY indexname`,
      [schema],
    );
    expect(indexes.rows.map(({ indexname }) => indexname)).toEqual([
      "campaign_audit_records_page_idx",
      "campaign_audit_records_pkey",
      "campaign_command_executions_actor_id_command_kind_idempoten_key",
      "campaign_command_executions_expiry_idx",
      "campaign_command_executions_pkey",
      "campaign_members_pkey",
      "campaign_members_user_idx",
      "campaigns_owner_page_idx",
      "campaigns_pkey",
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
