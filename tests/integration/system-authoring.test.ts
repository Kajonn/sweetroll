import { randomUUID } from "node:crypto";

import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { d20Document, d20Export } from "../../src/systems/implementation/package/fixtures/index.js";
import {
  createSystemPersistenceRepository,
  seedReferenceTemplates,
  type SystemPersistenceRepository,
} from "../../src/systems/implementation/persistence/index.js";
import {
  createSystemAuthoringModule,
  type SystemAuthoring,
} from "../../src/systems/authoring.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;

const DDL = `
  CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name text,
    locale text NOT NULL DEFAULT 'en',
    status text NOT NULL DEFAULT 'active',
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
  CREATE TABLE preview_snapshots (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    system_id       uuid NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
    source_revision integer NOT NULL,
    package_json    jsonb NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL
  );
  CREATE FUNCTION system_versions_prevent_mutation() RETURNS trigger
  LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.package_json IS DISTINCT FROM OLD.package_json
       OR NEW.checksum IS DISTINCT FROM OLD.checksum
       OR NEW.semantic_version IS DISTINCT FROM OLD.semantic_version THEN
      RAISE EXCEPTION 'published system versions are immutable';
    END IF;
    RETURN NEW;
  END;
  $$;
  CREATE TRIGGER system_versions_immutable
    BEFORE UPDATE ON system_versions
    FOR EACH ROW EXECUTE FUNCTION system_versions_prevent_mutation();
  CREATE TABLE characters (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    system_version_id uuid NOT NULL REFERENCES system_versions(id) ON DELETE RESTRICT,
    entity_definition_id text NOT NULL,
    name text NOT NULL,
    revision integer NOT NULL CHECK (revision >= 1),
    state_json jsonb NOT NULL,
    visibility text NOT NULL CHECK (visibility = 'owner_only'),
    lifecycle text NOT NULL CHECK (lifecycle IN ('active', 'archived')),
    archived_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
`;

describeWithDatabase("SystemAuthoring", () => {
  const schema = `system_authoring_${randomUUID().replaceAll("-", "")}`;
  let pool: Pool;
  let repo: SystemPersistenceRepository;
  let authoring: SystemAuthoring;

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
    repo = createSystemPersistenceRepository(pool);
    authoring = createSystemAuthoringModule({ repo });
  });

  beforeEach(async () => {
    await pool.query(`SET search_path TO ${schema}`);
    await pool.query(
      "TRUNCATE characters, system_audit_records, idempotency_receipts, preview_snapshots, system_versions, system_drafts, systems, users RESTART IDENTITY CASCADE",
    );
  });

  afterAll(async () => {
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    await pool.end();
  });

  async function createUser(displayName: string): Promise<string> {
    const result = await pool.query<{ id: string }>(
      "INSERT INTO users (display_name) VALUES ($1) RETURNING id",
      [displayName],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("createUser returned no row");
    }
    return row.id;
  }

  const ctx = (actorId: string) => ({ actorId, requestId: randomUUID() });

  async function waitForBlockedPublications(count: number): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const result = await pool.query<{ count: string }>(
        `SELECT count(*)
           FROM pg_stat_activity
          WHERE application_name = $1
            AND wait_event IN ('advisory', 'transactionid')`,
        [schema],
      );
      if (Number(result.rows[0]?.count) >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const activity = await pool.query<{ wait_event: string | null; query: string }>(
      `SELECT wait_event, query
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND usename = current_user
          AND wait_event IS NOT NULL`,
    );
    throw new Error(`Timed out waiting for ${count} blocked publications: ${JSON.stringify(activity.rows)}`);
  }

  it("creates a blank system with an initialized draft", async () => {
    const owner = await createUser("Ada");
    const result = await authoring.createDraft(ctx(owner), {
      source: { kind: "blank", name: "Pocket Quest" },
      idempotencyKey: randomUUID(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected");
    expect(result.value.system.name).toBe("Pocket Quest");
    expect(result.value.draft?.revision).toBe(1);
    expect(result.value.draft?.document.metadata.name).toBe("Pocket Quest");
    expect(result.value.versions).toEqual([]);
    expect(result.value.assessment).toEqual({ ok: true, diagnostics: [] });
  });

  it("replays identical creates from the idempotency key and rejects changed input", async () => {
    const owner = await createUser("Ada");
    const key = randomUUID();
    const first = await authoring.createDraft(ctx(owner), {
      source: { kind: "blank", name: "Same" },
      idempotencyKey: key,
    });
    expect(first.ok).toBe(true);
    const replay = await authoring.createDraft(ctx(owner), {
      source: { kind: "blank", name: "Same" },
      idempotencyKey: key,
    });
    expect(replay.ok).toBe(true);
    if (!first.ok || !replay.ok) throw new Error("unexpected");
    expect(replay.value.system.systemId).toBe(first.value.system.systemId);

    const mismatch = await authoring.createDraft(ctx(owner), {
      source: { kind: "blank", name: "Different" },
      idempotencyKey: key,
    });
    expect(mismatch).toEqual({
      ok: false,
      error: { code: "idempotency_mismatch", message: "This idempotency key was already used with different input." },
    });
  });

  it("creates a system by cloning a published version of the owner", async () => {
    const owner = await createUser("Ada");
    const created = await authoring.createDraft(ctx(owner), {
      source: { kind: "blank", name: "Source" },
      idempotencyKey: randomUUID(),
    });
    if (!created.ok) throw new Error("unexpected");
    const saved = await authoring.saveDraft(ctx(owner), {
      systemId: created.value.system.systemId,
      expectedRevision: 1,
      document: d20Document,
    });
    if (!saved.ok) throw new Error("unexpected");
    const published = await authoring.publish(ctx(owner), {
      systemId: created.value.system.systemId,
      expectedRevision: 2,
      semanticVersion: "1.0.0",
      releaseNotes: "",
      idempotencyKey: randomUUID(),
      acknowledgeBreaking: false,
    });
    if (!published.ok) throw new Error(`publish failed: ${JSON.stringify(published.error)}`);

    const clone = await authoring.createDraft(ctx(owner), {
      source: { kind: "clone", versionId: published.value.versionId },
      idempotencyKey: randomUUID(),
    });
    expect(clone.ok).toBe(true);
    if (!clone.ok) throw new Error("unexpected");
    expect(clone.value.draft?.document.expressions.map((e) => e.id)).toEqual(
      d20Document.expressions.map((e) => e.id),
    );
    expect(clone.value.assessment.ok).toBe(true);
  });

  it("imports an exported package into a new draft and rejects invalid exports", async () => {
    const owner = await createUser("Ada");
    const imported = await authoring.createDraft(ctx(owner), {
      source: { kind: "import", content: JSON.stringify(d20Export) },
      idempotencyKey: randomUUID(),
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) throw new Error("unexpected");
    expect(imported.value.draft?.document.expressions.length).toBe(3);

    const invalid = await authoring.createDraft(ctx(owner), {
      source: { kind: "import", content: "not json" },
      idempotencyKey: randomUUID(),
    });
    expect(invalid.ok).toBe(false);
    if (invalid.ok) throw new Error("unexpected");
    expect(invalid.error.code).toBe("invalid_package");
    expect(invalid.error.diagnostics?.length).toBeGreaterThan(0);
  });

  it("scopes open and list to the owning actor and paginates", async () => {
    const owner = await createUser("Ada");
    const stranger = await createUser("Bob");
    const first = await authoring.createDraft(ctx(owner), {
      source: { kind: "blank", name: "Mine" },
      idempotencyKey: randomUUID(),
    });
    if (!first.ok) throw new Error("unexpected");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await authoring.createDraft(ctx(owner), {
      source: { kind: "blank", name: "Also Mine" },
      idempotencyKey: randomUUID(),
    });
    if (!second.ok) throw new Error("unexpected");
    const systemId = first.value.system.systemId;

    expect((await authoring.open(ctx(stranger), systemId)).ok).toBe(false);
    const opened = await authoring.open(ctx(owner), systemId);
    expect(opened.ok).toBe(true);
    expect(await authoring.open(ctx(owner), randomUUID())).toEqual({
      ok: false,
      error: { code: "not_found", message: "The requested resource does not exist." },
    });

    const page1 = await authoring.list(ctx(owner), { limit: 1, cursor: null });
    expect(page1.ok).toBe(true);
    if (!page1.ok) throw new Error("unexpected");
    expect(page1.value.systems).toHaveLength(1);
    expect(page1.value.nextCursor).not.toBeNull();

    const page2 = await authoring.list(ctx(owner), { limit: 1, cursor: page1.value.nextCursor });
    if (!page2.ok) throw new Error("unexpected");
    expect(page2.value.systems).toHaveLength(1);
    expect(page2.value.systems[0]?.systemId).not.toBe(page1.value.systems[0]?.systemId);
    expect(page2.value.nextCursor).toBeNull();

    const strangerPage = await authoring.list(ctx(stranger), { limit: 20, cursor: null });
    expect(strangerPage.ok).toBe(true);
    if (!strangerPage.ok) throw new Error("unexpected");
    expect(strangerPage.value.systems).toEqual([]);
  });

  it("saves drafts with an assessment, rejects structural garbage, and reports conflicts", async () => {
    const owner = await createUser("Ada");
    const created = await authoring.createDraft(ctx(owner), {
      source: { kind: "blank", name: "Save" },
      idempotencyKey: randomUUID(),
    });
    if (!created.ok) throw new Error("unexpected");
    const systemId = created.value.system.systemId;

    const saved = await authoring.saveDraft(ctx(owner), {
      systemId,
      expectedRevision: 1,
      document: d20Document,
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error("unexpected");
    expect(saved.value.draft?.revision).toBe(2);
    expect(saved.value.assessment.ok).toBe(true);

    const stale = await authoring.saveDraft(ctx(owner), {
      systemId,
      expectedRevision: 1,
      document: d20Document,
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error("unexpected");
    expect(stale.error.code).toBe("conflict");
    expect(stale.error.latestRevision).toBe(2);

    const garbage = await authoring.saveDraft(ctx(owner), {
      systemId,
      expectedRevision: 2,
      document: { broken: true },
    });
    expect(garbage.ok).toBe(false);
    if (garbage.ok) throw new Error("unexpected");
    expect(garbage.error.code).toBe("invalid_package");
    const unchanged = await authoring.open(ctx(owner), systemId);
    if (!unchanged.ok) throw new Error("unexpected");
    expect(unchanged.value.draft?.revision).toBe(2);
  });

  it("saves a semantically invalid but structurally safe draft with failed assessment", async () => {
    const owner = await createUser("Ada");
    const created = await authoring.createDraft(ctx(owner), {
      source: { kind: "blank", name: "Broken" },
      idempotencyKey: randomUUID(),
    });
    if (!created.ok) throw new Error("unexpected");
    const broken = structuredClone(d20Document);
    broken.expressions.push({
      id: "broken_expr",
      context: "computed",
      resultType: "number",
      source: "fields.no_such_field + 1",
      fallback: 0,
    });
    const saved = await authoring.saveDraft(ctx(owner), {
      systemId: created.value.system.systemId,
      expectedRevision: 1,
      document: broken,
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error("unexpected");
    expect(saved.value.assessment.ok).toBe(false);
    expect(saved.value.assessment.diagnostics.length).toBeGreaterThan(0);
  });

  it("previews the current draft and refuses invalid drafts", async () => {
    const owner = await createUser("Ada");
    const created = await authoring.createDraft(ctx(owner), {
      source: { kind: "blank", name: "Preview" },
      idempotencyKey: randomUUID(),
    });
    if (!created.ok) throw new Error("unexpected");
    const systemId = created.value.system.systemId;
    await authoring.saveDraft(ctx(owner), { systemId, expectedRevision: 1, document: d20Document });

    const preview = await authoring.previewDraft(ctx(owner), { systemId });
    expect(preview.ok).toBe(true);
    if (!preview.ok) throw new Error("unexpected");
    expect(preview.value.systemId).toBe(systemId);
    expect(preview.value.sourceRevision).toBe(2);
    expect(preview.value.package.integrity.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);

    await authoring.saveDraft(ctx(owner), {
      systemId,
      expectedRevision: 2,
      document: { broken: true },
    });
    const stillValid = await authoring.previewDraft(ctx(owner), { systemId });
    expect(stillValid.ok).toBe(true);

    const semantic = structuredClone(d20Document);
    semantic.expressions.push({
      id: "broken_expr",
      context: "computed",
      resultType: "number",
      source: "fields.no_such_field + 1",
      fallback: 0,
    });
    const savedInvalid = await authoring.saveDraft(ctx(owner), {
      systemId,
      expectedRevision: 2,
      document: semantic,
    });
    if (!savedInvalid.ok) throw new Error("unexpected");
    expect(savedInvalid.value.assessment.ok).toBe(false);

    const invalid = await authoring.previewDraft(ctx(owner), { systemId });
    expect(invalid.ok).toBe(false);
    if (invalid.ok) throw new Error("unexpected");
    expect(invalid.error.code).toBe("invalid_package");
  });

  it("publishes an immutable version with audit, idempotency, and conflict handling", async () => {
    const owner = await createUser("Ada");
    const created = await authoring.createDraft(ctx(owner), {
      source: { kind: "blank", name: "Publish" },
      idempotencyKey: randomUUID(),
    });
    if (!created.ok) throw new Error("unexpected");
    const systemId = created.value.system.systemId;
    await authoring.saveDraft(ctx(owner), { systemId, expectedRevision: 1, document: d20Document });
    const key = randomUUID();

    const published = await authoring.publish(ctx(owner), {
      systemId,
      expectedRevision: 2,
      semanticVersion: "1.0.0",
      releaseNotes: "First",
      idempotencyKey: key,
      acknowledgeBreaking: false,
    });
    expect(published.ok).toBe(true);
    if (!published.ok) throw new Error(`publish failed: ${JSON.stringify(published.error)}`);
    expect(published.value.semanticVersion).toBe("1.0.0");
    expect(published.value.package.integrity.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);

    const replay = await authoring.publish(ctx(owner), {
      systemId,
      expectedRevision: 2,
      semanticVersion: "1.0.0",
      releaseNotes: "First",
      idempotencyKey: key,
      acknowledgeBreaking: false,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok || !published.ok) throw new Error("unexpected");
    expect(replay.value.versionId).toBe(published.value.versionId);

    const mismatch = await authoring.publish(ctx(owner), {
      systemId,
      expectedRevision: 2,
      semanticVersion: "1.0.0",
      releaseNotes: "First",
      idempotencyKey: key,
      acknowledgeBreaking: true,
    });
    expect(mismatch).toEqual({
      ok: false,
      error: { code: "idempotency_mismatch", message: "This idempotency key was already used with different input." },
    });

    const duplicate = await authoring.publish(ctx(owner), {
      systemId,
      expectedRevision: 2,
      semanticVersion: "1.0.0",
      releaseNotes: "Again",
      idempotencyKey: randomUUID(),
      acknowledgeBreaking: false,
    });
    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) throw new Error("unexpected");
    expect(duplicate.error.code).toBe("conflict");

    const stale = await authoring.publish(ctx(owner), {
      systemId,
      expectedRevision: 1,
      semanticVersion: "1.1.0",
      releaseNotes: "",
      idempotencyKey: randomUUID(),
      acknowledgeBreaking: false,
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error("unexpected");
    expect(stale.error.code).toBe("conflict");
    expect(stale.error.latestRevision).toBe(2);

    const badSemver = await authoring.publish(ctx(owner), {
      systemId,
      expectedRevision: 2,
      semanticVersion: "not-a-version",
      releaseNotes: "",
      idempotencyKey: randomUUID(),
      acknowledgeBreaking: false,
    });
    expect(badSemver.ok).toBe(false);
    if (badSemver.ok) throw new Error("unexpected");
    expect(badSemver.error.code).toBe("bad_request");

    const audit = await repo.listAudit(systemId);
    expect(audit.some((r) => r.kind === "version_published")).toBe(true);
  });

  it("blocks publication from archived systems until restored", async () => {
    const owner = await createUser("Ada");
    const created = await authoring.createDraft(ctx(owner), {
      source: { kind: "blank", name: "Archive" },
      idempotencyKey: randomUUID(),
    });
    if (!created.ok) throw new Error("unexpected");
    const systemId = created.value.system.systemId;
    await authoring.saveDraft(ctx(owner), { systemId, expectedRevision: 1, document: d20Document });

    const archived = await authoring.changeLifecycle(ctx(owner), {
      kind: "system",
      systemId,
      lifecycle: "archived",
    });
    expect(archived).toEqual({ ok: true, value: { kind: "system", systemId, lifecycle: "archived" } });

    const blocked = await authoring.publish(ctx(owner), {
      systemId,
      expectedRevision: 2,
      semanticVersion: "1.0.0",
      releaseNotes: "",
      idempotencyKey: randomUUID(),
      acknowledgeBreaking: false,
    });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("unexpected");
    expect(blocked.error.code).toBe("conflict");

    const restored = await authoring.changeLifecycle(ctx(owner), { kind: "system", systemId, lifecycle: "active" });
    expect(restored.ok).toBe(true);

    const published = await authoring.publish(ctx(owner), {
      systemId,
      expectedRevision: 2,
      semanticVersion: "1.0.0",
      releaseNotes: "",
      idempotencyKey: randomUUID(),
      acknowledgeBreaking: false,
    });
    expect(published.ok).toBe(true);
  });

  it("exports a published version and deprecates it", async () => {
    const owner = await createUser("Ada");
    const stranger = await createUser("Bob");
    const created = await authoring.createDraft(ctx(owner), {
      source: { kind: "blank", name: "Export" },
      idempotencyKey: randomUUID(),
    });
    if (!created.ok) throw new Error("unexpected");
    const systemId = created.value.system.systemId;
    await authoring.saveDraft(ctx(owner), { systemId, expectedRevision: 1, document: d20Document });
    const published = await authoring.publish(ctx(owner), {
      systemId,
      expectedRevision: 2,
      semanticVersion: "1.0.0",
      releaseNotes: "",
      idempotencyKey: randomUUID(),
      acknowledgeBreaking: false,
    });
    if (!published.ok) throw new Error("unexpected");

    const exported = await authoring.exportVersion(ctx(owner), published.value.versionId);
    expect(exported.ok).toBe(true);
    if (!exported.ok) throw new Error("unexpected");
    expect(exported.value.package.integrity.checksum).toBe(published.value.package.integrity.checksum);
    expect(exported.value.mediaType).toBe("application/vnd.sweetroll.system+json;version=1");

    expect((await authoring.exportVersion(ctx(stranger), published.value.versionId)).ok).toBe(false);
    expect((await authoring.exportVersion(ctx(owner), randomUUID())).ok).toBe(false);

    const deprecated = await authoring.changeLifecycle(ctx(owner), {
      kind: "version",
      versionId: published.value.versionId,
      lifecycle: "deprecated",
    });
    expect(deprecated.ok).toBe(true);
    if (!deprecated.ok) throw new Error("unexpected");
    expect(deprecated.value).toMatchObject({
      kind: "version",
      versionId: published.value.versionId,
      lifecycle: "deprecated",
    });
  });

  it("publishes a first version without a compatibility check", async () => {
    const owner = await createUser("Grace");
    const created = await authoring.createDraft(ctx(owner), {
      source: { kind: "blank", name: "Compat First" },
      idempotencyKey: randomUUID(),
    });
    if (!created.ok) throw new Error("unexpected");
    await authoring.saveDraft(ctx(owner), { systemId: created.value.system.systemId, expectedRevision: 1, document: d20Document });
    const published = await authoring.publish(ctx(owner), {
      systemId: created.value.system.systemId,
      expectedRevision: 2,
      semanticVersion: "1.0.0",
      releaseNotes: "Initial",
      idempotencyKey: randomUUID(),
      acknowledgeBreaking: false,
    });
    expect(published.ok).toBe(true);
  });

  it("requires acknowledgement and a greater major to publish a breaking version", async () => {
    const owner = await createUser("Hank");
    const created = await authoring.createDraft(ctx(owner), {
      source: { kind: "blank", name: "Compat Block" },
      idempotencyKey: randomUUID(),
    });
    if (!created.ok) throw new Error("unexpected");
    const systemId = created.value.system.systemId;
    await authoring.saveDraft(ctx(owner), { systemId, expectedRevision: 1, document: d20Document });
    const first = await authoring.publish(ctx(owner), {
      systemId,
      expectedRevision: 2,
      semanticVersion: "1.0.0",
      releaseNotes: "Initial",
      idempotencyKey: randomUUID(),
      acknowledgeBreaking: false,
    });
    if (!first.ok) throw new Error("unexpected");

    const mutated = structuredClone(d20Document);
    mutated.entities[0].fields = mutated.entities[0].fields.filter((f) => f.id !== "proficient");
    await authoring.saveDraft(ctx(owner), { systemId, expectedRevision: 2, document: mutated });
    const unacknowledged = await authoring.publish(ctx(owner), {
      systemId,
      expectedRevision: 3,
      semanticVersion: "2.0.0",
      releaseNotes: "Removed proficient",
      idempotencyKey: randomUUID(),
      acknowledgeBreaking: false,
    });
    expect(unacknowledged.ok).toBe(false);
    if (unacknowledged.ok) throw new Error("expected failure");
    expect(unacknowledged.error.code).toBe("invalid_package");
    expect(unacknowledged.error.diagnostics ?? []).toContainEqual(
      expect.objectContaining({
        code: "breaking_removed_definition",
        path: "/entities/character/fields/proficient",
      }),
    );

    const sameMajor = await authoring.publish(ctx(owner), {
      systemId,
      expectedRevision: 3,
      semanticVersion: "1.1.0",
      releaseNotes: "Removed proficient",
      idempotencyKey: randomUUID(),
      acknowledgeBreaking: true,
    });
    expect(sameMajor.ok).toBe(false);
    if (sameMajor.ok) throw new Error("expected failure");
    expect(sameMajor.error.code).toBe("invalid_package");
    expect(sameMajor.error.diagnostics).toEqual(unacknowledged.error.diagnostics);

    const acknowledged = await authoring.publish(ctx(owner), {
      systemId,
      expectedRevision: 3,
      semanticVersion: "2.0.0",
      releaseNotes: "Removed proficient",
      idempotencyKey: randomUUID(),
      acknowledgeBreaking: true,
    });
    expect(acknowledged.ok).toBe(true);
    if (!acknowledged.ok) throw new Error(`expected success: ${JSON.stringify(acknowledged.error)}`);
    const stored = await pool.query<{ compatibility_findings_json: unknown }>(
      "SELECT compatibility_findings_json FROM system_versions WHERE id = $1",
      [acknowledged.value.versionId],
    );
    expect(stored.rows[0]?.compatibility_findings_json).toEqual(unacknowledged.error.diagnostics);
  });

  it("serializes concurrent breaking publications against the current latest major", async () => {
    const owner = await createUser("Concurrent Publisher");
    const created = await authoring.createDraft(ctx(owner), {
      source: { kind: "blank", name: "Concurrent Breaking" },
      idempotencyKey: randomUUID(),
    });
    if (!created.ok) throw new Error("unexpected");
    const systemId = created.value.system.systemId;
    await authoring.saveDraft(ctx(owner), { systemId, expectedRevision: 1, document: d20Document });
    const first = await authoring.publish(ctx(owner), {
      systemId,
      expectedRevision: 2,
      semanticVersion: "1.0.0",
      releaseNotes: "Initial",
      idempotencyKey: randomUUID(),
      acknowledgeBreaking: false,
    });
    if (!first.ok) throw new Error("unexpected");

    const breaking = structuredClone(d20Document);
    breaking.entities[0].fields = breaking.entities[0].fields.filter((field) => field.id !== "proficient");
    await authoring.saveDraft(ctx(owner), { systemId, expectedRevision: 2, document: breaking });

    const publish = (semanticVersion: string) =>
      authoring.publish(ctx(owner), {
        systemId,
        expectedRevision: 3,
        semanticVersion,
        releaseNotes: `Breaking ${semanticVersion}`,
        idempotencyKey: randomUUID(),
        acknowledgeBreaking: true,
      });

    const insertGate = 1_374_921_663;
    await pool.query(`
      CREATE FUNCTION block_concurrent_version_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(${insertGate});
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER block_concurrent_version_insert
        BEFORE INSERT ON system_versions
        FOR EACH ROW EXECUTE FUNCTION block_concurrent_version_insert();
    `);
    const gateClient = await pool.connect();
    await gateClient.query("SELECT pg_advisory_lock($1::integer)", [insertGate]);
    let majorTwoPromise: ReturnType<typeof publish> | undefined;
    let majorThreePromise: ReturnType<typeof publish> | undefined;
    let majorTwo: Awaited<ReturnType<typeof publish>>;
    let majorThree: Awaited<ReturnType<typeof publish>>;
    try {
      majorThreePromise = publish("3.0.0");
      await waitForBlockedPublications(1);
      majorTwoPromise = publish("2.0.0");
      await waitForBlockedPublications(2);
      await gateClient.query("SELECT pg_advisory_unlock($1::integer)", [insertGate]);
      [majorTwo, majorThree] = await Promise.all([majorTwoPromise, majorThreePromise]);
    } finally {
      await gateClient.query("SELECT pg_advisory_unlock($1::integer)", [insertGate]);
      gateClient.release();
      await Promise.allSettled([majorTwoPromise, majorThreePromise].filter((value) => value !== undefined));
      await pool.query("DROP TRIGGER block_concurrent_version_insert ON system_versions");
      await pool.query("DROP FUNCTION block_concurrent_version_insert()");
    }

    expect(majorThree.ok).toBe(true);
    expect(majorTwo.ok).toBe(false);
    if (majorTwo.ok) throw new Error("major 2 must not publish after major 3");
    expect(majorTwo.error.code).toBe("invalid_package");
    expect(majorTwo.error.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "breaking_removed_definition",
        path: "/entities/character/fields/proficient",
      }),
    );
    const versions = await repo.listVersions(systemId);
    expect(versions.map(({ semanticVersion }) => semanticVersion).sort()).toEqual(["1.0.0", "3.0.0"]);
  }, 15_000);

  it("permits a compatible additive change between versions", async () => {
    const owner = await createUser("Iris");
    const created = await authoring.createDraft(ctx(owner), {
      source: { kind: "blank", name: "Compat Additive" },
      idempotencyKey: randomUUID(),
    });
    if (!created.ok) throw new Error("unexpected");
    const systemId = created.value.system.systemId;
    await authoring.saveDraft(ctx(owner), { systemId, expectedRevision: 1, document: d20Document });
    const first = await authoring.publish(ctx(owner), {
      systemId,
      expectedRevision: 2,
      semanticVersion: "1.0.0",
      releaseNotes: "Initial",
      idempotencyKey: randomUUID(),
      acknowledgeBreaking: false,
    });
    if (!first.ok) throw new Error("unexpected");

    const mutated = structuredClone(d20Document);
    mutated.entities[0].fields.push({
      kind: "text",
      id: "notes",
      label: "Notes",
      required: false,
      default: "",
      minLength: 0,
      maxLength: 200,
    });
    await authoring.saveDraft(ctx(owner), { systemId, expectedRevision: 2, document: mutated });
    const second = await authoring.publish(ctx(owner), {
      systemId,
      expectedRevision: 3,
      semanticVersion: "1.1.0",
      releaseNotes: "Added notes",
      idempotencyKey: randomUUID(),
      acknowledgeBreaking: false,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("expected success");
    expect(second.value.semanticVersion).toBe("1.1.0");
  });

  it("authorizes only accessible active published versions without returning package JSON", async () => {
    const owner = await createUser("Version Owner");
    const stranger = await createUser("Version User");
    const privateSystem = await repo.createSystem({ ownerId: owner, name: "Private" });
    const privateVersion = await repo.insertVersion({
      systemId: privateSystem.systemId,
      semanticVersion: "1.0.0",
      checksum: "private-checksum",
      package: d20Export.package,
      releaseNotes: "",
    });

    expect(await authoring.authorizeVersionUse(ctx(owner), privateVersion.versionId)).toEqual({
      ok: true,
      value: {
        systemId: privateSystem.systemId,
        versionId: privateVersion.versionId,
        checksum: "private-checksum",
      },
    });
    expect(await authoring.authorizeVersionUse(ctx(stranger), privateVersion.versionId)).toEqual({
      ok: false,
      error: { code: "not_found", message: "The requested resource does not exist." },
    });

    for (const access of ["public", "link"] as const) {
      const accessibleSystem = await repo.createSystem({ ownerId: owner, name: access });
      await pool.query("UPDATE systems SET access = $2 WHERE id = $1", [accessibleSystem.systemId, access]);
      const version = await repo.insertVersion({
        systemId: accessibleSystem.systemId,
        semanticVersion: "1.0.0",
        checksum: `${access}-checksum`,
        package: d20Export.package,
        releaseNotes: "",
      });
      expect(await authoring.authorizeVersionUse(ctx(stranger), version.versionId)).toEqual({
        ok: true,
        value: {
          systemId: accessibleSystem.systemId,
          versionId: version.versionId,
          checksum: `${access}-checksum`,
        },
      });
    }

    await repo.updateVersionLifecycle(privateVersion.versionId, "deprecated");
    expect((await authoring.authorizeVersionUse(ctx(owner), privateVersion.versionId)).ok).toBe(false);
    await pool.query("UPDATE system_versions SET lifecycle = 'published' WHERE id = $1", [privateVersion.versionId]);
    await repo.updateSystemLifecycle(privateSystem.systemId, "archived");
    expect((await authoring.authorizeVersionUse(ctx(owner), privateVersion.versionId)).ok).toBe(false);

    await seedReferenceTemplates(pool);
    const template = await authoring.authorizeVersionUse(
      ctx(stranger),
      "a0000000-0000-5000-8000-000000000002",
    );
    expect(template).toEqual({
      ok: true,
      value: {
        systemId: "a0000000-0000-5000-8000-000000000001",
        versionId: "a0000000-0000-5000-8000-000000000002",
        checksum: d20Export.package.integrity.checksum,
      },
    });
  });

  it("returns conflict without deleting a system or version pinned by a character", async () => {
    const owner = await createUser("Pinned Owner");
    const system = await repo.createSystem({ ownerId: owner, name: "Pinned" });
    const version = await repo.insertVersion({
      systemId: system.systemId,
      semanticVersion: "1.0.0",
      checksum: "pinned-checksum",
      package: d20Export.package,
      releaseNotes: "",
    });
    const character = await pool.query<{ id: string }>(
      `INSERT INTO characters
         (owner_id, system_version_id, entity_definition_id, name, revision, state_json, visibility, lifecycle)
       VALUES ($1, $2, 'character', 'Pinned Hero', 1, '{}'::jsonb, 'owner_only', 'active')
       RETURNING id`,
      [owner, version.versionId],
    );

    expect(await authoring.deleteSystem(ctx(owner), system.systemId)).toEqual({
      ok: false,
      error: { code: "conflict", message: "The system is referenced and cannot be deleted." },
    });
    expect((await pool.query("SELECT id FROM characters WHERE id = $1", [character.rows[0]?.id])).rowCount).toBe(1);
    expect((await pool.query("SELECT id FROM system_versions WHERE id = $1", [version.versionId])).rowCount).toBe(1);
    expect((await pool.query("SELECT id FROM systems WHERE id = $1", [system.systemId])).rowCount).toBe(1);
  });
});
