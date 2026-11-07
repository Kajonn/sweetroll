import type { Pool, PoolClient } from "pg";

import {
  compositionProblem,
  extensionUsage,
  insertCampaignExtension,
  loadCampaignExtensions,
  MAX_EXTENSIONS,
  syncAttachedCharacterExtensions,
  type CampaignExtension,
} from "../characters/campaign-extensions.js";
import { sortExtensionRefs } from "../characters/persistence.js";
import type { RequestContext } from "../systems/authoring.js";
import type { ExtensionAuthoring } from "../systems/extensions.js";
import { hashInput } from "../systems/implementation/authoring/assess.js";
import { createEffectivePackageLoader } from "../systems/implementation/runtime/composition-loader.js";
import {
  createPostgresPublishedExtensionLoader,
  createPostgresPublishedPackageLoader,
} from "../systems/implementation/runtime/package-loader.js";
import type { CampaignError, CampaignResult } from "./index.js";
import type { createCampaignPersistenceRepository } from "./persistence.js";
import { canManageCampaign, canReadCampaign } from "./policy.js";

// System extensions, stage E4 (design 6.8, decisions X7–X10). The GM or a
// co-GM adds or removes extensions of the campaign's system; attached
// characters always use the campaign's set. Adding is safe for every attached
// character (it only adds templates); removal is refused while anything in the
// campaign uses the extension (X9).

export type CampaignExtensionView = {
  extensionId: string;
  versionId: string;
  name: string;
  semanticVersion: string;
  addedBy: "campaign" | "character";
  addedByCharacterId: string | null;
  addedAt: string;
};

export type CampaignExtensionsView = {
  campaignId: string;
  revision: number;
  extensions: CampaignExtensionView[];
};

export type AddCampaignExtensionInput = {
  campaignId: string;
  extensionId: string;
  versionId: string;
  expectedCampaignRevision: number;
  idempotencyKey: string;
};

export type RemoveCampaignExtensionInput = {
  campaignId: string;
  extensionId: string;
  expectedCampaignRevision: number;
  idempotencyKey: string;
};

export interface CampaignExtensionCommands {
  listExtensions(ctx: RequestContext, input: { campaignId: string }): Promise<CampaignResult<CampaignExtensionsView>>;
  addExtension(ctx: RequestContext, input: AddCampaignExtensionInput): Promise<CampaignResult<CampaignExtensionsView>>;
  removeExtension(ctx: RequestContext, input: RemoveCampaignExtensionInput): Promise<CampaignResult<CampaignExtensionsView>>;
}

const ADD_KIND = "campaign_add_extension";
const REMOVE_KIND = "campaign_remove_extension";
const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NEWER = "The campaign has a newer revision. Retry with the latest revision and a new idempotency key.";

type Repo = ReturnType<typeof createCampaignPersistenceRepository>;

class ReceiptRace extends Error {}

export function createCampaignExtensionCommands(deps: {
  pool: Pool;
  repo: Repo;
  now: () => Date;
  newId: () => string;
  authorizeExtensionUse?: ExtensionAuthoring["authorizeExtensionUse"];
}): CampaignExtensionCommands {
  const { pool, repo, now, newId } = deps;
  const loadEffective = createEffectivePackageLoader({
    loadPackage: createPostgresPublishedPackageLoader(pool),
    loadExtensionPackage: createPostgresPublishedExtensionLoader(pool),
  });
  const fail = (code: CampaignError["code"], message: string, latestRevision?: number): CampaignError => ({
    code, message, ...(latestRevision === undefined ? {} : { latestRevision }),
  });
  const notFound = () => fail("not_found", "The requested resource does not exist.");

  async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
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

  async function view(client: PoolClient, campaignId: string, revision: number): Promise<CampaignExtensionsView> {
    const extensions = await loadCampaignExtensions(client, campaignId);
    const names = extensions.length === 0 ? [] : (await client.query<{ id: string; name: string; semantic_version: string }>(
      `SELECT v.id, s.name, v.semantic_version FROM system_versions v JOIN systems s ON s.id = v.system_id
        WHERE v.id = ANY($1::uuid[])`,
      [extensions.map((extension) => extension.versionId)],
    )).rows;
    const byVersion = new Map(names.map((row) => [row.id, row]));
    return {
      campaignId,
      revision,
      extensions: extensions.map((extension: CampaignExtension) => ({
        extensionId: extension.extensionId,
        versionId: extension.versionId,
        name: byVersion.get(extension.versionId)?.name ?? "",
        semanticVersion: byVersion.get(extension.versionId)?.semantic_version ?? "",
        addedBy: extension.addedBy,
        addedByCharacterId: extension.addedByCharacterId,
        addedAt: extension.addedAt.toISOString(),
      })),
    };
  }

  /** Shared revisioned, idempotent GM command shell (mirrors campaign update). */
  async function command(
    ctx: RequestContext,
    kind: string,
    input: { campaignId: string; expectedCampaignRevision: number; idempotencyKey: string },
    inputHash: string,
    mutate: (client: PoolClient, campaign: { campaignId: string; systemVersionId: string; revision: number }) => Promise<CampaignError | null>,
  ): Promise<CampaignResult<CampaignExtensionsView>> {
    if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length === 0 || input.idempotencyKey.length > 256) {
      return { ok: false, error: fail("bad_request", "An idempotency key is required.") };
    }
    if (!Number.isSafeInteger(input.expectedCampaignRevision) || input.expectedCampaignRevision < 1) {
      return { ok: false, error: fail("bad_request", "expectedCampaignRevision must be a positive integer.") };
    }
    const receiptKey = { actorId: ctx.actorId, commandKind: kind, idempotencyKey: input.idempotencyKey };
    const replay = async (receipt: { inputHash: string; resultJson: unknown; expiresAt: Date } | null): Promise<CampaignResult<CampaignExtensionsView>> => {
      if (receipt === null) return { ok: false, error: fail("internal", "An internal error occurred.") };
      if (receipt.inputHash !== inputHash) return { ok: false, error: fail("idempotency_mismatch", "This idempotency key was already used with different input.") };
      if (receipt.expiresAt.getTime() <= now().getTime()) return { ok: false, error: fail("result_unavailable", "The original result is no longer available.") };
      const stored = receipt.resultJson as { campaignId: string; value: CampaignExtensionsView };
      const readable = await transaction(async (client) => {
        const campaign = await repo.openCampaign(client, stored.campaignId);
        const membership = campaign === null ? null : await repo.loadMembership(client, stored.campaignId, ctx.actorId);
        return campaign !== null && canReadCampaign(campaign, membership);
      });
      return readable ? { ok: true, value: stored.value } : { ok: false, error: notFound() };
    };
    try {
      const existing = await repo.loadReceiptWithExpiry(pool, receiptKey);
      if (existing !== null) return await replay(existing);
      const outcome = await transaction(async (client) => {
        const campaign = await repo.lockCampaign(client, input.campaignId);
        const membership = campaign === null ? null : await repo.loadMembership(client, input.campaignId, ctx.actorId);
        const raced = await repo.loadReceiptWithExpiry(client, receiptKey);
        if (raced !== null) return { receipt: raced };
        if (campaign === null || !canReadCampaign(campaign, membership)) return { failure: notFound() };
        if (campaign.status !== "active") {
          return { failure: fail("conflict", "Archived campaigns reject rules changes until recovered.", campaign.revision) };
        }
        if (!canManageCampaign(campaign, membership)) return { failure: notFound() };
        if (campaign.revision !== input.expectedCampaignRevision) return { failure: fail("conflict", NEWER, campaign.revision) };
        const problem = await mutate(client, campaign);
        if (problem !== null) return { failure: problem };
        const bumped = await repo.bumpCampaignRevisionForMembership(client, {
          campaignId: campaign.campaignId, expectedRevision: campaign.revision, now: now(),
        });
        if (bumped === null) throw new Error("campaign changed under lock");
        const value = await view(client, campaign.campaignId, bumped.revision);
        const inserted = await repo.tryInsertReceipt(client, {
          ...receiptKey,
          inputHash,
          campaignId: campaign.campaignId,
          resultJson: { campaignId: campaign.campaignId, value },
          expiresAt: new Date(now().getTime() + RECEIPT_TTL_MS),
        });
        if (!inserted) throw new ReceiptRace();
        return { value };
      }).catch(async (error) => {
        if (error instanceof ReceiptRace) return { receipt: await repo.loadReceiptWithExpiry(pool, receiptKey) };
        throw error;
      });
      if ("failure" in outcome) return { ok: false, error: outcome.failure };
      if ("value" in outcome) return { ok: true, value: outcome.value };
      return await replay(outcome.receipt);
    } catch {
      return { ok: false, error: fail("internal", "An internal error occurred.") };
    }
  }

  async function record(client: PoolClient, ctx: RequestContext, campaignId: string, kind: "extension_added" | "extension_removed", summary: string) {
    await repo.appendAudit(client, { campaignId, actorId: ctx.actorId, kind: `campaign_${kind}`, summary, requestId: ctx.requestId });
    await repo.appendActivity(client, {
      eventId: newId(), campaignId, actorId: ctx.actorId, kind, sourceContentId: null, requestId: ctx.requestId, occurredAt: now(),
    });
  }

  return {
    async listExtensions(ctx, input) {
      try {
        return await transaction(async (client) => {
          const campaign = await repo.openCampaign(client, input.campaignId);
          const membership = campaign === null ? null : await repo.loadMembership(client, input.campaignId, ctx.actorId);
          if (campaign === null || !canReadCampaign(campaign, membership)) return { ok: false, error: notFound() } as const;
          return { ok: true, value: await view(client, campaign.campaignId, campaign.revision) } as const;
        });
      } catch {
        return { ok: false, error: fail("internal", "An internal error occurred.") };
      }
    },

    async addExtension(ctx, input) {
      if (typeof input.extensionId !== "string" || !UUID.test(input.extensionId) || typeof input.versionId !== "string" || !UUID.test(input.versionId)) {
        return { ok: false, error: fail("bad_request", "extensionId and versionId must be UUIDs.") };
      }
      const inputHash = hashInput({ campaignId: input.campaignId, extensionId: input.extensionId, versionId: input.versionId, expectedCampaignRevision: input.expectedCampaignRevision });
      // Decision X2: the GM must be allowed to use the extension. Authorized
      // before the transaction: the authorizer reads through the pool, and
      // waiting for a second connection while holding one can exhaust it.
      const use = deps.authorizeExtensionUse === undefined
        ? null
        : await deps.authorizeExtensionUse(ctx, input.versionId).catch(() => null);
      return command(ctx, ADD_KIND, input, inputHash, async (client, campaign) => {
        // It must also extend the campaign's own system.
        if (use === null) return notFound();
        const base = await client.query<{ system_id: string }>("SELECT system_id FROM system_versions WHERE id = $1", [campaign.systemVersionId]);
        if (!use.ok || use.value.extensionId !== input.extensionId || use.value.baseSystemId !== base.rows[0]?.system_id) return notFound();
        const current = await loadCampaignExtensions(client, campaign.campaignId);
        const existing = current.find((extension) => extension.extensionId === input.extensionId);
        if (existing !== undefined) {
          return fail("conflict", existing.versionId === input.versionId
            ? "The campaign already uses this extension."
            : "The campaign already uses another version of this extension.", campaign.revision);
        }
        if (current.length >= MAX_EXTENSIONS) return fail("bad_request", `A campaign may use at most ${MAX_EXTENSIONS} extensions.`);
        const next = sortExtensionRefs([...current, { extensionId: input.extensionId, versionId: input.versionId }]);
        const problem = await compositionProblem(loadEffective, client, campaign.systemVersionId, next);
        if (problem !== null) return fail("unprocessable", problem);
        await insertCampaignExtension(client, campaign.campaignId, { extensionId: input.extensionId, versionId: input.versionId }, "campaign", null);
        await syncAttachedCharacterExtensions(client, campaign.campaignId, next);
        await record(client, ctx, campaign.campaignId, "extension_added", "Campaign extension added");
        return null;
      });
    },

    async removeExtension(ctx, input) {
      if (typeof input.extensionId !== "string" || !UUID.test(input.extensionId)) {
        return { ok: false, error: fail("bad_request", "extensionId must be a UUID.") };
      }
      const inputHash = hashInput({ campaignId: input.campaignId, extensionId: input.extensionId, expectedCampaignRevision: input.expectedCampaignRevision });
      return command(ctx, REMOVE_KIND, input, inputHash, async (client, campaign) => {
        const current = await loadCampaignExtensions(client, campaign.campaignId);
        if (!current.some((extension) => extension.extensionId === input.extensionId)) return notFound();
        const usage = await extensionUsage(client, campaign.campaignId, input.extensionId);
        if (usage.characterIds.length > 0 || usage.templateIds.length > 0) {
          return fail("conflict", `The extension is still used by ${usage.characterIds.length} character(s) and ${usage.templateIds.length} campaign template(s). Remove those entries first.`, campaign.revision);
        }
        await client.query("DELETE FROM campaign_extensions WHERE campaign_id = $1 AND extension_id = $2", [campaign.campaignId, input.extensionId]);
        await syncAttachedCharacterExtensions(client, campaign.campaignId, current.filter((extension) => extension.extensionId !== input.extensionId));
        await record(client, ctx, campaign.campaignId, "extension_removed", "Campaign extension removed");
        return null;
      });
    },
  };
}
