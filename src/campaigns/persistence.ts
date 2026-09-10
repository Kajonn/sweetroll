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

export type CampaignReceiptWithExpiry = CampaignReceipt & {
  expiresAt: Date;
};

export type InvitationRecord = {
  invitationId: string;
  campaignId: string;
  issuedBy: string;
  intendedRole: "player" | "co_gm";
  tokenHash: string;
  status: "pending" | "accepted" | "declined" | "revoked";
  revision: number;
  consumingActorId: string | null;
  acceptedMembershipGeneration: number | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
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

type InvitationRow = {
  id: string;
  campaign_id: string;
  issued_by: string;
  intended_role: string;
  token_hash: string;
  status: string;
  revision: number;
  consuming_actor_id: string | null;
  accepted_membership_generation: number | null;
  expires_at: Date;
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
const INVITATION_COLUMNS =
  "id, campaign_id, issued_by, intended_role, token_hash, status, revision, consuming_actor_id, accepted_membership_generation, expires_at, created_at, updated_at";

function toInvitationRecord(row: InvitationRow): InvitationRecord {
  if (row.intended_role !== "player" && row.intended_role !== "co_gm") {
    throw new Error(`Unknown invitation role: ${row.intended_role}`);
  }
  if (row.status !== "pending" && row.status !== "accepted" && row.status !== "declined" && row.status !== "revoked") {
    throw new Error(`Unknown invitation status: ${row.status}`);
  }
  return {
    invitationId: row.id,
    campaignId: row.campaign_id,
    issuedBy: row.issued_by,
    intendedRole: row.intended_role,
    tokenHash: row.token_hash,
    status: row.status,
    revision: row.revision,
    consumingActorId: row.consuming_actor_id,
    acceptedMembershipGeneration: row.accepted_membership_generation,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

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

    async loadReceiptWithExpiry(
      client: DbClient,
      input: { actorId: string; commandKind: string; idempotencyKey: string },
    ): Promise<CampaignReceiptWithExpiry | null> {
      const result = await client.query<{
        input_hash: string;
        campaign_id: string | null;
        result_json: unknown;
        expires_at: Date;
      }>(
        `SELECT input_hash, campaign_id, result_json, expires_at
           FROM campaign_command_executions
          WHERE actor_id = $1 AND command_kind = $2 AND idempotency_key = $3`,
        [input.actorId, input.commandKind, input.idempotencyKey],
      );
      const row = result.rows[0];
      return row === undefined
        ? null
        : {
            inputHash: row.input_hash,
            campaignId: row.campaign_id,
            resultJson: row.result_json,
            expiresAt: row.expires_at,
          };
    },

    async insertInvitation(
      client: PoolClient,
      input: {
        invitationId: string;
        campaignId: string;
        issuedBy: string;
        intendedRole: InvitationRecord["intendedRole"];
        tokenHash: string;
        expiresAt: Date;
      },
    ): Promise<InvitationRecord> {
      const result = await client.query<InvitationRow>(
        `INSERT INTO campaign_invitations
           (id, campaign_id, issued_by, intended_role, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
         RETURNING ${INVITATION_COLUMNS}`,
        [
          input.invitationId,
          input.campaignId,
          input.issuedBy,
          input.intendedRole,
          input.tokenHash,
          input.expiresAt.toISOString(),
        ],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("insertInvitation returned no row");
      return toInvitationRecord(row);
    },

    async loadInvitation(client: DbClient, invitationId: string): Promise<InvitationRecord | null> {
      const result = await client.query<InvitationRow>(
        `SELECT ${INVITATION_COLUMNS} FROM campaign_invitations WHERE id = $1`,
        [invitationId],
      );
      const row = result.rows[0];
      return row === undefined ? null : toInvitationRecord(row);
    },

    async lockInvitation(client: PoolClient, invitationId: string): Promise<InvitationRecord | null> {
      const result = await client.query<InvitationRow>(
        `SELECT ${INVITATION_COLUMNS} FROM campaign_invitations WHERE id = $1 FOR UPDATE`,
        [invitationId],
      );
      const row = result.rows[0];
      return row === undefined ? null : toInvitationRecord(row);
    },

    async findInvitationByHash(client: DbClient, tokenHash: string): Promise<InvitationRecord | null> {
      const result = await client.query<InvitationRow>(
        `SELECT ${INVITATION_COLUMNS} FROM campaign_invitations WHERE token_hash = $1`,
        [tokenHash],
      );
      const row = result.rows[0];
      return row === undefined ? null : toInvitationRecord(row);
    },

    async rotateInvitationToken(
      client: PoolClient,
      input: { invitationId: string; newTokenHash: string; expiresAt: Date; expectedRevision: number; now: Date },
    ): Promise<InvitationRecord | null> {
      const result = await client.query<InvitationRow>(
        `UPDATE campaign_invitations
            SET token_hash = $2,
                expires_at = $3::timestamptz,
                revision = revision + 1,
                updated_at = $4::timestamptz
          WHERE id = $1 AND revision = $5
          RETURNING ${INVITATION_COLUMNS}`,
        [
          input.invitationId,
          input.newTokenHash,
          input.expiresAt.toISOString(),
          input.now.toISOString(),
          input.expectedRevision,
        ],
      );
      const row = result.rows[0];
      return row === undefined ? null : toInvitationRecord(row);
    },

    async consumeInvitation(
      client: PoolClient,
      input: {
        invitationId: string;
        status: "accepted" | "declined";
        consumingActorId: string;
        acceptedMembershipGeneration: number | null;
        expectedRevision: number;
        now: Date;
      },
    ): Promise<InvitationRecord | null> {
      const result = await client.query<InvitationRow>(
        `UPDATE campaign_invitations
            SET status = $2,
                consuming_actor_id = $3,
                accepted_membership_generation = $4,
                revision = revision + 1,
                updated_at = $5::timestamptz
          WHERE id = $1 AND revision = $6
          RETURNING ${INVITATION_COLUMNS}`,
        [
          input.invitationId,
          input.status,
          input.consumingActorId,
          input.acceptedMembershipGeneration,
          input.now.toISOString(),
          input.expectedRevision,
        ],
      );
      const row = result.rows[0];
      return row === undefined ? null : toInvitationRecord(row);
    },

    async revokePendingInvitation(
      client: PoolClient,
      input: { invitationId: string; expectedRevision: number; now: Date },
    ): Promise<InvitationRecord | null> {
      const result = await client.query<InvitationRow>(
        `UPDATE campaign_invitations
            SET status = 'revoked',
                revision = revision + 1,
                updated_at = $2::timestamptz
          WHERE id = $1 AND revision = $3 AND status = 'pending'
          RETURNING ${INVITATION_COLUMNS}`,
        [input.invitationId, input.now.toISOString(), input.expectedRevision],
      );
      const row = result.rows[0];
      return row === undefined ? null : toInvitationRecord(row);
    },

    async listInvitationsPage(
      client: DbClient,
      campaignId: string,
      input: { limit: number; cursorCreatedAt: string | null; cursorId: string | null },
    ): Promise<InvitationRecord[]> {
      const params: unknown[] = [campaignId];
      let cursorClause = "";
      if (input.cursorCreatedAt !== null && input.cursorId !== null) {
        params.push(input.cursorCreatedAt, input.cursorId);
        cursorClause = `AND (created_at < $2::timestamptz OR (created_at = $2::timestamptz AND id < $3))`;
      }
      params.push(input.limit + 1);
      const result = await client.query<InvitationRow>(
        `SELECT ${INVITATION_COLUMNS}
           FROM campaign_invitations
          WHERE campaign_id = $1
            ${cursorClause}
          ORDER BY created_at DESC, id DESC
          LIMIT $${params.length}`,
        params,
      );
      return result.rows.map(toInvitationRecord);
    },

    async countActiveMembers(client: DbClient, campaignId: string): Promise<number> {
      const result = await client.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM campaign_members WHERE campaign_id = $1 AND status = 'active'`,
        [campaignId],
      );
      return Number(result.rows[0]?.count ?? 0);
    },

    async upsertMembershipForAccept(
      client: PoolClient,
      input: { campaignId: string; userId: string; role: MembershipRecord["role"] },
    ): Promise<MembershipRecord> {
      const reactivated = await client.query<MembershipRow>(
        `UPDATE campaign_members
            SET role = $3,
                status = 'active',
                generation = generation + 1,
                updated_at = now()
          WHERE campaign_id = $1 AND user_id = $2 AND status = 'removed'
          RETURNING ${MEMBERSHIP_COLUMNS}`,
        [input.campaignId, input.userId, input.role],
      );
      const existing = reactivated.rows[0];
      if (existing !== undefined) return toMembershipRecord(existing);
      const inserted = await client.query<MembershipRow>(
        `INSERT INTO campaign_members (campaign_id, user_id, role, status, generation)
         VALUES ($1, $2, $3, 'active', 1)
         RETURNING ${MEMBERSHIP_COLUMNS}`,
        [input.campaignId, input.userId, input.role],
      );
      const row = inserted.rows[0];
      if (row === undefined) throw new Error("upsertMembershipForAccept returned no row");
      return toMembershipRecord(row);
    },

    async loadUserDisplayName(client: DbClient, userId: string): Promise<string | null> {
      const result = await client.query<{ display_name: string }>(
        `SELECT display_name FROM users WHERE id = $1`,
        [userId],
      );
      return result.rows[0]?.display_name ?? null;
    },
  };
}

export type CampaignPersistenceRepository = ReturnType<typeof createCampaignPersistenceRepository>;
