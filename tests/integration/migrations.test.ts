import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../src/platform/migrations.js";

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
    expect(lifecycles.rows).toEqual([{ lifecycle: "published" }]);
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
