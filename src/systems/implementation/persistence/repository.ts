import { forgedInTheDarkPackage } from "../package/fixtures/forged-in-the-dark.js";
import { d20Package, pbta2d6Package, d6SuccessPoolPackage } from "../package/fixtures/index.js";
import { compareExtensionPackages, comparePackages, type CompatibilityFinding } from "../package/compatibility.js";
import type { ExtensionPackageV1, SystemPackageV1 } from "../package/schema/index.js";
import type { Pool, PoolClient } from "pg";
import { saveSystemImages } from "./image-references.js";
import type { PreparedItemImage } from "../../../platform/item-image-storage.js";
import type { SystemDocumentV1 } from "../package/schema/index.js";

export type SystemId = string;
export type VersionId = string;
export type UserId = string;

export type SystemRecord = {
  systemId: SystemId;
  ownerId: UserId | null;
  name: string;
  access: string;
  lifecycle: string;
  /** Design 6.8: `extension` rows add templates to `baseSystemId`. */
  kind: SystemKind;
  baseSystemId: SystemId | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SystemKind = "system" | "extension";

export type DraftRecord = {
  systemId: SystemId;
  revision: number;
  document: unknown;
  sourceChecksum: string;
  updatedBy: UserId;
  updatedAt: Date;
  /** Extension drafts: base system version used for preview and validation. */
  baseVersionId: VersionId | null;
};

export type VersionRecord = {
  versionId: VersionId;
  systemId: SystemId;
  semanticVersion: string;
  checksum: string;
  package: unknown;
  releaseNotes: string;
  lifecycle: string;
  /** Extension versions: the base system version they were compiled against. */
  builtAgainstVersionId: VersionId | null;
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
  compatibilityBaseVersionId?: VersionId | null;
  /** Required for extension versions (design 6.8). */
  builtAgainstVersionId?: VersionId | null;
  acknowledgeBreaking: boolean;
  actorId: UserId;
  requestId: string;
};

export type PublishVersionResult =
  | { ok: true; version: VersionRecord }
  | { ok: false; code: "stale_revision"; latestRevision: number | null }
  | { ok: false; code: "breaking_version"; findings: CompatibilityFinding[] }
  | { ok: false; code: "duplicate_version" | "not_found" | "archived" };

/** Design 6.7: a published version shown as an upgrade or revert target. */
export type VersionChoice = {
  versionId: VersionId;
  systemId: SystemId;
  semanticVersion: string;
  releaseNotes: string;
  createdAt: Date;
};

export type AuthorizedVersionUse = {
  systemId: SystemId;
  versionId: VersionId;
  checksum: string;
};

export type AuthorizedExtensionUse = {
  extensionId: SystemId;
  versionId: VersionId;
  baseSystemId: SystemId;
  checksum: string;
};

export type AuthorizedCreationVersion = {
  systemId: SystemId;
  versionId: VersionId;
  systemName: string;
  semanticVersion: string;
  createdAt: string;
};

export type CreationVersionsCursor = {
  name: string;
  createdAt: string;
  versionId: string;
};

export function encodeCreationVersionsCursor(cursor: CreationVersionsCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCreationVersionsCursor(cursor: string | null): CreationVersionsCursor | null {
  if (cursor === null) return null;
  try {
    const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      name: unknown;
      createdAt: unknown;
      versionId: unknown;
    };
    if (
      typeof payload.name !== "string" ||
      typeof payload.createdAt !== "string" ||
      typeof payload.versionId !== "string" ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(payload.versionId) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.(?:\d{3}|\d{6})Z$/.test(payload.createdAt) ||
      Number.isNaN(Date.parse(payload.createdAt)) ||
      new Date(payload.createdAt).toISOString().slice(0, 19) !== payload.createdAt.slice(0, 19)
    ) {
      return null;
    }
    return { name: payload.name, createdAt: payload.createdAt, versionId: payload.versionId };
  } catch {
    return null;
  }
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

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
  newImages?: PreparedItemImage[];
  retainedImageIds?: string[];
  systemId: SystemId;
  expectedRevision: number | null;
  document: unknown;
  sourceChecksum: string;
  updatedBy: UserId;
  requestId: string;
  /** Extension drafts only; `undefined` keeps the stored value. */
  baseVersionId?: VersionId | null;
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

type ReceiptCommand = Omit<RecordReceiptInput, "result">;
type ReceiptResult<T, E> = { ok: true; value: T } | { ok: false; error: E };
type ReceiptTransaction = Pick<SystemPersistenceRepository, "createSystem" | "appendAudit" | "saveDraft" | "publishVersion">;

export interface SystemPersistenceRepository {
  executeWithReceipt<T, E>(
    input: ReceiptCommand,
    execute: (transaction: ReceiptTransaction) => Promise<ReceiptResult<T, E>>,
  ): Promise<ReceiptResult<T, E> | { ok: true; value: T; replayed: true } | { ok: false; mismatch: true }>;

  createSystem(input: { ownerId: UserId; name: string; baseSystemId?: SystemId }): Promise<SystemRecord>;
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
  /** Published versions of the same system created after `fromVersionId` that the actor may use. */
  listLaterAuthorizedVersions(actorId: UserId, fromVersionId: VersionId): Promise<VersionChoice[]>;
  /** Metadata of versions already pinned by a record; no use authorization. */
  describeVersionChoices(versionIds: VersionId[]): Promise<VersionChoice[]>;
  listAuthorizedVersions(
    actorId: UserId,
    page: { limit: number; cursor: CreationVersionsCursor | null; q: string | null; systemId: string | null },
  ): Promise<{ versions: AuthorizedCreationVersion[]; nextCursor: string | null }>;

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
  updateSystemAccess(input: {
    systemId: SystemId;
    actorId: UserId;
    access: "private" | "link" | "public";
    requestId: string;
  }): Promise<SystemRecord | null>;
  updateVersionLifecycle(
    versionId: VersionId,
    lifecycle: "published" | "deprecated",
  ): Promise<VersionRecord | null>;

  listSystemsPage(
    ownerId: UserId,
    page: { limit: number; cursor: string | null },
  ): Promise<{ systems: SystemRecord[]; nextCursor: string | null }>;

  deleteOwnedSystem(systemId: SystemId, ownerId: UserId): Promise<DeleteOwnedSystemResult>;

  /** Design 6.8: extensions of a base system the actor owns, plus `public` ones. */
  listExtensionsPage(
    actorId: UserId,
    baseSystemId: SystemId,
    page: { limit: number; cursor: string | null },
  ): Promise<{ extensions: SystemRecord[]; nextCursor: string | null }>;
  /** Published versions of an extension, newest first. */
  listPublishedVersions(systemId: SystemId): Promise<VersionRecord[]>;
  /** A published extension version of an active extension the actor may use. */
  authorizeExtensionUse(actorId: UserId, versionId: VersionId): Promise<AuthorizedExtensionUse | null>;

  publishVersion(input: PublishVersionInput): Promise<PublishVersionResult>;
}

export function createSystemPersistenceRepository(pool: Pool): SystemPersistenceRepository {
  return {
    ...transactionMethods(pool),

    async executeWithReceipt<T, E>(
      input: ReceiptCommand,
      execute: (transaction: ReceiptTransaction) => Promise<ReceiptResult<T, E>>,
    ) {
      return inTransaction(pool, async (client) => {
        await lockReceipt(client, input);
        const receipt = await loadReceipt(client, input);
        if (receipt !== null) {
          if (receipt.inputHash !== input.inputHash) return { ok: false, mismatch: true };
          return { ok: true, value: receipt.result as T, replayed: true };
        }
        const result = await execute(transactionMethods(client));
        if (result.ok) await recordReceipt(client, { ...input, result: result.value });
        return result;
      });
    },

    async listSystems(ownerId) {
      const result = await pool.query<SystemRow>(
        `SELECT id, owner_id, name, access, lifecycle, kind, base_system_id, created_at, updated_at
           FROM systems
          WHERE owner_id = $1 AND kind = 'system'
          ORDER BY created_at DESC, id DESC`,
        [ownerId],
      );
      return result.rows.map(toSystemRecord);
    },

    async openSystem(systemId) {
      const result = await pool.query<SystemRow>(
        `SELECT id, owner_id, name, access, lifecycle, kind, base_system_id, created_at, updated_at
           FROM systems
          WHERE id = $1`,
        [systemId],
      );
      const row = result.rows[0];
      return row === undefined ? null : toSystemRecord(row);
    },

    async loadDraft(systemId) {
      const result = await pool.query<DraftRow>(
        `SELECT system_id, revision, document_json, source_checksum, updated_by, updated_at, base_version_id
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
         RETURNING id, system_id, semantic_version, checksum, package_json, release_notes, lifecycle, built_against_version_id, created_at`,
        [input.systemId, input.semanticVersion, input.checksum, JSON.stringify(input.package), input.releaseNotes],
      );
      return toVersionRecord(requireRow(result.rows[0], "insertVersion"));
    },

    async loadVersion(versionId) {
      const result = await pool.query<VersionRow>(
        `SELECT id, system_id, semantic_version, checksum, package_json, release_notes, lifecycle, built_against_version_id, created_at
           FROM system_versions
          WHERE id = $1`,
        [versionId],
      );
      const row = result.rows[0];
      return row === undefined ? null : toVersionRecord(row);
    },

    async listVersions(systemId) {
      const result = await pool.query<VersionRow>(
        `SELECT id, system_id, semantic_version, checksum, package_json, release_notes, lifecycle, built_against_version_id, created_at
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
            AND s.kind = 'system'
            AND (s.owner_id = $1 OR s.access IN ('public', 'link'))`,
        [actorId, versionId],
      );
      const row = result.rows[0];
      return row === undefined
        ? null
        : { systemId: row.system_id, versionId: row.version_id, checksum: row.checksum };
    },

    async listLaterAuthorizedVersions(actorId, fromVersionId) {
      const result = await pool.query<VersionChoiceRow>(
        `SELECT v.id, v.system_id, v.semantic_version, v.release_notes, v.created_at
           FROM system_versions current_version
           JOIN system_versions v ON v.system_id = current_version.system_id
           JOIN systems s ON s.id = v.system_id
          WHERE current_version.id = $2
            AND (v.created_at, v.id) > (current_version.created_at, current_version.id)
            AND v.lifecycle = 'published'
            AND s.lifecycle = 'active'
            AND s.kind = 'system'
            AND (s.owner_id = $1 OR s.access IN ('public', 'link'))
          ORDER BY v.created_at DESC, v.id DESC
          LIMIT 50`,
        [actorId, fromVersionId],
      );
      return result.rows.map(toVersionChoice);
    },

    async describeVersionChoices(versionIds) {
      if (versionIds.length === 0) return [];
      const result = await pool.query<VersionChoiceRow>(
        `SELECT id, system_id, semantic_version, release_notes, created_at
           FROM system_versions WHERE id = ANY($1::uuid[])`,
        [versionIds],
      );
      return result.rows.map(toVersionChoice);
    },

    async listAuthorizedVersions(actorId, page) {
      // OD-01 option A (unlisted/link-only): enumeration exposes only systems
      // owned by the actor plus explicitly discoverable (public) systems.
      // Other owners' link-access systems stay usable via a known version ID
      // through authorizeVersionUse, but are excluded here.
      // Ordering is s.name ASC, v.created_at DESC, v.id DESC; the keyset
      // cursor assumes names are stable across pages (renames-may-move: a
      // concurrent rename can shift rows between pages; not solved here).
      const params: unknown[] = [actorId];
      let where = `s.kind = 'system' AND (s.owner_id = $1 OR s.access = 'public')`;
      if (page.q !== null) {
        params.push(`%${escapeLike(page.q)}%`);
        where += ` AND s.name ILIKE $${params.length}`;
      }
      if (page.systemId !== null) {
        params.push(page.systemId);
        where += ` AND s.id = $${params.length}`;
      }
      if (page.cursor !== null) {
        params.push(page.cursor.name, page.cursor.createdAt, page.cursor.versionId);
        const base = params.length - 2;
        where += ` AND (s.name > $${base} OR (s.name = $${base} AND v.created_at < $${base + 1}) OR (s.name = $${base} AND v.created_at = $${base + 1} AND v.id < $${base + 2}))`;
      }
      params.push(page.limit + 1);
      const result = await pool.query<AuthorizedCreationVersionRow>(
        `SELECT v.id AS version_id, s.id AS system_id, s.name AS system_name,
                v.semantic_version, v.created_at,
                to_char(v.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor
           FROM system_versions v
           JOIN systems s ON s.id = v.system_id
          WHERE v.lifecycle = 'published'
            AND s.lifecycle = 'active'
            AND ${where}
          ORDER BY s.name ASC, v.created_at DESC, v.id DESC
          LIMIT $${params.length}`,
        params,
      );
      const hasMore = result.rows.length > page.limit;
      const pageRows = hasMore ? result.rows.slice(0, page.limit) : result.rows;
      const last = pageRows[pageRows.length - 1];
      return {
        versions: pageRows.map((row) => ({
          versionId: row.version_id,
          systemId: row.system_id,
          systemName: row.system_name,
          semanticVersion: row.semantic_version,
          createdAt: row.created_at.toISOString(),
        })),
        nextCursor:
          hasMore && last !== undefined
            ? encodeCreationVersionsCursor({
                name: last.system_name,
                createdAt: last.created_at_cursor,
                versionId: last.version_id,
              })
            : null,
      };
    },

    async recordReceipt(input) {
      return inTransaction(pool, async (client) => {
        await lockReceipt(client, input);
        return recordReceipt(client, input);
      });
    },

    async loadReceipt(input) {
      return loadReceipt(pool, input);
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
          RETURNING id, owner_id, name, access, lifecycle, kind, base_system_id, created_at, updated_at`,
        [systemId, lifecycle],
      );
      const row = result.rows[0];
      return row === undefined ? null : toSystemRecord(row);
    },

    async updateSystemAccess(input) {
      return inTransaction(pool, async (client) => {
        const current = await client.query<SystemRow>(
          `SELECT id, owner_id, name, access, lifecycle, kind, base_system_id, created_at, updated_at
             FROM systems WHERE id = $1 AND owner_id = $2 FOR UPDATE`,
          [input.systemId, input.actorId],
        );
        const system = current.rows[0];
        if (system === undefined) return null;
        if (system.access === input.access) return toSystemRecord(system);
        const updated = await client.query<SystemRow>(
          `UPDATE systems SET access = $2, updated_at = now() WHERE id = $1
           RETURNING id, owner_id, name, access, lifecycle, kind, base_system_id, created_at, updated_at`,
          [input.systemId, input.access],
        );
        await transactionMethods(client).appendAudit({
          systemId: input.systemId,
          actorId: input.actorId,
          kind: "system_sharing_changed",
          summary: `System sharing changed to ${input.access}`,
          requestId: input.requestId,
        });
        return toSystemRecord(requireRow(updated.rows[0], "updateSystemAccess"));
      });
    },

    async updateVersionLifecycle(versionId, lifecycle) {
      const result = await pool.query<VersionRow>(
        `UPDATE system_versions SET lifecycle = $2
          WHERE id = $1
          RETURNING id, system_id, semantic_version, checksum, package_json, release_notes, lifecycle, built_against_version_id, created_at`,
        [versionId, lifecycle],
      );
      const row = result.rows[0];
      return row === undefined ? null : toVersionRecord(row);
    },

    async listSystemsPage(ownerId, page) {
      const params: unknown[] = [ownerId, page.limit + 1];
      let where = "owner_id = $1 AND kind = 'system'";
      if (page.cursor !== null) {
        params.push(page.cursor);
        where += ` AND (created_at, id) < (SELECT created_at, id FROM systems WHERE id = $${params.length} AND owner_id = $1)`;
      }
      const result = await pool.query<SystemRow>(
        `SELECT id, owner_id, name, access, lifecycle, kind, base_system_id, created_at, updated_at
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

    async listExtensionsPage(actorId, baseSystemId, page) {
      // Enumeration mirrors OD-01: owned plus public; link extensions stay
      // usable by a known version ID but are not listed to other users.
      const params: unknown[] = [actorId, baseSystemId, page.limit + 1];
      let where = "kind = 'extension' AND base_system_id = $2 AND (owner_id = $1 OR (access = 'public' AND lifecycle = 'active'))";
      if (page.cursor !== null) {
        params.push(page.cursor);
        where += ` AND (created_at, id) < (SELECT created_at, id FROM systems WHERE id = $${params.length})`;
      }
      const result = await pool.query<SystemRow>(
        `SELECT ${SYSTEM_COLUMNS}
           FROM systems
          WHERE ${where}
          ORDER BY created_at DESC, id DESC
          LIMIT $3`,
        params,
      );
      const hasMore = result.rows.length > page.limit;
      const pageRows = hasMore ? result.rows.slice(0, page.limit) : result.rows;
      const last = pageRows[pageRows.length - 1];
      return { extensions: pageRows.map(toSystemRecord), nextCursor: hasMore && last !== undefined ? last.id : null };
    },

    async listPublishedVersions(systemId) {
      const result = await pool.query<VersionRow>(
        `SELECT ${VERSION_COLUMNS}
           FROM system_versions
          WHERE system_id = $1 AND lifecycle = 'published'
          ORDER BY created_at DESC, id DESC`,
        [systemId],
      );
      return result.rows.map(toVersionRecord);
    },

    async authorizeExtensionUse(actorId, versionId) {
      const result = await pool.query<{ extension_id: string; version_id: string; base_system_id: string; checksum: string }>(
        `SELECT s.id AS extension_id, v.id AS version_id, s.base_system_id, v.checksum
           FROM system_versions v
           JOIN systems s ON s.id = v.system_id
          WHERE v.id = $2
            AND v.lifecycle = 'published'
            AND s.lifecycle = 'active'
            AND s.kind = 'extension'
            AND (s.owner_id = $1 OR s.access IN ('public', 'link'))`,
        [actorId, versionId],
      );
      const row = result.rows[0];
      return row === undefined
        ? null
        : { extensionId: row.extension_id, versionId: row.version_id, baseSystemId: row.base_system_id, checksum: row.checksum };
    },
  };
}

const SYSTEM_COLUMNS = "id, owner_id, name, access, lifecycle, kind, base_system_id, created_at, updated_at";
const VERSION_COLUMNS = "id, system_id, semantic_version, checksum, package_json, release_notes, lifecycle, built_against_version_id, created_at";

type SystemRow = {
  id: string;
  owner_id: string | null;
  name: string;
  access: string;
  lifecycle: string;
  kind: SystemKind;
  base_system_id: string | null;
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
  base_version_id: string | null;
};

type VersionRow = {
  id: string;
  system_id: string;
  semantic_version: string;
  checksum: string;
  package_json: unknown;
  release_notes: string;
  lifecycle: string;
  built_against_version_id: string | null;
  created_at: Date;
};

type VersionChoiceRow = {
  id: string;
  system_id: string;
  semantic_version: string;
  release_notes: string;
  created_at: Date;
};

function toVersionChoice(row: VersionChoiceRow): VersionChoice {
  return {
    versionId: row.id,
    systemId: row.system_id,
    semanticVersion: row.semantic_version,
    releaseNotes: row.release_notes,
    createdAt: row.created_at,
  };
}

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
  created_at_cursor: string;
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
    kind: row.kind,
    baseSystemId: row.base_system_id,
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
    baseVersionId: row.base_version_id,
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
    builtAgainstVersionId: row.built_against_version_id,
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

function transactionMethods(connection: Pool | PoolClient): ReceiptTransaction {
  return {
    async createSystem(input) {
      const result = await connection.query<SystemRow>(
        `INSERT INTO systems (owner_id, name, kind, base_system_id)
         VALUES ($1, $2, $3, $4)
         RETURNING id, owner_id, name, access, lifecycle, kind, base_system_id, created_at, updated_at`,
        [input.ownerId, input.name, input.baseSystemId === undefined ? "system" : "extension", input.baseSystemId ?? null],
      );
      return toSystemRecord(requireRow(result.rows[0], "createSystem"));
    },
    async appendAudit(input) {
      const result = await connection.query<AuditRow>(
        `INSERT INTO system_audit_records (system_id, actor_id, kind, summary, request_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, system_id, actor_id, kind, summary, occurred_at, request_id`,
        [input.systemId, input.actorId, input.kind, input.summary, input.requestId],
      );
      return toAuditRecord(requireRow(result.rows[0], "appendAudit"));
    },
    async saveDraft(input) {
      return "release" in connection
        ? saveDraft(connection, input)
        : inTransaction(connection, (client) => saveDraft(client, input));
    },
    async publishVersion(input) {
      return "release" in connection
        ? publishVersion(connection, input)
        : inTransaction(connection, (client) => publishVersion(client, input));
    },
  };
}

async function inTransaction<T>(pool: Pool, execute: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await execute(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function lockReceipt(client: PoolClient, input: Pick<ReceiptCommand, "actorId" | "commandKind" | "key">) {
  const lockKey = JSON.stringify([input.actorId, input.commandKind, input.key]);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);
}

async function loadReceipt(
  connection: Pool | PoolClient,
  input: Pick<ReceiptCommand, "actorId" | "commandKind" | "key">,
): Promise<IdempotencyReceipt | null> {
  const result = await connection.query<ReceiptRow>(
    `SELECT id, actor_id, command_kind, key, input_hash, result_json, created_at, expires_at
       FROM idempotency_receipts
      WHERE actor_id = $1 AND command_kind = $2 AND key = $3 AND expires_at > statement_timestamp()`,
    [input.actorId, input.commandKind, input.key],
  );
  const row = result.rows[0];
  return row === undefined ? null : toReceipt(row);
}

async function saveDraft(client: PoolClient, input: SaveDraftInput): Promise<DraftSaveResult> {
  const candidateName = (input.document as { metadata?: { name?: unknown } } | null)?.metadata?.name;
  const draftName = typeof candidateName === "string" && candidateName.trim() !== "" ? candidateName : null;
  // Image changes and ordinary saves share the system-before-draft lock order.
  await client.query("SELECT id FROM systems WHERE id=$1 FOR UPDATE", [input.systemId]);
  const existing = await client.query<DraftRow>(
    `SELECT system_id, revision, document_json, source_checksum, updated_by, updated_at, base_version_id
       FROM system_drafts
      WHERE system_id = $1
      FOR UPDATE`,
    [input.systemId],
  );
  const row = existing.rows[0];
  if (row === undefined) {
    if (input.expectedRevision !== null) {
      return { ok: false, code: "stale_revision", latestRevision: null };
    }
    await saveSystemImages(client, input.systemId, input.document as SystemDocumentV1, input.newImages, input.retainedImageIds);
    const inserted = await client.query<DraftRow>(
      `INSERT INTO system_drafts (system_id, revision, document_json, source_checksum, updated_by, base_version_id)
       VALUES ($1, 1, $2::jsonb, $3, $4, $5)
       RETURNING system_id, revision, document_json, source_checksum, updated_by, updated_at, base_version_id`,
      [input.systemId, JSON.stringify(input.document), input.sourceChecksum, input.updatedBy, input.baseVersionId ?? null],
    );
    const draft = toDraftRecord(requireRow(inserted.rows[0], "saveDraft"));
    if (draftName !== null) {
      await client.query(`UPDATE systems SET name = $2, updated_at = now() WHERE id = $1`,
        [input.systemId, draftName]);
    }
    await client.query(
      `INSERT INTO system_audit_records (system_id, actor_id, kind, summary, request_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [input.systemId, input.updatedBy, "draft_saved", `Draft revision ${draft.revision} saved`, input.requestId],
    );
    return { ok: true, draft };
  }
  if (row.revision !== input.expectedRevision) {
    return { ok: false, code: "stale_revision", latestRevision: row.revision };
  }
  await saveSystemImages(client, input.systemId, input.document as SystemDocumentV1, input.newImages, input.retainedImageIds);
  const updated = await client.query<DraftRow>(
    `UPDATE system_drafts
        SET revision = revision + 1, document_json = $2::jsonb, source_checksum = $3, updated_by = $4, updated_at = now(),
            base_version_id = CASE WHEN $5::boolean THEN $6::uuid ELSE base_version_id END
      WHERE system_id = $1
      RETURNING system_id, revision, document_json, source_checksum, updated_by, updated_at, base_version_id`,
    [input.systemId, JSON.stringify(input.document), input.sourceChecksum, input.updatedBy,
      input.baseVersionId !== undefined, input.baseVersionId ?? null],
  );
  const draft = toDraftRecord(requireRow(updated.rows[0], "saveDraft"));
  if (draftName !== null) {
    await client.query(`UPDATE systems SET name = $2, updated_at = now() WHERE id = $1`,
      [input.systemId, draftName]);
  }
  await client.query(
    `INSERT INTO system_audit_records (system_id, actor_id, kind, summary, request_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.systemId, input.updatedBy, "draft_saved", `Draft revision ${draft.revision} saved`, input.requestId],
  );
  return { ok: true, draft };
}

async function recordReceipt(client: PoolClient, input: RecordReceiptInput): Promise<RecordReceiptResult> {
  const existing = await loadReceipt(client, input);
  if (existing !== null) {
    if (existing.inputHash !== input.inputHash) return { ok: false, code: "idempotency_mismatch" };
    return { ok: true, reused: true, receipt: existing };
  }
  const inserted = await client.query<ReceiptRow>(
    `INSERT INTO idempotency_receipts (actor_id, command_kind, key, input_hash, result_json, expires_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     ON CONFLICT (actor_id, command_kind, key) DO UPDATE SET
       input_hash = EXCLUDED.input_hash, result_json = EXCLUDED.result_json,
       created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at
     RETURNING id, actor_id, command_kind, key, input_hash, result_json, created_at, expires_at`,
    [input.actorId, input.commandKind, input.key, input.inputHash, JSON.stringify(input.result), input.expiresAt],
  );
  return { ok: true, reused: false, receipt: toReceipt(requireRow(inserted.rows[0], "recordReceipt")) };
}

async function publishVersion(client: PoolClient, input: PublishVersionInput): Promise<PublishVersionResult> {
  const system = await client.query<{ owner_id: string | null; lifecycle: string; kind: SystemKind }>(
    "SELECT owner_id, lifecycle, kind FROM systems WHERE id = $1 FOR UPDATE",
    [input.systemId],
  );
  if (system.rows[0] === undefined) return { ok: false, code: "stale_revision", latestRevision: null };
  if (system.rows[0].owner_id !== input.actorId) return { ok: false, code: "not_found" };
  if (system.rows[0].lifecycle === "archived") return { ok: false, code: "archived" };
  const existing = await client.query<DraftRow>(
    `SELECT system_id, revision, document_json, source_checksum, updated_by, updated_at, base_version_id
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
    return { ok: false, code: "stale_revision", latestRevision: draft?.revision ?? null };
  }
  const latestVersion = await client.query<Pick<VersionRow, "id" | "semantic_version" | "package_json">>(
    `SELECT id, semantic_version, package_json
       FROM system_versions
      WHERE system_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [input.systemId],
  );
  const latest = latestVersion.rows[0];
  // Retain the breaking changes the author acknowledged against the assessed
  // base. A concurrent version can also make a previously compatible draft
  // breaking, so compare again when the assessed base has moved.
  const isExtension = system.rows[0].kind === "extension";
  if (isExtension !== (input.builtAgainstVersionId != null)) return { ok: false, code: "not_found" };
  const findings = input.compatibilityFindings.length === 0 && latest !== undefined
    && input.compatibilityBaseVersionId !== undefined && input.compatibilityBaseVersionId !== latest.id
    ? (isExtension
      ? compareExtensionPackages(latest.package_json as ExtensionPackageV1, input.package as ExtensionPackageV1).findings
      : comparePackages(latest.package_json as SystemPackageV1, input.package as SystemPackageV1).findings)
    : input.compatibilityFindings;
  if (findings.length > 0 && latest !== undefined) {
    const nextMajor = Number(input.semanticVersion.split(".")[0]);
    const latestMajor = Number(latest.semantic_version.split(".")[0]);
    if (!input.acknowledgeBreaking || nextMajor <= latestMajor) {
      return { ok: false, code: "breaking_version", findings };
    }
  }
  const result = await client.query<VersionRow>(
    `INSERT INTO system_versions
       (id, system_id, semantic_version, checksum, package_json, release_notes, compatibility_findings_json,
        built_against_version_id)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8)
      ON CONFLICT DO NOTHING
      RETURNING id, system_id, semantic_version, checksum, package_json, release_notes, lifecycle, built_against_version_id, created_at`,
    [
      input.versionId,
      input.systemId,
      input.semanticVersion,
      input.checksum,
      JSON.stringify(input.package),
      input.releaseNotes,
      JSON.stringify(findings),
      input.builtAgainstVersionId ?? null,
    ],
  );
  const inserted = result.rows[0];
  if (inserted === undefined) return { ok: false, code: "duplicate_version" };
  const version = toVersionRecord(inserted);
  await client.query(
    `INSERT INTO system_audit_records (system_id, actor_id, kind, summary, request_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.systemId, input.actorId, "version_published", `Published version ${input.semanticVersion}`, input.requestId],
  );
  return { ok: true, version };
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
  {
    systemId: forgedInTheDarkPackage.systemId,
    versionId: forgedInTheDarkPackage.versionId,
    name: "Template: Forged in the Dark",
    package: forgedInTheDarkPackage,
  },
];

export type SeedReferenceTemplatesResult = {
  systemsInserted: number;
  versionsInserted: number;
};

type SeedRunner = Pick<Pool | PoolClient, "query">;

export async function seedReferenceTemplates(runner: SeedRunner): Promise<SeedReferenceTemplatesResult> {
  let systemsInserted = 0;
  let versionsInserted = 0;
  for (const tpl of REFERENCE_TEMPLATES) {
    const inserted = await runner.query<{ id: string }>(
      `INSERT INTO systems (id, owner_id, name, access, lifecycle, created_at, updated_at)
       VALUES ($1, NULL, $2, 'link', 'active', now(), now())
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [tpl.systemId, tpl.name],
    );
    if ((inserted.rowCount ?? 0) > 0) systemsInserted += 1;
    const version = await runner.query<{ id: string }>(
      `INSERT INTO system_versions (id, system_id, semantic_version, checksum, package_json, release_notes, lifecycle, created_at)
       VALUES ($1, $2, '1.0.0', $3, $4::jsonb, 'Template seed', 'published', now())
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [tpl.versionId, tpl.systemId, tpl.package.integrity.checksum, JSON.stringify(tpl.package)],
    );
    if ((version.rowCount ?? 0) > 0) versionsInserted += 1;
  }
  return { systemsInserted, versionsInserted };
}
