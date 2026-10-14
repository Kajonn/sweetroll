import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { RequestContext } from "../systems/authoring.js";
import { hashInput } from "../systems/implementation/authoring/assess.js";
import type { TemplateKind } from "../systems/implementation/package/schema/index.js";
import type { CampaignError, CampaignResult } from "./index.js";
import { createCampaignPersistenceRepository } from "./persistence.js";
import { isActiveMember, isGameMaster } from "./policy.js";
import { createTemplateRepository } from "./templatePersistence.js";

export type TemplateContent = {
  name: string;
  description?: string;
  notes?: string;
  defaultQuantity?: number;
};
export type CampaignTemplateView = {
  templateId: string;
  campaignId: string;
  creatorId: string;
  kind: TemplateKind;
  audience: "all_players";
  status: "active" | "archived";
  revision: number;
  contentRevision: number;
  content: TemplateContent;
  createdAt: string;
  updatedAt: string;
};
export type TemplateLocation = { campaignId: string; templateId: string };
export type TemplateMutation = TemplateLocation & {
  expectedTemplateRevision: number;
  idempotencyKey: string;
};
export type CreateTemplate = {
  campaignId: string;
  kind: TemplateKind;
  content: TemplateContent;
  expectedTemplateRevision: number;
  idempotencyKey: string;
};
export type ListTemplates = {
  campaignId: string;
  status?: "active" | "archived";
  kind?: TemplateKind;
  limit?: number;
  cursor?: string | null;
};
export type TemplatePage = {
  templates: CampaignTemplateView[];
  nextCursor: string | null;
};

export function validateTemplateContent(
  kind: string,
  content: unknown,
): string | null {
  if (!["item", "spell", "talent", "effect"].includes(kind))
    return "Unknown template kind.";
  if (typeof content !== "object" || content === null || Array.isArray(content))
    return "Template content must be an object.";
  const values = content as Record<string, unknown>;
  for (const [key, value] of Object.entries(values)) {
    if (key === "defaultQuantity") {
      if (
        kind !== "item" ||
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 1
      )
        return "Only items accept a positive safe integer default quantity.";
    } else if (
      !["name", "description", "notes"].includes(key) ||
      typeof value !== "string" ||
      value.length > (key === "name" ? 200 : 2000)
    ) {
      return "Templates accept bounded name, description and notes only.";
    }
  }
  return typeof values.name === "string" && values.name.trim().length > 0
    ? null
    : "Template name is required.";
}

class TemplateFailure extends Error {
  constructor(readonly error: CampaignError) {
    super(error.message);
  }
}
function fail(code: CampaignError["code"], message: string): never {
  throw new TemplateFailure({ code, message });
}

/** Campaign-owned commands. Campaign lock serializes authority and catalog/placement races. */
export function createTemplateCommands(input: {
  pool: Pool;
  now?: () => Date;
  newId?: () => string;
}) {
  const repo = createCampaignPersistenceRepository(input.pool);
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
          error instanceof TemplateFailure
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
    gm: boolean,
    write: boolean,
  ) {
    const campaign = await repo.lockCampaign(client, campaignId);
    const member =
      campaign === null
        ? null
        : await repo.loadMembership(client, campaignId, ctx.actorId);
    if (campaign === null || !isActiveMember(member))
      fail("not_found", "The requested campaign does not exist.");
    if (gm && !isGameMaster(member))
      fail(
        "forbidden",
        "Only an active GM or co-GM can manage campaign templates.",
      );
    if (write && campaign.status !== "active")
      fail("conflict", "Recover the campaign before editing its templates.");
    return member;
  }
  async function mutate(
    ctx: RequestContext,
    operation: "create" | "update" | "archive" | "recover",
    body: CreateTemplate | (TemplateMutation & { content?: TemplateContent }),
  ) {
    return transaction(async (client) => {
      await authorize(client, ctx, body.campaignId, true, true);
      const key = {
        actorId: ctx.actorId,
        commandKind: `campaign_template_${operation}`,
        idempotencyKey: body.idempotencyKey,
      };
      if (
        typeof body.idempotencyKey !== "string" ||
        body.idempotencyKey.length === 0 ||
        body.idempotencyKey.length > 200
      )
        fail("bad_request", "An idempotency key is required.");
      const inputHash = hashInput(body);
      // Recheck the receipt only after acquiring the campaign lock. Concurrent identical calls serialize.
      const receipt = await repo.loadReceiptWithExpiry(client, key);
      if (receipt !== null) {
        if (
          receipt.inputHash !== inputHash ||
          receipt.campaignId !== body.campaignId
        )
          fail(
            "idempotency_mismatch",
            "This idempotency key was already used with different input.",
          );
        if (receipt.expiresAt <= now())
          fail("result_unavailable", "The saved result has expired.");
        return receipt.resultJson as CampaignTemplateView;
      }
      if (
        !Number.isSafeInteger(body.expectedTemplateRevision) ||
        body.expectedTemplateRevision < 0
      )
        fail("bad_request", "An expected template revision is required.");
      let value: CampaignTemplateView;
      if (operation === "create" && "kind" in body) {
        if (body.expectedTemplateRevision !== 0)
          fail("conflict", "A new template must expect revision zero.");
        const invalid = validateTemplateContent(body.kind, body.content);
        if (invalid !== null) fail("bad_request", invalid);
        if ((await catalog.count(client, body.campaignId)) >= 500)
          fail("too_large", "Campaign template limit reached (500).");
        value = await catalog.create(client, {
          templateId: newId(),
          campaignId: body.campaignId,
          creatorId: ctx.actorId,
          kind: body.kind,
          content: body.content,
        });
      } else {
        if (!("templateId" in body))
          fail("bad_request", "Template ID required.");
        const current = await catalog.read(client, body);
        if (current === null)
          fail("not_found", "The requested template does not exist.");
        if (current.revision !== body.expectedTemplateRevision)
          fail(
            "conflict",
            "The template has changed. Refresh and explicitly review before retrying.",
          );
        if (
          current.status !== (operation === "recover" ? "archived" : "active")
        )
          fail("conflict", "The template lifecycle has changed.");
        if (operation === "update") {
          const invalid = validateTemplateContent(current.kind, body.content);
          if (invalid !== null) fail("bad_request", invalid);
          value = await catalog.update(
            client,
            current,
            body.content! as TemplateContent,
            ctx.actorId,
          );
        } else
          value = await catalog.setStatus(
            client,
            current,
            operation === "archive" ? "archived" : "active",
          );
      }
      await repo.appendAudit(client, {
        campaignId: body.campaignId,
        actorId: ctx.actorId,
        kind: `template_${operation}`,
        summary: "Campaign template changed",
        requestId: ctx.requestId,
      });
      await repo.appendActivity(client, {
        eventId: newId(),
        campaignId: body.campaignId,
        actorId: ctx.actorId,
        kind: `template_${operation}`,
        sourceContentId: null,
        requestId: ctx.requestId,
        occurredAt: now(),
      });
      const inserted = await repo.tryInsertReceipt(client, {
        ...key,
        inputHash,
        campaignId: body.campaignId,
        resultJson: value,
        expiresAt: new Date(now().getTime() + 30 * 86400000),
      });
      if (!inserted)
        fail(
          "idempotency_mismatch",
          "This idempotency key was already used in another campaign.",
        );
      return value;
    });
  }
  return {
    createTemplate: (ctx: RequestContext, body: CreateTemplate) =>
      mutate(ctx, "create", body),
    updateTemplate: (
      ctx: RequestContext,
      body: TemplateMutation & { content: TemplateContent },
    ) => mutate(ctx, "update", body),
    archiveTemplate: (ctx: RequestContext, body: TemplateMutation) =>
      mutate(ctx, "archive", body),
    recoverTemplate: (ctx: RequestContext, body: TemplateMutation) =>
      mutate(ctx, "recover", body),
    openTemplate: (ctx: RequestContext, body: TemplateLocation) =>
      transaction(async (client) => {
        const member = await authorize(
          client,
          ctx,
          body.campaignId,
          false,
          false,
        );
        const view = await catalog.read(client, body);
        if (
          view === null ||
          (view.status === "archived" && !isGameMaster(member))
        )
          fail("not_found", "The requested template does not exist.");
        return view;
      }),
    listTemplates: (
      ctx: RequestContext,
      body: ListTemplates,
    ): Promise<CampaignResult<TemplatePage>> =>
      transaction(async (client) => {
        await authorize(
          client,
          ctx,
          body.campaignId,
          body.status === "archived",
          false,
        );
        try {
          return await catalog.page(client, body);
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "bad_request"
          )
            fail("bad_request", error.message);
          throw error;
        }
      }),
  };
}
export type TemplateCommands = ReturnType<typeof createTemplateCommands>;
