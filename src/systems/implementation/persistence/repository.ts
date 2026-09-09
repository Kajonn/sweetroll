import { d20Package, pbta2d6Package, d6SuccessPoolPackage } from "../package/fixtures/index.js";
import type { CompatibilityFinding } from "../package/compatibility.js";
import type { SystemPackageV1 } from "../package/schema/index.js";
import type { Pool, PoolClient } from "pg";

export type SystemId = string;
export type VersionId = string;
export type UserId = string;

export type SystemRecord = {
  systemId: SystemId;
  ownerId: UserId | null;
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
  lifecycle: string;
  createdAt: Date;
};

export type PreviewSnapshotRecord = {
  snapshotId: string;
  systemId: SystemId;
  sourceRevision: number;
  package: unknown;
  createdAt: Date;
  expiresAt: Date;
};

export type PublishVersionInput = {
  systemId: SystemId;
  versionId: VersionId;
  expectedRevision: number;
  sourceChecksum: string;
  semanticVersion: string;
  checksum: string;
  package: unknown;
  releaseNotes: string;
  compatibilityFindings: CompatibilityFinding[];
  acknowledgeBreaking: boolean;
  actorId: UserId;
  requestId: string;
};

export type PublishVersionResult =
  | { ok: true; version: VersionRecord }
  | { ok: false; code: "stale_revision"; latestRevision: number | null }
  | { ok: false; code: "breaking_version"; findings: CompatibilityFinding[] }
  | { ok: false; code: "duplicate_version" };

export type AuthorizedVersionUse = {
  systemId: SystemId;
  versionId: VersionId;
  checksum: string;
};

export type AuthorizedCreationVersion = {
  systemId: SystemId;
  versionId: VersionId;
  systemName: string;
  semanticVersion: string;
  createdAt: string;
};

export type DeleteOwnedSystemResult =
  | { ok: true }
  | { ok: false; code: "not_found" | "referenced" };

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
  requestId: string;
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
  authorizeVersionUse(actorId: UserId, versionId: VersionId): Promise<AuthorizedVersionUse | null>;
  listAuthorizedVersions(actorId: UserId): Promise<AuthorizedCreationVersion[]>;

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

  createPreviewSnapshot(input: {
    systemId: SystemId;
    sourceRevision: number;
    package: unknown;
    expiresAt: Date;
  }): Promise<PreviewSnapshotRecord>;
  loadPreviewSnapshot(snapshotId: string): Promise<PreviewSnapshotRecord | null>;

  updateSystemLifecycle(
    systemId: SystemId,
    lifecycle: "active" | "archived",
  ): Promise<SystemRecord | null>;
  updateVersionLifecycle(
    versionId: VersionId,
    lifecycle: "published" | "deprecated",
  ): Promise<VersionRecord | null>;

  listSystemsPage(
    ownerId: UserId,
    page: { limit: number; cursor: string | null },
  ): Promise<{ systems: SystemRecord[]; nextCursor: string | null }>;

  deleteOwnedSystem(systemId: SystemId, ownerId: UserId): Promise<DeleteOwnedSystemResult>;

  publishVersion(input: PublishVersionInput): Promise<PublishVersionResult>;
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
         RETURNING id, system_id, semantic_version, checksum, package_json, release_notes, lifecycle, created_at`,
        [input.systemId, input.semanticVersion, input.checksum, JSON.stringify(input.package), input.releaseNotes],
      );
      return toVersionRecord(requireRow(result.rows[0], "insertVersion"));
    },

    async loadVersion(versionId) {
      const result = await pool.query<VersionRow>(
        `SELECT id, system_id, semantic_version, checksum, package_json, release_notes, lifecycle, created_at
           FROM system_versions
          WHERE id = $1`,
        [versionId],
      );
      const row = result.rows[0];
      return row === undefined ? null : toVersionRecord(row);
    },

    async listVersions(systemId) {
      const result = await pool.query<VersionRow>(
        `SELECT id, system_id, semantic_version, checksum, package_json, release_notes, lifecycle, created_at
           FROM system_versions
          WHERE system_id = $1
          ORDER BY created_at DESC, id DESC`,
        [systemId],
      );
      return result.rows.map(toVersionRecord);
    },

    async authorizeVersionUse(actorId, versionId) {
      const result = await pool.query<AuthorizedVersionUseRow>(
        `SELECT s.id AS system_id, v.id AS version_id, v.checksum
           FROM system_versions v
           JOIN systems s ON s.id = v.system_id
          WHERE v.id = $2
            AND v.lifecycle = 'published'
            AND s.lifecycle = 'active'
            AND (s.owner_id = $1 OR s.access IN ('public', 'link'))`,
        [actorId, versionId],
      );
      const row = result.rows[0];
      return row === undefined
        ? null
        : { systemId: row.system_id, versionId: row.version_id, checksum: row.checksum };
    },

    async listAuthorizedVersions(actorId) {
      // OD-01 option A (unlisted/link-only): enumeration exposes only systems
      // owned by the actor plus explicitly discoverable (public) systems.
      // Other owners' link-access systems stay usable via a known version ID
      // through authorizeVersionUse, but are excluded here.
      const result = await pool.query<AuthorizedCreationVersionRow>(
        `SELECT v.id AS version_id, s.id AS system_id, s.name AS system_name,
                v.semantic_version, v.created_at
           FROM system_versions v
           JOIN systems s ON s.id = v.system_id
          WHERE v.lifecycle = 'published'
            AND s.lifecycle = 'active'
            AND (s.owner_id = $1 OR s.access = 'public')
          ORDER BY s.name ASC, v.created_at DESC, v.id DESC`,
        [actorId],
      );
      return result.rows.map((row) => ({
        versionId: row.version_id,
        systemId: row.system_id,
        systemName: row.system_name,
        semanticVersion: row.semantic_version,
        createdAt: row.created_at.toISOString(),
      }));
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

    async createPreviewSnapshot(input) {
      const result = await pool.query<PreviewRow>(
        `INSERT INTO preview_snapshots (system_id, source_revision, package_json, expires_at)
         VALUES ($1, $2, $3::jsonb, $4)
         RETURNING id, system_id, source_revision, package_json, created_at, expires_at`,
        [input.systemId, input.sourceRevision, JSON.stringify(input.package), input.expiresAt],
      );
      return toPreviewSnapshot(requireRow(result.rows[0], "createPreviewSnapshot"));
    },

    async loadPreviewSnapshot(snapshotId) {
      const result = await pool.query<PreviewRow>(
        `SELECT id, system_id, source_revision, package_json, created_at, expires_at
           FROM preview_snapshots
          WHERE id = $1 AND expires_at > now()`,
        [snapshotId],
      );
      const row = result.rows[0];
      return row === undefined ? null : toPreviewSnapshot(row);
    },

    async updateSystemLifecycle(systemId, lifecycle) {
      const result = await pool.query<SystemRow>(
        `UPDATE systems SET lifecycle = $2, updated_at = now()
          WHERE id = $1
          RETURNING id, owner_id, name, access, lifecycle, created_at, updated_at`,
        [systemId, lifecycle],
      );
      const row = result.rows[0];
      return row === undefined ? null : toSystemRecord(row);
    },

    async updateVersionLifecycle(versionId, lifecycle) {
      const result = await pool.query<VersionRow>(
        `UPDATE system_versions SET lifecycle = $2
          WHERE id = $1
          RETURNING id, system_id, semantic_version, checksum, package_json, release_notes, lifecycle, created_at`,
        [versionId, lifecycle],
      );
      const row = result.rows[0];
      return row === undefined ? null : toVersionRecord(row);
    },

    async listSystemsPage(ownerId, page) {
      const params: unknown[] = [ownerId, page.limit + 1];
      let where = "owner_id = $1";
      if (page.cursor !== null) {
        params.push(page.cursor);
        where += ` AND (created_at, id) < (SELECT created_at, id FROM systems WHERE id = $${params.length})`;
      }
      const result = await pool.query<SystemRow>(
        `SELECT id, owner_id, name, access, lifecycle, created_at, updated_at
           FROM systems
          WHERE ${where}
          ORDER BY created_at DESC, id DESC
          LIMIT $2`,
        params,
      );
      const hasMore = result.rows.length > page.limit;
      const pageRows = hasMore ? result.rows.slice(0, page.limit) : result.rows;
      const last = pageRows[pageRows.length - 1];
      return {
        systems: pageRows.map(toSystemRecord),
        nextCursor: hasMore && last !== undefined ? last.id : null,
      };
    },

    async publishVersion(input) {
      return publishVersionImpl(pool, input);
    },

    async deleteOwnedSystem(systemId, ownerId) {
      try {
        const result = await pool.query(
          `DELETE FROM systems
            WHERE id = $1 AND owner_id = $2`,
          [systemId, ownerId],
        );
        return (result.rowCount ?? 0) > 0 ? { ok: true } : { ok: false, code: "not_found" };
      } catch (error) {
        if ((error as { code?: string }).code === "23503") {
          return { ok: false, code: "referenced" };
        }
        throw error;
      }
    },
  };
}

type SystemRow = {
  id: string;
  owner_id: string | null;
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
  lifecycle: string;
  created_at: Date;
};

type AuthorizedVersionUseRow = {
  system_id: string;
  version_id: string;
  checksum: string;
};

type AuthorizedCreationVersionRow = {
  version_id: string;
  system_id: string;
  system_name: string;
  semantic_version: string;
  created_at: Date;
};

type PreviewRow = {
  id: string;
  system_id: string;
  source_revision: number;
  package_json: unknown;
  created_at: Date;
  expires_at: Date;
};

function toPreviewSnapshot(row: PreviewRow): PreviewSnapshotRecord {
  return {
    snapshotId: row.id,
    systemId: row.system_id,
    sourceRevision: row.source_revision,
    package: row.package_json,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

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
    lifecycle: row.lifecycle,
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
      const draft = toDraftRecord(requireRow(inserted.rows[0], "saveDraft"));
      await client.query(
        `INSERT INTO system_audit_records (system_id, actor_id, kind, summary, request_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [input.systemId, input.updatedBy, "draft_saved", `Draft revision ${draft.revision} saved`, input.requestId],
      );
      await client.query("COMMIT");
      return { ok: true, draft };
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
    const draft = toDraftRecord(requireRow(updated.rows[0], "saveDraft"));
    await client.query(
      `INSERT INTO system_audit_records (system_id, actor_id, kind, summary, request_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [input.systemId, input.updatedBy, "draft_saved", `Draft revision ${draft.revision} saved`, input.requestId],
    );
    await client.query("COMMIT");
    return { ok: true, draft };
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

async function publishVersionImpl(pool: Pool, input: PublishVersionInput): Promise<PublishVersionResult> {
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
    const draft = existing.rows[0];
    if (
      draft === undefined ||
      draft.revision !== input.expectedRevision ||
      draft.source_checksum !== input.sourceChecksum
    ) {
      await client.query("COMMIT");
      return { ok: false, code: "stale_revision", latestRevision: draft?.revision ?? null };
    }
    const latestVersion = await client.query<Pick<VersionRow, "semantic_version">>(
      `SELECT semantic_version
         FROM system_versions
        WHERE system_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [input.systemId],
    );
    const latest = latestVersion.rows[0];
    if (input.compatibilityFindings.length > 0 && latest !== undefined) {
      const nextMajor = Number(input.semanticVersion.split(".")[0]);
      const latestMajor = Number(latest.semantic_version.split(".")[0]);
      if (!input.acknowledgeBreaking || nextMajor <= latestMajor) {
        await client.query("COMMIT");
        return { ok: false, code: "breaking_version", findings: input.compatibilityFindings };
      }
    }
    let inserted: VersionRow | undefined;
    try {
      const result = await client.query<VersionRow>(
        `INSERT INTO system_versions
           (id, system_id, semantic_version, checksum, package_json, release_notes, compatibility_findings_json)
          VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb)
          RETURNING id, system_id, semantic_version, checksum, package_json, release_notes, lifecycle, created_at`,
        [
          input.versionId,
          input.systemId,
          input.semanticVersion,
          input.checksum,
          JSON.stringify(input.package),
          input.releaseNotes,
          JSON.stringify(input.compatibilityFindings),
        ],
      );
      inserted = result.rows[0];
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        await client.query("ROLLBACK");
        return { ok: false, code: "duplicate_version" };
      }
      throw error;
    }
    const version = toVersionRecord(requireRow(inserted, "publishVersion"));
    await client.query(
      `INSERT INTO system_audit_records (system_id, actor_id, kind, summary, request_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [input.systemId, input.actorId, "version_published", `Published version ${input.semanticVersion}`, input.requestId],
    );
    await client.query("COMMIT");
    return { ok: true, version };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Reference template seeding
// ---------------------------------------------------------------------------

export type ReferenceTemplate = {
  systemId: SystemId;
  versionId: VersionId;
  name: string;
  package: SystemPackageV1;
};

export const REFERENCE_TEMPLATES: ReadonlyArray<ReferenceTemplate> = [
  {
    // Row identity matches the fixture package identity verbatim: the
    // runtime loader requires the stored package's embedded versionId to
    // equal the requested row id, and the package schema only accepts
    // schema-valid UUIDs. Never point these at synthetic row ids.
    systemId: "a0000000-0000-5000-8000-000000000001",
    versionId: "a0000000-0000-5000-8000-000000000002",
    name: "Template: d20",
    package: d20Package,
  },
  {
    systemId: "b0000000-0000-5000-8000-000000000001",
    versionId: "b0000000-0000-5000-8000-000000000002",
    name: "Template: PbtA 2d6",
    package: pbta2d6Package,
  },
  {
    systemId: "c0000000-0000-5000-8000-000000000001",
    versionId: "c0000000-0000-5000-8000-000000000002",
    name: "Template: d6 success pool",
    package: d6SuccessPoolPackage,
  },
];

export type SeedReferenceTemplatesResult = {
  systemsInserted: number;
  versionsReplaced: number;
};

type SeedRunner = Pick<Pool | PoolClient, "query">;

function storedPackageIdentity(packageJson: unknown): { versionId: unknown; systemId: unknown } {
  if (packageJson === null || typeof packageJson !== "object") return { versionId: null, systemId: null };
  const record = packageJson as { versionId?: unknown; systemId?: unknown };
  return { versionId: record.versionId, systemId: record.systemId };
}

export async function seedReferenceTemplates(runner: SeedRunner): Promise<SeedReferenceTemplatesResult> {
  let systemsInserted = 0;
  let versionsReplaced = 0;
  for (const tpl of REFERENCE_TEMPLATES) {
    const inserted = await runner.query<{ id: string }>(
      `INSERT INTO systems (id, owner_id, name, access, lifecycle, created_at, updated_at)
       VALUES ($1, NULL, $2, 'link', 'active', now(), now())
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [tpl.systemId, tpl.name],
    );
    if ((inserted.rowCount ?? 0) > 0) systemsInserted += 1;
    const existing = await runner.query<{ id: string; checksum: string; package_json: unknown }>(
      `SELECT id, checksum, package_json
         FROM system_versions
        WHERE id = $1`,
      [tpl.versionId],
    );
    const row = existing.rows[0];
    if (row === undefined) {
      await runner.query(
        `INSERT INTO system_versions (id, system_id, semantic_version, checksum, package_json, release_notes, lifecycle, created_at)
         VALUES ($1, $2, '1.0.0', $3, $4::jsonb, 'Template seed', 'published', now())`,
        [tpl.versionId, tpl.systemId, tpl.package.integrity.checksum, JSON.stringify(tpl.package)],
      );
      versionsReplaced += 1;
      continue;
    }
    const identity = storedPackageIdentity(row.package_json);
    const alreadySeeded =
      row.checksum === tpl.package.integrity.checksum &&
      identity.versionId === tpl.versionId &&
      identity.systemId === tpl.systemId;
    if (alreadySeeded) continue;
    // Replace placeholder ("pending:") rows and repair rows whose stored
    // package identity drifted from the fixture, so the runtime loader's
    // package/row identity invariant holds. Legacy rows under retired
    // synthetic ids are removed by migration 0010, not here.
    //
    // RESTRICT guard (Task 11 I4): characters.system_version_id plus
    // character_migration_previews.source/target_version_id and
    // character_migrations.source/target_version_id reference
    // system_versions with ON DELETE RESTRICT. A repair-by-delete would
    // fail (23503) — or worse, remove a row live characters depend on —
    // once drift coincides with real usage. Skip the repair, keep the old
    // row, and log so the drift is visible instead of crashing boot.
    const isUndefinedTable = (error: unknown): boolean =>
      (error as { code?: string }).code === "42P01";
    const probeReferences = async (text: string): Promise<boolean> => {
      try {
        const hit = await runner.query<{ one: number }>(text, [tpl.versionId]);
        return (hit.rows.length ?? 0) > 0;
      } catch (error) {
        // Isolated seeder schemas (e.g. reference-templates.test.ts) have no
        // characters/migration tables yet — undefined_table means "no references".
        if (isUndefinedTable(error)) return false;
        throw error;
      }
    };
    let referenced = await probeReferences(
      "SELECT 1 AS one FROM characters WHERE system_version_id = $1 LIMIT 1",
    );
    if (!referenced) {
      referenced = await probeReferences(
        "SELECT 1 AS one FROM character_migration_previews WHERE source_version_id = $1 OR target_version_id = $1 LIMIT 1",
      );
    }
    if (!referenced) {
      referenced = await probeReferences(
        "SELECT 1 AS one FROM character_migrations WHERE source_version_id = $1 OR target_version_id = $1 LIMIT 1",
      );
    }
    if (referenced) {
      console.warn(
        `[seedReferenceTemplates] skipping repair of ${tpl.versionId}: referenced by characters; keeping existing row`,
      );
      continue;
    }
    await runner.query("DELETE FROM system_versions WHERE id = $1", [tpl.versionId]);
    await runner.query(
      `INSERT INTO system_versions (id, system_id, semantic_version, checksum, package_json, release_notes, lifecycle, created_at)
       VALUES ($1, $2, '1.0.0', $3, $4::jsonb, 'Template seed', 'published', now())`,
      [tpl.versionId, tpl.systemId, tpl.package.integrity.checksum, JSON.stringify(tpl.package)],
    );
    versionsReplaced += 1;
  }
  return { systemsInserted, versionsReplaced };
}
