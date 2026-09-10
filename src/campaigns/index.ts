import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type { RequestContext } from "../systems/authoring.js";
import { hashInput } from "../systems/implementation/authoring/assess.js";
import type { CampaignLimits } from "../platform/config.js";

import {
  createCampaignPersistenceRepository,
  type CampaignPersistenceRepository,
  type CampaignRecord,
  type MembershipRecord,
} from "./persistence.js";
import {
  authorizeRemoval,
  authorizeRoleChange,
  canChangeLifecycle,
  canManageCampaign,
  canReadCampaign,
  isActiveMember,
} from "./policy.js";

export type { RequestContext };
export type CampaignId = string;
export type UserId = string;

export type CampaignErrorCode =
  | "bad_request"
  | "not_found"
  | "conflict"
  | "idempotency_mismatch"
  | "internal";

export type CampaignError = {
  code: CampaignErrorCode;
  message: string;
  latestRevision?: number | null;
};

export type CampaignResult<T> = { ok: true; value: T } | { ok: false; error: CampaignError };

export type CampaignView = {
  campaignId: CampaignId;
  ownerId: UserId;
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

export type CampaignSummary = {
  campaignId: CampaignId;
  title: string;
  status: "active" | "archived";
  revision: number;
  accessRevision: number;
  updatedAt: Date;
};

export type MemberView = {
  campaignId: CampaignId;
  userId: UserId;
  role: "owner" | "co_gm" | "player";
  status: "active" | "removed";
  generation: number;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateCampaignInput = {
  systemVersionId: string;
  title: string;
  description?: string;
  idempotencyKey: string;
};

export type OpenCampaignInput = {
  campaignId: CampaignId;
};

export type ListCampaignsInput = {
  limit?: number;
  cursor?: string | null;
};

export type ListCampaignsResult = {
  campaigns: CampaignSummary[];
  nextCursor: string | null;
};

export type UpdateCampaignInput = {
  campaignId: CampaignId;
  title?: string;
  description?: string;
  expectedCampaignRevision: number;
  idempotencyKey: string;
};

export type ArchiveCampaignInput = {
  campaignId: CampaignId;
  expectedCampaignRevision: number;
  idempotencyKey: string;
};

export type RecoverCampaignInput = {
  campaignId: CampaignId;
  expectedCampaignRevision: number;
  idempotencyKey: string;
};

export type ListMembersInput = {
  campaignId: CampaignId;
  limit?: number;
  cursor?: string | null;
};

export type ListMembersResult = {
  members: MemberView[];
  nextCursor: string | null;
};

export type ChangeRoleInput = {
  campaignId: CampaignId;
  userId: UserId;
  role: "co_gm" | "player";
  expectedCampaignRevision: number;
  idempotencyKey: string;
};

export type RemoveMemberInput = {
  campaignId: CampaignId;
  userId: UserId;
  expectedCampaignRevision: number;
  idempotencyKey: string;
};

export interface Campaigns {
  create(ctx: RequestContext, input: CreateCampaignInput): Promise<CampaignResult<CampaignView>>;
  open(ctx: RequestContext, input: OpenCampaignInput): Promise<CampaignResult<CampaignView>>;
  list(ctx: RequestContext, input: ListCampaignsInput): Promise<CampaignResult<ListCampaignsResult>>;
  update(ctx: RequestContext, input: UpdateCampaignInput): Promise<CampaignResult<CampaignView>>;
  archive(ctx: RequestContext, input: ArchiveCampaignInput): Promise<CampaignResult<CampaignView>>;
  recover(ctx: RequestContext, input: RecoverCampaignInput): Promise<CampaignResult<CampaignView>>;
  listMembers(ctx: RequestContext, input: ListMembersInput): Promise<CampaignResult<ListMembersResult>>;
  changeRole(ctx: RequestContext, input: ChangeRoleInput): Promise<CampaignResult<MemberView>>;
  removeMember(ctx: RequestContext, input: RemoveMemberInput): Promise<CampaignResult<MemberView>>;
}

export type CreateCampaignsModuleInput = {
  pool: Pool;
  limits: CampaignLimits;
  now?: () => Date;
  newId?: () => string;
  hooks?: {
    /**
     * Task 4 seam: invoked inside the removeMember transaction after the
     * membership row flips to removed and before audit/receipt commit.
     * A throw rolls the whole removal back. Task 4 plugs adopted-character
     * return through this hook; no public removal route may be registered
     * until the hook performs that return.
     */
    afterMemberRemoved?: MemberRemovalHook;
  };
};

/**
 * Task 4 extension point for departure: runs on the caller's transaction
 * client inside removeMember, after the membership status flips to removed
 * and before audit/receipt rows commit, so character return (Task 4) is
 * all-or-nothing with the removal itself.
 */
export type MemberRemovalHook = (
  client: PoolClient,
  removal: {
    campaignId: CampaignId;
    userId: UserId;
    actorId: UserId;
    requestId: string;
    membership: MemberView;
  },
) => Promise<void>;

const NOT_FOUND_MESSAGE = "The requested campaign does not exist.";
const MISMATCH_MESSAGE = "This idempotency key was already used with different input.";
const RECEIPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const CREATE_KIND = "campaign_create";
const UPDATE_KIND = "campaign_update";
const ARCHIVE_KIND = "campaign_archive";
const RECOVER_KIND = "campaign_recover";
const CHANGE_ROLE_KIND = "campaign_change_role";
const REMOVE_MEMBER_KIND = "campaign_remove_member";

type ListCursor = { createdAt: string; id: string; scope: string };

/**
 * Thrown inside a transaction when the idempotency receipt insert loses a
 * concurrent race after the mutation already ran. Forcing a rollback keeps
 * the spurious row from committing; the caller then replays the winner.
 */
class ReceiptRace extends Error {
  constructor() {
    super("idempotency receipt raced");
  }
}

export function createCampaignsModule(input: CreateCampaignsModuleInput): Campaigns {
  const repo: CampaignPersistenceRepository = createCampaignPersistenceRepository(input.pool);
  const limits = input.limits;
  const now = input.now ?? (() => new Date());
  const newId = input.newId ?? (() => randomUUID());
  const hooks = input.hooks;

  const errors = {
    bad_request: (message: string): CampaignError => ({ code: "bad_request", message }),
    not_found: (message: string = NOT_FOUND_MESSAGE): CampaignError => ({ code: "not_found", message }),
    mismatch: (): CampaignError => ({ code: "idempotency_mismatch", message: MISMATCH_MESSAGE }),
    conflict: (message: string, latestRevision?: number | null): CampaignError => ({
      code: "conflict",
      message,
      ...(latestRevision === undefined ? {} : { latestRevision }),
    }),
    internal: (): CampaignError => ({ code: "internal", message: "An internal error occurred." }),
  };

  function toView(record: CampaignRecord): CampaignView {
    return {
      campaignId: record.campaignId,
      ownerId: record.ownerId,
      systemVersionId: record.systemVersionId,
      title: record.title,
      description: record.description,
      status: record.status,
      revision: record.revision,
      accessRevision: record.accessRevision,
      archivedAt: record.archivedAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
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

  function serializeView(view: CampaignView): unknown {
    return {
      ...view,
      archivedAt: view.archivedAt === null ? null : view.archivedAt.toISOString(),
      createdAt: view.createdAt.toISOString(),
      updatedAt: view.updatedAt.toISOString(),
    };
  }

  function deserializeView(stored: unknown): CampaignView {
    const raw = stored as Omit<CampaignView, "archivedAt" | "createdAt" | "updatedAt"> & {
      archivedAt: string | null;
      createdAt: string;
      updatedAt: string;
    };
    return {
      ...raw,
      archivedAt: raw.archivedAt === null ? null : new Date(raw.archivedAt),
      createdAt: new Date(raw.createdAt),
      updatedAt: new Date(raw.updatedAt),
    };
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

  function checkTitle(title: unknown): CampaignError | null {
    if (typeof title !== "string" || title.trim().length === 0) {
      return errors.bad_request("title must be a non-empty string.");
    }
    if ([...title].length > limits.maxTitleLength) {
      return errors.bad_request(`title must be at most ${limits.maxTitleLength} characters.`);
    }
    return null;
  }

  function checkDescription(description: unknown): CampaignError | null {
    if (typeof description !== "string") {
      return errors.bad_request("description must be a string.");
    }
    if ([...description].length > limits.maxDescriptionLength) {
      return errors.bad_request(`description must be at most ${limits.maxDescriptionLength} characters.`);
    }
    return null;
  }

  function checkRevision(revision: unknown): CampaignError | null {
    if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
      return errors.bad_request("expectedCampaignRevision must be a positive integer.");
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
  ): { cursor: ListCursor | null } | { error: CampaignError } {
    if (raw === undefined || raw === null) return { cursor: null };
    try {
      const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<ListCursor>;
      if (
        typeof parsed.createdAt !== "string" ||
        typeof parsed.id !== "string" ||
        typeof parsed.scope !== "string" ||
        Number.isNaN(Date.parse(parsed.createdAt)) ||
        parsed.id.length === 0
      ) {
        return { error: errors.bad_request("cursor is malformed.") };
      }
      // Cursors never cross scopes: a members cursor is bound to its
      // campaign, a campaigns cursor to the actor it was issued to.
      if (parsed.scope !== expectedScope) {
        return { error: errors.bad_request("cursor is not valid for this query.") };
      }
      return { cursor: { createdAt: parsed.createdAt, id: parsed.id, scope: parsed.scope } };
    } catch {
      return { error: errors.bad_request("cursor is malformed.") };
    }
  }

  function encodeCursor(cursor: ListCursor): string {
    return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  }

  async function withClient<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await input.pool.connect();
    try {
      return await work(client);
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

  async function resolveReplay<T>(options: {
    commandKind: string;
    idempotencyKey: string;
    inputHash: string;
    receipt: { inputHash: string; resultJson: unknown } | null;
    deserialize: (stored: unknown) => T;
    reauthorize: (campaignId: string) => Promise<CampaignError | null>;
  }): Promise<CampaignResult<T>> {
    if (options.receipt === null) return { ok: false, error: errors.internal() };
    if (options.receipt.inputHash !== options.inputHash) return { ok: false, error: errors.mismatch() };
    const stored = options.receipt.resultJson as { campaignId?: string; value?: unknown };
    if (typeof stored.campaignId === "string") {
      const denial = await options.reauthorize(stored.campaignId);
      if (denial !== null) return { ok: false, error: denial };
    }
    return { ok: true, value: options.deserialize(stored.value) };
  }

  async function reauthorizeMember(
    ctx: RequestContext,
    campaignId: string,
  ): Promise<CampaignError | null> {
    // One connection for both reads so the campaign row and the caller
    // membership share a consistent snapshot.
    return await withClient(async (client) => {
      const campaign = await repo.openCampaign(client, campaignId);
      const membership =
        campaign === null ? null : await repo.loadMembership(client, campaignId, ctx.actorId);
      if (campaign === null || !canReadCampaign(campaign, membership)) {
        return errors.not_found();
      }
      return null;
    });
  }

  return {
    async create(ctx, createInput) {
      try {
        const keyError = checkIdempotencyKey(createInput.idempotencyKey);
        if (keyError !== null) return { ok: false, error: keyError };
        const titleError = checkTitle(createInput.title);
        if (titleError !== null) return { ok: false, error: titleError };
        const description = createInput.description ?? "";
        const descriptionError = checkDescription(description);
        if (descriptionError !== null) return { ok: false, error: descriptionError };

        const version = await repo.loadAccessibleVersion(ctx.actorId, createInput.systemVersionId);
        if (version === null) return { ok: false, error: errors.not_found() };

        const inputHash = hashInput({
          systemVersionId: createInput.systemVersionId,
          title: createInput.title,
          description,
        });
        const receiptKey = {
          actorId: ctx.actorId,
          commandKind: CREATE_KIND,
          idempotencyKey: createInput.idempotencyKey,
        };

        // Receipt-first: an exact replay returns the stored value without
        // inserting a second campaign row.
        const preExisting = await repo.loadReceipt(input.pool, receiptKey);
        if (preExisting !== null) {
          return await resolveReplay<CampaignView>({
            commandKind: CREATE_KIND,
            idempotencyKey: createInput.idempotencyKey,
            inputHash,
            receipt: preExisting,
            deserialize: deserializeView,
            reauthorize: (id) => reauthorizeMember(ctx, id),
          });
        }

        const outcome = await withTransaction(async (client) => {
          // Re-check inside the transaction: a concurrent identical request
          // may have committed between the pre-check and our inserts.
          const raced = await repo.loadReceipt(client, receiptKey);
          if (raced !== null) {
            return { committed: false as const, receipt: raced };
          }
          const campaignId = newId();
          const timestamp = now();
          const record = await repo.insertCampaign(client, {
            campaignId,
            ownerId: ctx.actorId,
            systemVersionId: version.versionId,
            title: createInput.title,
            description,
          });
          await repo.insertOwnerMembership(client, campaignId, ctx.actorId);
          await repo.appendAudit(client, {
            campaignId,
            actorId: ctx.actorId,
            kind: "campaign_created",
            summary: "Campaign created",
            requestId: ctx.requestId,
          });
          const value = toView(record);
          const stored = { campaignId, value: serializeView(value), idempotencyKey: createInput.idempotencyKey };
          const inserted = await repo.tryInsertReceipt(client, {
            actorId: ctx.actorId,
            commandKind: CREATE_KIND,
            idempotencyKey: createInput.idempotencyKey,
            inputHash,
            campaignId,
            resultJson: stored,
            expiresAt: new Date(timestamp.getTime() + RECEIPT_TTL_MS),
          });
          if (!inserted) {
            // Lost a concurrent race after mutating: roll back so the
            // spurious row never commits, then replay the winner below.
            throw new ReceiptRace();
          }
          return { committed: true as const, value };
        }).catch(async (error) => {
          if (error instanceof ReceiptRace) {
            const receipt = await repo.loadReceipt(input.pool, receiptKey);
            return { committed: false as const, receipt };
          }
          throw error;
        });

        if (outcome.committed) return { ok: true, value: outcome.value };
        return await resolveReplay<CampaignView>({
          commandKind: CREATE_KIND,
          idempotencyKey: createInput.idempotencyKey,
          inputHash,
          receipt: outcome.receipt,
          deserialize: deserializeView,
          reauthorize: (id) => reauthorizeMember(ctx, id),
        });
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async open(ctx, openInput) {
      try {
        // Single-client snapshot: campaign identity and caller membership
        // are resolved together, never on independently pooled connections.
        const outcome = await withClient(async (client) => {
          const campaign = await repo.openCampaign(client, openInput.campaignId);
          const membership =
            campaign === null
              ? null
              : await repo.loadMembership(client, openInput.campaignId, ctx.actorId);
          return { campaign, membership };
        });
        if (outcome.campaign === null || !canReadCampaign(outcome.campaign, outcome.membership)) {
          return { ok: false, error: errors.not_found() };
        }
        return { ok: true, value: toView(outcome.campaign) };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async list(ctx, listInput) {
      try {
        const checked = checkLimit(listInput.limit);
        if ("error" in checked) return { ok: false, error: checked.error };
        const decoded = decodeCursor(listInput.cursor, ctx.actorId);
        if ("error" in decoded) return { ok: false, error: decoded.error };
        const rows = await repo.listCampaignsPage(input.pool, ctx.actorId, {
          limit: checked.limit,
          cursorCreatedAt: decoded.cursor?.createdAt ?? null,
          cursorId: decoded.cursor?.id ?? null,
        });
        const hasMore = rows.length > checked.limit;
        const page = hasMore ? rows.slice(0, checked.limit) : rows;
        const last = page[page.length - 1];
        return {
          ok: true,
          value: {
            campaigns: page.map((record) => ({
              campaignId: record.campaignId,
              title: record.title,
              status: record.status,
              revision: record.revision,
              accessRevision: record.accessRevision,
              updatedAt: record.updatedAt,
            })),
            nextCursor:
              hasMore && last !== undefined
                ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.campaignId, scope: ctx.actorId })
                : null,
          },
        };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async update(ctx, updateInput) {
      try {
        const keyError = checkIdempotencyKey(updateInput.idempotencyKey);
        if (keyError !== null) return { ok: false, error: keyError };
        const revisionError = checkRevision(updateInput.expectedCampaignRevision);
        if (revisionError !== null) return { ok: false, error: revisionError };
        if (updateInput.title === undefined && updateInput.description === undefined) {
          return { ok: false, error: errors.bad_request("Nothing to update.") };
        }
        if (updateInput.title !== undefined) {
          const titleError = checkTitle(updateInput.title);
          if (titleError !== null) return { ok: false, error: titleError };
        }
        if (updateInput.description !== undefined) {
          const descriptionError = checkDescription(updateInput.description);
          if (descriptionError !== null) return { ok: false, error: descriptionError };
        }

        const inputHash = hashInput({
          campaignId: updateInput.campaignId,
          title: updateInput.title ?? null,
          description: updateInput.description ?? null,
          expectedCampaignRevision: updateInput.expectedCampaignRevision,
        });
        const receiptKey = {
          actorId: ctx.actorId,
          commandKind: UPDATE_KIND,
          idempotencyKey: updateInput.idempotencyKey,
        };

        // Receipt-first: an exact replay returns the stored value without
        // re-applying the mutation.
        const preExisting = await repo.loadReceipt(input.pool, receiptKey);
        if (preExisting !== null) {
          return await resolveReplay<CampaignView>({
            commandKind: UPDATE_KIND,
            idempotencyKey: updateInput.idempotencyKey,
            inputHash,
            receipt: preExisting,
            deserialize: deserializeView,
            reauthorize: (id) => reauthorizeMember(ctx, id),
          });
        }

        const outcome = await withTransaction(async (client) => {
          const campaign = await repo.lockCampaign(client, updateInput.campaignId);
          const membership =
            campaign === null
              ? null
              : await repo.loadMembership(client, updateInput.campaignId, ctx.actorId);
          // Re-check before any mutation: a waiter behind the row lock must
          // replay instead of re-applying or hitting a revision conflict.
          const raced = await repo.loadReceipt(client, receiptKey);
          if (raced !== null) {
            return { committed: false as const, receipt: raced };
          }
          if (campaign === null || !isActiveMember(membership)) {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          if (campaign.status !== "active") {
            return {
              committed: false as const,
              failure: errors.conflict("Archived campaigns reject metadata changes until recovered.", campaign.revision),
            };
          }
          if (!canManageCampaign(campaign, membership)) {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          if (campaign.revision !== updateInput.expectedCampaignRevision) {
            return {
              committed: false as const,
              failure: errors.conflict(
                "The campaign has a newer revision. Retry with the latest revision and a new idempotency key.",
                campaign.revision,
              ),
            };
          }
          const updated = await repo.updateCampaignMetadata(client, {
            campaignId: campaign.campaignId,
            title: updateInput.title ?? campaign.title,
            description: updateInput.description ?? campaign.description,
            expectedRevision: updateInput.expectedCampaignRevision,
            now: now(),
          });
          if (updated === null) {
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
            kind: "campaign_updated",
            summary: "Campaign metadata updated",
            requestId: ctx.requestId,
          });
          const value = toView(updated);
          const stored = {
            campaignId: campaign.campaignId,
            value: serializeView(value),
            idempotencyKey: updateInput.idempotencyKey,
          };
          const inserted = await repo.tryInsertReceipt(client, {
            actorId: ctx.actorId,
            commandKind: UPDATE_KIND,
            idempotencyKey: updateInput.idempotencyKey,
            inputHash,
            campaignId: campaign.campaignId,
            resultJson: stored,
            expiresAt: new Date(now().getTime() + RECEIPT_TTL_MS),
          });
          if (!inserted) {
            // Lost a concurrent race after mutating: roll back so the second
            // application never commits, then replay the winner below.
            throw new ReceiptRace();
          }
          return { committed: true as const, value };
        }).catch(async (error) => {
          if (error instanceof ReceiptRace) {
            const receipt = await repo.loadReceipt(input.pool, receiptKey);
            return { committed: false as const, receipt };
          }
          throw error;
        });

        if ("failure" in outcome) return { ok: false, error: outcome.failure };
        if (outcome.committed) return { ok: true, value: outcome.value };
        return await resolveReplay<CampaignView>({
          commandKind: UPDATE_KIND,
          idempotencyKey: updateInput.idempotencyKey,
          inputHash,
          receipt: outcome.receipt ?? null,
          deserialize: deserializeView,
          reauthorize: (id) => reauthorizeMember(ctx, id),
        });
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async archive(ctx, archiveInput) {
      try {
        const keyError = checkIdempotencyKey(archiveInput.idempotencyKey);
        if (keyError !== null) return { ok: false, error: keyError };
        const revisionError = checkRevision(archiveInput.expectedCampaignRevision);
        if (revisionError !== null) return { ok: false, error: revisionError };
        const inputHash = hashInput({
          campaignId: archiveInput.campaignId,
          expectedCampaignRevision: archiveInput.expectedCampaignRevision,
        });
        const receiptKey = {
          actorId: ctx.actorId,
          commandKind: ARCHIVE_KIND,
          idempotencyKey: archiveInput.idempotencyKey,
        };

        // Receipt-first: an exact replay returns the stored value without
        // re-applying the mutation.
        const preExisting = await repo.loadReceipt(input.pool, receiptKey);
        if (preExisting !== null) {
          return await resolveReplay<CampaignView>({
            commandKind: ARCHIVE_KIND,
            idempotencyKey: archiveInput.idempotencyKey,
            inputHash,
            receipt: preExisting,
            deserialize: deserializeView,
            reauthorize: (id) => reauthorizeMember(ctx, id),
          });
        }

        const outcome = await withTransaction(async (client) => {
          const campaign = await repo.lockCampaign(client, archiveInput.campaignId);
          const membership =
            campaign === null
              ? null
              : await repo.loadMembership(client, archiveInput.campaignId, ctx.actorId);
          // Re-check before any mutation: a waiter behind the row lock must
          // replay instead of re-applying or hitting a revision conflict.
          const raced = await repo.loadReceipt(client, receiptKey);
          if (raced !== null) {
            return { committed: false as const, receipt: raced };
          }
          if (campaign === null || !isActiveMember(membership)) {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          if (!canChangeLifecycle(membership)) {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          if (campaign.status === "archived") {
            return {
              committed: false as const,
              failure: errors.conflict("The campaign is already archived.", campaign.revision),
            };
          }
          if (campaign.revision !== archiveInput.expectedCampaignRevision) {
            return {
              committed: false as const,
              failure: errors.conflict(
                "The campaign has a newer revision. Retry with the latest revision and a new idempotency key.",
                campaign.revision,
              ),
            };
          }
          const updated = await repo.updateCampaignStatus(client, {
            campaignId: campaign.campaignId,
            status: "archived",
            expectedRevision: archiveInput.expectedCampaignRevision,
            now: now(),
          });
          if (updated === null) {
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
            kind: "campaign_archived",
            summary: "Campaign archived",
            requestId: ctx.requestId,
          });
          const value = toView(updated);
          const stored = {
            campaignId: campaign.campaignId,
            value: serializeView(value),
            idempotencyKey: archiveInput.idempotencyKey,
          };
          const inserted = await repo.tryInsertReceipt(client, {
            actorId: ctx.actorId,
            commandKind: ARCHIVE_KIND,
            idempotencyKey: archiveInput.idempotencyKey,
            inputHash,
            campaignId: campaign.campaignId,
            resultJson: stored,
            expiresAt: new Date(now().getTime() + RECEIPT_TTL_MS),
          });
          if (!inserted) {
            // Lost a concurrent race after mutating: roll back so the second
            // application never commits, then replay the winner below.
            throw new ReceiptRace();
          }
          return { committed: true as const, value };
        }).catch(async (error) => {
          if (error instanceof ReceiptRace) {
            const receipt = await repo.loadReceipt(input.pool, receiptKey);
            return { committed: false as const, receipt };
          }
          throw error;
        });

        if ("failure" in outcome) return { ok: false, error: outcome.failure };
        if (outcome.committed) return { ok: true, value: outcome.value };
        return await resolveReplay<CampaignView>({
          commandKind: ARCHIVE_KIND,
          idempotencyKey: archiveInput.idempotencyKey,
          inputHash,
          receipt: outcome.receipt ?? null,
          deserialize: deserializeView,
          reauthorize: (id) => reauthorizeMember(ctx, id),
        });
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async recover(ctx, recoverInput) {
      try {
        const keyError = checkIdempotencyKey(recoverInput.idempotencyKey);
        if (keyError !== null) return { ok: false, error: keyError };
        const revisionError = checkRevision(recoverInput.expectedCampaignRevision);
        if (revisionError !== null) return { ok: false, error: revisionError };
        const inputHash = hashInput({
          campaignId: recoverInput.campaignId,
          expectedCampaignRevision: recoverInput.expectedCampaignRevision,
        });
        const receiptKey = {
          actorId: ctx.actorId,
          commandKind: RECOVER_KIND,
          idempotencyKey: recoverInput.idempotencyKey,
        };

        // Receipt-first: an exact replay returns the stored value without
        // re-applying the mutation.
        const preExisting = await repo.loadReceipt(input.pool, receiptKey);
        if (preExisting !== null) {
          return await resolveReplay<CampaignView>({
            commandKind: RECOVER_KIND,
            idempotencyKey: recoverInput.idempotencyKey,
            inputHash,
            receipt: preExisting,
            deserialize: deserializeView,
            reauthorize: (id) => reauthorizeMember(ctx, id),
          });
        }

        const outcome = await withTransaction(async (client) => {
          const campaign = await repo.lockCampaign(client, recoverInput.campaignId);
          const membership =
            campaign === null
              ? null
              : await repo.loadMembership(client, recoverInput.campaignId, ctx.actorId);
          // Re-check before any mutation: a waiter behind the row lock must
          // replay instead of re-applying or hitting a revision conflict.
          const raced = await repo.loadReceipt(client, receiptKey);
          if (raced !== null) {
            return { committed: false as const, receipt: raced };
          }
          if (campaign === null || !isActiveMember(membership)) {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          if (!canChangeLifecycle(membership)) {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          if (campaign.status === "active") {
            return {
              committed: false as const,
              failure: errors.conflict("The campaign is already active.", campaign.revision),
            };
          }
          if (campaign.revision !== recoverInput.expectedCampaignRevision) {
            return {
              committed: false as const,
              failure: errors.conflict(
                "The campaign has a newer revision. Retry with the latest revision and a new idempotency key.",
                campaign.revision,
              ),
            };
          }
          const updated = await repo.updateCampaignStatus(client, {
            campaignId: campaign.campaignId,
            status: "active",
            expectedRevision: recoverInput.expectedCampaignRevision,
            now: now(),
          });
          if (updated === null) {
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
            kind: "campaign_recovered",
            summary: "Campaign recovered",
            requestId: ctx.requestId,
          });
          const value = toView(updated);
          const stored = {
            campaignId: campaign.campaignId,
            value: serializeView(value),
            idempotencyKey: recoverInput.idempotencyKey,
          };
          const inserted = await repo.tryInsertReceipt(client, {
            actorId: ctx.actorId,
            commandKind: RECOVER_KIND,
            idempotencyKey: recoverInput.idempotencyKey,
            inputHash,
            campaignId: campaign.campaignId,
            resultJson: stored,
            expiresAt: new Date(now().getTime() + RECEIPT_TTL_MS),
          });
          if (!inserted) {
            // Lost a concurrent race after mutating: roll back so the second
            // application never commits, then replay the winner below.
            throw new ReceiptRace();
          }
          return { committed: true as const, value };
        }).catch(async (error) => {
          if (error instanceof ReceiptRace) {
            const receipt = await repo.loadReceipt(input.pool, receiptKey);
            return { committed: false as const, receipt };
          }
          throw error;
        });

        if ("failure" in outcome) return { ok: false, error: outcome.failure };
        if (outcome.committed) return { ok: true, value: outcome.value };
        return await resolveReplay<CampaignView>({
          commandKind: RECOVER_KIND,
          idempotencyKey: recoverInput.idempotencyKey,
          inputHash,
          receipt: outcome.receipt ?? null,
          deserialize: deserializeView,
          reauthorize: (id) => reauthorizeMember(ctx, id),
        });
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async listMembers(ctx, listInput) {
      try {
        const checked = checkLimit(listInput.limit);
        if ("error" in checked) return { ok: false, error: checked.error };
        const decoded = decodeCursor(listInput.cursor, listInput.campaignId);
        if ("error" in decoded) return { ok: false, error: decoded.error };
        // Authorization precedes pagination on one snapshot: the roster page
        // is selected with the campaign predicate already applied, never by
        // paginating first and filtering unauthorized rows in memory.
        const outcome = await withClient(async (client) => {
          const campaign = await repo.openCampaign(client, listInput.campaignId);
          const membership =
            campaign === null
              ? null
              : await repo.loadMembership(client, listInput.campaignId, ctx.actorId);
          if (campaign === null || !canReadCampaign(campaign, membership)) {
            return { authorized: false as const };
          }
          const rows = await repo.listMembersPage(client, listInput.campaignId, {
            limit: checked.limit,
            cursorCreatedAt: decoded.cursor?.createdAt ?? null,
            cursorUserId: decoded.cursor?.id ?? null,
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
            members: page.map(toMemberView),
            nextCursor:
              hasMore && last !== undefined
                ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.userId, scope: listInput.campaignId })
                : null,
          },
        };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async changeRole(ctx, roleInput) {
      try {
        const keyError = checkIdempotencyKey(roleInput.idempotencyKey);
        if (keyError !== null) return { ok: false, error: keyError };
        const revisionError = checkRevision(roleInput.expectedCampaignRevision);
        if (revisionError !== null) return { ok: false, error: revisionError };
        if (roleInput.role !== "co_gm" && roleInput.role !== "player") {
          return { ok: false, error: errors.bad_request("role must be co_gm or player.") };
        }
        const inputHash = hashInput({
          campaignId: roleInput.campaignId,
          userId: roleInput.userId,
          role: roleInput.role,
          expectedCampaignRevision: roleInput.expectedCampaignRevision,
        });
        const receiptKey = {
          actorId: ctx.actorId,
          commandKind: CHANGE_ROLE_KIND,
          idempotencyKey: roleInput.idempotencyKey,
        };

        // Receipt-first: an exact replay returns the stored value without
        // re-applying the mutation.
        const preExisting = await repo.loadReceipt(input.pool, receiptKey);
        if (preExisting !== null) {
          return await resolveReplay<MemberView>({
            commandKind: CHANGE_ROLE_KIND,
            idempotencyKey: roleInput.idempotencyKey,
            inputHash,
            receipt: preExisting,
            deserialize: deserializeMember,
            reauthorize: (id) => reauthorizeMember(ctx, id),
          });
        }

        const outcome = await withTransaction(async (client) => {
          const campaign = await repo.lockCampaign(client, roleInput.campaignId);
          const caller =
            campaign === null ? null : await repo.loadMembership(client, roleInput.campaignId, ctx.actorId);
          const target =
            campaign === null ? null : await repo.loadMembership(client, roleInput.campaignId, roleInput.userId);
          // Re-check before any mutation: a waiter behind the row lock must
          // replay instead of re-applying or hitting a revision conflict.
          const raced = await repo.loadReceipt(client, receiptKey);
          if (raced !== null) {
            return { committed: false as const, receipt: raced };
          }
          if (campaign === null || !isActiveMember(caller)) {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          if (campaign.status !== "active") {
            return {
              committed: false as const,
              failure: errors.conflict("Archived campaigns reject membership changes until recovered.", campaign.revision),
            };
          }
          const denial = authorizeRoleChange({ caller, target, newRole: roleInput.role });
          if (denial === "not_member" && target === null) {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          if (denial !== null) {
            return { committed: false as const, failure: mapPolicyDenial(denial, errors) };
          }
          if (campaign.revision !== roleInput.expectedCampaignRevision) {
            return {
              committed: false as const,
              failure: errors.conflict(
                "The campaign has a newer revision. Retry with the latest revision and a new idempotency key.",
                campaign.revision,
              ),
            };
          }
          const bumped = await repo.bumpCampaignRevisionForMembership(client, {
            campaignId: campaign.campaignId,
            expectedRevision: roleInput.expectedCampaignRevision,
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
          const updated = await repo.updateMembership(client, {
            campaignId: campaign.campaignId,
            userId: roleInput.userId,
            role: roleInput.role,
          });
          if (updated === null) {
            return { committed: false as const, failure: errors.internal() as CampaignError };
          }
          await repo.appendAudit(client, {
            campaignId: campaign.campaignId,
            actorId: ctx.actorId,
            kind: "campaign_role_changed",
            summary: "Campaign role changed",
            requestId: ctx.requestId,
          });
          const value = toMemberView(updated);
          const stored = {
            campaignId: campaign.campaignId,
            value: serializeMember(value),
            idempotencyKey: roleInput.idempotencyKey,
          };
          const inserted = await repo.tryInsertReceipt(client, {
            actorId: ctx.actorId,
            commandKind: CHANGE_ROLE_KIND,
            idempotencyKey: roleInput.idempotencyKey,
            inputHash,
            campaignId: campaign.campaignId,
            resultJson: stored,
            expiresAt: new Date(now().getTime() + RECEIPT_TTL_MS),
          });
          if (!inserted) {
            // Lost a concurrent race after mutating: roll back so the second
            // application never commits, then replay the winner below.
            throw new ReceiptRace();
          }
          return { committed: true as const, value };
        }).catch(async (error) => {
          if (error instanceof ReceiptRace) {
            const receipt = await repo.loadReceipt(input.pool, receiptKey);
            return { committed: false as const, receipt };
          }
          throw error;
        });

        if ("failure" in outcome) return { ok: false, error: outcome.failure };
        if (outcome.committed) return { ok: true, value: outcome.value };
        return await resolveReplay<MemberView>({
          commandKind: CHANGE_ROLE_KIND,
          idempotencyKey: roleInput.idempotencyKey,
          inputHash,
          receipt: outcome.receipt ?? null,
          deserialize: deserializeMember,
          reauthorize: (id) => reauthorizeMember(ctx, id),
        });
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async removeMember(ctx, removeInput) {
      try {
        const keyError = checkIdempotencyKey(removeInput.idempotencyKey);
        if (keyError !== null) return { ok: false, error: keyError };
        const revisionError = checkRevision(removeInput.expectedCampaignRevision);
        if (revisionError !== null) return { ok: false, error: revisionError };
        const inputHash = hashInput({
          campaignId: removeInput.campaignId,
          userId: removeInput.userId,
          expectedCampaignRevision: removeInput.expectedCampaignRevision,
        });
        const receiptKey = {
          actorId: ctx.actorId,
          commandKind: REMOVE_MEMBER_KIND,
          idempotencyKey: removeInput.idempotencyKey,
        };
        // Leave/removal replays a minimal own-command acknowledgement without
        // requiring current membership: the caller may have departed already.
        const replayRemoval = (
          receipt: { inputHash: string; resultJson: unknown } | null,
        ): CampaignResult<MemberView> => {
          if (receipt === null) return { ok: false, error: errors.internal() };
          if (receipt.inputHash !== inputHash) return { ok: false, error: errors.mismatch() };
          const stored = receipt.resultJson as { value?: unknown };
          return { ok: true, value: deserializeMember(stored.value) };
        };

        // Receipt-first: an exact replay returns the stored acknowledgement
        // without re-applying the removal.
        const preExisting = await repo.loadReceipt(input.pool, receiptKey);
        if (preExisting !== null) {
          return replayRemoval(preExisting);
        }

        const outcome = await withTransaction(async (client) => {
          // Departure stays available while archived: no status gate here.
          const campaign = await repo.lockCampaign(client, removeInput.campaignId);
          const caller =
            campaign === null ? null : await repo.loadMembership(client, removeInput.campaignId, ctx.actorId);
          const target =
            campaign === null ? null : await repo.loadMembership(client, removeInput.campaignId, removeInput.userId);
          // Re-check before any mutation: a waiter behind the row lock must
          // replay instead of re-applying or hitting a revision conflict.
          const raced = await repo.loadReceipt(client, receiptKey);
          if (raced !== null) {
            return { committed: false as const, receipt: raced };
          }
          if (campaign === null || !isActiveMember(caller)) {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          const denial = authorizeRemoval({ caller, target });
          if (denial === "not_member" && target === null) {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          if (denial !== null) {
            return { committed: false as const, failure: mapPolicyDenial(denial, errors) };
          }
          if (campaign.revision !== removeInput.expectedCampaignRevision) {
            return {
              committed: false as const,
              failure: errors.conflict(
                "The campaign has a newer revision. Retry with the latest revision and a new idempotency key.",
                campaign.revision,
              ),
            };
          }
          const bumped = await repo.bumpCampaignRevisionForMembership(client, {
            campaignId: campaign.campaignId,
            expectedRevision: removeInput.expectedCampaignRevision,
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
          const updated = await repo.updateMembership(client, {
            campaignId: campaign.campaignId,
            userId: removeInput.userId,
            status: "removed",
          });
          if (updated === null) {
            return { committed: false as const, failure: errors.internal() as CampaignError };
          }
          const value = toMemberView(updated);
          // Task 4 seam: member-return plugs in here, inside the same
          // transaction, so removal, controller/grant cleanup, audit and
          // receipt stay all-or-nothing. A throw rolls everything back.
          if (hooks?.afterMemberRemoved !== undefined) {
            await hooks.afterMemberRemoved(client, {
              campaignId: campaign.campaignId,
              userId: removeInput.userId,
              actorId: ctx.actorId,
              requestId: ctx.requestId,
              membership: value,
            });
          }
          await repo.appendAudit(client, {
            campaignId: campaign.campaignId,
            actorId: ctx.actorId,
            kind: "campaign_member_removed",
            summary: "Campaign member removed",
            requestId: ctx.requestId,
          });
          const stored = {
            campaignId: campaign.campaignId,
            value: serializeMember(value),
            idempotencyKey: removeInput.idempotencyKey,
          };
          const inserted = await repo.tryInsertReceipt(client, {
            actorId: ctx.actorId,
            commandKind: REMOVE_MEMBER_KIND,
            idempotencyKey: removeInput.idempotencyKey,
            inputHash,
            campaignId: campaign.campaignId,
            resultJson: stored,
            expiresAt: new Date(now().getTime() + RECEIPT_TTL_MS),
          });
          if (!inserted) {
            // Lost a concurrent race after mutating: roll back so the second
            // application never commits, then replay the winner below.
            throw new ReceiptRace();
          }
          return { committed: true as const, value };
        }).catch(async (error) => {
          if (error instanceof ReceiptRace) {
            const receipt = await repo.loadReceipt(input.pool, receiptKey);
            return { committed: false as const, receipt };
          }
          throw error;
        });

        if ("failure" in outcome) return { ok: false, error: outcome.failure };
        if (outcome.committed) return { ok: true, value: outcome.value };
        return replayRemoval(outcome.receipt ?? null);
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },
  };

  function mapPolicyDenial(
    denial: "not_member" | "not_manager" | "owner_immutable" | "owner_only" | "self_only",
    errs: typeof errors,
  ): CampaignError {
    switch (denial) {
      case "not_member":
        return errs.not_found();
      case "not_manager":
      case "owner_only":
        // Management-role failures collapse to not_found, consistent with
        // update: a non-manager must not learn whether the target membership
        // exists. Only definite caller errors stay bad_request below.
        return errs.not_found();
      case "owner_immutable":
        return errs.bad_request("The campaign owner role cannot be changed or removed. Archive the campaign instead.");
      case "self_only":
        return errs.bad_request("Players may only leave the campaign themselves.");
    }
  }
}
