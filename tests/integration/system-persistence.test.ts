import { randomUUID } from "node:crypto";

import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createSystemPersistenceRepository } from "../../src/systems/implementation/persistence/index.js";

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
`;

describeWithDatabase("SystemPersistenceRepository", () => {
  const schema = `system_repo_${randomUUID().replaceAll("-", "")}`;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: databaseUrl,
      max: 1,
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
  });

  beforeEach(async () => {
    await pool.query(`SET search_path TO ${schema}`);
    await pool.query(
      "TRUNCATE system_audit_records, idempotency_receipts, preview_snapshots, system_versions, system_drafts, systems, users RESTART IDENTITY CASCADE",
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

  it("creates, opens, and lists systems scoped to the owner", async () => {
    const owner = await createUser("Ada");
    const other = await createUser("Bob");

    const created = await createSystemPersistenceRepository(pool).createSystem({
      ownerId: owner,
      name: "Pocket Quest",
    });

    expect(created.access).toBe("private");
    expect(created.lifecycle).toBe("active");

    const opened = await createSystemPersistenceRepository(pool).openSystem(created.systemId);
    expect(opened).toEqual(created);

    expect(
      await createSystemPersistenceRepository(pool).openSystem(randomUUID()),
    ).toBeNull();

    const owned = await createSystemPersistenceRepository(pool).listSystems(owner);
    expect(owned.map((s) => s.systemId)).toContain(created.systemId);

    const foreign = await createSystemPersistenceRepository(pool).listSystems(other);
    expect(foreign.map((s) => s.systemId)).not.toContain(created.systemId);
  });

  it("initializes a draft, increments its revision, and reports stale saves", async () => {
    const owner = await createUser("Ada");
    const { systemId } = await createSystemPersistenceRepository(pool).createSystem({
      ownerId: owner,
      name: "Pocket Quest",
    });
    const repo = createSystemPersistenceRepository(pool);

    const first = await repo.saveDraft({
      systemId,
      expectedRevision: null,
      document: { schemaVersion: "1.0", head: "first" },
      sourceChecksum: "sha256:first",
      updatedBy: owner,
      requestId: "req-test",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unexpected");
    expect(first.draft.revision).toBe(1);
    expect(first.draft.document).toEqual({ schemaVersion: "1.0", head: "first" });

    const second = await repo.saveDraft({
      systemId,
      expectedRevision: 1,
      document: { schemaVersion: "1.0", head: "second" },
      sourceChecksum: "sha256:second",
      updatedBy: owner,
      requestId: "req-test",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unexpected");
    expect(second.draft.revision).toBe(2);

    const stale = await repo.saveDraft({
      systemId,
      expectedRevision: 1,
      document: { schemaVersion: "1.0", head: "stale" },
      sourceChecksum: "sha256:stale",
      updatedBy: owner,
      requestId: "req-test",
    });
    expect(stale).toEqual({ ok: false, code: "stale_revision", latestRevision: 2 });

    const loaded = await repo.loadDraft(systemId);
    expect(loaded?.revision).toBe(2);
    expect(loaded?.document).toEqual({ schemaVersion: "1.0", head: "second" });
    expect(loaded?.sourceChecksum).toBe("sha256:second");
  });

  it("rejects a stale save when no draft has ever been saved", async () => {
    const owner = await createUser("Ada");
    const { systemId } = await createSystemPersistenceRepository(pool).createSystem({
      ownerId: owner,
      name: "Pocket Quest",
    });

    const result = await createSystemPersistenceRepository(pool).saveDraft({
      systemId,
      expectedRevision: 1,
      document: { schemaVersion: "1.0" },
      sourceChecksum: "sha256:x",
      updatedBy: owner,
      requestId: "req-test",
    });
    expect(result).toEqual({ ok: false, code: "stale_revision", latestRevision: null });
  });

  it("stores immutable versions and lists them newest-first", async () => {
    const owner = await createUser("Ada");
    const repo = createSystemPersistenceRepository(pool);
    const { systemId } = await repo.createSystem({ ownerId: owner, name: "Pocket Quest" });

    const v1 = await repo.insertVersion({
      systemId,
      semanticVersion: "1.0.0",
      checksum: "sha256:aaa",
      package: { schemaVersion: "1.0", name: "one" },
      releaseNotes: "First",
    });
    const v2 = await repo.insertVersion({
      systemId,
      semanticVersion: "1.1.0",
      checksum: "sha256:bbb",
      package: { schemaVersion: "1.0", name: "two" },
      releaseNotes: "",
    });

    const loaded = await repo.loadVersion(v1.versionId);
    expect(loaded).toEqual(v1);

    const versions = await repo.listVersions(systemId);
    expect(versions.map((v) => v.semanticVersion)).toEqual(["1.1.0", "1.0.0"]);

    await expect(
      repo.insertVersion({
        systemId,
        semanticVersion: "1.0.0",
        checksum: "sha256:ccc",
        package: { schemaVersion: "1.0", name: "three" },
        releaseNotes: "",
      }),
    ).rejects.toMatchObject({ code: "23505" });

    await expect(
      repo.insertVersion({
        systemId,
        semanticVersion: "2.0.0",
        checksum: "sha256:bbb",
        package: { schemaVersion: "1.0", name: "four" },
        releaseNotes: "",
      }),
    ).rejects.toMatchObject({ code: "23505" });

    expect(await repo.loadVersion(randomUUID())).toBeNull();
  });

  it("records idempotency receipts, replays identical input, and rejects mismatched input", async () => {
    const actor = await createUser("Ada");
    const repo = createSystemPersistenceRepository(pool);
    const expiresAt = new Date(Date.now() + 60_000);

    const first = await repo.recordReceipt({
      actorId: actor,
      commandKind: "publish",
      key: "retry-key",
      inputHash: "hash-1",
      result: { published: true },
      expiresAt,
    });
    expect(first).toEqual({ ok: true, reused: false, receipt: expect.objectContaining({ key: "retry-key" }) });

    const replay = await repo.recordReceipt({
      actorId: actor,
      commandKind: "publish",
      key: "retry-key",
      inputHash: "hash-1",
      result: { published: true },
      expiresAt,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error("unexpected");
    expect(replay.reused).toBe(true);
    expect(replay.receipt.result).toEqual({ published: true });

    const mismatch = await repo.recordReceipt({
      actorId: actor,
      commandKind: "publish",
      key: "retry-key",
      inputHash: "hash-2",
      result: { published: true },
      expiresAt,
    });
    expect(mismatch).toEqual({ ok: false, code: "idempotency_mismatch" });

    const loaded = await repo.loadReceipt({ actorId: actor, commandKind: "publish", key: "retry-key" });
    expect(loaded?.inputHash).toBe("hash-1");

    expect(
      await repo.loadReceipt({ actorId: actor, commandKind: "publish", key: "other-key" }),
    ).toBeNull();
  });

  it("treats an expired idempotency receipt as reusable with a fresh input", async () => {
    const actor = await createUser("Ada");
    const repo = createSystemPersistenceRepository(pool);
    const expired = new Date(Date.now() - 1000);

    await repo.recordReceipt({
      actorId: actor,
      commandKind: "publish",
      key: "expired-key",
      inputHash: "hash-old",
      result: { published: true },
      expiresAt: expired,
    });

    expect(
      await repo.loadReceipt({ actorId: actor, commandKind: "publish", key: "expired-key" }),
    ).toBeNull();

    const fresh = await repo.recordReceipt({
      actorId: actor,
      commandKind: "publish",
      key: "expired-key",
      inputHash: "hash-new",
      result: { published: false },
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) throw new Error("unexpected");
    expect(fresh.reused).toBe(false);
    expect(fresh.receipt.inputHash).toBe("hash-new");
  });

  it("appends and lists audit records newest-first", async () => {
    const owner = await createUser("Ada");
    const repo = createSystemPersistenceRepository(pool);
    const { systemId } = await repo.createSystem({ ownerId: owner, name: "Pocket Quest" });

    await repo.appendAudit({
      systemId,
      actorId: owner,
      kind: "draft_saved",
      summary: "Saved the draft",
      requestId: "req-1",
    });
    await repo.appendAudit({
      systemId,
      actorId: owner,
      kind: "published",
      summary: "Published 1.0.0",
      requestId: "req-2",
    });

    const records = await repo.listAudit(systemId);
    expect(records.map((r) => r.kind)).toEqual(["published", "draft_saved"]);
    expect(records[0]?.requestId).toBe("req-2");
    expect(records[1]?.requestId).toBe("req-1");

    expect(await repo.listAudit(randomUUID())).toEqual([]);
  });

  it("creates and loads unexpired preview snapshots and hides expired ones", async () => {
    const owner = await createUser("Ada");
    const repo = createSystemPersistenceRepository(pool);
    const { systemId } = await repo.createSystem({ ownerId: owner, name: "Pocket Quest" });

    const created = await repo.createPreviewSnapshot({
      systemId,
      sourceRevision: 3,
      package: { schemaVersion: "1.0", name: "preview" },
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(created.sourceRevision).toBe(3);

    const loaded = await repo.loadPreviewSnapshot(created.snapshotId);
    expect(loaded?.systemId).toBe(systemId);
    expect(loaded?.package).toEqual({ schemaVersion: "1.0", name: "preview" });

    const expired = await repo.createPreviewSnapshot({
      systemId,
      sourceRevision: 4,
      package: { schemaVersion: "1.0", name: "expired" },
      expiresAt: new Date(Date.now() - 1_000),
    });
    expect(await repo.loadPreviewSnapshot(expired.snapshotId)).toBeNull();
    expect(await repo.loadPreviewSnapshot(randomUUID())).toBeNull();
  });

  it("changes system and version lifecycle and rejects package mutation", async () => {
    const owner = await createUser("Ada");
    const repo = createSystemPersistenceRepository(pool);
    const { systemId } = await repo.createSystem({ ownerId: owner, name: "Pocket Quest" });
    const version = await repo.insertVersion({
      systemId,
      semanticVersion: "1.0.0",
      checksum: "sha256:aaa",
      package: { schemaVersion: "1.0", name: "one" },
      releaseNotes: "",
    });

    const archived = await repo.updateSystemLifecycle(systemId, "archived");
    expect(archived?.lifecycle).toBe("archived");
    const restored = await repo.updateSystemLifecycle(systemId, "active");
    expect(restored?.lifecycle).toBe("active");
    expect(await repo.updateSystemLifecycle(randomUUID(), "archived")).toBeNull();

    const deprecated = await repo.updateVersionLifecycle(version.versionId, "deprecated");
    expect(deprecated?.lifecycle).toBe("deprecated");
    expect(await repo.updateVersionLifecycle(randomUUID(), "deprecated")).toBeNull();

    await expect(
      pool.query("UPDATE system_versions SET package_json = '{}'::jsonb WHERE id = $1", [version.versionId]),
    ).rejects.toMatchObject({ message: "published system versions are immutable" });
  });

  it("paginates systems with a keyset cursor", async () => {
    const owner = await createUser("Ada");
    const repo = createSystemPersistenceRepository(pool);
    const delay = () => new Promise((resolve) => setTimeout(resolve, 5));
    await repo.createSystem({ ownerId: owner, name: "A" });
    await delay();
    await repo.createSystem({ ownerId: owner, name: "B" });
    await delay();
    await repo.createSystem({ ownerId: owner, name: "C" });

    const page1 = await repo.listSystemsPage(owner, { limit: 2, cursor: null });
    expect(page1.systems.map((s) => s.name)).toEqual(["C", "B"]);
    expect(page1.nextCursor).toBe(page1.systems[1]?.systemId ?? null);

    const page2 = await repo.listSystemsPage(owner, { limit: 2, cursor: page1.nextCursor });
    expect(page2.systems.map((s) => s.name)).toEqual(["A"]);
    expect(page2.nextCursor).toBeNull();
  });

  it("publishes a version transactionally with an audit record and rejects duplicates and stale input", async () => {
    const owner = await createUser("Ada");
    const repo = createSystemPersistenceRepository(pool);
    const { systemId } = await repo.createSystem({ ownerId: owner, name: "Pocket Quest" });
    await repo.saveDraft({
      systemId,
      expectedRevision: null,
      document: { schemaVersion: "1.0", head: "one" },
      sourceChecksum: "sha256:one",
      updatedBy: owner,
      requestId: "req-pub",
    });

    const published = await repo.publishVersion({
      systemId,
      expectedRevision: 1,
      sourceChecksum: "sha256:one",
      semanticVersion: "1.0.0",
      checksum: "sha256:pkg",
      package: { schemaVersion: "1.0", name: "pkg" },
      releaseNotes: "First",
      compatibilityFindings: [],
      actorId: owner,
      requestId: "req-pub",
    });
    expect(published.ok).toBe(true);
    if (!published.ok) throw new Error("unexpected");
    expect(published.version.lifecycle).toBe("published");

    const audit = await repo.listAudit(systemId);
    expect(audit.map((r) => r.kind)).toEqual(["version_published", "draft_saved"]);

    const duplicate = await repo.publishVersion({
      systemId,
      expectedRevision: 1,
      sourceChecksum: "sha256:one",
      semanticVersion: "1.0.0",
      checksum: "sha256:other",
      package: { schemaVersion: "1.0", name: "other" },
      releaseNotes: "",
      compatibilityFindings: [],
      actorId: owner,
      requestId: "req-pub",
    });
    expect(duplicate).toEqual({ ok: false, code: "duplicate_version" });

    const stale = await repo.publishVersion({
      systemId,
      expectedRevision: 99,
      sourceChecksum: "sha256:one",
      semanticVersion: "1.1.0",
      checksum: "sha256:pkg2",
      package: { schemaVersion: "1.0", name: "pkg2" },
      releaseNotes: "",
      compatibilityFindings: [],
      actorId: owner,
      requestId: "req-pub",
    });
    expect(stale).toEqual({ ok: false, code: "stale_revision", latestRevision: 1 });

    const noDraft = await repo.publishVersion({
      systemId: randomUUID(),
      expectedRevision: 1,
      sourceChecksum: "sha256:x",
      semanticVersion: "1.0.0",
      checksum: "sha256:y",
      package: {},
      releaseNotes: "",
      compatibilityFindings: [],
      actorId: owner,
      requestId: "req-pub",
    });
    expect(noDraft).toEqual({ ok: false, code: "stale_revision", latestRevision: null });
  });
});
