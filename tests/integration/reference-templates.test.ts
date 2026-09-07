import { randomUUID } from "node:crypto";

import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createSystemRuntime } from "../../src/systems/runtime.js";
import { createPostgresPublishedPackageLoader } from "../../src/systems/implementation/runtime/package-loader.js";
import { calculatePackageChecksum } from "../../src/systems/implementation/package/canonical.js";
import {
  REFERENCE_TEMPLATES,
  seedReferenceTemplates,
} from "../../src/systems/implementation/persistence/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;

const DDL = `
  CREATE TABLE systems (
    id uuid PRIMARY KEY,
    owner_id uuid,
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
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (system_id, semantic_version)
  );
`;

/**
 * Task 11 focused regression: seeded reference templates must resolve
 * through the production runtime path. Authorization alone is not enough —
 * `SystemRuntime` rejects packages whose embedded versionId differs from the
 * requested row id, which is exactly what character creation hits.
 */
describeWithDatabase("reference template seeding", () => {
  const schema = `reference_templates_${randomUUID().replaceAll("-", "")}`;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: databaseUrl,
      application_name: schema,
      max: 5,
      onConnect: async client => {
        await client.query(`SET search_path TO ${schema}`);
      },
    });
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    await admin.query(DDL);
    await admin.end();
  });

  beforeEach(async () => {
    await pool.query(`SET search_path TO ${schema}`);
    await pool.query("TRUNCATE system_versions, systems RESTART IDENTITY CASCADE");
  });

  afterAll(async () => {
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    await pool.end();
  });

  it("stamps seeded packages with their row identity and a matching checksum", async () => {
    await seedReferenceTemplates(pool);
    for (const template of REFERENCE_TEMPLATES) {
      const row = (
        await pool.query<{ checksum: string; package_json: { versionId: string; systemId: string; integrity: { checksum: string } } }>(
          "SELECT checksum, package_json FROM system_versions WHERE id = $1",
          [template.versionId],
        )
      ).rows[0];
      expect(row).toBeDefined();
      expect(row?.package_json.versionId).toBe(template.versionId);
      expect(row?.package_json.systemId).toBe(template.systemId);
      expect(row?.package_json.integrity.checksum).toBe(row?.checksum);
      expect(row?.checksum).toBe(
        calculatePackageChecksum(
          row?.package_json as unknown as Parameters<typeof calculatePackageChecksum>[0],
        ),
      );
    }
  });

  it("resolves every reference template through the production runtime loader", async () => {
    await seedReferenceTemplates(pool);
    const runtime = createSystemRuntime({
      loadPackage: createPostgresPublishedPackageLoader(pool),
      authoritativeRollSecret: "a".repeat(32),
    });
    for (const template of REFERENCE_TEMPLATES) {
      const resolved = await runtime.resolve({
        versionId: template.versionId,
        entityId: "character",
        intent: { kind: "initialize" },
      });
      expect(resolved.ok).toBe(true);
    }
  });

  it("repairs rows whose stored package drifted from the fixture", async () => {
    const template = REFERENCE_TEMPLATES[0];
    expect(template).toBeDefined();
    await pool.query(
      "INSERT INTO systems (id, owner_id, name, access, lifecycle, created_at, updated_at) VALUES ($1, NULL, 'Template: d20', 'link', 'active', now(), now())",
      [template?.systemId],
    );
    await pool.query(
      "INSERT INTO system_versions (id, system_id, semantic_version, checksum, package_json, release_notes, lifecycle, created_at) VALUES ($1, $2, '1.0.0', 'pending:d20', '{}'::jsonb, 'Template seed', 'published', now())",
      [template?.versionId, template?.systemId],
    );
    const result = await seedReferenceTemplates(pool);
    expect(result.versionsReplaced).toBeGreaterThanOrEqual(1);
    const row = (
      await pool.query<{ package_json: { versionId: string; systemId: string } }>(
        "SELECT package_json FROM system_versions WHERE id = $1",
        [template?.versionId],
      )
    ).rows[0];
    expect(row?.package_json.versionId).toBe(template?.versionId);
    expect(row?.package_json.systemId).toBe(template?.systemId);
  });
});

/**
 * Task 11 I4 (TDD): repair-by-delete is RESTRICT-unsafe once characters or
 * migration rows reference a drifted template row. The seeder must skip the
 * repair (log + keep the old row) instead of DELETEing a referenced version.
 * Runs against a fake runner so no database is required. Probes must pass
 * the drifted row's own versionId as $1 (per-versionId arguments).
 */
describe("reference template seeder RESTRICT guard", () => {
  type ProbeCall = { text: string; params: unknown[] };

  function makeFake(targetVersionId: string, hitOn: "characters" | "previews" | "migrations") {
    const calls: ProbeCall[] = [];
    const fakeRunner = {
      async query(text: string, params?: unknown[]) {
        calls.push({ text, params: params ?? [] });
        if (text.startsWith("INSERT INTO systems")) return { rowCount: 0, rows: [] };
        if (text.startsWith("SELECT id, checksum")) {
          const versionId = params?.[0] as string;
          const tpl = REFERENCE_TEMPLATES.find(t => t.versionId === versionId);
          if (tpl !== undefined && versionId === targetVersionId) {
            return { rowCount: 1, rows: [{ id: versionId, checksum: "pending:drift", package_json: {} }] };
          }
          if (tpl !== undefined) {
            return {
              rowCount: 1,
              rows: [{
                id: versionId,
                checksum: tpl.package.integrity.checksum,
                package_json: { versionId: tpl.versionId, systemId: tpl.systemId },
              }],
            };
          }
          return { rowCount: 0, rows: [] };
        }
        if (text.includes("FROM characters WHERE system_version_id")) {
          const hit = hitOn === "characters" && params?.[0] === targetVersionId;
          return { rowCount: hit ? 1 : 0, rows: hit ? [{ one: 1 }] : [] };
        }
        if (text.includes("FROM character_migration_previews")) {
          const hit = hitOn === "previews" && params?.[0] === targetVersionId;
          return { rowCount: hit ? 1 : 0, rows: hit ? [{ one: 1 }] : [] };
        }
        if (text.includes("FROM character_migrations")) {
          const hit = hitOn === "migrations" && params?.[0] === targetVersionId;
          return { rowCount: hit ? 1 : 0, rows: hit ? [{ one: 1 }] : [] };
        }
        throw new Error(`unexpected query: ${text}`);
      },
    };
    return { calls, fakeRunner };
  }

  async function expectSkipOnReference(hitOn: "characters" | "previews" | "migrations") {
    const template = REFERENCE_TEMPLATES[0]!;
    const { calls, fakeRunner } = makeFake(template.versionId, hitOn);
    // eslint-disable-next-line no-console
    const warn = console.warn;
    const warnings: unknown[][] = [];
    // eslint-disable-next-line no-console
    console.warn = (...args: unknown[]) => void warnings.push(args);
    try {
      const result = await seedReferenceTemplates(fakeRunner as never);
      expect(result.versionsReplaced).toBe(0);
    } finally {
      // eslint-disable-next-line no-console
      console.warn = warn;
    }
    expect(calls.some(c => c.text.startsWith("DELETE FROM system_versions"))).toBe(false);
    const tableFragment =
      hitOn === "characters"
        ? "FROM characters WHERE system_version_id"
        : hitOn === "previews"
          ? "FROM character_migration_previews"
          : "FROM character_migrations";
    const probeCalls = calls.filter(c => c.text.includes(tableFragment));
    expect(probeCalls.length).toBeGreaterThanOrEqual(1);
    // Per-versionId probe arguments: every probe carries the drifted row's own versionId as $1.
    for (const probe of probeCalls) expect(probe.params[0]).toBe(template.versionId);
    expect(probeCalls.some(c => c.params[0] === template.versionId)).toBe(true);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  }

  it("skips repair when characters reference the drifted version", async () => {
    await expectSkipOnReference("characters");
  });

  it("skips repair when migration previews reference the drifted version", async () => {
    await expectSkipOnReference("previews");
  });

  it("skips repair when migrations reference the drifted version", async () => {
    await expectSkipOnReference("migrations");
  });
});
