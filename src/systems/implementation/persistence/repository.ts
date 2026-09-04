import type { Pool } from "pg";

export type SystemId = string;
export type VersionId = string;
export type UserId = string;

export type SystemRecord = {
  systemId: SystemId;
  ownerId: UserId;
  name: string;
  access: string;
  lifecycle: string;
  createdAt: Date;
  updatedAt: Date;
};

export type DraftRecord = {
  systemId: SystemId;
  revision: number;
  document: unknown;
  sourceChecksum: string;
  updatedBy: UserId;
  updatedAt: Date;
};

export type VersionRecord = {
  versionId: VersionId;
  systemId: SystemId;
  semanticVersion: string;
  checksum: string;
  package: unknown;
  releaseNotes: string;
  createdAt: Date;
};

export type IdempotencyReceipt = {
  receiptId: string;
  actorId: UserId;
  commandKind: string;
  key: string;
  inputHash: string;
  result: unknown;
  createdAt: Date;
  expiresAt: Date;
};

export type AuditRecord = {
  id: string;
  systemId: SystemId;
  actorId: UserId;
  kind: string;
  summary: string;
  occurredAt: Date;
  requestId: string;
};

export type SaveDraftInput = {
  systemId: SystemId;
  expectedRevision: number | null;
  document: unknown;
  sourceChecksum: string;
  updatedBy: UserId;
};

export type DraftSaveResult =
  | { ok: true; draft: DraftRecord }
  | { ok: false; code: "stale_revision"; latestRevision: number | null };

export type RecordReceiptInput = {
  actorId: UserId;
  commandKind: string;
  key: string;
  inputHash: string;
  result: unknown;
  expiresAt: Date;
};

export type RecordReceiptResult =
  | { ok: true; reused: boolean; receipt: IdempotencyReceipt }
  | { ok: false; code: "idempotency_mismatch" };

export interface SystemPersistenceRepository {
  createSystem(input: { ownerId: UserId; name: string }): Promise<SystemRecord>;
  listSystems(ownerId: UserId): Promise<SystemRecord[]>;
  openSystem(systemId: SystemId): Promise<SystemRecord | null>;

  saveDraft(input: SaveDraftInput): Promise<DraftSaveResult>;
  loadDraft(systemId: SystemId): Promise<DraftRecord | null>;

  insertVersion(input: {
    systemId: SystemId;
    semanticVersion: string;
    checksum: string;
    package: unknown;
    releaseNotes: string;
  }): Promise<VersionRecord>;
  loadVersion(versionId: VersionId): Promise<VersionRecord | null>;
  listVersions(systemId: SystemId): Promise<VersionRecord[]>;

  recordReceipt(input: RecordReceiptInput): Promise<RecordReceiptResult>;
  loadReceipt(input: {
    actorId: UserId;
    commandKind: string;
    key: string;
  }): Promise<IdempotencyReceipt | null>;

  appendAudit(input: {
    systemId: SystemId;
    actorId: UserId;
    kind: string;
    summary: string;
    requestId: string;
  }): Promise<AuditRecord>;
  listAudit(systemId: SystemId): Promise<AuditRecord[]>;
}

export function createSystemPersistenceRepository(pool: Pool): SystemPersistenceRepository {
  return {
    async createSystem(input) {
      const result = await pool.query<SystemRow>(
        `INSERT INTO systems (owner_id, name)
         VALUES ($1, $2)
         RETURNING id, owner_id, name, access, lifecycle, created_at, updated_at`,
        [input.ownerId, input.name],
      );
      return toSystemRecord(requireRow(result.rows[0], "createSystem"));
    },

    async listSystems(ownerId) {
      const result = await pool.query<SystemRow>(
        `SELECT id, owner_id, name, access, lifecycle, created_at, updated_at
           FROM systems
          WHERE owner_id = $1
          ORDER BY created_at DESC, id DESC`,
        [ownerId],
      );
      return result.rows.map(toSystemRecord);
    },

    async openSystem(systemId) {
      const result = await pool.query<SystemRow>(
        `SELECT id, owner_id, name, access, lifecycle, created_at, updated_at
           FROM systems
          WHERE id = $1`,
        [systemId],
      );
      const row = result.rows[0];
      return row === undefined ? null : toSystemRecord(row);
    },

    async saveDraft(input) {
      return saveDraftImpl(pool, input);
    },

    async loadDraft(systemId) {
      const result = await pool.query<DraftRow>(
        `SELECT system_id, revision, document_json, source_checksum, updated_by, updated_at
           FROM system_drafts
          WHERE system_id = $1`,
        [systemId],
      );
      const row = result.rows[0];
      return row === undefined ? null : toDraftRecord(row);
    },

    async insertVersion(input) {
      const result = await pool.query<VersionRow>(
        `INSERT INTO system_versions (system_id, semantic_version, checksum, package_json, release_notes)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         RETURNING id, system_id, semantic_version, checksum, package_json, release_notes, created_at`,
        [input.systemId, input.semanticVersion, input.checksum, JSON.stringify(input.package), input.releaseNotes],
      );
      return toVersionRecord(requireRow(result.rows[0], "insertVersion"));
    },

    async loadVersion(versionId) {
      const result = await pool.query<VersionRow>(
        `SELECT id, system_id, semantic_version, checksum, package_json, release_notes, created_at
           FROM system_versions
          WHERE id = $1`,
        [versionId],
      );
      const row = result.rows[0];
      return row === undefined ? null : toVersionRecord(row);
    },

    async listVersions(systemId) {
      const result = await pool.query<VersionRow>(
        `SELECT id, system_id, semantic_version, checksum, package_json, release_notes, created_at
           FROM system_versions
          WHERE system_id = $1
          ORDER BY created_at DESC, id DESC`,
        [systemId],
      );
      return result.rows.map(toVersionRecord);
    },

    async recordReceipt(input) {
      return recordReceiptImpl(pool, input);
    },

    async loadReceipt(input) {
      const result = await pool.query<ReceiptRow>(
        `SELECT id, actor_id, command_kind, key, input_hash, result_json, created_at, expires_at
           FROM idempotency_receipts
          WHERE actor_id = $1 AND command_kind = $2 AND key = $3 AND expires_at > now()`,
        [input.actorId, input.commandKind, input.key],
      );
      const row = result.rows[0];
      return row === undefined ? null : toReceipt(row);
    },

    async appendAudit(input) {
      const result = await pool.query<AuditRow>(
        `INSERT INTO system_audit_records (system_id, actor_id, kind, summary, request_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, system_id, actor_id, kind, summary, occurred_at, request_id`,
        [input.systemId, input.actorId, input.kind, input.summary, input.requestId],
      );
      return toAuditRecord(requireRow(result.rows[0], "appendAudit"));
    },

    async listAudit(systemId) {
      const result = await pool.query<AuditRow>(
        `SELECT id, system_id, actor_id, kind, summary, occurred_at, request_id
           FROM system_audit_records
          WHERE system_id = $1
          ORDER BY occurred_at DESC, id DESC`,
        [systemId],
      );
      return result.rows.map(toAuditRecord);
    },
  };
}

type SystemRow = {
  id: string;
  owner_id: string;
  name: string;
  access: string;
  lifecycle: string;
  created_at: Date;
  updated_at: Date;
};

type DraftRow = {
  system_id: string;
  revision: number;
  document_json: unknown;
  source_checksum: string;
  updated_by: string;
  updated_at: Date;
};

type VersionRow = {
  id: string;
  system_id: string;
  semantic_version: string;
  checksum: string;
  package_json: unknown;
  release_notes: string;
  created_at: Date;
};

type ReceiptRow = {
  id: string;
  actor_id: string;
  command_kind: string;
  key: string;
  input_hash: string;
  result_json: unknown;
  created_at: Date;
  expires_at: Date;
};

type AuditRow = {
  id: string;
  system_id: string;
  actor_id: string;
  kind: string;
  summary: string;
  occurred_at: Date;
  request_id: string;
};

function requireRow<T>(row: T | undefined, operation: string): T {
  if (row === undefined) {
    throw new Error(`${operation} returned no row`);
  }
  return row;
}

function toSystemRecord(row: SystemRow): SystemRecord {
  return {
    systemId: row.id,
    ownerId: row.owner_id,
    name: row.name,
    access: row.access,
    lifecycle: row.lifecycle,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDraftRecord(row: DraftRow): DraftRecord {
  return {
    systemId: row.system_id,
    revision: row.revision,
    document: row.document_json,
    sourceChecksum: row.source_checksum,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

function toVersionRecord(row: VersionRow): VersionRecord {
  return {
    versionId: row.id,
    systemId: row.system_id,
    semanticVersion: row.semantic_version,
    checksum: row.checksum,
    package: row.package_json,
    releaseNotes: row.release_notes,
    createdAt: row.created_at,
  };
}

function toReceipt(row: ReceiptRow): IdempotencyReceipt {
  return {
    receiptId: row.id,
    actorId: row.actor_id,
    commandKind: row.command_kind,
    key: row.key,
    inputHash: row.input_hash,
    result: row.result_json,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function toAuditRecord(row: AuditRow): AuditRecord {
  return {
    id: row.id,
    systemId: row.system_id,
    actorId: row.actor_id,
    kind: row.kind,
    summary: row.summary,
    occurredAt: row.occurred_at,
    requestId: row.request_id,
  };
}

async function saveDraftImpl(pool: Pool, input: SaveDraftInput): Promise<DraftSaveResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<DraftRow>(
      `SELECT system_id, revision, document_json, source_checksum, updated_by, updated_at
         FROM system_drafts
        WHERE system_id = $1
        FOR UPDATE`,
      [input.systemId],
    );
    const row = existing.rows[0];
    if (row === undefined) {
      if (input.expectedRevision !== null) {
        await client.query("COMMIT");
        return { ok: false, code: "stale_revision", latestRevision: null };
      }
      const inserted = await client.query<DraftRow>(
        `INSERT INTO system_drafts (system_id, revision, document_json, source_checksum, updated_by)
         VALUES ($1, 1, $2::jsonb, $3, $4)
         RETURNING system_id, revision, document_json, source_checksum, updated_by, updated_at`,
        [input.systemId, JSON.stringify(input.document), input.sourceChecksum, input.updatedBy],
      );
      await client.query("COMMIT");
      return { ok: true, draft: toDraftRecord(requireRow(inserted.rows[0], "saveDraft")) };
    }
    if (row.revision !== input.expectedRevision) {
      await client.query("COMMIT");
      return { ok: false, code: "stale_revision", latestRevision: row.revision };
    }
    const updated = await client.query<DraftRow>(
      `UPDATE system_drafts
          SET revision = revision + 1, document_json = $2::jsonb, source_checksum = $3, updated_by = $4, updated_at = now()
        WHERE system_id = $1
        RETURNING system_id, revision, document_json, source_checksum, updated_by, updated_at`,
      [input.systemId, JSON.stringify(input.document), input.sourceChecksum, input.updatedBy],
    );
    await client.query("COMMIT");
    return { ok: true, draft: toDraftRecord(requireRow(updated.rows[0], "saveDraft")) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function recordReceiptImpl(pool: Pool, input: RecordReceiptInput): Promise<RecordReceiptResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<ReceiptRow>(
      `SELECT id, actor_id, command_kind, key, input_hash, result_json, created_at, expires_at
         FROM idempotency_receipts
        WHERE actor_id = $1 AND command_kind = $2 AND key = $3
        FOR UPDATE`,
      [input.actorId, input.commandKind, input.key],
    );
    const row = existing.rows[0];
    if (row !== undefined && row.expires_at.getTime() > Date.now()) {
      if (row.input_hash !== input.inputHash) {
        await client.query("COMMIT");
        return { ok: false, code: "idempotency_mismatch" };
      }
      await client.query("COMMIT");
      return { ok: true, reused: true, receipt: toReceipt(row) };
    }
    if (row !== undefined) {
      await client.query(
        "DELETE FROM idempotency_receipts WHERE id = $1",
        [row.id],
      );
    }
    const inserted = await client.query<ReceiptRow>(
      `INSERT INTO idempotency_receipts (actor_id, command_kind, key, input_hash, result_json, expires_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       RETURNING id, actor_id, command_kind, key, input_hash, result_json, created_at, expires_at`,
      [input.actorId, input.commandKind, input.key, input.inputHash, JSON.stringify(input.result), input.expiresAt],
    );
    await client.query("COMMIT");
    return { ok: true, reused: false, receipt: toReceipt(requireRow(inserted.rows[0], "recordReceipt")) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}