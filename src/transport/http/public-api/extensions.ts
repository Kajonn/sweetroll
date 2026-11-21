import { Type } from "@sinclair/typebox";

import type { Campaigns } from "../../../campaigns/index.js";
import type { Characters } from "../../../characters/index.js";
import type { ExtensionAuthoring } from "../../../systems/extensions.js";
import { CampaignVersionCheckDto } from "../campaigns.js";
import {
  CharacterVersionCheckDto,
  CompositionDto,
  CompositionOptionsDto,
  toCompositionOptionsDto,
} from "../characters.js";
import { Diagnostic, ExtensionSummaryDto, ExtensionVersionDto, ExtensionWorkspaceDto } from "../extensions.js";
import { map, wire, type Route } from "./router.js";
import * as s from "./schemas.js";

// System extensions through public API v1 (extensions plan E7, owner-approved
// 2026-11-21). Extension authoring mirrors the browser routes; composition
// changes for characters and campaigns mirror `composition-options`,
// `composition-check` and `composition` (design 6.7/6.8). Sharing, archive and
// deletion of an extension use PATCH/DELETE /systems/{extensionId}.

const systemId = s.object({ systemId: s.uuid });
const extensionId = s.object({ extensionId: s.uuid });
const listQuery = s.object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), cursor: Type.Optional(s.uuid) });
const createExtension = s.object({ baseVersionId: s.uuid, name: Type.String({ minLength: 1, maxLength: 120, pattern: "\\S" }), idempotencyKey: s.key });
const saveDraft = s.object({
  expectedRevision: s.revision,
  document: Type.Object({}, { additionalProperties: true, description: "An extension document (schema 2.0): metadata, expressions and templates." }),
  baseVersionId: Type.Optional({ ...s.uuid, description: "Base system version to check and preview against." }),
});
const publish = s.object({
  expectedRevision: s.revision,
  semanticVersion: Type.String({ pattern: "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$" }),
  releaseNotes: Type.Optional(Type.String({ maxLength: 10_000 })),
  acknowledgeBreaking: Type.Optional(Type.Boolean()),
  idempotencyKey: s.key,
});
const compositionCheck = s.object({ target: CompositionDto });
const characterCompositionChange = s.object({ target: CompositionDto, expectedRevision: s.revision, idempotencyKey: s.key });
const campaignCompositionChange = s.object({ target: CompositionDto, expectedCampaignRevision: s.revision, idempotencyKey: s.key });
const characterIdParams = s.object({ characterId: s.uuid });
const campaignIdParams = s.object({ campaignId: s.uuid });

export const extensionSchemas = {
  ExtensionPage: Type.Object({
    extensions: Type.Array(Type.Composite([ExtensionSummaryDto, Type.Object({ latestVersion: Type.Union([ExtensionVersionDto, Type.Null()]) })])),
    nextCursor: Type.Union([s.uuid, Type.Null()]),
  }),
  ExtensionWorkspace: ExtensionWorkspaceDto,
  ExtensionPreview: Type.Object({
    baseVersionId: s.uuid,
    package: Type.Object({}, { additionalProperties: true }),
    warnings: Type.Array(Diagnostic),
  }),
  ExtensionPublication: Type.Composite([ExtensionVersionDto, Type.Object({ package: Type.Object({}, { additionalProperties: true }) })]),
  CompositionOptions: CompositionOptionsDto,
  CharacterCompositionCheck: CharacterVersionCheckDto,
  CampaignCompositionCheck: CampaignVersionCheckDto,
  CampaignCompositionResult: s.object({ campaignId: s.uuid, revision: s.revision, systemVersionId: s.uuid }),
};

export function registerExtensionRoutes(route: Route, { extensions, characters, campaigns }: {
  extensions: ExtensionAuthoring; characters: Characters; campaigns: Campaigns;
}) {
  // --- Authoring --------------------------------------------------------------
  route({
    method: "GET", path: "/systems/:systemId/extensions", id: "listSystemExtensions",
    description: "List the owned and public extensions of a system the caller may read, each with its latest published version.",
    scope: "systems:read", input: { params: systemId, querystring: listQuery }, output: "ExtensionPage",
  }, async (ctx, { params, query }) => map(await extensions.list(ctx, {
    systemId: params.systemId, limit: query.limit ?? 25, cursor: query.cursor ?? null,
  }), wire));

  route({
    method: "POST", path: "/systems/:systemId/extensions", id: "createExtension",
    description: "Create a private extension of a system, with an empty draft built against a usable published base version.",
    scope: "systems:write", input: { params: systemId, body: createExtension }, output: "ExtensionWorkspace", created: true,
    example: { baseVersionId: "00000000-0000-4000-8000-000000000001", name: "Frost pack", idempotencyKey: "extension-1" },
  }, async (ctx, { params, body }) => map(await extensions.createExtension(ctx, { systemId: params.systemId, ...body }), wire));

  route({
    method: "GET", path: "/extensions/:extensionId", id: "readExtension",
    description: "Read an owned extension: its draft, published versions and the draft's assessment against its base version.",
    scope: "systems:read", input: { params: extensionId }, output: "ExtensionWorkspace",
  }, async (ctx, { params }) => map(await extensions.open(ctx, params.extensionId), wire));

  route({
    method: "PUT", path: "/extensions/:extensionId/draft", id: "saveExtensionDraft",
    description: "Replace an owned extension draft at the supplied revision, optionally moving it to another base version.",
    scope: "systems:write", input: { params: extensionId, body: saveDraft }, output: "ExtensionWorkspace", document: true,
  }, async (ctx, { params, body }) => map(await extensions.saveDraft(ctx, {
    extensionId: params.extensionId, expectedRevision: body.expectedRevision, document: body.document,
    ...(body.baseVersionId === undefined ? {} : { baseVersionId: body.baseVersionId }),
  }), wire));

  route({
    method: "POST", path: "/extensions/:extensionId/preview", id: "previewExtensionDraft",
    description: "Compile the current draft against its base version without publishing.",
    scope: "systems:write", input: { params: extensionId }, output: "ExtensionPreview", bucket: "validate",
  }, async (ctx, { params }) => map(await extensions.preview(ctx, params.extensionId), wire));

  route({
    method: "POST", path: "/extensions/:extensionId/publish", id: "publishExtensionVersion",
    description: "Publish the exact draft revision as an immutable extension version.",
    scope: "systems:write", input: { params: extensionId, body: publish }, output: "ExtensionPublication", created: true, bucket: "publish",
    example: { expectedRevision: 2, semanticVersion: "1.0.0", idempotencyKey: "extension-publish-1" },
  }, async (ctx, { params, body }) => map(await extensions.publish(ctx, {
    extensionId: params.extensionId, expectedRevision: body.expectedRevision, semanticVersion: body.semanticVersion,
    releaseNotes: body.releaseNotes ?? "", acknowledgeBreaking: body.acknowledgeBreaking ?? false, idempotencyKey: body.idempotencyKey,
  }), wire));

  // --- Character compositions (standalone characters) ----------------------------
  route({
    method: "GET", path: "/characters/:characterId/composition-options", id: "readCharacterCompositionOptions",
    description: "The character's rules (base version and extensions), the revert target, later base versions and addable extensions.",
    scope: "characters:read", input: { params: characterIdParams }, output: "CompositionOptions",
  }, async (ctx, { params }) => map(await characters.listVersionOptions(ctx, params), toCompositionOptionsDto));

  route({
    method: "POST", path: "/characters/:characterId/composition-check", id: "checkCharacterComposition",
    description: "Dry run of one composition change (base upgrade, or add, remove or upgrade one extension) or of the revert. Nothing is saved.",
    scope: "characters:read", input: { params: characterIdParams, body: compositionCheck }, output: "CharacterCompositionCheck",
  }, async (ctx, { params, body }) => characters.checkVersionChange(ctx, { characterId: params.characterId, target: body.target }));

  route({
    method: "POST", path: "/characters/:characterId/composition", id: "changeCharacterComposition",
    description: "Make one checked composition change, or revert to the composition recorded before the most recent change.",
    scope: "characters:write", input: { params: characterIdParams, body: characterCompositionChange }, output: "CharacterMutation",
  }, async (ctx, { params, body }) => map(await characters.manage(ctx, {
    kind: "changeVersion", characterId: params.characterId, target: body.target,
    expectedRevision: body.expectedRevision, idempotencyKey: body.idempotencyKey,
  }), (result) => ({ characterId: result.character.characterId, revision: result.character.revision })));

  // --- Campaign compositions (GM and co-GM) -------------------------------------
  route({
    method: "GET", path: "/campaigns/:campaignId/composition-options", id: "readCampaignCompositionOptions",
    description: "The campaign's rules, the revert target, later base versions and addable extensions. GM and co-GM only.",
    scope: "campaigns:read", input: { params: campaignIdParams }, output: "CompositionOptions",
  }, async (ctx, { params }) => map(await campaigns.listVersionOptions(ctx, params), toCompositionOptionsDto));

  route({
    method: "POST", path: "/campaigns/:campaignId/composition-check", id: "checkCampaignComposition",
    description: "Dry run of one composition change for the campaign, every attached character and template base. Nothing is saved.",
    scope: "campaigns:read", input: { params: campaignIdParams, body: compositionCheck }, output: "CampaignCompositionCheck",
  }, async (ctx, { params, body }) => map(await campaigns.checkVersionChange(ctx, { campaignId: params.campaignId, target: body.target }), wire));

  route({
    method: "POST", path: "/campaigns/:campaignId/composition", id: "changeCampaignComposition",
    description: "Move the campaign, its attached characters and template bases together, or nothing. Any blocked character blocks the change.",
    scope: "campaigns:write", input: { params: campaignIdParams, body: campaignCompositionChange }, output: "CampaignCompositionResult",
  }, async (ctx, { params, body }) => map(await campaigns.changeVersion(ctx, {
    campaignId: params.campaignId, target: body.target,
    expectedCampaignRevision: body.expectedCampaignRevision, idempotencyKey: body.idempotencyKey,
  }), (view) => ({ campaignId: view.campaignId, revision: view.revision, systemVersionId: view.systemVersionId })));
}
