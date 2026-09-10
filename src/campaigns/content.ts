import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type { RequestContext } from "../systems/authoring.js";
import { hashInput } from "../systems/implementation/authoring/assess.js";
import type { CampaignLimits } from "../platform/config.js";
import type {
  ActivityEventKind,
  ActivityEventRecord,
  CampaignPersistenceRepository,
  ContentAudience,
  ContentRecord,
} from "./persistence.js";
import {
  canAdministerContentSharing,
  canExportCampaign,
  canManageContent,
  canReadContent,
  isActiveMember,
  isGameMaster,
} from "./policy.js";
import type { CampaignError, CampaignResult } from "./index.js";

export type ContentId = string;

export type CreateContentInput = {
  campaignId: string;
  title?: string;
  body?: string;
  tags?: string[];
  /** Defaults to gm_only for GM-created content, owner_only for players. */
  audience?: ContentAudience;
  grantedUserIds?: string[];
  idempotencyKey: string;
};

export type OpenContentInput = {
  contentId: ContentId;
};

export type ListContentInput = {
  campaignId: string;
  limit?: number;
  cursor?: string | null;
};

export type UpdateContentInput = {
  contentId: ContentId;
  title?: string;
  body?: string;
  tags?: string[];
  audience?: ContentAudience;
  expectedContentRevision: number;
  idempotencyKey: string;
};

export type DeleteContentInput = {
  contentId: ContentId;
  expectedContentRevision: number;
  idempotencyKey: string;
};

export type RecoverContentInput = {
  contentId: ContentId;
  expectedContentRevision: number;
  idempotencyKey: string;
};

export type ReplaceGrantsInput = {
  contentId: ContentId;
  grantedUserIds: string[];
  expectedContentRevision: number;
  idempotencyKey: string;
};

export type ListActivityInput = {
  campaignId: string;
  limit?: number;
  cursor?: string | null;
};

export type ExportCampaignInput = {
  campaignId: string;
  idempotencyKey: string;
};

export type ContentSummary = {
  contentId: ContentId;
  campaignId: string;
  creatorId: string;
  audience: ContentAudience;
  title: string;
  tags: string[];
  revision: number;
  accessRevision: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ContentView = ContentSummary & {
  body: string;
  status: "active" | "deleted";
  deletedAt: Date | null;
  /** Present only when the reader is a GM or the creator. */
  grantedUserIds?: string[];
};

export type ListContentResult = {
  content: ContentSummary[];
  nextCursor: string | null;
};

export type ActivityEventView = {
  eventId: string;
  kind: ActivityEventKind;
  actorId: string;
  sourceContentId: string | null;
  requestId: string;
  occurredAt: Date;
};

export type ListActivityResult = {
  events: ActivityEventView[];
  nextCursor: string | null;
};

export type CampaignExportSnapshot = {
  exportVersion: 1;
  campaign: {
    campaignId: string;
    ownerId: string;
    systemVersionId: string;
    title: string;
    description: string;
    status: "active" | "archived";
    revision: number;
    accessRevision: number;
    createdAt: string;
    updatedAt: string;
  };
  members: { userId: string; role: string; status: string; generation: number }[];
  content: {
    contentId: string;
    creatorId: string;
    audience: ContentAudience;
    title: string;
    body: string;
    tags: string[];
    revision: number;
    accessRevision: number;
    createdAt: string;
    updatedAt: string;
    grantedUserIds?: string[];
  }[];
  activity: {
    eventId: string;
    kind: ActivityEventKind;
    actorId: string;
    sourceContentId: string | null;
    requestId: string;
    occurredAt: string;
  }[];
};

const AUDIENCES: ContentAudience[] = ["gm_only", "all_players", "selected_players", "owner_only"];

/**
 * Deep-sorts object keys the way PostgreSQL jsonb stores them (by length,
 * then bytewise), so a snapshot stringifies byte-identical before and after
 * a receipt round-trip. Arrays keep their query order; only keys normalize.
 */
function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.length === b.length ? (a < b ? -1 : a > b ? 1 : 0) : a.length - b.length,
    );
    return Object.fromEntries(entries.map(([key, entry]) => [key, canonicalizeJson(entry)]));
  }
  return value;
}

const CREATE_KIND = "content_create";
const UPDATE_KIND = "content_update";
const DELETE_KIND = "content_delete";
const RECOVER_KIND = "content_recover";
const GRANTS_KIND = "content_replace_grants";
const EXPORT_KIND = "campaign_export";

const RECEIPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NOT_FOUND_MESSAGE = "The requested content does not exist.";
const MISMATCH_MESSAGE = "This idempotency key was already used with different input.";

/**
 * Thrown inside a transaction when the idempotency receipt insert loses a
 * concurrent race after the mutation already ran. Rolling back keeps the
 * spurious row from committing; the caller then replays the winner.
 */
class ReceiptRace extends Error {
  constructor() {
    super("content idempotency receipt raced");
  }
}

export type CreateContentCommandsInput = {
  pool: Pool;
  repo: CampaignPersistenceRepository;
  limits: CampaignLimits;
  now?: (() => Date) | undefined;
  newId?: (() => string) | undefined;
};

export interface ContentCommands {
  createContent(ctx: RequestContext, input: CreateContentInput): Promise<CampaignResult<ContentView>>;
  openContent(ctx: RequestContext, input: OpenContentInput): Promise<CampaignResult<ContentView>>;
  listContent(ctx: RequestContext, input: ListContentInput): Promise<CampaignResult<ListContentResult>>;
  updateContent(ctx: RequestContext, input: UpdateContentInput): Promise<CampaignResult<ContentView>>;
  deleteContent(ctx: RequestContext, input: DeleteContentInput): Promise<CampaignResult<ContentView>>;
  recoverContent(ctx: RequestContext, input: RecoverContentInput): Promise<CampaignResult<ContentView>>;
  replaceGrants(ctx: RequestContext, input: ReplaceGrantsInput): Promise<CampaignResult<ContentView>>;
  listActivity(ctx: RequestContext, input: ListActivityInput): Promise<CampaignResult<ListActivityResult>>;
  exportCampaign(
    ctx: RequestContext,
    input: ExportCampaignInput,
  ): Promise<CampaignResult<CampaignExportSnapshot>>;
}

export function createContentCommands(input: CreateContentCommandsInput): ContentCommands {
  const repo = input.repo;
  const limits = input.limits;
  const now = input.now ?? (() => new Date());
  const newId = input.newId ?? (() => randomUUID());

  const errors = {
    bad_request: (message: string): CampaignError => ({ code: "bad_request", message }),
    not_found: (message: string = NOT_FOUND_MESSAGE): CampaignError => ({ code: "not_found", message }),
    campaign_not_found: (): CampaignError => ({
      code: "not_found",
      message: "The requested campaign does not exist.",
    }),
    mismatch: (): CampaignError => ({ code: "idempotency_mismatch", message: MISMATCH_MESSAGE }),
    conflict: (message: string, latestRevision?: number | null): CampaignError => ({
      code: "conflict",
      message,
      ...(latestRevision === undefined ? {} : { latestRevision }),
    }),
    export_too_large: (message: string): CampaignError => ({ code: "export_too_large", message }),
    result_unavailable: (): CampaignError => ({
      code: "result_unavailable",
      message: "The original result is no longer available.",
    }),
    internal: (): CampaignError => ({ code: "internal", message: "An internal error occurred." }),
  };

  function checkIdempotencyKey(key: unknown): CampaignError | null {
    if (typeof key !== "string" || key.length === 0 || key.length > 256) {
      return errors.bad_request("idempotencyKey must be a non-empty string of at most 256 characters.");
    }
    return null;
  }

  function checkContentRevision(value: unknown): CampaignError | null {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      return errors.bad_request("expectedContentRevision must be a positive integer.");
    }
    return null;
  }

  function checkTitle(title: unknown): CampaignError | null {
    if (typeof title !== "string") return errors.bad_request("title must be a string.");
    if ([...title].length > limits.maxContentTitleLength) {
      return errors.bad_request(`title must be at most ${limits.maxContentTitleLength} characters.`);
    }
    return null;
  }

  function checkBody(body: unknown): CampaignError | null {
    if (typeof body !== "string") return errors.bad_request("body must be a string.");
    if ([...body].length > limits.maxContentBodyLength) {
      return errors.bad_request(`body must be at most ${limits.maxContentBodyLength} characters.`);
    }
    return null;
  }

  function checkTags(tags: unknown): CampaignError | null {
    if (!Array.isArray(tags)) return errors.bad_request("tags must be an array of strings.");
    if (tags.length > limits.maxContentTags) {
      return errors.bad_request(`tags must contain at most ${limits.maxContentTags} entries.`);
    }
    for (const tag of tags) {
      if (typeof tag !== "string" || tag.length === 0) {
        return errors.bad_request("tags must be non-empty strings.");
      }
      if ([...tag].length > limits.maxContentTagLength) {
        return errors.bad_request(`tags must each be at most ${limits.maxContentTagLength} characters.`);
      }
    }
    return null;
  }

  function checkAudience(audience: unknown): CampaignError | null {
    if (typeof audience !== "string" || !AUDIENCES.some((candidate) => candidate === audience)) {
      return errors.bad_request("audience must be gm_only, all_players, selected_players or owner_only.");
    }
    return null;
  }

  function checkGrantedUserIds(userIds: unknown): CampaignError | null {
    if (!Array.isArray(userIds)) return errors.bad_request("grantedUserIds must be an array of user IDs.");
    if (userIds.length > limits.maxContentGrants) {
      return errors.bad_request(`grantedUserIds must contain at most ${limits.maxContentGrants} entries.`);
    }
    const seen = new Set<string>();
    for (const userId of userIds) {
      if (typeof userId !== "string" || userId.length === 0) {
        return errors.bad_request("grantedUserIds must be non-empty strings.");
      }
      if (seen.has(userId)) return errors.bad_request("grantedUserIds must not contain duplicates.");
      seen.add(userId);
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
    occurred: boolean,
  ): { cursor: { at: string; id: string } | null } | { error: CampaignError } {
    if (raw === undefined || raw === null) return { cursor: null };
    try {
      const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
        createdAt?: unknown;
        occurredAt?: unknown;
        id?: unknown;
        scope?: unknown;
      };
      const at = occurred ? parsed.occurredAt : parsed.createdAt;
      if (
        typeof at !== "string" ||
        typeof parsed.id !== "string" ||
        typeof parsed.scope !== "string" ||
        Number.isNaN(Date.parse(at)) ||
        parsed.id.length === 0 ||
        parsed.scope !== expectedScope
      ) {
        return { error: errors.bad_request("cursor is not valid for this query.") };
      }
      return { cursor: { at, id: parsed.id } };
    } catch {
      return { error: errors.bad_request("cursor is malformed.") };
    }
  }

  function encodeCursor(at: string, id: string, scope: string, occurred: boolean): string {
    const payload = occurred ? { occurredAt: at, id, scope } : { createdAt: at, id, scope };
    return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
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

  function toSummary(record: ContentRecord): ContentSummary {
    return {
      contentId: record.contentId,
      campaignId: record.campaignId,
      creatorId: record.creatorId,
      audience: record.audience,
      title: record.title,
      tags: [...record.tags],
      revision: record.revision,
      accessRevision: record.accessRevision,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  function toView(record: ContentRecord, grantedUserIds?: string[]): ContentView {
    return {
      ...toSummary(record),
      body: record.body,
      status: record.status,
      deletedAt: record.deletedAt,
      ...(grantedUserIds === undefined ? {} : { grantedUserIds: [...grantedUserIds] }),
    };
  }

  function serializeView(view: ContentView): unknown {
    return {
      ...view,
      createdAt: view.createdAt.toISOString(),
      updatedAt: view.updatedAt.toISOString(),
      deletedAt: view.deletedAt === null ? null : view.deletedAt.toISOString(),
    };
  }

  function deserializeView(stored: unknown): ContentView {
    const raw = stored as Omit<ContentView, "createdAt" | "updatedAt" | "deletedAt"> & {
      createdAt: string;
      updatedAt: string;
      deletedAt: string | null;
    };
    return {
      ...raw,
      createdAt: new Date(raw.createdAt),
      updatedAt: new Date(raw.updatedAt),
      deletedAt: raw.deletedAt === null ? null : new Date(raw.deletedAt),
    };
  }

  function toEventView(record: ActivityEventRecord): ActivityEventView {
    return {
      eventId: record.eventId,
      kind: record.kind,
      actorId: record.actorId,
      sourceContentId: record.sourceContentId,
      requestId: record.requestId,
      occurredAt: record.occurredAt,
    };
  }

  /**
   * Exact-replay helper with current-membership reauthorization. Reads are
   * denied (not_found) once the caller loses access; mutations use the same
   * per-kind receipt identity as the rest of the campaign module.
   */
  async function resolveReplay(
    ctx: RequestContext,
    options: {
      inputHash: string;
      receipt: { inputHash: string; resultJson: unknown } | null;
      campaignId: string;
    },
  ): Promise<CampaignResult<ContentView>> {
    if (options.receipt === null) return { ok: false, error: errors.internal() };
    if (options.receipt.inputHash !== options.inputHash) return { ok: false, error: errors.mismatch() };
    const stored = options.receipt.resultJson as { contentId?: string; value?: unknown };
    if (typeof stored.contentId !== "string") return { ok: false, error: errors.internal() };
    const denial = await reauthorizeContent(ctx, stored.contentId, options.campaignId, false);
    if (denial !== null) return { ok: false, error: denial };
    return { ok: true, value: deserializeView(stored.value) };
  }

  /**
   * Current-policy reauthorization for one content row: active membership in
   * the owning campaign plus present-tense visibility. Deleted rows stay
   * hidden unless recovery explicitly allows them.
   */
  async function reauthorizeContent(
    ctx: RequestContext,
    contentId: string,
    campaignId: string,
    allowDeleted: boolean,
  ): Promise<CampaignError | null> {
    return await withClient(async (client) => {
      const campaign = await repo.openCampaign(client, campaignId);
      const membership =
        campaign === null ? null : await repo.loadMembership(client, campaignId, ctx.actorId);
      if (campaign === null || !isActiveMember(membership)) return errors.not_found();
      const content = await repo.loadContent(client, contentId);
      if (content === null || content.campaignId !== campaignId) return errors.not_found();
      if (content.status !== "active" && !allowDeleted) return errors.not_found();
      const grants = new Set(await repo.loadContentGrantUserIds(client, contentId));
      if (!canReadContent({ content, membership, grantedUserIds: grants })) return errors.not_found();
      return null;
    });
  }

  async function reauthorizeExport(ctx: RequestContext, campaignId: string): Promise<CampaignError | null> {
    return await withClient(async (client) => {
      const campaign = await repo.openCampaign(client, campaignId);
      const membership =
        campaign === null ? null : await repo.loadMembership(client, campaignId, ctx.actorId);
      if (campaign === null || !canExportCampaign(membership)) return errors.campaign_not_found();
      return null;
    });
  }

  async function recordMutation(
    client: PoolClient,
    options: {
      campaignId: string;
      actorId: string;
      auditKind: string;
      auditSummary: string;
      activityKind: ActivityEventKind;
      contentId: string;
      requestId: string;
      occurredAt: Date;
    },
  ): Promise<void> {
    await repo.appendAudit(client, {
      campaignId: options.campaignId,
      actorId: options.actorId,
      kind: options.auditKind,
      summary: options.auditSummary,
      requestId: options.requestId,
    });
    // Activity rows carry source references only: no bodies, bindings or
    // sheet state. The request ID correlates every event from one command
    // and is intentionally not unique per event.
    await repo.appendActivity(client, {
      eventId: newId(),
      campaignId: options.campaignId,
      actorId: options.actorId,
      kind: options.activityKind,
      sourceContentId: options.contentId,
      requestId: options.requestId,
      occurredAt: options.occurredAt,
    });
  }

  /** Active same-campaign membership check for every grant target. */
  async function checkGrantTargets(
    client: PoolClient,
    campaignId: string,
    userIds: string[],
  ): Promise<CampaignError | null> {
    for (const userId of userIds) {
      const membership = await repo.loadMembership(client, campaignId, userId);
      if (membership === null || !isActiveMember(membership)) {
        return errors.bad_request("Grants must target active members of the same campaign.");
      }
    }
    return null;
  }

  async function viewForReader(
    client: PoolClient,
    ctx: RequestContext,
    record: ContentRecord,
    membershipRole: "owner" | "co_gm" | "player",
  ): Promise<ContentView> {
    const isGm = membershipRole === "owner" || membershipRole === "co_gm";
    if (isGm || record.creatorId === ctx.actorId) {
      return toView(record, await repo.loadContentGrantUserIds(client, record.contentId));
    }
    return toView(record);
  }

  return {
    async createContent(ctx, createInput) {
      try {
        const keyError = checkIdempotencyKey(createInput.idempotencyKey);
        if (keyError !== null) return { ok: false, error: keyError };
        const title = createInput.title ?? "";
        const body = createInput.body ?? "";
        const tags = createInput.tags ?? [];
        const grantedUserIds = createInput.grantedUserIds ?? [];
        const titleError = checkTitle(title);
        if (titleError !== null) return { ok: false, error: titleError };
        const bodyError = checkBody(body);
        if (bodyError !== null) return { ok: false, error: bodyError };
        const tagsError = checkTags(tags);
        if (tagsError !== null) return { ok: false, error: tagsError };
        const grantsError = checkGrantedUserIds(grantedUserIds);
        if (grantsError !== null) return { ok: false, error: grantsError };
        if (createInput.audience !== undefined) {
          const audienceError = checkAudience(createInput.audience);
          if (audienceError !== null) return { ok: false, error: audienceError };
        }

        const inputHash = hashInput({
          campaignId: createInput.campaignId,
          title,
          body,
          tags,
          audience: createInput.audience ?? null,
          grantedUserIds: [...grantedUserIds].sort(),
        });
        const receiptKey = {
          actorId: ctx.actorId,
          commandKind: CREATE_KIND,
          idempotencyKey: createInput.idempotencyKey,
        };

        const preExisting = await repo.loadReceipt(input.pool, receiptKey);
        if (preExisting !== null) {
          return await resolveReplay(ctx, {
            inputHash,
            receipt: preExisting,
            campaignId: createInput.campaignId,
          });
        }

        const outcome = await withTransaction(async (client) => {
          // Content follows the campaign-first lock order: campaign, then
          // the content row, so concurrent membership/content mutations
          // serialize instead of deadlocking.
          const campaign = await repo.lockCampaign(client, createInput.campaignId);
          const membership =
            campaign === null
              ? null
              : await repo.loadMembership(client, createInput.campaignId, ctx.actorId);
          const raced = await repo.loadReceipt(client, receiptKey);
          if (raced !== null) {
            return { committed: false as const, receipt: raced };
          }
          if (campaign === null || !isActiveMember(membership)) {
            return { committed: false as const, failure: errors.campaign_not_found() as CampaignError };
          }
          if (campaign.status !== "active") {
            return {
              committed: false as const,
              failure: errors.conflict("Archived campaigns reject content changes until recovered.", campaign.revision),
            };
          }
          const gm = isGameMaster(membership);
          // Sharing is GM-only: players author owner-only notes and cannot
          // set an audience or name grants.
          if (!gm && (createInput.audience !== undefined && createInput.audience !== "owner_only")) {
            return {
              committed: false as const,
              failure: errors.bad_request("Players may only create owner-only notes."),
            };
          }
          if (!gm && grantedUserIds.length > 0) {
            return {
              committed: false as const,
              failure: errors.bad_request("Players may only create owner-only notes."),
            };
          }
          const audience = createInput.audience ?? (gm ? "gm_only" : "owner_only");
          const targetError = await checkGrantTargets(client, campaign.campaignId, grantedUserIds);
          if (targetError !== null) {
            return { committed: false as const, failure: targetError };
          }
          const timestamp = now();
          const record = await repo.insertContent(client, {
            contentId: newId(),
            campaignId: campaign.campaignId,
            creatorId: ctx.actorId,
            audience,
            title,
            body,
            tags: [...tags],
            now: timestamp,
          });
          if (grantedUserIds.length > 0) {
            const replaced = await repo.replaceContentGrants(client, {
              contentId: record.contentId,
              campaignId: campaign.campaignId,
              userIds: grantedUserIds,
              expectedRevision: record.revision,
              now: timestamp,
            });
            if (replaced === null) {
              return { committed: false as const, failure: errors.internal() as CampaignError };
            }
          }
          const live = await repo.lockContent(client, record.contentId);
          if (live === null) {
            return { committed: false as const, failure: errors.internal() as CampaignError };
          }
          await recordMutation(client, {
            campaignId: campaign.campaignId,
            actorId: ctx.actorId,
            auditKind: "content_created",
            auditSummary: "Campaign content created",
            activityKind: "content_created",
            contentId: record.contentId,
            requestId: ctx.requestId,
            occurredAt: timestamp,
          });
          const value = toView(live, grantedUserIds.length > 0 ? [...grantedUserIds].sort() : []);
          const stored = {
            campaignId: campaign.campaignId,
            contentId: record.contentId,
            value: serializeView(value),
            idempotencyKey: createInput.idempotencyKey,
          };
          const inserted = await repo.tryInsertReceipt(client, {
            actorId: ctx.actorId,
            commandKind: CREATE_KIND,
            idempotencyKey: createInput.idempotencyKey,
            inputHash,
            campaignId: campaign.campaignId,
            resultJson: stored,
            expiresAt: new Date(timestamp.getTime() + RECEIPT_TTL_MS),
          });
          if (!inserted) {
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
        return await resolveReplay(ctx, {
          inputHash,
          receipt: outcome.receipt ?? null,
          campaignId: createInput.campaignId,
        });
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async openContent(ctx, openInput) {
      try {
        const outcome = await withClient(async (client) => {
          const content = await repo.loadContent(client, openInput.contentId);
          if (content === null || content.status !== "active") {
            return { authorized: false as const };
          }
          const campaign = await repo.openCampaign(client, content.campaignId);
          const membership =
            campaign === null ? null : await repo.loadMembership(client, content.campaignId, ctx.actorId);
          if (campaign === null || !isActiveMember(membership)) {
            return { authorized: false as const };
          }
          const grants = new Set(await repo.loadContentGrantUserIds(client, content.contentId));
          if (!canReadContent({ content, membership, grantedUserIds: grants })) {
            return { authorized: false as const };
          }
          return {
            authorized: true as const,
            content,
            membership,
            grants: [...grants],
          };
        });
        if (!outcome.authorized) return { ok: false, error: errors.not_found() };
        const gm = isGameMaster(outcome.membership);
        const view =
          gm || outcome.content.creatorId === ctx.actorId
            ? toView(outcome.content, outcome.grants)
            : toView(outcome.content);
        return { ok: true, value: view };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async listContent(ctx, listInput) {
      try {
        const checked = checkLimit(listInput.limit);
        if ("error" in checked) return { ok: false, error: checked.error };
        const scope = `${listInput.campaignId}:${ctx.actorId}:content`;
        const decoded = decodeCursor(listInput.cursor, scope, false);
        if ("error" in decoded) return { ok: false, error: decoded.error };
        const outcome = await withClient(async (client) => {
          const campaign = await repo.openCampaign(client, listInput.campaignId);
          const membership =
            campaign === null ? null : await repo.loadMembership(client, listInput.campaignId, ctx.actorId);
          if (campaign === null || !isActiveMember(membership)) {
            return { authorized: false as const };
          }
          const rows = await repo.listContentPage(client, {
            campaignId: listInput.campaignId,
            actorId: ctx.actorId,
            isGm: isGameMaster(membership),
            limit: checked.limit,
            cursorCreatedAt: decoded.cursor?.at ?? null,
            cursorId: decoded.cursor?.id ?? null,
          });
          return { authorized: true as const, rows };
        });
        if (!outcome.authorized) return { ok: false, error: errors.campaign_not_found() };
        const hasMore = outcome.rows.length > checked.limit;
        const page = hasMore ? outcome.rows.slice(0, checked.limit) : outcome.rows;
        const last = page[page.length - 1];
        return {
          ok: true,
          value: {
            content: page.map(toSummary),
            nextCursor:
              hasMore && last !== undefined
                ? encodeCursor(last.createdAt.toISOString(), last.contentId, scope, false)
                : null,
          },
        };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async updateContent(ctx, updateInput) {
      try {
        const keyError = checkIdempotencyKey(updateInput.idempotencyKey);
        if (keyError !== null) return { ok: false, error: keyError };
        const revisionError = checkContentRevision(updateInput.expectedContentRevision);
        if (revisionError !== null) return { ok: false, error: revisionError };
        if (
          updateInput.title === undefined &&
          updateInput.body === undefined &&
          updateInput.tags === undefined &&
          updateInput.audience === undefined
        ) {
          return { ok: false, error: errors.bad_request("Nothing to update.") };
        }
        if (updateInput.title !== undefined) {
          const titleError = checkTitle(updateInput.title);
          if (titleError !== null) return { ok: false, error: titleError };
        }
        if (updateInput.body !== undefined) {
          const bodyError = checkBody(updateInput.body);
          if (bodyError !== null) return { ok: false, error: bodyError };
        }
        if (updateInput.tags !== undefined) {
          const tagsError = checkTags(updateInput.tags);
          if (tagsError !== null) return { ok: false, error: tagsError };
        }
        if (updateInput.audience !== undefined) {
          const audienceError = checkAudience(updateInput.audience);
          if (audienceError !== null) return { ok: false, error: audienceError };
        }

        const inputHash = hashInput({
          contentId: updateInput.contentId,
          title: updateInput.title ?? null,
          body: updateInput.body ?? null,
          tags: updateInput.tags ?? null,
          audience: updateInput.audience ?? null,
          expectedContentRevision: updateInput.expectedContentRevision,
        });
        const receiptKey = {
          actorId: ctx.actorId,
          commandKind: UPDATE_KIND,
          idempotencyKey: updateInput.idempotencyKey,
        };

        const preExisting = await repo.loadReceipt(input.pool, receiptKey);
        if (preExisting !== null) {
          const stored = preExisting.resultJson as { campaignId?: string };
          return await resolveReplay(ctx, {
            inputHash,
            receipt: preExisting,
            campaignId: typeof stored.campaignId === "string" ? stored.campaignId : "",
          });
        }

        const outcome = await withTransaction(async (client) => {
          // Campaign-first lock order: resolve the owning campaign with an
          // unlocked read, lock the campaign, then lock the content row.
          // Content is never hard-deleted, so the locked read below only
          // guards against a concurrent impossibility; revision checks
          // still serialize racing patches.
          const known = await repo.loadContent(client, updateInput.contentId);
          if (known === null) {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          const campaign = await repo.lockCampaign(client, known.campaignId);
          const locked = await repo.lockContent(client, known.contentId);
          if (locked === null) {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          const membership =
            campaign === null ? null : await repo.loadMembership(client, locked.campaignId, ctx.actorId);
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
              failure: errors.conflict("Archived campaigns reject content changes until recovered.", campaign.revision),
            };
          }
          if (locked.status !== "active") {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          const grants = new Set(await repo.loadContentGrantUserIds(client, locked.contentId));
          if (!canManageContent({ content: locked, membership, grantedUserIds: grants })) {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          if (
            updateInput.audience !== undefined &&
            updateInput.audience !== locked.audience &&
            !canAdministerContentSharing({ content: locked, membership, grantedUserIds: grants })
          ) {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          if (locked.revision !== updateInput.expectedContentRevision) {
            return {
              committed: false as const,
              failure: errors.conflict(
                "The content has a newer revision. Retry with the latest revision and a new idempotency key.",
                locked.revision,
              ),
            };
          }
          const timestamp = now();
          const updated = await repo.updateContent(client, {
            contentId: locked.contentId,
            title: updateInput.title ?? null,
            body: updateInput.body ?? null,
            tags: updateInput.tags === undefined ? null : [...updateInput.tags],
            audience: updateInput.audience ?? null,
            bumpAccess: updateInput.audience !== undefined && updateInput.audience !== locked.audience,
            expectedRevision: updateInput.expectedContentRevision,
            now: timestamp,
          });
          if (updated === null) {
            return {
              committed: false as const,
              failure: errors.conflict(
                "The content has a newer revision. Retry with the latest revision and a new idempotency key.",
                locked.revision,
              ),
            };
          }
          await recordMutation(client, {
            campaignId: campaign.campaignId,
            actorId: ctx.actorId,
            auditKind: "content_updated",
            auditSummary: "Campaign content updated",
            activityKind: "content_updated",
            contentId: locked.contentId,
            requestId: ctx.requestId,
            occurredAt: timestamp,
          });
          const value = await viewForReader(client, ctx, updated, membership.role);
          const stored = {
            campaignId: campaign.campaignId,
            contentId: locked.contentId,
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
            expiresAt: new Date(timestamp.getTime() + RECEIPT_TTL_MS),
          });
          if (!inserted) {
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
        const stored = (outcome.receipt?.resultJson ?? null) as { campaignId?: string } | null;
        return await resolveReplay(ctx, {
          inputHash,
          receipt: outcome.receipt ?? null,
          campaignId: typeof stored?.campaignId === "string" ? stored.campaignId : "",
        });
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async deleteContent(ctx, deleteInput) {
      try {
        const keyError = checkIdempotencyKey(deleteInput.idempotencyKey);
        if (keyError !== null) return { ok: false, error: keyError };
        const revisionError = checkContentRevision(deleteInput.expectedContentRevision);
        if (revisionError !== null) return { ok: false, error: revisionError };

        const inputHash = hashInput({
          contentId: deleteInput.contentId,
          expectedContentRevision: deleteInput.expectedContentRevision,
        });
        const receiptKey = {
          actorId: ctx.actorId,
          commandKind: DELETE_KIND,
          idempotencyKey: deleteInput.idempotencyKey,
        };

        const preExisting = await repo.loadReceipt(input.pool, receiptKey);
        if (preExisting !== null) {
          const stored = preExisting.resultJson as { campaignId?: string };
          return await resolveReplay(ctx, {
            inputHash,
            receipt: preExisting,
            campaignId: typeof stored.campaignId === "string" ? stored.campaignId : "",
          });
        }

        const outcome = await withTransaction(async (client) => {
          // Campaign-first lock order (see updateContent).
          const known = await repo.loadContent(client, deleteInput.contentId);
          if (known === null) {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          const campaign = await repo.lockCampaign(client, known.campaignId);
          const locked = await repo.lockContent(client, known.contentId);
          if (locked === null) {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          const membership =
            campaign === null ? null : await repo.loadMembership(client, locked.campaignId, ctx.actorId);
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
              failure: errors.conflict("Archived campaigns reject content changes until recovered.", campaign.revision),
            };
          }
          if (locked.status !== "active") {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          const grants = new Set(await repo.loadContentGrantUserIds(client, locked.contentId));
          if (!canManageContent({ content: locked, membership, grantedUserIds: grants })) {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          if (locked.revision !== deleteInput.expectedContentRevision) {
            return {
              committed: false as const,
              failure: errors.conflict(
                "The content has a newer revision. Retry with the latest revision and a new idempotency key.",
                locked.revision,
              ),
            };
          }
          const timestamp = now();
          const updated = await repo.setContentStatus(client, {
            contentId: locked.contentId,
            status: "deleted",
            expectedRevision: deleteInput.expectedContentRevision,
            now: timestamp,
          });
          if (updated === null) {
            return {
              committed: false as const,
              failure: errors.conflict(
                "The content has a newer revision. Retry with the latest revision and a new idempotency key.",
                locked.revision,
              ),
            };
          }
          await recordMutation(client, {
            campaignId: campaign.campaignId,
            actorId: ctx.actorId,
            auditKind: "content_deleted",
            auditSummary: "Campaign content deleted",
            activityKind: "content_deleted",
            contentId: locked.contentId,
            requestId: ctx.requestId,
            occurredAt: timestamp,
          });
          const value = await viewForReader(client, ctx, updated, membership.role);
          const stored = {
            campaignId: campaign.campaignId,
            contentId: locked.contentId,
            value: serializeView(value),
            idempotencyKey: deleteInput.idempotencyKey,
          };
          const inserted = await repo.tryInsertReceipt(client, {
            actorId: ctx.actorId,
            commandKind: DELETE_KIND,
            idempotencyKey: deleteInput.idempotencyKey,
            inputHash,
            campaignId: campaign.campaignId,
            resultJson: stored,
            expiresAt: new Date(timestamp.getTime() + RECEIPT_TTL_MS),
          });
          if (!inserted) {
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
        // Delete replays through the deleted row: reauthorize with deletion
        // allowed, then confirm the stored value rather than re-hiding it.
        const stored = (outcome.receipt?.resultJson ?? null) as {
          campaignId?: string;
          contentId?: string;
          value?: unknown;
        } | null;
        if (outcome.receipt === undefined || outcome.receipt === null || outcome.receipt.inputHash !== inputHash) {
          if (outcome.receipt !== undefined && outcome.receipt !== null) {
            return { ok: false, error: errors.mismatch() };
          }
          return { ok: false, error: errors.internal() };
        }
        if (typeof stored?.campaignId !== "string" || typeof stored?.contentId !== "string") {
          return { ok: false, error: errors.internal() };
        }
        const denial = await reauthorizeContent(ctx, stored.contentId, stored.campaignId, true);
        if (denial !== null) return { ok: false, error: denial };
        return { ok: true, value: deserializeView(stored.value) };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async recoverContent(ctx, recoverInput) {
      try {
        const keyError = checkIdempotencyKey(recoverInput.idempotencyKey);
        if (keyError !== null) return { ok: false, error: keyError };
        const revisionError = checkContentRevision(recoverInput.expectedContentRevision);
        if (revisionError !== null) return { ok: false, error: revisionError };

        const inputHash = hashInput({
          contentId: recoverInput.contentId,
          expectedContentRevision: recoverInput.expectedContentRevision,
        });
        const receiptKey = {
          actorId: ctx.actorId,
          commandKind: RECOVER_KIND,
          idempotencyKey: recoverInput.idempotencyKey,
        };

        const preExisting = await repo.loadReceipt(input.pool, receiptKey);
        if (preExisting !== null) {
          const stored = preExisting.resultJson as { campaignId?: string };
          return await resolveReplay(ctx, {
            inputHash,
            receipt: preExisting,
            campaignId: typeof stored.campaignId === "string" ? stored.campaignId : "",
          });
        }

        const outcome = await withTransaction(async (client) => {
          // Campaign-first lock order (see updateContent).
          const known = await repo.loadContent(client, recoverInput.contentId);
          if (known === null) {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          const campaign = await repo.lockCampaign(client, known.campaignId);
          const locked = await repo.lockContent(client, known.contentId);
          if (locked === null) {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          const membership =
            campaign === null ? null : await repo.loadMembership(client, locked.campaignId, ctx.actorId);
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
              failure: errors.conflict("Archived campaigns reject content changes until recovered.", campaign.revision),
            };
          }
          if (locked.status !== "deleted") {
            return {
              committed: false as const,
              failure: errors.conflict("The content is already active.", locked.revision),
            };
          }
          // Recovery reuses the ordinary visibility policy: the deleted row
          // is evaluated as if it were active, so only its creator or a GM
          // who could read it may restore it.
          const grants = new Set(await repo.loadContentGrantUserIds(client, locked.contentId));
          const visibleAsActive = { ...locked, status: "active" as const };
          if (!canManageContent({ content: visibleAsActive, membership, grantedUserIds: grants })) {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          if (locked.revision !== recoverInput.expectedContentRevision) {
            return {
              committed: false as const,
              failure: errors.conflict(
                "The content has a newer revision. Retry with the latest revision and a new idempotency key.",
                locked.revision,
              ),
            };
          }
          const timestamp = now();
          const updated = await repo.setContentStatus(client, {
            contentId: locked.contentId,
            status: "active",
            expectedRevision: recoverInput.expectedContentRevision,
            now: timestamp,
          });
          if (updated === null) {
            return {
              committed: false as const,
              failure: errors.conflict(
                "The content has a newer revision. Retry with the latest revision and a new idempotency key.",
                locked.revision,
              ),
            };
          }
          await recordMutation(client, {
            campaignId: campaign.campaignId,
            actorId: ctx.actorId,
            auditKind: "content_recovered",
            auditSummary: "Campaign content recovered",
            activityKind: "content_recovered",
            contentId: locked.contentId,
            requestId: ctx.requestId,
            occurredAt: timestamp,
          });
          const value = await viewForReader(client, ctx, updated, membership.role);
          const stored = {
            campaignId: campaign.campaignId,
            contentId: locked.contentId,
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
            expiresAt: new Date(timestamp.getTime() + RECEIPT_TTL_MS),
          });
          if (!inserted) {
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
        const stored = (outcome.receipt?.resultJson ?? null) as { campaignId?: string } | null;
        return await resolveReplay(ctx, {
          inputHash,
          receipt: outcome.receipt ?? null,
          campaignId: typeof stored?.campaignId === "string" ? stored.campaignId : "",
        });
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async replaceGrants(ctx, grantsInput) {
      try {
        const keyError = checkIdempotencyKey(grantsInput.idempotencyKey);
        if (keyError !== null) return { ok: false, error: keyError };
        const revisionError = checkContentRevision(grantsInput.expectedContentRevision);
        if (revisionError !== null) return { ok: false, error: revisionError };
        const targetsError = checkGrantedUserIds(grantsInput.grantedUserIds);
        if (targetsError !== null) return { ok: false, error: targetsError };

        const sortedTargets = [...grantsInput.grantedUserIds].sort();
        const inputHash = hashInput({
          contentId: grantsInput.contentId,
          grantedUserIds: sortedTargets,
          expectedContentRevision: grantsInput.expectedContentRevision,
        });
        const receiptKey = {
          actorId: ctx.actorId,
          commandKind: GRANTS_KIND,
          idempotencyKey: grantsInput.idempotencyKey,
        };

        const preExisting = await repo.loadReceipt(input.pool, receiptKey);
        if (preExisting !== null) {
          const stored = preExisting.resultJson as { campaignId?: string };
          return await resolveReplay(ctx, {
            inputHash,
            receipt: preExisting,
            campaignId: typeof stored.campaignId === "string" ? stored.campaignId : "",
          });
        }

        const outcome = await withTransaction(async (client) => {
          // Campaign-first lock order (see updateContent).
          const known = await repo.loadContent(client, grantsInput.contentId);
          if (known === null) {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          const campaign = await repo.lockCampaign(client, known.campaignId);
          const locked = await repo.lockContent(client, known.contentId);
          if (locked === null) {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          const membership =
            campaign === null ? null : await repo.loadMembership(client, locked.campaignId, ctx.actorId);
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
              failure: errors.conflict("Archived campaigns reject content changes until recovered.", campaign.revision),
            };
          }
          if (locked.status !== "active") {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          // GM-only sharing administration on a currently readable note: an
          // inaccessible owner-only note cannot be shared by guessing its ID.
          const grants = new Set(await repo.loadContentGrantUserIds(client, locked.contentId));
          if (!canAdministerContentSharing({ content: locked, membership, grantedUserIds: grants })) {
            return { committed: false as const, failure: errors.not_found() as CampaignError };
          }
          const targetError = await checkGrantTargets(client, campaign.campaignId, sortedTargets);
          if (targetError !== null) {
            return { committed: false as const, failure: targetError };
          }
          if (locked.revision !== grantsInput.expectedContentRevision) {
            return {
              committed: false as const,
              failure: errors.conflict(
                "The content has a newer revision. Retry with the latest revision and a new idempotency key.",
                locked.revision,
              ),
            };
          }
          const timestamp = now();
          const updated = await repo.replaceContentGrants(client, {
            contentId: locked.contentId,
            campaignId: campaign.campaignId,
            userIds: sortedTargets,
            expectedRevision: grantsInput.expectedContentRevision,
            now: timestamp,
          });
          if (updated === null) {
            return {
              committed: false as const,
              failure: errors.conflict(
                "The content has a newer revision. Retry with the latest revision and a new idempotency key.",
                locked.revision,
              ),
            };
          }
          await recordMutation(client, {
            campaignId: campaign.campaignId,
            actorId: ctx.actorId,
            auditKind: "content_grants_replaced",
            auditSummary: "Campaign content grants replaced",
            activityKind: "content_grants_replaced",
            contentId: locked.contentId,
            requestId: ctx.requestId,
            occurredAt: timestamp,
          });
          const value = await viewForReader(client, ctx, updated, membership.role);
          const stored = {
            campaignId: campaign.campaignId,
            contentId: locked.contentId,
            value: serializeView(value),
            idempotencyKey: grantsInput.idempotencyKey,
          };
          const inserted = await repo.tryInsertReceipt(client, {
            actorId: ctx.actorId,
            commandKind: GRANTS_KIND,
            idempotencyKey: grantsInput.idempotencyKey,
            inputHash,
            campaignId: campaign.campaignId,
            resultJson: stored,
            expiresAt: new Date(timestamp.getTime() + RECEIPT_TTL_MS),
          });
          if (!inserted) {
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
        const stored = (outcome.receipt?.resultJson ?? null) as { campaignId?: string } | null;
        return await resolveReplay(ctx, {
          inputHash,
          receipt: outcome.receipt ?? null,
          campaignId: typeof stored?.campaignId === "string" ? stored.campaignId : "",
        });
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async listActivity(ctx, activityInput) {
      try {
        const checked = checkLimit(activityInput.limit);
        if ("error" in checked) return { ok: false, error: checked.error };
        const scope = `${activityInput.campaignId}:${ctx.actorId}:activity`;
        const decoded = decodeCursor(activityInput.cursor, scope, true);
        if ("error" in decoded) return { ok: false, error: decoded.error };
        const outcome = await withClient(async (client) => {
          const campaign = await repo.openCampaign(client, activityInput.campaignId);
          const membership =
            campaign === null
              ? null
              : await repo.loadMembership(client, activityInput.campaignId, ctx.actorId);
          if (campaign === null || !isActiveMember(membership)) {
            return { authorized: false as const };
          }
          const rows = await repo.listActivityPage(client, {
            campaignId: activityInput.campaignId,
            actorId: ctx.actorId,
            isGm: isGameMaster(membership),
            limit: checked.limit,
            cursorOccurredAt: decoded.cursor?.at ?? null,
            cursorId: decoded.cursor?.id ?? null,
          });
          return { authorized: true as const, rows };
        });
        if (!outcome.authorized) return { ok: false, error: errors.campaign_not_found() };
        const hasMore = outcome.rows.length > checked.limit;
        const page = hasMore ? outcome.rows.slice(0, checked.limit) : outcome.rows;
        const last = page[page.length - 1];
        return {
          ok: true,
          value: {
            events: page.map(toEventView),
            nextCursor:
              hasMore && last !== undefined
                ? encodeCursor(last.occurredAt.toISOString(), last.eventId, scope, true)
                : null,
          },
        };
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },

    async exportCampaign(ctx, exportInput) {
      try {
        const keyError = checkIdempotencyKey(exportInput.idempotencyKey);
        if (keyError !== null) return { ok: false, error: keyError };

        const inputHash = hashInput({ campaignId: exportInput.campaignId });
        const receiptKey = {
          actorId: ctx.actorId,
          commandKind: EXPORT_KIND,
          idempotencyKey: exportInput.idempotencyKey,
        };

        const replayExport = async (
          receipt: { inputHash: string; resultJson: unknown; expiresAt: Date } | null,
        ): Promise<CampaignResult<CampaignExportSnapshot>> => {
          if (receipt === null) return { ok: false, error: errors.internal() };
          if (receipt.inputHash !== inputHash) return { ok: false, error: errors.mismatch() };
          if (receipt.expiresAt.getTime() <= now().getTime()) {
            return { ok: false, error: errors.result_unavailable() };
          }
          const stored = receipt.resultJson as { campaignId?: string; value?: unknown };
          if (typeof stored.campaignId !== "string") return { ok: false, error: errors.internal() };
          const denial = await reauthorizeExport(ctx, stored.campaignId);
          if (denial !== null) return { ok: false, error: denial };
          return { ok: true, value: stored.value as CampaignExportSnapshot };
        };

        const preExisting = await repo.loadReceiptWithExpiry(input.pool, receiptKey);
        if (preExisting !== null) {
          return await replayExport(preExisting);
        }

        // One read-only snapshot for every projected source: members,
        // visible content, visible activity and their grants share the same
        // consistent view, so the export never mixes generations.
        const snapshot = await withClient(async (client) => {
          const campaign = await repo.openCampaign(client, exportInput.campaignId);
          const membership =
            campaign === null
              ? null
              : await repo.loadMembership(client, exportInput.campaignId, ctx.actorId);
          if (campaign === null || !canExportCampaign(membership)) {
            return { authorized: false as const };
          }
          const gm = isGameMaster(membership);
          const bound = limits.exportMaxRecords + 1;
          const members = await repo.loadMembershipsForExport(client, campaign.campaignId);
          // Archived campaigns still export: reads stay available while
          // archived, and the snapshot records the archived status.
          const content = await repo.loadVisibleContentForExport(client, {
            campaignId: campaign.campaignId,
            actorId: ctx.actorId,
            isGm: gm,
            limit: bound,
          });
          const activity = await repo.loadVisibleActivityForExport(client, {
            campaignId: campaign.campaignId,
            actorId: ctx.actorId,
            isGm: gm,
            limit: bound,
          });
          const grants = await repo.loadGrantsForContents(
            client,
            content.map((record) => record.contentId),
          );
          return { authorized: true as const, campaign, members, content, activity, grants };
        });
        if (!snapshot.authorized) return { ok: false, error: errors.campaign_not_found() };

        const recordCount =
          1 + snapshot.members.length + snapshot.content.length + snapshot.activity.length;
        if (
          snapshot.content.length > limits.exportMaxRecords ||
          snapshot.activity.length > limits.exportMaxRecords ||
          recordCount > limits.exportMaxRecords
        ) {
          return {
            ok: false,
            error: errors.export_too_large(
              `The campaign export exceeds the configured limit of ${limits.exportMaxRecords} records.`,
            ),
          };
        }

        // Deterministic projection: fixed key order, ID/occurred-at ordering
        // from the queries, ISO timestamps, no random IDs, no wall-clock
        // stamps, no receipts, no token hashes, no credentials, no character
        // payloads (Task 8 extends this projection to campaign rolls).
        // Canonicalized so the bytes survive the jsonb receipt round-trip
        // unchanged: same key plus same input always replays byte-identical.
        const value = canonicalizeJson({
          exportVersion: 1,          campaign: {
            campaignId: snapshot.campaign.campaignId,
            ownerId: snapshot.campaign.ownerId,
            systemVersionId: snapshot.campaign.systemVersionId,
            title: snapshot.campaign.title,
            description: snapshot.campaign.description,
            status: snapshot.campaign.status,
            revision: snapshot.campaign.revision,
            accessRevision: snapshot.campaign.accessRevision,
            createdAt: snapshot.campaign.createdAt.toISOString(),
            updatedAt: snapshot.campaign.updatedAt.toISOString(),
          },
          members: snapshot.members.map((member) => ({
            userId: member.userId,
            role: member.role,
            status: member.status,
            generation: member.generation,
          })),
          content: snapshot.content.map((record) => ({
            contentId: record.contentId,
            creatorId: record.creatorId,
            audience: record.audience,
            title: record.title,
            body: record.body,
            tags: [...record.tags],
            revision: record.revision,
            accessRevision: record.accessRevision,
            createdAt: record.createdAt.toISOString(),
            updatedAt: record.updatedAt.toISOString(),
            ...(record.audience === "selected_players"
              ? { grantedUserIds: [...(snapshot.grants.get(record.contentId) ?? [])] }
              : {}),
          })),
          activity: snapshot.activity.map((event) => ({
            eventId: event.eventId,
            kind: event.kind,
            actorId: event.actorId,
            sourceContentId: event.sourceContentId,
            requestId: event.requestId,
            occurredAt: event.occurredAt.toISOString(),
          })),
        }) as CampaignExportSnapshot;
        const payloadBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
        if (payloadBytes > limits.exportMaxBytes) {
          return {
            ok: false,
            error: errors.export_too_large(
              `The campaign export exceeds the configured limit of ${limits.exportMaxBytes} bytes.`,
            ),
          };
        }

        const timestamp = now();
        const stored = {
          campaignId: snapshot.campaign.campaignId,
          value,
          idempotencyKey: exportInput.idempotencyKey,
        };
        const outcome = await withTransaction(async (client) => {
          const raced = await repo.loadReceiptWithExpiry(client, receiptKey);
          if (raced !== null) {
            return { committed: false as const, receipt: raced };
          }
          const inserted = await repo.tryInsertReceipt(client, {
            actorId: ctx.actorId,
            commandKind: EXPORT_KIND,
            idempotencyKey: exportInput.idempotencyKey,
            inputHash,
            campaignId: snapshot.campaign.campaignId,
            resultJson: stored,
            expiresAt: new Date(timestamp.getTime() + RECEIPT_TTL_MS),
          });
          if (!inserted) {
            throw new ReceiptRace();
          }
          return { committed: true as const, value };
        }).catch(async (error) => {
          if (error instanceof ReceiptRace) {
            const receipt = await repo.loadReceiptWithExpiry(input.pool, receiptKey);
            return { committed: false as const, receipt };
          }
          throw error;
        });

        if (outcome.committed) return { ok: true, value: outcome.value };
        return await replayExport(outcome.receipt ?? null);
      } catch {
        return { ok: false, error: errors.internal() };
      }
    },
  };
}
