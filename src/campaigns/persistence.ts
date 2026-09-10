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
  /**
   * Task 7 storage only: the roll audience default Task 8 wires into roll
   * behavior. No command reads or writes it yet; the DB default applies.
   */
  rollAudienceDefault: "owner_only" | "gm_only" | "campaign";
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

export type ContentAudience = "gm_only" | "all_players" | "selected_players" | "owner_only";

export type ContentStatus = "active" | "deleted";

export type ContentRecord = {
  contentId: string;
  campaignId: string;
  creatorId: string;
  audience: ContentAudience;
  title: string;
  body: string;
  tags: string[];
  revision: number;
  accessRevision: number;
  status: ContentStatus;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ActivityEventKind =
  | "content_created"
  | "content_updated"
  | "content_deleted"
  | "content_recovered"
  | "content_grants_replaced"
  | "roll_executed";

export type ActivityEventRecord = {
  eventId: string;
  campaignId: string;
  actorId: string;
  kind: ActivityEventKind;
  sourceContentId: string | null;
  /** Roll source for `roll_executed` events; NULL for content events. */
  sourceRollId: string | null;
  requestId: string;
  occurredAt: Date;
};

/**
 * I6 Task 8: one visible campaign roll for the export projection. Full
 * details (dice, bindings, output) are included only when the exporter may
 * read the roll under the same source policy as activity; private rolls of
 * other members never enter the projection.
 */
export type RollExportRecord = {
  rollId: string;
  characterId: string;
  actorId: string;
  actionId: string;
  audience: "owner_only" | "gm_only" | "campaign";
  expression: string;
  dice: unknown;
  bindings: unknown;
  total: number;
  output: string;
  occurredAt: Date;
};

export type AccessibleVersion = {
  systemId: string;
  versionId: string;
  checksum: string;
};

/**
 * I6 Task 9: one attached character for the campaign roster read. GMs see
 * every attached sheet; players see only sheets they control (enforced in
 * SQL by listAttachedCharactersPage, never paginate-then-filter).
 */
export type AttachedCharacterRecord = {
  characterId: string;
  campaignId: string;
  name: string;
  entityDefinitionId: string;
  systemVersionId: string;
  revision: number;
  lifecycle: "active" | "archived";
  placementGeneration: number;
  controllers: string[];
  createdAt: Date;
  updatedAt: Date;
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
  roll_audience_default: string;
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

type ContentRow = {
  id: string;
  campaign_id: string;
  creator_id: string;
  audience: string;
  title: string;
  body: string;
  tags: string[];
  revision: number;
  access_revision: number;
  status: string;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type ActivityEventRow = {
  id: string;
  campaign_id: string;
  actor_id: string;
  kind: string;
  source_content_id: string | null;
  source_roll_id: string | null;
  request_id: string;
  occurred_at: Date;
};

type RollExportRow = {
  id: string;
  character_id: string;
  actor_id: string;
  action_id: string;
  audience: string;
  expression: string;
  dice_json: unknown;
  bindings_json: unknown;
  total: number;
  rendered_output: string;
  occurred_at: Date;
};

function toCampaignRecord(row: CampaignRow): CampaignRecord {
  if (row.status !== "active" && row.status !== "archived") {
    throw new Error(`Unknown campaign status: ${row.status}`);
  }
  if (
    row.roll_audience_default !== "owner_only" &&
    row.roll_audience_default !== "gm_only" &&
    row.roll_audience_default !== "campaign"
  ) {
    throw new Error(`Unknown roll audience default: ${row.roll_audience_default}`);
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
    rollAudienceDefault: row.roll_audience_default,
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
  "id, owner_id, system_version_id, title, description, status, revision, access_revision, archived_at, created_at, updated_at, roll_audience_default";
const MEMBERSHIP_COLUMNS = "campaign_id, user_id, role, status, generation, created_at, updated_at";
const CONTENT_COLUMNS =
  "id, campaign_id, creator_id, audience, title, body, tags, revision, access_revision, status, deleted_at, created_at, updated_at";
const ACTIVITY_COLUMNS = "id, campaign_id, actor_id, kind, source_content_id, source_roll_id, request_id, occurred_at";

function toContentRecord(row: ContentRow): ContentRecord {
  if (
    row.audience !== "gm_only" &&
    row.audience !== "all_players" &&
    row.audience !== "selected_players" &&
    row.audience !== "owner_only"
  ) {
    throw new Error(`Unknown content audience: ${row.audience}`);
  }
  if (row.status !== "active" && row.status !== "deleted") {
    throw new Error(`Unknown content status: ${row.status}`);
  }
  return {
    contentId: row.id,
    campaignId: row.campaign_id,
    creatorId: row.creator_id,
    audience: row.audience,
    title: row.title,
    body: row.body,
    tags: [...row.tags],
    revision: row.revision,
    accessRevision: row.access_revision,
    status: row.status,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toActivityEventRecord(row: ActivityEventRow): ActivityEventRecord {
  switch (row.kind) {
    case "content_created":
    case "content_updated":
    case "content_deleted":
    case "content_recovered":
    case "content_grants_replaced":
    case "roll_executed":
      break;
    default:
      throw new Error(`Unknown activity kind: ${row.kind}`);
  }
  return {
    eventId: row.id,
    campaignId: row.campaign_id,
    actorId: row.actor_id,
    kind: row.kind,
    sourceContentId: row.source_content_id,
    sourceRollId: row.source_roll_id,
    requestId: row.request_id,
    occurredAt: row.occurred_at,
  };
}

function toRollExportRecord(row: RollExportRow): RollExportRecord {
  if (row.audience !== "owner_only" && row.audience !== "gm_only" && row.audience !== "campaign") {
    throw new Error(`Unknown roll audience: ${row.audience}`);
  }
  return {
    rollId: row.id,
    characterId: row.character_id,
    actorId: row.actor_id,
    actionId: row.action_id,
    audience: row.audience,
    expression: row.expression,
    dice: row.dice_json,
    bindings: row.bindings_json,
    total: row.total,
    output: row.rendered_output,
    occurredAt: row.occurred_at,
  };
}

/**
 * Current-state content visibility predicate for the aliased content table
 * `c`. Never paginate-then-filter: every list/export query applies this in
 * SQL. $1 is the actor ID, $2 the GM flag.
 */
const CONTENT_VISIBILITY_PREDICATE = `(
  c.audience = 'all_players'
  OR ($2::boolean AND c.audience IN ('gm_only', 'selected_players'))
  OR (c.audience = 'selected_players' AND EXISTS (
    SELECT 1 FROM campaign_content_grants g
     WHERE g.content_id = c.id AND g.user_id = $1
  ))
  OR (c.audience = 'owner_only' AND c.creator_id = $1)
)`;

/**
 * I6 Task 8: current-state roll visibility predicate for the aliased roll
 * table `r`, mirroring `canReadRoll` in policy.ts. $1 is the actor ID, $2
 * the GM flag. Private rolls belong to the rolling actor only (no GM
 * override); `gm_only` admits the roller plus current GMs; `campaign`
 * admits every active member (callers already require active membership).
 */
const ROLL_VISIBILITY_PREDICATE = `(
  r.audience = 'campaign'
  OR (r.audience = 'gm_only' AND ($2::boolean OR r.actor_id = $1))
  OR (r.audience = 'owner_only' AND r.actor_id = $1)
)`;
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

    /**
     * I6 Task 9: attached-character page for `GET /campaigns/{id}/characters`.
     * Authorization precedes pagination in SQL: GMs read every attached
     * sheet, players only sheets they control. $1 is the actor ID, $2 the
     * GM flag. Controllers ride along as an ordered array so the roster
     * read stays a single bounded query.
     */
    async listAttachedCharactersPage(
      client: DbClient,
      input: {
        campaignId: string;
        actorId: string;
        isGm: boolean;
        limit: number;
        cursorCreatedAt: string | null;
        cursorId: string | null;
      },
    ): Promise<AttachedCharacterRecord[]> {
      const params: unknown[] = [input.actorId, input.isGm, input.campaignId];
      let cursorClause = "";
      if (input.cursorCreatedAt !== null && input.cursorId !== null) {
        params.push(input.cursorCreatedAt, input.cursorId);
        cursorClause = `AND (ch.created_at < $4::timestamptz OR (ch.created_at = $4::timestamptz AND ch.id < $5))`;
      }
      params.push(input.limit + 1);
      const result = await client.query<{
        id: string;
        campaign_id: string;
        name: string;
        entity_definition_id: string;
        system_version_id: string;
        revision: number;
        lifecycle: string;
        placement_generation: number;
        controllers: string[];
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT ch.id, ch.campaign_id, ch.name, ch.entity_definition_id, ch.system_version_id,
                ch.revision, ch.lifecycle, ch.placement_generation,
                ARRAY(SELECT cc.user_id FROM character_controllers cc
                       WHERE cc.character_id = ch.id ORDER BY cc.user_id) AS controllers,
                ch.created_at, ch.updated_at
           FROM characters ch
          WHERE ch.campaign_id = $3
            AND ($2::boolean OR EXISTS (
              SELECT 1 FROM character_controllers cc
               WHERE cc.character_id = ch.id AND cc.user_id = $1
            ))
            ${cursorClause}
          ORDER BY ch.created_at DESC, ch.id DESC
          LIMIT $${params.length}`,
        params,
      );
      return result.rows.map((row) => {
        if (row.lifecycle !== "active" && row.lifecycle !== "archived") {
          throw new Error(`Unknown character lifecycle: ${row.lifecycle}`);
        }
        return {
          characterId: row.id,
          campaignId: row.campaign_id,
          name: row.name,
          entityDefinitionId: row.entity_definition_id,
          systemVersionId: row.system_version_id,
          revision: row.revision,
          lifecycle: row.lifecycle,
          placementGeneration: row.placement_generation,
          controllers: row.controllers,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
      });
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

    async insertContent(
      client: PoolClient,
      input: {
        contentId: string;
        campaignId: string;
        creatorId: string;
        audience: ContentAudience;
        title: string;
        body: string;
        tags: string[];
        now: Date;
      },
    ): Promise<ContentRecord> {
      const result = await client.query<ContentRow>(
        `INSERT INTO campaign_content_items
            (id, campaign_id, creator_id, audience, title, body, tags, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $8::timestamptz)
          RETURNING ${CONTENT_COLUMNS}`,
        [
          input.contentId,
          input.campaignId,
          input.creatorId,
          input.audience,
          input.title,
          input.body,
          input.tags,
          input.now.toISOString(),
        ],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("insertContent returned no row");
      return toContentRecord(row);
    },

    async loadContent(client: DbClient, contentId: string): Promise<ContentRecord | null> {
      const result = await client.query<ContentRow>(
        `SELECT ${CONTENT_COLUMNS} FROM campaign_content_items WHERE id = $1`,
        [contentId],
      );
      const row = result.rows[0];
      return row === undefined ? null : toContentRecord(row);
    },

    async lockContent(client: PoolClient, contentId: string): Promise<ContentRecord | null> {
      const result = await client.query<ContentRow>(
        `SELECT ${CONTENT_COLUMNS} FROM campaign_content_items WHERE id = $1 FOR UPDATE`,
        [contentId],
      );
      const row = result.rows[0];
      return row === undefined ? null : toContentRecord(row);
    },

    /**
     * Revision-checked content patch. Null fields keep their values. Bumps
     * revision always; access_revision only when the audience changed (or
     * when forced for delete/recover, which hide or restore rows).
     */
    async updateContent(
      client: PoolClient,
      input: {
        contentId: string;
        title: string | null;
        body: string | null;
        tags: string[] | null;
        audience: ContentAudience | null;
        bumpAccess: boolean;
        expectedRevision: number;
        now: Date;
      },
    ): Promise<ContentRecord | null> {
      const result = await client.query<ContentRow>(
        `UPDATE campaign_content_items
            SET title = COALESCE($2, title),
                body = COALESCE($3, body),
                tags = COALESCE($4, tags),
                audience = COALESCE($5, audience),
                revision = revision + 1,
                access_revision = access_revision + CASE WHEN $6::boolean THEN 1 ELSE 0 END,
                updated_at = $7::timestamptz
          WHERE id = $1 AND revision = $8
          RETURNING ${CONTENT_COLUMNS}`,
        [
          input.contentId,
          input.title,
          input.body,
          input.tags,
          input.audience,
          input.bumpAccess,
          input.now.toISOString(),
          input.expectedRevision,
        ],
      );
      const row = result.rows[0];
      return row === undefined ? null : toContentRecord(row);
    },

    async setContentStatus(
      client: PoolClient,
      input: { contentId: string; status: ContentStatus; expectedRevision: number; now: Date },
    ): Promise<ContentRecord | null> {
      const result = await client.query<ContentRow>(
        `UPDATE campaign_content_items
            SET status = $2,
                deleted_at = CASE WHEN $2 = 'deleted' THEN $3::timestamptz ELSE NULL END,
                revision = revision + 1,
                access_revision = access_revision + 1,
                updated_at = $3::timestamptz
          WHERE id = $1 AND revision = $4
          RETURNING ${CONTENT_COLUMNS}`,
        [input.contentId, input.status, input.now.toISOString(), input.expectedRevision],
      );
      const row = result.rows[0];
      return row === undefined ? null : toContentRecord(row);
    },

    /**
     * Atomic grant replacement: clears every grant, inserts the new set
     * (none when empty), and increments content revision and authorization
     * generation together. Revision-checked so a concurrent patch conflicts.
     */
    async replaceContentGrants(
      client: PoolClient,
      input: {
        contentId: string;
        campaignId: string;
        userIds: string[];
        expectedRevision: number;
        now: Date;
      },
    ): Promise<ContentRecord | null> {
      await client.query(`DELETE FROM campaign_content_grants WHERE content_id = $1`, [input.contentId]);
      for (const userId of [...input.userIds].sort()) {
        await client.query(
          `INSERT INTO campaign_content_grants (content_id, campaign_id, user_id)
           VALUES ($1, $2, $3)`,
          [input.contentId, input.campaignId, userId],
        );
      }
      const result = await client.query<ContentRow>(
        `UPDATE campaign_content_items
            SET revision = revision + 1,
                access_revision = access_revision + 1,
                updated_at = $2::timestamptz
          WHERE id = $1 AND revision = $3
          RETURNING ${CONTENT_COLUMNS}`,
        [input.contentId, input.now.toISOString(), input.expectedRevision],
      );
      const row = result.rows[0];
      return row === undefined ? null : toContentRecord(row);
    },

    async loadContentGrantUserIds(client: DbClient, contentId: string): Promise<string[]> {
      const result = await client.query<{ user_id: string }>(
        `SELECT user_id FROM campaign_content_grants WHERE content_id = $1 ORDER BY user_id`,
        [contentId],
      );
      return result.rows.map(({ user_id }) => user_id);
    },

    /**
     * Active, currently-visible content page. Authorization precedes
     * pagination: the visibility predicate is part of the query, so
     * unauthorized rows never affect counts or cursors.
     */
    async listContentPage(
      client: DbClient,
      input: {
        campaignId: string;
        actorId: string;
        isGm: boolean;
        limit: number;
        cursorCreatedAt: string | null;
        cursorId: string | null;
      },
    ): Promise<ContentRecord[]> {
      const params: unknown[] = [input.actorId, input.isGm, input.campaignId];
      let cursorClause = "";
      if (input.cursorCreatedAt !== null && input.cursorId !== null) {
        params.push(input.cursorCreatedAt, input.cursorId);
        cursorClause = `AND (c.created_at < $4::timestamptz OR (c.created_at = $4::timestamptz AND c.id < $5))`;
      }
      params.push(input.limit + 1);
      const result = await client.query<ContentRow>(
        `SELECT ${CONTENT_COLUMNS.split(", ").map((column) => `c.${column}`).join(", ")}
           FROM campaign_content_items c
          WHERE c.campaign_id = $3 AND c.status = 'active' AND ${CONTENT_VISIBILITY_PREDICATE}
            ${cursorClause}
          ORDER BY c.created_at DESC, c.id DESC
          LIMIT $${params.length}`,
        params,
      );
      return result.rows.map(toContentRecord);
    },

    /**
     * Departure cleanup: destroys every grant naming the departing member in
     * this campaign. Rejoin mints a new membership generation and never
     * reactivates these rows (they are gone, not flagged).
     */
    async deleteContentGrantsForMember(
      client: PoolClient,
      input: { campaignId: string; userId: string },
    ): Promise<number> {
      const result = await client.query(
        `DELETE FROM campaign_content_grants WHERE campaign_id = $1 AND user_id = $2`,
        [input.campaignId, input.userId],
      );
      return result.rowCount ?? 0;
    },

    async appendActivity(
      client: PoolClient,
      input: {
        eventId: string;
        campaignId: string;
        actorId: string;
        kind: ActivityEventKind;
        sourceContentId: string | null;
        /** Roll source for `roll_executed` events; NULL otherwise. */
        sourceRollId?: string | null;
        requestId: string;
        occurredAt: Date;
      },
    ): Promise<ActivityEventRecord> {
      const result = await client.query<ActivityEventRow>(
        `INSERT INTO campaign_activity_events
            (id, campaign_id, actor_id, kind, source_content_id, source_roll_id, request_id, occurred_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
          RETURNING ${ACTIVITY_COLUMNS}`,
        [
          input.eventId,
          input.campaignId,
          input.actorId,
          input.kind,
          input.sourceContentId,
          input.sourceRollId ?? null,
          input.requestId,
          input.occurredAt.toISOString(),
        ],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("appendActivity returned no row");
      return toActivityEventRecord(row);
    },

    /**
     * Source-policy-filtered activity page: events whose current source
     * state the caller can no longer read (grant removed, note deleted or
     * narrowed, or a roll outside the reader's audience) are excluded in SQL
     * before pagination. Request IDs only correlate events; several rows may
     * share one.
     */
    async listActivityPage(
      client: DbClient,
      input: {
        campaignId: string;
        actorId: string;
        isGm: boolean;
        limit: number;
        cursorOccurredAt: string | null;
        cursorId: string | null;
      },
    ): Promise<ActivityEventRecord[]> {
      const params: unknown[] = [input.actorId, input.isGm, input.campaignId];
      let cursorClause = "";
      if (input.cursorOccurredAt !== null && input.cursorId !== null) {
        params.push(input.cursorOccurredAt, input.cursorId);
        cursorClause = `AND (e.occurred_at < $4::timestamptz OR (e.occurred_at = $4::timestamptz AND e.id < $5))`;
      }
      params.push(input.limit + 1);
      const result = await client.query<ActivityEventRow>(
        `SELECT ${ACTIVITY_COLUMNS.split(", ").map((column) => `e.${column}`).join(", ")}
           FROM campaign_activity_events e
           LEFT JOIN campaign_content_items c ON c.id = e.source_content_id
           LEFT JOIN character_rolls r ON r.id = e.source_roll_id
          WHERE e.campaign_id = $3
            AND (c.id IS NULL OR (c.status = 'active' AND ${CONTENT_VISIBILITY_PREDICATE}))
            AND (r.id IS NULL OR ${ROLL_VISIBILITY_PREDICATE})
            ${cursorClause}
          ORDER BY e.occurred_at DESC, e.id DESC
          LIMIT $${params.length}`,
        params,
      );
      return result.rows.map(toActivityEventRecord);
    },

    /** Full roster (any status) for the export projection, ordered by user. */
    async loadMembershipsForExport(client: DbClient, campaignId: string): Promise<MembershipRecord[]> {
      const result = await client.query<MembershipRow>(
        `SELECT ${MEMBERSHIP_COLUMNS}
           FROM campaign_members
          WHERE campaign_id = $1
          ORDER BY user_id`,
        [campaignId],
      );
      return result.rows.map(toMembershipRecord);
    },

    /**
     * Visible content for the export projection in deterministic ID order.
     * Bounded: pass exportMaxRecords + 1 and treat overflow as too large.
     */
    async loadVisibleContentForExport(
      client: DbClient,
      input: { campaignId: string; actorId: string; isGm: boolean; limit: number },
    ): Promise<ContentRecord[]> {
      const result = await client.query<ContentRow>(
        `SELECT ${CONTENT_COLUMNS.split(", ").map((column) => `c.${column}`).join(", ")}
           FROM campaign_content_items c
          WHERE c.campaign_id = $3 AND c.status = 'active' AND ${CONTENT_VISIBILITY_PREDICATE}
          ORDER BY c.id
          LIMIT $4`,
        [input.actorId, input.isGm, input.campaignId, input.limit],
      );
      return result.rows.map(toContentRecord);
    },

    async loadVisibleActivityForExport(
      client: DbClient,
      input: { campaignId: string; actorId: string; isGm: boolean; limit: number },
    ): Promise<ActivityEventRecord[]> {
      const result = await client.query<ActivityEventRow>(
        `SELECT ${ACTIVITY_COLUMNS.split(", ").map((column) => `e.${column}`).join(", ")}
           FROM campaign_activity_events e
           LEFT JOIN campaign_content_items c ON c.id = e.source_content_id
           LEFT JOIN character_rolls r ON r.id = e.source_roll_id
          WHERE e.campaign_id = $3
            AND (c.id IS NULL OR (c.status = 'active' AND ${CONTENT_VISIBILITY_PREDICATE}))
            AND (r.id IS NULL OR ${ROLL_VISIBILITY_PREDICATE})
          ORDER BY e.occurred_at, e.id
          LIMIT $4`,
        [input.actorId, input.isGm, input.campaignId, input.limit],
      );
      return result.rows.map(toActivityEventRecord);
    },

    /**
     * I6 Task 8: visible campaign rolls for the export projection in
     * deterministic ID order, using the same source policy as activity
     * (no unrestricted export query). Rolls are pinned to their ORIGINAL
     * campaign scope, so a returned character never breaks authorization of
     * its historical rolls. Bounded: pass exportMaxRecords + 1 and treat
     * overflow as too large.
     */
    async loadVisibleRollsForExport(
      client: DbClient,
      input: { campaignId: string; actorId: string; isGm: boolean; limit: number },
    ): Promise<RollExportRecord[]> {
      const result = await client.query<RollExportRow>(
        `SELECT r.id, r.character_id, r.actor_id, r.action_id, r.audience,
                r.expression, r.dice_json, r.bindings_json, r.total, r.rendered_output, r.occurred_at
           FROM character_rolls r
          WHERE r.scope_campaign_id = $3 AND ${ROLL_VISIBILITY_PREDICATE}
          ORDER BY r.id
          LIMIT $4`,
        [input.actorId, input.isGm, input.campaignId, input.limit],
      );
      return result.rows.map(toRollExportRecord);
    },

    async loadGrantsForContents(
      client: DbClient,
      contentIds: string[],
    ): Promise<Map<string, string[]>> {
      const grants = new Map<string, string[]>();
      if (contentIds.length === 0) return grants;
      const result = await client.query<{ content_id: string; user_id: string }>(
        `SELECT content_id, user_id FROM campaign_content_grants
          WHERE content_id = ANY($1) ORDER BY content_id, user_id`,
        [contentIds],
      );
      for (const row of result.rows) {
        const list = grants.get(row.content_id) ?? [];
        list.push(row.user_id);
        grants.set(row.content_id, list);
      }
      return grants;
    },
  };
}

export type CampaignPersistenceRepository = ReturnType<typeof createCampaignPersistenceRepository>;
