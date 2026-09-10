import type { Pool, PoolClient } from "pg";

export type DbClient = Pool | PoolClient;

export type CampaignRecord = {
  campaignId: string;
  ownerId: string;
  systemVersionId: string;
  title: string;
  description: string;
  status: "active" | "archived";
  revision: number;
  accessRevision: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type MembershipRecord = {
  campaignId: string;
  userId: string;
  role: "owner" | "co_gm" | "player";
  status: "active" | "removed";
  generation: number;
  createdAt: Date;
  updatedAt: Date;
};

export type AccessibleVersion = {
  systemId: string;
  versionId: string;
  checksum: string;
};

export type CampaignReceipt = {
  inputHash: string;
  campaignId: string | null;
  resultJson: unknown;
};

type CampaignRow = {
  id: string;
  owner_id: string;
  system_version_id: string;
  title: string;
  description: string;
  status: string;
  revision: number;
  access_revision: number;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type MembershipRow = {
  campaign_id: string;
  user_id: string;
  role: string;
  status: string;
  generation: number;
  created_at: Date;
  updated_at: Date;
};

function toCampaignRecord(row: CampaignRow): CampaignRecord {
  if (row.status !== "active" && row.status !== "archived") {
    throw new Error(`Unknown campaign status: ${row.status}`);
  }
  return {
    campaignId: row.id,
    ownerId: row.owner_id,
    systemVersionId: row.system_version_id,
    title: row.title,
    description: row.description,
    status: row.status,
    revision: row.revision,
    accessRevision: row.access_revision,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMembershipRecord(row: MembershipRow): MembershipRecord {
  if (row.role !== "owner" && row.role !== "co_gm" && row.role !== "player") {
    throw new Error(`Unknown campaign role: ${row.role}`);
  }
  if (row.status !== "active" && row.status !== "removed") {
    throw new Error(`Unknown membership status: ${row.status}`);
  }
  return {
    campaignId: row.campaign_id,
    userId: row.user_id,
    role: row.role,
    status: row.status,
    generation: row.generation,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const CAMPAIGN_COLUMNS =
  "id, owner_id, system_version_id, title, description, status, revision, access_revision, archived_at, created_at, updated_at";
const MEMBERSHIP_COLUMNS = "campaign_id, user_id, role, status, generation, created_at, updated_at";

export function createCampaignPersistenceRepository(pool: Pool) {
  return {
    async loadAccessibleVersion(actorId: string, versionId: string): Promise<AccessibleVersion | null> {
      // Same owner/public/link predicate as Characters version creation:
      // published version on an active system owned by the actor or shared
      // publicly/by-link. Link-only systems stay usable by known version ID
      // but are never enumerated here.
      const result = await pool.query<{
        system_id: string;
        version_id: string;
        checksum: string;
      }>(
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

    async insertCampaign(
      client: PoolClient,
      input: {
        campaignId: string;
        ownerId: string;
        systemVersionId: string;
        title: string;
        description: string;
      },
    ): Promise<CampaignRecord> {
      const result = await client.query<CampaignRow>(
        `INSERT INTO campaigns (id, owner_id, system_version_id, title, description)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${CAMPAIGN_COLUMNS}`,
        [input.campaignId, input.ownerId, input.systemVersionId, input.title, input.description],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("insertCampaign returned no row");
      return toCampaignRecord(row);
    },

    async insertOwnerMembership(client: PoolClient, campaignId: string, ownerId: string): Promise<MembershipRecord> {
      const result = await client.query<MembershipRow>(
        `INSERT INTO campaign_members (campaign_id, user_id, role, status, generation)
         VALUES ($1, $2, 'owner', 'active', 1)
         RETURNING ${MEMBERSHIP_COLUMNS}`,
        [campaignId, ownerId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("insertOwnerMembership returned no row");
      return toMembershipRecord(row);
    },

    async openCampaign(client: DbClient, campaignId: string): Promise<CampaignRecord | null> {
      const result = await client.query<CampaignRow>(
        `SELECT ${CAMPAIGN_COLUMNS} FROM campaigns WHERE id = $1`,
        [campaignId],
      );
      const row = result.rows[0];
      return row === undefined ? null : toCampaignRecord(row);
    },

    async lockCampaign(client: PoolClient, campaignId: string): Promise<CampaignRecord | null> {
      const result = await client.query<CampaignRow>(
        `SELECT ${CAMPAIGN_COLUMNS} FROM campaigns WHERE id = $1 FOR UPDATE`,
        [campaignId],
      );
      const row = result.rows[0];
      return row === undefined ? null : toCampaignRecord(row);
    },

    async updateCampaignMetadata(
      client: PoolClient,
      input: { campaignId: string; title: string; description: string; expectedRevision: number; now: Date },
    ): Promise<CampaignRecord | null> {
      const result = await client.query<CampaignRow>(
        `UPDATE campaigns
            SET title = $2, description = $3, revision = revision + 1, updated_at = $4
          WHERE id = $1 AND revision = $5
          RETURNING ${CAMPAIGN_COLUMNS}`,
        [input.campaignId, input.title, input.description, input.now.toISOString(), input.expectedRevision],
      );
      const row = result.rows[0];
      return row === undefined ? null : toCampaignRecord(row);
    },

    async updateCampaignStatus(
      client: PoolClient,
      input: { campaignId: string; status: "active" | "archived"; expectedRevision: number; now: Date },
    ): Promise<CampaignRecord | null> {
      const result = await client.query<CampaignRow>(
        `UPDATE campaigns
            SET status = $2,
                revision = revision + 1,
                access_revision = access_revision + 1,
                archived_at = CASE WHEN $2 = 'archived' THEN $3::timestamptz ELSE NULL END,
                updated_at = $3::timestamptz
          WHERE id = $1 AND revision = $4
          RETURNING ${CAMPAIGN_COLUMNS}`,
        [input.campaignId, input.status, input.now.toISOString(), input.expectedRevision],
      );
      const row = result.rows[0];
      return row === undefined ? null : toCampaignRecord(row);
    },

    async bumpCampaignRevisionForMembership(
      client: PoolClient,
      input: { campaignId: string; expectedRevision: number; now: Date },
    ): Promise<CampaignRecord | null> {
      const result = await client.query<CampaignRow>(
        `UPDATE campaigns
            SET revision = revision + 1,
                access_revision = access_revision + 1,
                updated_at = $2
          WHERE id = $1 AND revision = $3
          RETURNING ${CAMPAIGN_COLUMNS}`,
        [input.campaignId, input.now.toISOString(), input.expectedRevision],
      );
      const row = result.rows[0];
      return row === undefined ? null : toCampaignRecord(row);
    },

    async loadMembership(
      client: DbClient,
      campaignId: string,
      userId: string,
    ): Promise<MembershipRecord | null> {
      const result = await client.query<MembershipRow>(
        `SELECT ${MEMBERSHIP_COLUMNS} FROM campaign_members WHERE campaign_id = $1 AND user_id = $2`,
        [campaignId, userId],
      );
      const row = result.rows[0];
      return row === undefined ? null : toMembershipRecord(row);
    },

    async updateMembership(
      client: PoolClient,
      input: { campaignId: string; userId: string; role?: MembershipRecord["role"]; status?: MembershipRecord["status"] },
    ): Promise<MembershipRecord | null> {
      const result = await client.query<MembershipRow>(
        `UPDATE campaign_members
            SET role = COALESCE($3, role),
                status = COALESCE($4, status),
                generation = CASE WHEN COALESCE($4, status) = 'removed' THEN generation + 1 ELSE generation END,
                updated_at = now()
          WHERE campaign_id = $1 AND user_id = $2
          RETURNING ${MEMBERSHIP_COLUMNS}`,
        [input.campaignId, input.userId, input.role ?? null, input.status ?? null],
      );
      const row = result.rows[0];
      return row === undefined ? null : toMembershipRecord(row);
    },

    async listCampaignsPage(
      client: DbClient,
      actorId: string,
      input: { limit: number; cursorCreatedAt: string | null; cursorId: string | null },
    ): Promise<CampaignRecord[]> {
      const params: unknown[] = [actorId];
      let cursorClause = "";
      if (input.cursorCreatedAt !== null && input.cursorId !== null) {
        params.push(input.cursorCreatedAt, input.cursorId);
        cursorClause = `AND (c.created_at < $2::timestamptz OR (c.created_at = $2::timestamptz AND c.id < $3))`;
      }
      params.push(input.limit + 1);
      const result = await client.query<CampaignRow>(
        `SELECT ${CAMPAIGN_COLUMNS.split(", ").map((column) => `c.${column}`).join(", ")}
           FROM campaigns c
           JOIN campaign_members m ON m.campaign_id = c.id
          WHERE m.user_id = $1 AND m.status = 'active'
            ${cursorClause}
          ORDER BY c.created_at DESC, c.id DESC
          LIMIT $${params.length}`,
        params,
      );
      return result.rows.map(toCampaignRecord);
    },

    async listMembersPage(
      client: DbClient,
      campaignId: string,
      input: { limit: number; cursorCreatedAt: string | null; cursorUserId: string | null },
    ): Promise<MembershipRecord[]> {
      const params: unknown[] = [campaignId];
      let cursorClause = "";
      if (input.cursorCreatedAt !== null && input.cursorUserId !== null) {
        params.push(input.cursorCreatedAt, input.cursorUserId);
        cursorClause = `AND (created_at < $2::timestamptz OR (created_at = $2::timestamptz AND user_id < $3))`;
      }
      params.push(input.limit + 1);
      const result = await client.query<MembershipRow>(
        `SELECT ${MEMBERSHIP_COLUMNS}
           FROM campaign_members
          WHERE campaign_id = $1
            ${cursorClause}
          ORDER BY created_at DESC, user_id DESC
          LIMIT $${params.length}`,
        params,
      );
      return result.rows.map(toMembershipRecord);
    },

    async appendAudit(
      client: PoolClient,
      input: { campaignId: string; actorId: string; kind: string; summary: string; requestId: string },
    ): Promise<void> {
      await client.query(
        `INSERT INTO campaign_audit_records (campaign_id, actor_id, kind, summary, request_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [input.campaignId, input.actorId, input.kind, input.summary, input.requestId],
      );
    },

    async tryInsertReceipt(
      client: PoolClient,
      input: {
        actorId: string;
        commandKind: string;
        idempotencyKey: string;
        inputHash: string;
        campaignId: string | null;
        resultJson: unknown;
        expiresAt: Date;
      },
    ): Promise<boolean> {
      const result = await client.query(
        `INSERT INTO campaign_command_executions
           (actor_id, command_kind, idempotency_key, input_hash, campaign_id, result_json, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         ON CONFLICT (actor_id, command_kind, idempotency_key) DO NOTHING`,
        [
          input.actorId,
          input.commandKind,
          input.idempotencyKey,
          input.inputHash,
          input.campaignId,
          JSON.stringify(input.resultJson),
          input.expiresAt.toISOString(),
        ],
      );
      return (result.rowCount ?? 0) === 1;
    },

    async loadReceipt(
      client: DbClient,
      input: { actorId: string; commandKind: string; idempotencyKey: string },
    ): Promise<CampaignReceipt | null> {
      const result = await client.query<{ input_hash: string; campaign_id: string | null; result_json: unknown }>(
        `SELECT input_hash, campaign_id, result_json
           FROM campaign_command_executions
          WHERE actor_id = $1 AND command_kind = $2 AND idempotency_key = $3`,
        [input.actorId, input.commandKind, input.idempotencyKey],
      );
      const row = result.rows[0];
      return row === undefined
        ? null
        : { inputHash: row.input_hash, campaignId: row.campaign_id, resultJson: row.result_json };
    },
  };
}

export type CampaignPersistenceRepository = ReturnType<typeof createCampaignPersistenceRepository>;
