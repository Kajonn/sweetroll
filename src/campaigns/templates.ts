import {canReadTemplate,templateReadScope,type TemplateAudience,type TemplateGrant} from "./templatePolicy.js";
import {
  resolveTemplateBase,
  type PublishedPackageLoader,
} from "../systems/templates.js";
import type { DerivedBase } from "../systems/implementation/package/schema/dynamic.js";
import type { ObjectTemplateV1 } from "../systems/implementation/package/schema/index.js";
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
  base?: DerivedBase;
  defaultValues?: Record<string, unknown>;
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
  audience: TemplateAudience;
  grants:TemplateGrant[];
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
export type TemplateSharing={audience:TemplateAudience;grants:TemplateGrant[]};
export type CreateTemplate = {
  audience?:TemplateAudience;
  grants?:TemplateGrant[];
  baseTemplateId?: string;
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
    if (key === "defaultValues") {
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        Object.keys(value).length > 100
      )
        return "Invalid typed defaults.";
    } else if (key === "defaultQuantity") {
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

/** Strict data-only input shared by direct blank creation and proposal approval. */
export function validateBlankTemplateContent(kind: string, content: unknown): string | null {
  const invalid = validateTemplateContent(kind, content);
  if (invalid) return invalid;
  return Object.keys(content as object).some(key => !["name", "description", "notes", "defaultQuantity"].includes(key))
    ? "Blank templates accept presentation text and item quantity only." : null;
}
/** Caller must hold the campaign lock; every write uses the caller's transaction. */
export async function publishBlankTemplate(
  client: PoolClient,
  catalog: ReturnType<typeof createTemplateRepository>,
  body: Parameters<ReturnType<typeof createTemplateRepository>["create"]>[1],
  reject: (code: CampaignError["code"], message: string) => never,
): Promise<CampaignTemplateView> {
  const invalid = validateBlankTemplateContent(body.kind, body.content);
  if (invalid) reject("bad_request", invalid);
  if (await catalog.count(client, body.campaignId) >= 500)
    reject("too_large", "Campaign template limit reached (500).");
  return catalog.create(client, body);
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
  maxGrants?:number;
  loadTemplatePackage?: PublishedPackageLoader;
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
    return { member, campaign };
  }
  async function mutate(
    ctx: RequestContext,
    operation: "create" | "update" | "archive" | "recover" | "sharing",
    body: CreateTemplate | (TemplateMutation & { content?: TemplateContent;audience?:TemplateAudience;grants?:TemplateGrant[] }),
  ) {
    return transaction(async (client) => {
      const { campaign } = await authorize(
        client,
        ctx,
        body.campaignId,
        true,
        true,
      );
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
      async function contentWithBase(
        kind: TemplateKind,
        content: TemplateContent,
        baseId?: string,
      ): Promise<TemplateContent> {
        if (baseId !== undefined && !/^[a-z][a-z0-9_]{0,63}$/.test(baseId))
          fail("bad_request", "Invalid base template ID.");
        if (baseId === undefined) {
          if (content.defaultValues !== undefined)
            fail(
              "bad_request",
              "Blank templates cannot contain typed defaults.",
            );
          return content;
        }
        const pkg = await input.loadTemplatePackage?.(
          campaign.systemVersionId,
          client,
        );
        if (!pkg || pkg.versionId !== campaign.systemVersionId)
          fail("bad_request", "The pinned system template is unavailable.");
        const base = resolveTemplateBase(
          pkg,
          baseId,
          kind,
          content.defaultValues ?? {},
        );
        if (!base)
          fail(
            "bad_request",
            "The base is unknown, has unsupported field dependencies, or has invalid writable defaults. Choose a pinned base whose actions use carrying-character and writable entry fields.",
          );
        return {
          ...content,
          base: {
            versionId: pkg.versionId,
            packageChecksum: pkg.integrity.checksum,
            templateId: base.id,
          },
        };
      }
      async function validateSharing(audience:unknown, grants:unknown):Promise<TemplateSharing> {
        if(!['all_players','gm_only','selected_players'].includes(audience as string) || !Array.isArray(grants) || grants.length>Math.min(100,input.maxGrants ?? 100) || (audience==='selected_players'?grants.length===0:grants.length!==0)) fail('bad_request','Invalid template audience or recipients.');
        const ids=new Set<string>();
        for(const grant of grants as TemplateGrant[]) {
          if(!grant || Object.keys(grant).some(k=>!['userId','generation'].includes(k)) || typeof grant.userId!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(grant.userId) || !Number.isSafeInteger(grant.generation) || grant.generation<1 || ids.has(grant.userId)) fail('bad_request','Invalid template recipient.');
          ids.add(grant.userId);
          const member=await repo.loadMembership(client,body.campaignId,grant.userId);
          if(!isActiveMember(member)||member.role!=='player'||member.generation!==grant.generation) fail('bad_request','Choose current active players.');
        }
        return {audience:audience as TemplateAudience,grants:grants as TemplateGrant[]};
      }
      let value: CampaignTemplateView;
      if (operation === "create" && "kind" in body) {
        if (body.expectedTemplateRevision !== 0)
          fail("conflict", "A new template must expect revision zero.");
        const invalid = validateTemplateContent(body.kind, body.content);
        if (invalid !== null) fail("bad_request", invalid);
        const sharing=await validateSharing(body.audience ?? "all_players",body.grants ?? []);
        const creation = {
          templateId: newId(), campaignId: body.campaignId, creatorId: ctx.actorId,
          kind: body.kind,
          content: await contentWithBase(body.kind, body.content, body.baseTemplateId),
        };
        if (body.baseTemplateId === undefined) value = await publishBlankTemplate(client, catalog, creation, fail);
        else {
          if (await catalog.count(client, body.campaignId) >= 500) fail("too_large", "Campaign template limit reached (500).");
          value = await catalog.create(client, creation);
        }
        if(sharing.audience!=='all_players') value=await catalog.setSharing(client,value,sharing.audience,sharing.grants,false);
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
        if(operation==='sharing') {
          const sharing=await validateSharing(body.audience,body.grants ?? []);
          value=await catalog.setSharing(client,current,sharing.audience,sharing.grants);
        } else if (operation === "update") {
          const invalid = validateTemplateContent(current.kind, body.content);
          if (invalid !== null) fail("bad_request", invalid);
          value = await catalog.update(
            client,
            current,
            await contentWithBase(
              current.kind,
              body.content!,
              current.content.base?.templateId,
            ),
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
      if(value.audience === "all_players" && operation !== "sharing") await repo.appendActivity(client, {
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
    listTemplateBases: (
      ctx: RequestContext,
      body: { campaignId: string },
    ): Promise<CampaignResult<ObjectTemplateV1[]>> =>
      transaction(async (client) => {
        const { campaign } = await authorize(
          client,
          ctx,
          body.campaignId,
          true,
          false,
        );
        const pkg = await input.loadTemplatePackage?.(
          campaign.systemVersionId,
          client,
        );
        if (!pkg || pkg.versionId !== campaign.systemVersionId) return [];
        return (pkg.templates ?? [])
          .filter(
            (t) => resolveTemplateBase(pkg, t.id, t.kind, {}) !== undefined,
          )
          .map((t) => structuredClone(t));
      }),
    shareTemplate: (ctx:RequestContext,body:TemplateMutation & TemplateSharing)=>mutate(ctx,'sharing',body),
    previewTemplates: (ctx:RequestContext,body:ListTemplates & {targetUserId:string}):Promise<CampaignResult<TemplatePage>>=>transaction(async client=>{
      const {member:caller}=await authorize(client,ctx,body.campaignId,true,false);
      const member=await repo.loadMembership(client,body.campaignId,body.targetUserId);
      if(!isActiveMember(member)||member.role!=='player')fail('not_found','The requested player does not exist.');
      if(body.status==='archived')return {templates:[],nextCursor:null};
      try {const page=await catalog.page(client,{...body,scope:templateReadScope(member,JSON.stringify(['preview',ctx.actorId,caller.generation,member.userId]))});return {...page,templates:page.templates.map(t=>({...t,grants:[]}))};}
      catch(error){if(error instanceof Error && 'code' in error && error.code==='bad_request')fail('bad_request',error.message);throw error;}
    }),
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
        const { member } = await authorize(
          client,
          ctx,
          body.campaignId,
          false,
          false,
        );
        const view = await catalog.read(client, body);
        if (
          view === null ||
          !canReadTemplate(view,member)
        )
          fail("not_found", "The requested template does not exist.");
        return isGameMaster(member)?view:{...view,grants:[]};
      }),
    listTemplates: (
      ctx: RequestContext,
      body: ListTemplates,
    ): Promise<CampaignResult<TemplatePage>> =>
      transaction(async (client) => {
        const {member}=await authorize(
          client,
          ctx,
          body.campaignId,
          body.status === "archived",
          false,
        );
        try {
          const page=await catalog.page(client,{...body,scope:templateReadScope(member,JSON.stringify(['actual',ctx.actorId]))});
          return isGameMaster(member)?page:{...page,templates:page.templates.map(t=>({...t,grants:[]}))};
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
