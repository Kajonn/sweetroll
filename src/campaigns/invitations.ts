import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type { RequestContext } from "../systems/authoring.js";
import { hashInput } from "../systems/implementation/authoring/assess.js";
import type { CampaignLimits } from "../platform/config.js";
import type {
  CampaignPersistenceRepository,
  InvitationRecord,
  MembershipRecord,
} from "./persistence.js";
import { isActiveMember, isGameMaster } from "./policy.js";
import type { CampaignError, CampaignResult, MemberView } from "./index.js";

export type InvitationId = string;

export type IssueInvitationInput = {
  campaignId: string;
  intendedRole: "player" | "co_gm";
  expiresAt?: string | Date;
  expectedCampaignRevision: number;
  idempotencyKey: string;
};

export type ListInvitationsInput = {
  campaignId: string;
  limit?: number;
  cursor?: string | null;
};

export type ReviewInvitationInput = {
  token: string;
};

export type ConsumeInvitationInput = {
  campaignId: string;
  token: string;
  expectedInvitationRevision: number;
  reviewedAccessRevision: number;
  idempotencyKey: string;
};

export type RotateInvitationInput = {
  campaignId: string;
  invitationId: InvitationId;
  expectedInvitationRevision: number;
  expectedCampaignRevision: number;
  expiresAt?: string | Date;
  idempotencyKey: string;
};

export type RevokeInvitationInput = {
  campaignId: string;
  invitationId: InvitationId;
  expectedInvitationRevision: number;
  expectedCampaignRevision: number;
  idempotencyKey: string;
};

export type InvitationMetadata = {
  invitationId: InvitationId;
  campaignId: string;
  intendedRole: "player" | "co_gm";
  status: "pending" | "accepted" | "declined" | "revoked";
  expiresAt: Date;
  invitationRevision: number;
  issuedBy: string;
};

/** Initial success carries the one-time plaintext token. */
export type InvitationIssueSuccess = InvitationMetadata & { token: string };
/** Same-key replay carries metadata only; no new token is minted. */
export type InvitationIssueReplay = InvitationMetadata & { tokenUnavailable: true };
export type InvitationRotateSuccess = InvitationMetadata & { token: string };
export type InvitationRotateReplay = InvitationMetadata & { tokenUnavailable: true };

export type InvitationReview = {
  invitationId: InvitationId;
  campaignId: string;
  campaignTitle: string;
  systemVersionId: string;
  inviterDisplayName: string;
  intendedRole: "player" | "co_gm";
  expiresAt: Date;
  invitationRevision: number;
  accessRevision: number;
};

export type InvitationAcceptSuccess = {
  invitationId: InvitationId;
  campaignId: string;
  membership: MemberView;
  membershipGeneration: number;
};

export type InvitationDeclineSuccess = {
  invitationId: InvitationId;
  campaignId: string;
  status: "declined";
};

export type InvitationListItem = {
  invitationId: InvitationId;
  intendedRole: "player" | "co_gm";
  status: "pending" | "accepted" | "declined" | "revoked";
  expiresAt: Date;
  invitationRevision: number;
  issuedBy: string;
  createdAt: Date;
};

export type ListInvitationsResult = {
  invitations: InvitationListItem[];
  nextCursor: string | null;
};

export interface InvitationCommands {
  issueInvitation(
    ctx: RequestContext,
    input: IssueInvitationInput,
  ): Promise<CampaignResult<InvitationIssueSuccess | InvitationIssueReplay>>;
  listInvitations(
    ctx: RequestContext,
    input: ListInvitationsInput,
  ): Promise<CampaignResult<ListInvitationsResult>>;
  reviewInvitation(
    ctx: RequestContext,
    input: ReviewInvitationInput,
  ): Promise<CampaignResult<InvitationReview>>;
  acceptInvitation(
    ctx: RequestContext,
    input: ConsumeInvitationInput,
  ): Promise<CampaignResult<InvitationAcceptSuccess>>;
  declineInvitation(
    ctx: RequestContext,
    input: ConsumeInvitationInput,
  ): Promise<CampaignResult<InvitationDeclineSuccess>>;
  rotateInvitation(
    ctx: RequestContext,
    input: RotateInvitationInput,
  ): Promise<CampaignResult<InvitationRotateSuccess | InvitationRotateReplay>>;
  revokeInvitation(
    ctx: RequestContext,
    input: RevokeInvitationInput,
  ): Promise<CampaignResult<InvitationMetadata>>;
}

export type InvitationRateLimit = {
  windowMs: number;
  maxAttempts: number;
};

export const DEFAULT_INVITATION_RATE_LIMIT: InvitationRateLimit = {
  windowMs: 60_000,
  maxAttempts: 60,
};

export type CreateInvitationCommandsInput = {
  pool: Pool;
  repo: CampaignPersistenceRepository;
  limits: CampaignLimits;
  now?: (() => Date) | undefined;
  newId?: (() => string) | undefined;
  newToken?: (() => string) | undefined;
  rateLimit?: InvitationRateLimit | undefined;
  /** Millisecond clock backing the adapter-level limiter (tests inject a fake). */
  rateNow?: (() => number) | undefined;
};

/** 256-bit server randomness, base64url-encoded. Decodes to 32 bytes. */
export function generateInvitationToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Only this SHA-256 hex digest ever persists; plaintext is never stored. */
export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Bounded adapter-level limiter (no HTTP rate-limit mechanism exists in this
 * slice). Per-key sliding windows with a cap on tracked keys; the oldest
 * bucket is evicted when the bound is exceeded.
 */
export function createInvitationRateLimiter(
  limit: InvitationRateLimit,
  input?: { now?: (() => number) | undefined; maxBuckets?: number | undefined },
): { check(key: string): boolean } {
  const now = input?.now ?? (() => Date.now());
  const maxBuckets = input?.maxBuckets ?? 5_000;
  const buckets = new Map<string, number[]>();
  return {
    check(key: string): boolean {
      const timestamp = now();
      let hits = buckets.get(key);
      if (hits === undefined) {
        hits = [];
        buckets.set(key, hits);
        if (buckets.size > maxBuckets) {
          const oldest = buckets.keys().next();
          if (!oldest.done) buckets.delete(oldest.value);
        }
      }
      while (hits.length > 0 && (hits[0] ?? 0) <= timestamp - limit.windowMs) {
        hits.shift();
      }
      if (hits.length >= limit.maxAttempts) return false;
      hits.push(timestamp);
      return true;
    },
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const RECEIPT_TTL_MS = 30 * DAY_MS;
const MAX_TOKEN_LENGTH = 512;

const ISSUE_KIND = "campaign_invitation_issue";
const ROTATE_KIND = "campaign_invitation_rotate";
const ACCEPT_KIND = "campaign_invitation_accept";
const DECLINE_KIND = "campaign_invitation_decline";
const REVOKE_KIND = "campaign_invitation_revoke";

/** Generic collapse: unknown/revoked/rotated/expired tokens are indistinguishable. */
const UNAVAILABLE_MESSAGE = "This invitation is unavailable.";
const MISMATCH_MESSAGE = "This idempotency key was already used with different input.";
const REREVIEW_MESSAGE = "The invitation or campaign changed since review. Review it again before consuming it.";

/**
 * Thrown inside a transaction when the idempotency receipt insert loses a
 * concurrent race after the mutation already ran. Rolling back keeps the
 * spurious row from committing; the caller then replays the winner.
 */
class ReceiptRace extends Error {
  constructor() {
    super("invitation idempotency receipt raced");
  }
}

export function createInvitationCommands(input: CreateInvitationCommandsInput): InvitationCommands {
  const repo = input.repo;
  const limits = input.limits;
  const now = input.now ?? (() => new Date());
  const newId = input.newId ?? (() => randomUUID());
  const newToken = input.newToken ?? generateInvitationToken;
  const limiter = createInvitationRateLimiter(input.rateLimit ?? DEFAULT_INVITATION_RATE_LIMIT, {
    now: input.rateNow,
  });

  const errors = {
    bad_request: (message: string): CampaignError => ({ code: "bad_request", message }),
    not_found: (message = "The requested campaign does not exist."): CampaignError => ({
      code: "not_found",
      message,
    }),
    unavailable: (): CampaignError => ({ code: "not_found", message: UNAVAILABLE_MESSAGE }),
    mismatch: (): CampaignError => ({ code: "idempotency_mismatch", message: MISMATCH_MESSAGE }),
    conflict: (message: string, latestRevision?: number | null): CampaignError => ({
      code: "conflict",
      message,
      ...(latestRevision === undefined ? {} : { latestRevision }),
    }),
    rate_limited: (): CampaignError => ({
      code: "rate_limited",
      message: "Too many invitation requests. Try again later.",
    }),
    result_unavailable: (): CampaignError => ({
      code: "result_unavailable",
      message: "The original result is no longer available.",
    }),
    internal: (): CampaignError => ({ code: "internal", message: "An internal error occurred." }),
  };

  function toMetadata(record: InvitationRecord): InvitationMetadata {
    return {
      invitationId: record.invitationId,
      campaignId: record.campaignId,
      intendedRole: record.intendedRole,
      status: record.status,
      expiresAt: record.expiresAt,
      invitationRevision: record.revision,
      issuedBy: record.issuedBy,
    };
  }

  function toMemberView(record: MembershipRecord): MemberView {
    return {
      campaignId: record.campaignId,
      userId: record.userId,
      role: record.role,
      status: record.status,
      generation: record.generation,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  function serializeMetadata(metadata: InvitationMetadata): unknown {
    return { ...metadata, expiresAt: metadata.expiresAt.toISOString() };
  }

  function deserializeMetadata(stored: unknown): InvitationMetadata {
    const raw = stored as Omit<InvitationMetadata, "expiresAt"> & { expiresAt: string };
    return { ...raw, expiresAt: new Date(raw.expiresAt) };
  }

  function serializeMember(view: MemberView): unknown {
    return {
      ...view,
      createdAt: view.createdAt.toISOString(),
      updatedAt: view.updatedAt.toISOString(),
    };
  }

  function deserializeMember(stored: unknown): MemberView {
    const raw = stored as Omit<MemberView, "createdAt" | "updatedAt"> & {
      createdAt: string;
      updatedAt: string;
    };
    return { ...raw, createdAt: new Date(raw.createdAt), updatedAt: new Date(raw.updatedAt) };
  }

  function checkIdempotencyKey(key: unknown): CampaignError | null {
    if (typeof key !== "string" || key.length === 0 || key.length > 256) {
      return errors.bad_request("idempotencyKey must be a non-empty string of at most 256 characters.");
    }
    return null;
  }

  function checkRevision(value: unknown, name: string): CampaignError | null {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      return errors.bad_request(`${name} must be a positive integer.`);
    }
    return null;
  }

  function checkLimit(limit: number | undefined): { limit: number } | { error: CampaignError } {
    const value = limit === undefined ? limits.pageDefault : limit;
    if (!Number.isInteger(value) || value < 1 || value > limits.pageMax) {
      return {
        error: errors.bad_request(`limit must be an integer from 1 through ${limits.pageMax}.`),
      };
    }
    return { limit: value };
  }

  function decodeCursor(
    raw: string | null | undefined,
    expectedScope: string,
  ): { cursor: { createdAt: string; id: string } | null } | { error: CampaignError } {
    if (raw === undefined || raw === null) return { cursor: null };
    try {
      const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
        createdAt?: unknown;
        id?: unknown;
        scope?: unknown;
      };
      if (
        typeof parsed.createdAt !== "string" ||
        typeof parsed.id !== "string" ||
        typeof parsed.scope !== "string" ||
        Number.isNaN(Date.parse(parsed.createdAt)) ||
        parsed.id.length === 0 ||
        parsed.scope !== expectedScope
      ) {
        return { error: errors.bad_request("cursor is not valid for this query.") };
      }
      return { cursor: { createdAt: parsed.createdAt, id: parsed.id } };
    } catch {
      return { error: errors.bad_request("cursor is malformed.") };
    }
  }

  function encodeCursor(createdAt: string, id: string, scope: string): string {
    return Buffer.from(JSON.stringify({ createdAt, id, scope }), "utf8").toString("base64url");
  }

  async function withClient<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await input.pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      try {
        const value = await work(client);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the original failure when rollback itself errors.
        }
        throw error;
      }
    } finally {
      client.release();
    }
  }

  async function withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await input.pool.connect();
    try {
      await client.query("BEGIN");
      try {
        const value = await work(client);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    } finally {
      client.release();
    }
  }

  function resolveExpiry(raw: string | Date | undefined): { expiresAt: Date } | { error: CampaignError } {
    const timestamp = now();
    if (raw === undefined) {
      return { expiresAt: new Date(timestamp.getTime() + limits.invitationExpiryDefaultDays * DAY_MS) };
    }
    const parsed = raw instanceof Date ? new Date(raw.getTime()) : new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      return { error: errors.bad_request("expiresAt must be a valid date.") };
    }
    if (parsed.getTime() <= timestamp.getTime()) {
      return { error: errors.bad_request("expiresAt must be in the future.") };
    }
    if (parsed.getTime() > timestamp.getTime() + limits.invitationExpiryMaxDays * DAY_MS) {
      return {
        error: errors.bad_request(
          `expiresAt must be within ${limits.invitationExpiryMaxDays} days.`,
        ),
      };
    }
    return { expiresAt: parsed };
  }

  function checkTokenShape(token: unknown): CampaignError | null {
    if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
      return errors.unavailable();
    }
    return null;
  }

  /**
   * Admin replay guard: the caller must still be an active GM. Consumed or
   * rotated invitations replay current metadata, never token bytes.
   */
  async function reauthorizeAdmin(ctx: RequestContext, campaignId: string): Promise<CampaignError | null> {
    return await withClient(async (client) => {
      const campaign = await repo.openCampaign(client, campaignId);
      const membership =
        campaign === null ? null : await repo.loadMembership(client, campaignId, ctx.actorId);
      if (campaign === null || !isActiveMember(membership) || !isGameMaster(membership)) {
        return errors.not_found();
      }
      return null;
    });
  }

  async function replayAdminMetadata(options: {
    ctx: RequestContext;
    inputHash: string;
    receipt: { inputHash: string; resultJson: unknown; expiresAt: Date } | null;
  }): Promise<CampaignResult<InvitationMetadata & { tokenUnavailable: true }>> {
    if (options.receipt === null) return { ok: false, error: errors.internal() };
    if (options.receipt.inputHash !== options.inputHash) return { ok: false, error: errors.mismatch() };
    if (options.receipt.expiresAt.getTime() <= now().getTime()) {
      return { ok: false, error: errors.result_unavailable() };
    }
    const stored = options.receipt.resultJson as { campaignId?: string; invitationId?: string; value?: unknown };
    if (typeof stored.campaignId !== "string") return { ok: false, error: errors.internal() };
    const denial = await reauthorizeAdmin(options.ctx, stored.campaignId);
    if (denial !== null) return { ok: false, error: denial };
    // Return live metadata: a rotation/consume/revoke after the original call
    // is reflected instead of a stale snapshot, still without token bytes.
    if (typeof stored.invitationId === "string") {
      const live = await repo.loadInvitation(input.pool, stored.invitationId);
      if (live !== null) return { ok: true, value: { ...toMetadata(live), tokenUnavailable: true as const } };
    }
    return { ok: true, value: { ...deserializeMetadata(stored.value), tokenUnavailable: true as const } };
  }

  return {
    async issueInvitation(ctx, issueInput) {
      try {
        const keyError = checkIdempotencyKey(issueInput.idempotencyKey);
        if (keyError !== null) return { ok: false, error: keyError };
        const revisionError = checkRevision(issueInput.expectedCampaignRevision, "expectedCampaignRevision");
        if (revisionError !== null) return { ok: false, error: revisionError };
        if (issueInput.intendedRole !== "player" && issueInput.intendedRole !== "co_gm") {
          return { ok: false, error: errors.bad_request("intendedRole must be player or co_gm.") };
        }
        if (!limiter.check(`issue:${ctx.actorId}`)) return { ok: false, error: errors.rate_limited() };
        const resolved = resolveExpiry(issueInput.expiresAt);
        if ("error" in resolved) return { ok: false, error: resolved.error };

        const inputHash = hashInput({
          campaignId: issueInput.campaignId,
          intendedRole: issueInput.intendedRole,
          // Hash the client-supplied expiry (null when absent): the resolved
          // default moves with the clock, so hashing it would turn an exact
          // retry into a spurious mismatch. The stored metadata keeps the
          // resolved instant.
          expiresAt:
            issueInput.expiresAt instanceof Date
              ? issueInput.expiresAt.toISOString()
              : (issueInput.expiresAt ?? null),
          expectedCampaignRevision: issueInput.expectedCampaignRevision,
        });
        const receiptKey = {
          actorId: ctx.actorId,
          commandKind: ISSUE_KIND,
          idempotencyKey: issueInput.idempotencyKey,
        };

        // Receipt-first: same-key replay returns metadata with
        // tokenUnavailable and never mints a second token.
        const preExisting = await repo.loadReceiptWithExpiry(input.pool, receiptKey);
        if (preExisting !== null) {
          return await replayAdminMetadata({ ctx, inputHash, receipt: preExisting });
        }

        const outcome = await withTransaction(async (client) => {
          const campaign = await repo.lockCampaign(client, issueInput.campaignId);
          const membership =
            campaign === null ? null : await repo.loadMembership(client, issueInput.campaignId, ctx.actorId);
          const raced = await repo.loadReceiptWithExpiry(client, receiptKey);
          if (raced !== null) {
            return { committed: false as const, receipt: raced };
          }
          if (campaign === null || !isActiveMember(membership) || !isGameMaster(membership)) {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          if (campaign.status !== "active") {
            return {
              committed: false as const,
              failure: errors.conflict("Archived campaigns cannot issue invitations.", campaign.revision),
            };
          }
          // Co-GMs manage player invitations only; elevated roles are
          // owner-only. Collapses like other owner_only denials.
          if (issueInput.intendedRole === "co_gm" && membership.role !== "owner") {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          if (campaign.revision !== issueInput.expectedCampaignRevision) {
            return {
              committed: false as const,
              failure: errors.conflict(
                "The campaign has a newer revision. Retry with the latest revision and a new idempotency key.",
                campaign.revision,
              ),
            };
          }
          const token = newToken();
          const record = await repo.insertInvitation(client, {
            invitationId: newId(),
            campaignId: campaign.campaignId,
            issuedBy: ctx.actorId,
            intendedRole: issueInput.intendedRole,
            tokenHash: hashInvitationToken(token),
            expiresAt: resolved.expiresAt,
          });
          const bumped = await repo.bumpCampaignRevisionForMembership(client, {
            campaignId: campaign.campaignId,
            expectedRevision: issueInput.expectedCampaignRevision,
            now: now(),
          });
          if (bumped === null) {
            return {
              committed: false as const,
              failure: errors.conflict(
                "The campaign has a newer revision. Retry with the latest revision and a new idempotency key.",
                campaign.revision,
              ),
            };
          }
          // Audit and receipt carry metadata only: no token bytes, no hash.
          await repo.appendAudit(client, {
            campaignId: campaign.campaignId,
            actorId: ctx.actorId,
            kind: "invitation_issued",
            summary: "Campaign invitation issued",
            requestId: ctx.requestId,
          });
          const metadata = toMetadata(record);
          const stored = {
            campaignId: campaign.campaignId,
            invitationId: record.invitationId,
            value: serializeMetadata(metadata),
            idempotencyKey: issueInput.idempotencyKey,
          };
          const inserted = await repo.tryInsertReceipt(client, {
            actorId: ctx.actorId,
            commandKind: ISSUE_KIND,
            idempotencyKey: issueInput.idempotencyKey,
            inputHash,
            campaignId: campaign.campaignId,
            resultJson: stored,
            expiresAt: new Date(now().getTime() + RECEIPT_TTL_MS),
          });
          if (!inserted) {
            throw new ReceiptRace();
          }
          return { committed: true as const, value: { ...metadata, token } };
        }).catch(async (error) => {
          if (error instanceof ReceiptRace) {
            const receipt = await repo.loadReceiptWithExpiry(input.pool, receiptKey);
            return { committed: false as const, receipt };
          }
          throw error;
        });

        if ("failure" in outcome) return { ok: false, error: outcome.failure };
        if (outcome.committed) return { ok: true, value: outcome.value };
        return await replayAdminMetadata({ ctx, inputHash, receipt: outcome.receipt ?? null });
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async listInvitations(ctx, listInput) {
      try {
        const checked = checkLimit(listInput.limit);
        if ("error" in checked) return { ok: false, error: checked.error };
        const scope = `inv:${listInput.campaignId}`;
        const decoded = decodeCursor(listInput.cursor, scope);
        if ("error" in decoded) return { ok: false, error: decoded.error };
        const outcome = await withClient(async (client) => {
          const campaign = await repo.openCampaign(client, listInput.campaignId);
          const membership =
            campaign === null ? null : await repo.loadMembership(client, listInput.campaignId, ctx.actorId);
          if (campaign === null || !isActiveMember(membership) || !isGameMaster(membership)) {
            return { authorized: false as const };
          }
          const rows = await repo.listInvitationsPage(client, listInput.campaignId, {
            limit: checked.limit,
            cursorCreatedAt: decoded.cursor?.createdAt ?? null,
            cursorId: decoded.cursor?.id ?? null,
          });
          return { authorized: true as const, rows };
        });
        if (!outcome.authorized) {
          return { ok: false, error: errors.not_found() };
        }
        const hasMore = outcome.rows.length > checked.limit;
        const page = hasMore ? outcome.rows.slice(0, checked.limit) : outcome.rows;
        const last = page[page.length - 1];
        return {
          ok: true,
          value: {
            invitations: page.map((record) => ({
              invitationId: record.invitationId,
              intendedRole: record.intendedRole,
              status: record.status,
              expiresAt: record.expiresAt,
              invitationRevision: record.revision,
              issuedBy: record.issuedBy,
              createdAt: record.createdAt,
            })),
            nextCursor:
              hasMore && last !== undefined
                ? encodeCursor(last.createdAt.toISOString(), last.invitationId, scope)
                : null,
          },
        };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async reviewInvitation(ctx, reviewInput) {
      try {
        const shapeError = checkTokenShape(reviewInput.token);
        if (shapeError !== null) return { ok: false, error: shapeError };
        if (!limiter.check(`review:${ctx.actorId}`)) return { ok: false, error: errors.rate_limited() };
        // Read-only: no idempotency key, no revision precondition. Only
        // campaign identity, inviter display name, role, expiry and the two
        // revisions needed for a later consume leave this method.
        const outcome = await withClient(async (client) => {
          const invitation = await repo.findInvitationByHash(client, hashInvitationToken(reviewInput.token));
          if (invitation === null) return { available: false as const };
          const campaign = await repo.openCampaign(client, invitation.campaignId);
          if (campaign === null) return { available: false as const };
          if (invitation.status !== "pending" || invitation.expiresAt.getTime() <= now().getTime()) {
            return { available: false as const };
          }
          if (campaign.status !== "active") return { available: false as const };
          const inviterDisplayName = await repo.loadUserDisplayName(client, invitation.issuedBy);
          return {
            available: true as const,
            value: {
              invitationId: invitation.invitationId,
              campaignId: campaign.campaignId,
              campaignTitle: campaign.title,
              systemVersionId: campaign.systemVersionId,
              inviterDisplayName: inviterDisplayName ?? "Unknown member",
              intendedRole: invitation.intendedRole,
              expiresAt: invitation.expiresAt,
              invitationRevision: invitation.revision,
              accessRevision: campaign.accessRevision,
            } satisfies InvitationReview,
          };
        });
        if (!outcome.available) return { ok: false, error: errors.unavailable() };
        return { ok: true, value: outcome.value };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async acceptInvitation(ctx, consumeInput) {
      try {
        const keyError = checkIdempotencyKey(consumeInput.idempotencyKey);
        if (keyError !== null) return { ok: false, error: keyError };
        const invitationRevisionError = checkRevision(consumeInput.expectedInvitationRevision, "expectedInvitationRevision");
        if (invitationRevisionError !== null) return { ok: false, error: invitationRevisionError };
        const accessRevisionError = checkRevision(consumeInput.reviewedAccessRevision, "reviewedAccessRevision");
        if (accessRevisionError !== null) return { ok: false, error: accessRevisionError };
        const shapeError = checkTokenShape(consumeInput.token);
        if (shapeError !== null) return { ok: false, error: shapeError };
        if (!limiter.check(`consume:${ctx.actorId}`)) return { ok: false, error: errors.rate_limited() };

        const tokenHash = hashInvitationToken(consumeInput.token);
        const inputHash = hashInput({
          campaignId: consumeInput.campaignId,
          tokenHash,
          expectedInvitationRevision: consumeInput.expectedInvitationRevision,
          reviewedAccessRevision: consumeInput.reviewedAccessRevision,
        });
        const receiptKey = {
          actorId: ctx.actorId,
          commandKind: ACCEPT_KIND,
          idempotencyKey: consumeInput.idempotencyKey,
        };

        const replayAccept = async (
          receipt: { inputHash: string; resultJson: unknown; expiresAt: Date } | null,
        ): Promise<CampaignResult<InvitationAcceptSuccess>> => {
          if (receipt === null) return { ok: false, error: errors.internal() };
          if (receipt.inputHash !== inputHash) return { ok: false, error: errors.mismatch() };
          if (receipt.expiresAt.getTime() <= now().getTime()) return { ok: false, error: errors.result_unavailable() };
          const stored = receipt.resultJson as {
            invitationId?: string;
            membershipGeneration?: number;
            value?: unknown;
          };
          if (typeof stored.invitationId !== "string" || typeof stored.membershipGeneration !== "number") {
            return { ok: false, error: errors.internal() };
          }
          // Confirm the original outcome only while the same membership
          // generation is still active. Never resurrects removed membership.
          const invitation = await repo.loadInvitation(input.pool, stored.invitationId);
          if (
            invitation === null ||
            invitation.status !== "accepted" ||
            invitation.consumingActorId !== ctx.actorId ||
            invitation.acceptedMembershipGeneration !== stored.membershipGeneration
          ) {
            return { ok: false, error: errors.result_unavailable() };
          }
          const membership = await repo.loadMembership(input.pool, invitation.campaignId, ctx.actorId);
          if (
            membership === null ||
            membership.status !== "active" ||
            membership.generation !== stored.membershipGeneration
          ) {
            return { ok: false, error: errors.result_unavailable() };
          }
          return {
            ok: true,
            value: {
              invitationId: stored.invitationId,
              campaignId: invitation.campaignId,
              membership: deserializeMember(stored.value),
              membershipGeneration: stored.membershipGeneration,
            },
          };
        };

        const preExisting = await repo.loadReceiptWithExpiry(input.pool, receiptKey);
        if (preExisting !== null) {
          return await replayAccept(preExisting);
        }

        const outcome = await withTransaction(async (client) => {
          // Global single-use: campaign lock first, then the invitation lock,
          // so two actors racing accept/decline serialize and exactly one wins.
          const located = await repo.findInvitationByHash(client, tokenHash);
          if (located === null || located.campaignId !== consumeInput.campaignId) {
            return { committed: false as const, failure: errors.unavailable() as CampaignError };
          }
          const campaign = await repo.lockCampaign(client, located.campaignId);
          const invitation = await repo.lockInvitation(client, located.invitationId);
          const raced = await repo.loadReceipt(client, receiptKey);
          if (raced !== null) {
            const fresh = await repo.loadReceiptWithExpiry(client, receiptKey);
            return { committed: false as const, receipt: fresh };
          }
          if (
            invitation === null ||
            invitation.tokenHash !== tokenHash ||
            invitation.status !== "pending" ||
            invitation.expiresAt.getTime() <= now().getTime()
          ) {
            return { committed: false as const, failure: errors.unavailable() as CampaignError };
          }
          if (campaign === null || campaign.status !== "active") {
            return { committed: false as const, failure: errors.unavailable() as CampaignError };
          }
          if (invitation.revision !== consumeInput.expectedInvitationRevision) {
            return {
              committed: false as const,
              failure: errors.conflict(REREVIEW_MESSAGE, invitation.revision),
            };
          }
          if (campaign.accessRevision !== consumeInput.reviewedAccessRevision) {
            return {
              committed: false as const,
              failure: errors.conflict(REREVIEW_MESSAGE, campaign.accessRevision),
            };
          }
          const existing = await repo.loadMembership(client, campaign.campaignId, ctx.actorId);
          // Already-active members cannot elevate or rejoin via token: a
          // definite error that leaves the token unconsumed.
          if (existing !== null && existing.status === "active") {
            return {
              committed: false as const,
              failure: errors.bad_request("You are already an active member of this campaign."),
            };
          }
          if ((await repo.countActiveMembers(client, campaign.campaignId)) >= limits.maxMembers) {
            return {
              committed: false as const,
              failure: errors.conflict("The campaign has reached its member limit.", campaign.revision),
            };
          }
          const member = await repo.upsertMembershipForAccept(client, {
            campaignId: campaign.campaignId,
            userId: ctx.actorId,
            role: invitation.intendedRole,
          });
          const consumed = await repo.consumeInvitation(client, {
            invitationId: invitation.invitationId,
            status: "accepted",
            consumingActorId: ctx.actorId,
            acceptedMembershipGeneration: member.generation,
            expectedRevision: consumeInput.expectedInvitationRevision,
            now: now(),
          });
          if (consumed === null) {
            return {
              committed: false as const,
              failure: errors.conflict(REREVIEW_MESSAGE, invitation.revision),
            };
          }
          const bumped = await repo.bumpCampaignRevisionForMembership(client, {
            campaignId: campaign.campaignId,
            expectedRevision: campaign.revision,
            now: now(),
          });
          if (bumped === null) {
            return {
              committed: false as const,
              failure: errors.conflict(
                "The campaign changed while joining. Review the invitation again.",
                campaign.revision,
              ),
            };
          }
          await repo.appendAudit(client, {
            campaignId: campaign.campaignId,
            actorId: ctx.actorId,
            kind: "invitation_accepted",
            summary: "Campaign invitation accepted",
            requestId: ctx.requestId,
          });
          const membership = toMemberView(member);
          const stored = {
            campaignId: campaign.campaignId,
            invitationId: invitation.invitationId,
            membershipGeneration: member.generation,
            value: serializeMember(membership),
            idempotencyKey: consumeInput.idempotencyKey,
          };
          const inserted = await repo.tryInsertReceipt(client, {
            actorId: ctx.actorId,
            commandKind: ACCEPT_KIND,
            idempotencyKey: consumeInput.idempotencyKey,
            inputHash,
            campaignId: campaign.campaignId,
            resultJson: stored,
            expiresAt: new Date(now().getTime() + RECEIPT_TTL_MS),
          });
          if (!inserted) {
            throw new ReceiptRace();
          }
          return {
            committed: true as const,
            value: {
              invitationId: invitation.invitationId,
              campaignId: campaign.campaignId,
              membership,
              membershipGeneration: member.generation,
            } satisfies InvitationAcceptSuccess,
          };
        }).catch(async (error) => {
          if (error instanceof ReceiptRace) {
            const receipt = await repo.loadReceiptWithExpiry(input.pool, receiptKey);
            return { committed: false as const, receipt };
          }
          throw error;
        });

        if ("failure" in outcome) return { ok: false, error: outcome.failure };
        if (outcome.committed) return { ok: true, value: outcome.value };
        return await replayAccept(outcome.receipt ?? null);
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async declineInvitation(ctx, consumeInput) {
      try {
        const keyError = checkIdempotencyKey(consumeInput.idempotencyKey);
        if (keyError !== null) return { ok: false, error: keyError };
        const invitationRevisionError = checkRevision(consumeInput.expectedInvitationRevision, "expectedInvitationRevision");
        if (invitationRevisionError !== null) return { ok: false, error: invitationRevisionError };
        const accessRevisionError = checkRevision(consumeInput.reviewedAccessRevision, "reviewedAccessRevision");
        if (accessRevisionError !== null) return { ok: false, error: accessRevisionError };
        const shapeError = checkTokenShape(consumeInput.token);
        if (shapeError !== null) return { ok: false, error: shapeError };
        if (!limiter.check(`consume:${ctx.actorId}`)) return { ok: false, error: errors.rate_limited() };

        const tokenHash = hashInvitationToken(consumeInput.token);
        const inputHash = hashInput({
          campaignId: consumeInput.campaignId,
          tokenHash,
          expectedInvitationRevision: consumeInput.expectedInvitationRevision,
          reviewedAccessRevision: consumeInput.reviewedAccessRevision,
        });
        const receiptKey = {
          actorId: ctx.actorId,
          commandKind: DECLINE_KIND,
          idempotencyKey: consumeInput.idempotencyKey,
        };

        const replayDecline = async (
          receipt: { inputHash: string; resultJson: unknown; expiresAt: Date } | null,
        ): Promise<CampaignResult<InvitationDeclineSuccess>> => {
          if (receipt === null) return { ok: false, error: errors.internal() };
          if (receipt.inputHash !== inputHash) return { ok: false, error: errors.mismatch() };
          if (receipt.expiresAt.getTime() <= now().getTime()) return { ok: false, error: errors.result_unavailable() };
          const stored = receipt.resultJson as { invitationId?: string; value?: unknown };
          if (typeof stored.invitationId !== "string") return { ok: false, error: errors.internal() };
          const invitation = await repo.loadInvitation(input.pool, stored.invitationId);
          if (
            invitation === null ||
            invitation.status !== "declined" ||
            invitation.consumingActorId !== ctx.actorId
          ) {
            return { ok: false, error: errors.result_unavailable() };
          }
          return {
            ok: true,
            value: { invitationId: stored.invitationId, campaignId: invitation.campaignId, status: "declined" },
          };
        };

        const preExisting = await repo.loadReceiptWithExpiry(input.pool, receiptKey);
        if (preExisting !== null) {
          return await replayDecline(preExisting);
        }

        const outcome = await withTransaction(async (client) => {
          const located = await repo.findInvitationByHash(client, tokenHash);
          if (located === null || located.campaignId !== consumeInput.campaignId) {
            return { committed: false as const, failure: errors.unavailable() as CampaignError };
          }
          const campaign = await repo.lockCampaign(client, located.campaignId);
          const invitation = await repo.lockInvitation(client, located.invitationId);
          const raced = await repo.loadReceipt(client, receiptKey);
          if (raced !== null) {
            const fresh = await repo.loadReceiptWithExpiry(client, receiptKey);
            return { committed: false as const, receipt: fresh };
          }
          if (
            invitation === null ||
            invitation.tokenHash !== tokenHash ||
            invitation.status !== "pending" ||
            invitation.expiresAt.getTime() <= now().getTime()
          ) {
            return { committed: false as const, failure: errors.unavailable() as CampaignError };
          }
          if (campaign === null || campaign.status !== "active") {
            return { committed: false as const, failure: errors.unavailable() as CampaignError };
          }
          if (invitation.revision !== consumeInput.expectedInvitationRevision) {
            return {
              committed: false as const,
              failure: errors.conflict(REREVIEW_MESSAGE, invitation.revision),
            };
          }
          if (campaign.accessRevision !== consumeInput.reviewedAccessRevision) {
            return {
              committed: false as const,
              failure: errors.conflict(REREVIEW_MESSAGE, campaign.accessRevision),
            };
          }
          // Decline consumes the token without creating membership.
          const consumed = await repo.consumeInvitation(client, {
            invitationId: invitation.invitationId,
            status: "declined",
            consumingActorId: ctx.actorId,
            acceptedMembershipGeneration: null,
            expectedRevision: consumeInput.expectedInvitationRevision,
            now: now(),
          });
          if (consumed === null) {
            return {
              committed: false as const,
              failure: errors.conflict(REREVIEW_MESSAGE, invitation.revision),
            };
          }
          const bumped = await repo.bumpCampaignRevisionForMembership(client, {
            campaignId: campaign.campaignId,
            expectedRevision: campaign.revision,
            now: now(),
          });
          if (bumped === null) {
            return {
              committed: false as const,
              failure: errors.conflict(
                "The campaign changed while declining. Review the invitation again.",
                campaign.revision,
              ),
            };
          }
          await repo.appendAudit(client, {
            campaignId: campaign.campaignId,
            actorId: ctx.actorId,
            kind: "invitation_declined",
            summary: "Campaign invitation declined",
            requestId: ctx.requestId,
          });
          const stored = {
            campaignId: campaign.campaignId,
            invitationId: invitation.invitationId,
            value: { status: "declined" },
            idempotencyKey: consumeInput.idempotencyKey,
          };
          const inserted = await repo.tryInsertReceipt(client, {
            actorId: ctx.actorId,
            commandKind: DECLINE_KIND,
            idempotencyKey: consumeInput.idempotencyKey,
            inputHash,
            campaignId: campaign.campaignId,
            resultJson: stored,
            expiresAt: new Date(now().getTime() + RECEIPT_TTL_MS),
          });
          if (!inserted) {
            throw new ReceiptRace();
          }
          return {
            committed: true as const,
            value: {
              invitationId: invitation.invitationId,
              campaignId: campaign.campaignId,
              status: "declined",
            } satisfies InvitationDeclineSuccess,
          };
        }).catch(async (error) => {
          if (error instanceof ReceiptRace) {
            const receipt = await repo.loadReceiptWithExpiry(input.pool, receiptKey);
            return { committed: false as const, receipt };
          }
          throw error;
        });

        if ("failure" in outcome) return { ok: false, error: outcome.failure };
        if (outcome.committed) return { ok: true, value: outcome.value };
        return await replayDecline(outcome.receipt ?? null);
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async rotateInvitation(ctx, rotateInput) {
      try {
        const keyError = checkIdempotencyKey(rotateInput.idempotencyKey);
        if (keyError !== null) return { ok: false, error: keyError };
        const invitationRevisionError = checkRevision(rotateInput.expectedInvitationRevision, "expectedInvitationRevision");
        if (invitationRevisionError !== null) return { ok: false, error: invitationRevisionError };
        const campaignRevisionError = checkRevision(rotateInput.expectedCampaignRevision, "expectedCampaignRevision");
        if (campaignRevisionError !== null) return { ok: false, error: campaignRevisionError };
        const resolved = resolveExpiry(rotateInput.expiresAt);
        if ("error" in resolved) return { ok: false, error: resolved.error };

        const inputHash = hashInput({
          campaignId: rotateInput.campaignId,
          invitationId: rotateInput.invitationId,
          // Client-supplied expiry only (see issueInvitation): the resolved
          // default moves with the clock and must not affect replay identity.
          expiresAt:
            rotateInput.expiresAt instanceof Date
              ? rotateInput.expiresAt.toISOString()
              : (rotateInput.expiresAt ?? null),
          expectedInvitationRevision: rotateInput.expectedInvitationRevision,
          expectedCampaignRevision: rotateInput.expectedCampaignRevision,
        });
        const receiptKey = {
          actorId: ctx.actorId,
          commandKind: ROTATE_KIND,
          idempotencyKey: rotateInput.idempotencyKey,
        };

        // Lost-response recovery replays metadata only: another lost response
        // needs another explicit rotation, never a recovered token.
        const preExisting = await repo.loadReceiptWithExpiry(input.pool, receiptKey);
        if (preExisting !== null) {
          return await replayAdminMetadata({ ctx, inputHash, receipt: preExisting });
        }

        const outcome = await withTransaction(async (client) => {
          const campaign = await repo.lockCampaign(client, rotateInput.campaignId);
          const invitation =
            campaign === null ? null : await repo.lockInvitation(client, rotateInput.invitationId);
          const membership =
            campaign === null ? null : await repo.loadMembership(client, rotateInput.campaignId, ctx.actorId);
          const raced = await repo.loadReceiptWithExpiry(client, receiptKey);
          if (raced !== null) {
            return { committed: false as const, receipt: raced };
          }
          if (campaign === null || !isActiveMember(membership) || !isGameMaster(membership)) {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          if (invitation === null || invitation.campaignId !== rotateInput.campaignId) {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          if (invitation.intendedRole === "co_gm" && membership.role !== "owner") {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          if (invitation.status !== "pending") {
            return {
              committed: false as const,
              failure: errors.conflict("Only pending invitations can be rotated.", invitation.revision),
            };
          }
          if (campaign.revision !== rotateInput.expectedCampaignRevision) {
            return {
              committed: false as const,
              failure: errors.conflict(
                "The campaign has a newer revision. Retry with the latest revision and a new idempotency key.",
                campaign.revision,
              ),
            };
          }
          const token = newToken();
          const rotated = await repo.rotateInvitationToken(client, {
            invitationId: invitation.invitationId,
            newTokenHash: hashInvitationToken(token),
            expiresAt: resolved.expiresAt,
            expectedRevision: rotateInput.expectedInvitationRevision,
            now: now(),
          });
          if (rotated === null) {
            return {
              committed: false as const,
              failure: errors.conflict(
                "The invitation has a newer revision. Retry with the latest revision and a new idempotency key.",
                invitation.revision,
              ),
            };
          }
          const bumped = await repo.bumpCampaignRevisionForMembership(client, {
            campaignId: campaign.campaignId,
            expectedRevision: rotateInput.expectedCampaignRevision,
            now: now(),
          });
          if (bumped === null) {
            return {
              committed: false as const,
              failure: errors.conflict(
                "The campaign has a newer revision. Retry with the latest revision and a new idempotency key.",
                campaign.revision,
              ),
            };
          }
          await repo.appendAudit(client, {
            campaignId: campaign.campaignId,
            actorId: ctx.actorId,
            kind: "invitation_rotated",
            summary: "Campaign invitation rotated",
            requestId: ctx.requestId,
          });
          const metadata = toMetadata(rotated);
          const stored = {
            campaignId: campaign.campaignId,
            invitationId: invitation.invitationId,
            value: serializeMetadata(metadata),
            idempotencyKey: rotateInput.idempotencyKey,
          };
          const inserted = await repo.tryInsertReceipt(client, {
            actorId: ctx.actorId,
            commandKind: ROTATE_KIND,
            idempotencyKey: rotateInput.idempotencyKey,
            inputHash,
            campaignId: campaign.campaignId,
            resultJson: stored,
            expiresAt: new Date(now().getTime() + RECEIPT_TTL_MS),
          });
          if (!inserted) {
            throw new ReceiptRace();
          }
          return { committed: true as const, value: { ...metadata, token } };
        }).catch(async (error) => {
          if (error instanceof ReceiptRace) {
            const receipt = await repo.loadReceiptWithExpiry(input.pool, receiptKey);
            return { committed: false as const, receipt };
          }
          throw error;
        });

        if ("failure" in outcome) return { ok: false, error: outcome.failure };
        if (outcome.committed) return { ok: true, value: outcome.value };
        return await replayAdminMetadata({ ctx, inputHash, receipt: outcome.receipt ?? null });
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async revokeInvitation(ctx, revokeInput) {
      try {
        const keyError = checkIdempotencyKey(revokeInput.idempotencyKey);
        if (keyError !== null) return { ok: false, error: keyError };
        const invitationRevisionError = checkRevision(revokeInput.expectedInvitationRevision, "expectedInvitationRevision");
        if (invitationRevisionError !== null) return { ok: false, error: invitationRevisionError };
        const campaignRevisionError = checkRevision(revokeInput.expectedCampaignRevision, "expectedCampaignRevision");
        if (campaignRevisionError !== null) return { ok: false, error: campaignRevisionError };

        const inputHash = hashInput({
          campaignId: revokeInput.campaignId,
          invitationId: revokeInput.invitationId,
          expectedInvitationRevision: revokeInput.expectedInvitationRevision,
          expectedCampaignRevision: revokeInput.expectedCampaignRevision,
        });
        const receiptKey = {
          actorId: ctx.actorId,
          commandKind: REVOKE_KIND,
          idempotencyKey: revokeInput.idempotencyKey,
        };

        const replayRevoke = async (
          receipt: { inputHash: string; resultJson: unknown; expiresAt: Date } | null,
        ): Promise<CampaignResult<InvitationMetadata>> => {
          if (receipt === null) return { ok: false, error: errors.internal() };
          if (receipt.inputHash !== inputHash) return { ok: false, error: errors.mismatch() };
          if (receipt.expiresAt.getTime() <= now().getTime()) {
            return { ok: false, error: errors.result_unavailable() };
          }
          const stored = receipt.resultJson as { campaignId?: string; invitationId?: string; value?: unknown };
          if (typeof stored.campaignId !== "string") return { ok: false, error: errors.internal() };
          const denial = await reauthorizeAdmin(ctx, stored.campaignId);
          if (denial !== null) return { ok: false, error: denial };
          if (typeof stored.invitationId === "string") {
            const live = await repo.loadInvitation(input.pool, stored.invitationId);
            if (live !== null) return { ok: true, value: toMetadata(live) };
          }
          return { ok: true, value: deserializeMetadata(stored.value) };
        };

        const preExisting = await repo.loadReceiptWithExpiry(input.pool, receiptKey);
        if (preExisting !== null) {
          return await replayRevoke(preExisting);
        }

        const outcome = await withTransaction(async (client) => {
          const campaign = await repo.lockCampaign(client, revokeInput.campaignId);
          const invitation =
            campaign === null ? null : await repo.lockInvitation(client, revokeInput.invitationId);
          const membership =
            campaign === null ? null : await repo.loadMembership(client, revokeInput.campaignId, ctx.actorId);
          const raced = await repo.loadReceiptWithExpiry(client, receiptKey);
          if (raced !== null) {
            return { committed: false as const, receipt: raced };
          }
          if (campaign === null || !isActiveMember(membership) || !isGameMaster(membership)) {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          if (invitation === null || invitation.campaignId !== revokeInput.campaignId) {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          if (invitation.intendedRole === "co_gm" && membership.role !== "owner") {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          if (invitation.revision !== revokeInput.expectedInvitationRevision) {
            return {
              committed: false as const,
              failure: errors.conflict(
                "The invitation has a newer revision. Retry with the latest revision and a new idempotency key.",
                invitation.revision,
              ),
            };
          }
          if (campaign.revision !== revokeInput.expectedCampaignRevision) {
            return {
              committed: false as const,
              failure: errors.conflict(
                "The campaign has a newer revision. Retry with the latest revision and a new idempotency key.",
                campaign.revision,
              ),
            };
          }
          // Idempotent: revoking an already-consumed or revoked invite
          // succeeds without touching membership; only a pending invite
          // transitions and bumps the campaign revision.
          let record = invitation;
          if (invitation.status === "pending") {
            const revoked = await repo.revokePendingInvitation(client, {
              invitationId: invitation.invitationId,
              expectedRevision: revokeInput.expectedInvitationRevision,
              now: now(),
            });
            if (revoked === null) {
              return {
                committed: false as const,
                failure: errors.conflict(
                  "The invitation has a newer revision. Retry with the latest revision and a new idempotency key.",
                  invitation.revision,
                ),
              };
            }
            record = revoked;
            const bumped = await repo.bumpCampaignRevisionForMembership(client, {
              campaignId: campaign.campaignId,
              expectedRevision: revokeInput.expectedCampaignRevision,
              now: now(),
            });
            if (bumped === null) {
              return {
                committed: false as const,
                failure: errors.conflict(
                  "The campaign has a newer revision. Retry with the latest revision and a new idempotency key.",
                  campaign.revision,
                ),
              };
            }
            await repo.appendAudit(client, {
              campaignId: campaign.campaignId,
              actorId: ctx.actorId,
              kind: "invitation_revoked",
              summary: "Campaign invitation revoked",
              requestId: ctx.requestId,
            });
          }
          const metadata = toMetadata(record);
          const stored = {
            campaignId: campaign.campaignId,
            invitationId: invitation.invitationId,
            value: serializeMetadata(metadata),
            idempotencyKey: revokeInput.idempotencyKey,
          };
          const inserted = await repo.tryInsertReceipt(client, {
            actorId: ctx.actorId,
            commandKind: REVOKE_KIND,
            idempotencyKey: revokeInput.idempotencyKey,
            inputHash,
            campaignId: campaign.campaignId,
            resultJson: stored,
            expiresAt: new Date(now().getTime() + RECEIPT_TTL_MS),
          });
          if (!inserted) {
            throw new ReceiptRace();
          }
          return { committed: true as const, value: metadata };
        }).catch(async (error) => {
          if (error instanceof ReceiptRace) {
            const receipt = await repo.loadReceiptWithExpiry(input.pool, receiptKey);
            return { committed: false as const, receipt };
          }
          throw error;
        });

        if ("failure" in outcome) return { ok: false, error: outcome.failure };
        if (outcome.committed) return { ok: true, value: outcome.value };
        return await replayRevoke(outcome.receipt ?? null);
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },
  };
}
