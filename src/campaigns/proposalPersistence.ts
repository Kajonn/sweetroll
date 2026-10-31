import type { PoolClient } from "pg";
import type {
  ProposalView,
  ProposalLocation,
  ProposalStatus,
  SubmitProposal,
} from "./proposals.js";
export type ProposalRecord = Omit<ProposalView, "eligibility"> & {
  membershipGeneration: number;
};
const SELECT = `SELECT id AS "proposalId", campaign_id AS "campaignId", submitter_id AS "submitterId", membership_generation AS "membershipGeneration", kind, content_json AS content, status, revision, created_at AS "createdAt", updated_at AS "updatedAt", decision_actor_id AS "decisionActorId", decided_at AS "decidedAt", decision_reason AS "decisionReason", approved_template_id AS "approvedTemplateId" FROM campaign_item_proposals`;
type Row = Omit<ProposalRecord, "decision"> & {
  decisionActorId: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
};
function view(row: Row): ProposalRecord {
  const { decisionActorId, decidedAt, decisionReason, ...p } = row;
  return {
    ...p,
    createdAt: new Date(p.createdAt).toISOString(),
    updatedAt: new Date(p.updatedAt).toISOString(),
    decision:
      decisionActorId && decidedAt
        ? {
            actorId: decisionActorId,
            decidedAt: new Date(decidedAt).toISOString(),
            reason: decisionReason,
          }
        : null,
  };
}
export function createProposalRepository() {
  async function read(
    client: PoolClient,
    p: ProposalLocation,
  ): Promise<ProposalRecord | null> {
    const r = await client.query<Row>(
      `${SELECT} WHERE campaign_id=$1 AND id=$2`,
      [p.campaignId, p.proposalId],
    );
    return r.rows[0] ? view(r.rows[0]) : null;
  }
  return {
    read,
    async count(
      client: PoolClient,
      campaignId: string,
      submitterId: string,
      generation: number,
    ): Promise<{ total: number; pending: number }> {
      return (
        await client.query(
          `SELECT count(*)::int AS total,count(*) FILTER(WHERE submitter_id=$2 AND membership_generation=$3 AND status='pending')::int AS pending FROM campaign_item_proposals WHERE campaign_id=$1`,
          [campaignId, submitterId, generation],
        )
      ).rows[0];
    },
    async create(
      client: PoolClient,
      p: SubmitProposal & {
        proposalId: string;
        submitterId: string;
        membershipGeneration: number;
      },
    ): Promise<ProposalRecord> {
      await client.query(
        `INSERT INTO campaign_item_proposals(id,campaign_id,submitter_id,membership_generation,kind,content_json) VALUES($1,$2,$3,$4,$5,$6)`,
        [
          p.proposalId,
          p.campaignId,
          p.submitterId,
          p.membershipGeneration,
          p.kind,
          p.content,
        ],
      );
      return (await read(client, p))!;
    },
    async decide(
      client: PoolClient,
      p: ProposalRecord,
      d: {
        actorId: string;
        status: "approved" | "rejected";
        reason: string | null;
        templateId: string | null;
      },
    ): Promise<ProposalRecord> {
      await client.query(
        `UPDATE campaign_item_proposals SET status=$2,revision=2,decision_actor_id=$3,decided_at=now(),decision_reason=$4,approved_template_id=$5,updated_at=now() WHERE id=$1`,
        [p.proposalId, d.status, d.actorId, d.reason, d.templateId],
      );
      return (await read(client, p))!;
    },
    async list(
      client: PoolClient,
      p: {
        campaignId: string;
        submitterId: string | null;
        generation: number;
        status: ProposalStatus | null;
        anchor: string | null;
        limit: number;
      },
    ): Promise<ProposalRecord[]> {
      const r = await client.query<Row>(
        `${SELECT} WHERE campaign_id=$1 AND ($2::uuid IS NULL OR (submitter_id=$2 AND membership_generation=$3)) AND ($4::text IS NULL OR status=$4) AND ($5::uuid IS NULL OR id>$5) ORDER BY id LIMIT $6`,
        [
          p.campaignId,
          p.submitterId,
          p.generation,
          p.status,
          p.anchor,
          p.limit,
        ],
      );
      return r.rows.map(view);
    },
  };
}
