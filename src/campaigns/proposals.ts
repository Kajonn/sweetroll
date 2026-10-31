import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { CampaignError, CampaignResult } from "./index.js";
import type { RequestContext } from "../systems/authoring.js";
import { hashInput } from "../systems/implementation/authoring/assess.js";
import { createCampaignPersistenceRepository } from "./persistence.js";
import type { CampaignRecord, MembershipRecord } from "./persistence.js";
import { isActiveMember, isGameMaster } from "./policy.js";
import { createTemplateRepository } from "./templatePersistence.js";
import {
  publishBlankTemplate,
  validateBlankTemplateContent,
  type CampaignTemplateView,
  type TemplateContent,
} from "./templates.js";
import {
  createProposalRepository,
  type ProposalRecord,
} from "./proposalPersistence.js";
export type ProposalContent = Omit<TemplateContent, "base" | "defaultValues">;
export type ProposalStatus = "pending" | "approved" | "rejected";
export type ProposalView = {
  proposalId: string;
  campaignId: string;
  submitterId: string;
  kind: CampaignTemplateView["kind"];
  content: ProposalContent;
  status: ProposalStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  decision: {
    actorId: string;
    decidedAt: string;
    reason: string | null;
  } | null;
  approvedTemplateId: string | null;
  eligibility?: {
    canApprove: boolean;
    reason:
      | "already_decided"
      | "campaign_archived"
      | "submitter_inactive"
      | "catalog_full"
      | null;
  };
};
export type ProposalLocation = { campaignId: string; proposalId: string };
export type SubmitProposal = {
  campaignId: string;
  kind: ProposalView["kind"];
  content: ProposalContent;
  expectedProposalRevision: number;
  idempotencyKey: string;
};
export type DecideProposal = ProposalLocation & {
  expectedProposalRevision: number;
  idempotencyKey: string;
  reason?: string;
};
export type ListProposals = {
  campaignId: string;
  status?: ProposalStatus;
  limit?: number;
  cursor?: string | null;
};
export type ProposalPage = {
  proposals: ProposalView[];
  nextCursor: string | null;
};
export type ProposalDecision = {
  proposal: ProposalView;
  template?: CampaignTemplateView;
};
export function proposalView(record: ProposalRecord): ProposalView {
  const { membershipGeneration: _generation, ...view } = record;
  return view;
}
class ProposalFailure extends Error {
  constructor(readonly error: CampaignError) {
    super(error.message);
  }
}
function fail(code: CampaignError["code"], message: string): never {
  throw new ProposalFailure({ code, message });
}
export function createProposalCommands(input: {
  pool: Pool;
  now?: () => Date;
  newId?: () => string;
}) {
  const repo = createCampaignPersistenceRepository(input.pool);
  const proposals = createProposalRepository();
  const catalog = createTemplateRepository(input.pool);
  const now = input.now ?? (() => new Date());
  const newId = input.newId ?? randomUUID;
  async function transaction<T>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<CampaignResult<T>> {
    const client = await input.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await work(client);
      await client.query("COMMIT");
      return { ok: true, value };
    } catch (error) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        error:
          error instanceof ProposalFailure
            ? error.error
            : { code: "internal", message: "An internal error occurred." },
      };
    } finally {
      client.release();
    }
  }
  async function authorize(
    client: PoolClient,
    ctx: RequestContext,
    campaignId: string,
    mode: "read" | "submit" | "decide",
  ) {
    const campaign = await repo.lockCampaign(client, campaignId);
    const member = campaign
      ? await repo.loadMembership(client, campaignId, ctx.actorId)
      : null;
    if (!campaign || !isActiveMember(member))
      fail("not_found", "The requested campaign does not exist.");
    if (mode === "submit" && member.role !== "player")
      fail("forbidden", "Only players can suggest templates.");
    if (mode === "decide" && !isGameMaster(member))
      fail("forbidden", "Only a GM or co-GM can review suggestions.");
    if (mode !== "read" && campaign.status !== "active")
      fail("conflict", "Recover the campaign before changing suggestions.");
    return { campaign, member };
  }
  async function readable(
    client: PoolClient,
    ctx: RequestContext,
    body: ProposalLocation,
    member: MembershipRecord,
  ) {
    const p = await proposals.read(client, body);
    if (
      !p ||
      (!isGameMaster(member) &&
        (p.submitterId !== ctx.actorId ||
          p.membershipGeneration !== member.generation))
    )
      fail("not_found", "The requested suggestion does not exist.");
    return p;
  }
  async function view(
    client: PoolClient,
    p: ProposalRecord,
    campaign: CampaignRecord,
    member: MembershipRecord,
  ): Promise<ProposalView> {
    const result = proposalView(p);
    if (isGameMaster(member)) {
      const submitter = await repo.loadMembership(
        client,
        p.campaignId,
        p.submitterId,
      );
      const reason =
        p.status !== "pending"
          ? "already_decided"
          : campaign.status !== "active"
            ? "campaign_archived"
            : !isActiveMember(submitter) ||
                submitter.generation !== p.membershipGeneration
              ? "submitter_inactive"
              : (await catalog.count(client, p.campaignId)) >= 500
                ? "catalog_full"
                : null;
      result.eligibility = { canApprove: reason === null, reason };
    }
    return result;
  }
  function strictBody(body: object, allowed: string[]) {
    if (Object.keys(body).some((k) => !allowed.includes(k)))
      fail("bad_request", "Unknown suggestion input.");
  }
  async function receipt(
    client: PoolClient,
    ctx: RequestContext,
    body: SubmitProposal | DecideProposal,
    operation: string,
    member: MembershipRecord,
  ) {
    if (
      typeof body.idempotencyKey !== "string" ||
      !body.idempotencyKey.length ||
      body.idempotencyKey.length > 200
    )
      fail("bad_request", "An idempotency key is required.");
    const key = {
      actorId: ctx.actorId,
      commandKind: `campaign_proposal_${operation}`,
      idempotencyKey: body.idempotencyKey,
    };
    const inputHash = hashInput(body);
    const r = await repo.loadReceiptWithExpiry(client, key);
    if (r) {
      // Do not reveal a former membership's successful submission after rejoining.
      const saved = r.resultJson as {
        membershipGeneration: number;
        value: ProposalDecision;
      };
      if (
        operation === "submit" &&
        saved.membershipGeneration !== member.generation
      )
        fail("not_found", "The requested suggestion does not exist.");
      if (r.campaignId !== body.campaignId || r.inputHash !== inputHash)
        fail(
          "idempotency_mismatch",
          "This idempotency key was already used with different input.",
        );
      if (r.expiresAt <= now())
        fail("result_unavailable", "The saved result has expired.");
      return { key, inputHash, saved: saved.value };
    }
    return { key, inputHash, saved: null };
  }
  async function store(
    client: PoolClient,
    ctx: RequestContext,
    body: SubmitProposal | DecideProposal,
    operation: string,
    member: MembershipRecord,
    value: ProposalDecision,
    key: { actorId: string; commandKind: string; idempotencyKey: string },
    inputHash: string,
  ) {
    await repo.appendAudit(client, {
      campaignId: body.campaignId,
      actorId: ctx.actorId,
      kind: `proposal_${operation}`,
      summary: "Campaign suggestion changed",
      requestId: ctx.requestId,
    });
    const inserted = await repo.tryInsertReceipt(client, {
      ...key,
      inputHash,
      campaignId: body.campaignId,
      resultJson: { membershipGeneration: member.generation, value },
      expiresAt: new Date(now().getTime() + 30 * 86400000),
    });
    if (!inserted)
      fail(
        "idempotency_mismatch",
        "This idempotency key was already used in another campaign.",
      );
    return value;
  }
  async function decide(
    ctx: RequestContext,
    body: DecideProposal,
    operation: "approve" | "reject",
  ): Promise<CampaignResult<ProposalDecision>> {
    return transaction(async (client) => {
      strictBody(body, [
        "campaignId",
        "proposalId",
        "expectedProposalRevision",
        "idempotencyKey",
        ...(operation === "reject" ? ["reason"] : []),
      ]);
      const { campaign, member } = await authorize(
        client,
        ctx,
        body.campaignId,
        "decide",
      );
      const r = await receipt(client, ctx, body, operation, member);
      if (r.saved)
        return {
          ...r.saved,
          proposal: await view(
            client,
            await readable(client, ctx, body, member),
            campaign,
            member,
          ),
        };
      if (
        !Number.isSafeInteger(body.expectedProposalRevision) ||
        body.expectedProposalRevision < 1 ||
        (body.reason !== undefined &&
          (typeof body.reason !== "string" || body.reason.length > 2000))
      )
        fail("bad_request", "Invalid suggestion decision.");
      const p = await readable(client, ctx, body, member);
      if (
        p.status !== "pending" ||
        p.revision !== body.expectedProposalRevision
      )
        fail(
          "conflict",
          "The suggestion changed. Refresh and explicitly review before retrying.",
        );
      let template: CampaignTemplateView | undefined;
      if (operation === "approve") {
        const submitter = await repo.loadMembership(
          client,
          p.campaignId,
          p.submitterId,
        );
        if (
          !isActiveMember(submitter) ||
          submitter.generation !== p.membershipGeneration
        )
          fail(
            "conflict",
            "The submitter is no longer in the original membership.",
          );
        template = await publishBlankTemplate(
          client,
          catalog,
          {
            templateId: newId(),
            campaignId: p.campaignId,
            creatorId: ctx.actorId,
            kind: p.kind,
            content: p.content,
          },
          fail,
        );
      }
      const updated = await proposals.decide(client, p, {
        actorId: ctx.actorId,
        status: operation === "approve" ? "approved" : "rejected",
        reason: operation === "reject" ? (body.reason ?? null) : null,
        templateId: template?.templateId ?? null,
      });
      if (template)
        await repo.appendActivity(client, {
          eventId: newId(),
          campaignId: p.campaignId,
          actorId: ctx.actorId,
          kind: "template_create",
          sourceContentId: null,
          requestId: ctx.requestId,
          occurredAt: now(),
        });
      const result: ProposalDecision = {
        proposal: await view(client, updated, campaign, member),
        ...(template ? { template } : {}),
      };
      return store(
        client,
        ctx,
        body,
        operation,
        member,
        result,
        r.key,
        r.inputHash,
      );
    });
  }
  return {
    submitProposal: (
      ctx: RequestContext,
      body: SubmitProposal,
    ): Promise<CampaignResult<ProposalDecision>> =>
      transaction(async (client) => {
        strictBody(body, [
          "campaignId",
          "kind",
          "content",
          "expectedProposalRevision",
          "idempotencyKey",
        ]);
        const { member } = await authorize(
          client,
          ctx,
          body.campaignId,
          "submit",
        );
        const r = await receipt(client, ctx, body, "submit", member);
        if (r.saved) return r.saved;
        if (body.expectedProposalRevision !== 0)
          fail("bad_request", "A new suggestion must expect revision zero.");
        const invalid = validateBlankTemplateContent(body.kind, body.content);
        if (invalid) fail("bad_request", invalid);
        const counts = await proposals.count(
          client,
          body.campaignId,
          ctx.actorId,
          member.generation,
        );
        if (counts.total >= 500 || counts.pending >= 20)
          fail(
            "too_large",
            "Suggestion limit reached (500 per campaign, 20 pending per membership).",
          );
        const p = await proposals.create(client, {
          ...body,
          proposalId: newId(),
          submitterId: ctx.actorId,
          membershipGeneration: member.generation,
        });
        const result = { proposal: proposalView(p) };
        return store(
          client,
          ctx,
          body,
          "submit",
          member,
          result,
          r.key,
          r.inputHash,
        );
      }),
    openProposal: (
      ctx: RequestContext,
      body: ProposalLocation,
    ): Promise<CampaignResult<ProposalView>> =>
      transaction(async (client) => {
        const { campaign, member } = await authorize(
          client,
          ctx,
          body.campaignId,
          "read",
        );
        return view(
          client,
          await readable(client, ctx, body, member),
          campaign,
          member,
        );
      }),
    listProposals: (
      ctx: RequestContext,
      body: ListProposals,
    ): Promise<CampaignResult<ProposalPage>> =>
      transaction(async (client) => {
        const { campaign, member } = await authorize(
          client,
          ctx,
          body.campaignId,
          "read",
        );
        const limit = body.limit ?? 50;
        if (
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 100 ||
          (body.status !== undefined &&
            !["pending", "approved", "rejected"].includes(body.status))
        )
          fail("bad_request", "Invalid suggestion page.");
        const scope = hashInput({
          campaignId: body.campaignId,
          actorId: ctx.actorId,
          role: member.role,
          generation: member.generation,
          status: body.status ?? null,
          order: "id",
        });
        let anchor: string | null = null;
        if (body.cursor) {
          try {
            const c = JSON.parse(
              Buffer.from(body.cursor, "base64url").toString(),
            );
            if (
              c.scope !== scope ||
              typeof c.id !== "string" ||
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                c.id,
              )
            )
              throw Error();
            anchor = c.id;
          } catch {
            fail("bad_request", "Invalid suggestion cursor.");
          }
        }
        const rows = await proposals.list(client, {
          campaignId: body.campaignId,
          submitterId: isGameMaster(member) ? null : ctx.actorId,
          generation: member.generation,
          status: body.status ?? null,
          anchor,
          limit: limit + 1,
        });
        const visible = rows.slice(0, limit);
        const last = visible.at(-1);
        return {
          proposals: await Promise.all(
            visible.map((p) => view(client, p, campaign, member)),
          ),
          nextCursor:
            rows.length > limit && last
              ? Buffer.from(
                  JSON.stringify({ scope, id: last.proposalId }),
                ).toString("base64url")
              : null,
        };
      }),
    approveProposal: (ctx: RequestContext, body: DecideProposal) =>
      decide(ctx, body, "approve"),
    rejectProposal: (ctx: RequestContext, body: DecideProposal) =>
      decide(ctx, body, "reject"),
  };
}
export type ProposalCommands = ReturnType<typeof createProposalCommands>;
