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
});