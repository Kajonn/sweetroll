import { Type, type TProperties } from "@sinclair/typebox";
import { ImageDescriptorSchema } from "../../../platform/image-attachment.js";
import { MAX_IMAGE_BYTES } from "../../../platform/image-processing.js";
import {
  BooleanFieldV1Schema, DecimalFieldV1Schema, IntegerFieldV1Schema, MultiChoiceFieldV1Schema,
  FieldV1Schema, ResourceFieldV1Schema, ResourceValueV1Schema, SingleChoiceFieldV1Schema, SlotDefinitionV1Schema,
  SystemDocumentV1Schema, TemplateKindSchema, TextFieldV1Schema,
} from "../../../systems/implementation/package/schema/document.js";
import { SystemPackageV1Schema } from "../../../systems/implementation/package/schema/package.js";
import { DefinitionIdSchema } from "../../../systems/implementation/package/schema/common.js";
import { EntrySourceSchema } from "../../../systems/implementation/package/schema/dynamic.js";

export const object = <P extends TProperties>(properties: P) => Type.Object(properties, { additionalProperties: false });
export const nullable = <T extends ReturnType<typeof Type.String> | ReturnType<typeof Type.Integer>>(schema: T) =>
  Type.Union([schema, Type.Null()]);
export const page = (cursor: ReturnType<typeof Type.String>) => ({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  cursor: Type.Optional(cursor),
});

export const uuid = Type.String({ format: "uuid" });
export const definitionId = DefinitionIdSchema;
export const text = Type.String();
export const dateTime = Type.String({ format: "date-time" });
export const lifecycle = Type.Union([Type.Literal("active"), Type.Literal("archived")]);
export const cursor = Type.String({ minLength: 1, maxLength: 2048 });
export const revision = Type.Integer({ minimum: 1, maximum: 2_147_483_647 });
export const key = Type.String({ minLength: 1, maxLength: 128, pattern: "\\S" });
export const scalar = Type.Union([text, Type.Number(), Type.Boolean(), Type.Null()]);
export const value = Type.Union([scalar, Type.Array(Type.String()), ResourceValueV1Schema]);
export const values = Type.Record(definitionId, value, { maxProperties: 512, additionalProperties: false });

const diagnostic = object({
  code: text,
  message: text,
  path: Type.String({ description: "JSON Pointer into the submitted document or command body." }),
  severity: Type.Union([Type.Literal("error"), Type.Literal("warning")]),
});
export const errorEnvelope = object({
  error: object({
    code: text,
    message: text,
    latestRevision: Type.Optional(nullable(revision)),
    diagnostics: Type.Optional(Type.Array(diagnostic)),
  }),
  requestId: text,
});

const sharingAccess = Type.Union([Type.Literal("private"), Type.Literal("link"), Type.Literal("public")]);
const system = object({
  systemId: uuid, name: text,
  access: sharingAccess,
  lifecycle, createdAt: dateTime, updatedAt: dateTime,
});

export const preview = object({
  snapshotId: uuid, systemId: uuid, sourceRevision: revision, package: SystemPackageV1Schema, expiresAt: dateTime,
});
export const assessment = object({ valid: Type.Boolean(), diagnostics: Type.Array(diagnostic) });
export const publication = object({
  systemId: uuid, versionId: uuid, semanticVersion: text, checksum: text, releaseNotes: text, createdAt: dateTime,
  lifecycle: Type.Union([Type.Literal("published"), Type.Literal("deprecated")]),
});
export const workspace = object({
  system,
  draft: Type.Union([object({ revision, document: SystemDocumentV1Schema, updatedAt: dateTime }), Type.Null()]),
  versions: Type.Array(publication),
  assessment,
});

export const systemPage = object({ systems: Type.Array(system), nextCursor: nullable(uuid) });
export const systemQuery = object(page(uuid));
export const systemId = object({ systemId: uuid });
export const versionId = object({ versionId: uuid });
export const systemTemplate = object({ systemId: uuid, templateId: definitionId });
const systemName = Type.String({ minLength: 1, maxLength: 120, pattern: "\\S" });
export const createSystem = Type.Union([
  object({ name: systemName, idempotencyKey: key }),
  object({ source: Type.Union([
    object({ kind: Type.Literal("clone"), versionId: uuid }),
    object({ kind: Type.Literal("import"), content: Type.String({ minLength: 1, maxLength: 16 * 1024 * 1024 }) }),
  ]), idempotencyKey: key }),
]);
export const changeSharing = object({ access: sharingAccess });
export const sharing = object({ systemId: uuid, access: sharingAccess });
export const starterTemplates = object({ templates: Type.Array(object({ versionId: uuid, name: text })) });
// Document assessment in SystemAuthoring supplies stable structural and rule diagnostics.
const documentInput = Type.Object({}, { additionalProperties: true });
export const validateDocument = object({ document: documentInput });
export const saveDraft = object({ expectedRevision: nullable(revision), document: documentInput });
export const publishDraft = object({
  expectedRevision: revision, idempotencyKey: key,
  semanticVersion: Type.String({ maxLength: 32, pattern: "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$" }),
  releaseNotes: Type.Optional(Type.String({ maxLength: 10_000 })),
  acknowledgeBreaking: Type.Optional(Type.Boolean()),
});

export const characterQuery = object(page(cursor));
export const creationVersionsQuery = object({
  ...page(cursor),
  q: Type.Optional(Type.String({ maxLength: 120 })),
  systemId: Type.Optional(uuid),
});
export const creationVersions = object({
  versions: Type.Array(object({ versionId: uuid, systemId: uuid, systemName: text, semanticVersion: text, createdAt: dateTime })),
  nextCursor: nullable(cursor),
});
export const creationOptionsQuery = object({ systemVersionId: uuid });
export const creationOptions = object({
  versionId: uuid,
  packageChecksum: text,
  templates: Type.Array(object({
    id: definitionId, label: text, kind: TemplateKindSchema,
    description: Type.Optional(text), fields: Type.Array(FieldV1Schema),
  })),
  entities: Type.Array(object({
    id: definitionId, label: text, kind: Type.Union([Type.Literal("playable"), Type.Literal("npc")]),
    slots: Type.Array(SlotDefinitionV1Schema),
    fields: Type.Array(Type.Union([
      TextFieldV1Schema, IntegerFieldV1Schema, DecimalFieldV1Schema, BooleanFieldV1Schema,
      SingleChoiceFieldV1Schema, MultiChoiceFieldV1Schema, ResourceFieldV1Schema,
    ])),
  })),
});
export const createCharacter = object({
  systemVersionId: uuid, entityDefinitionId: definitionId,
  name: Type.String({ minLength: 1, maxLength: 120, pattern: "\\S" }),
  initialValues: Type.Optional(values), idempotencyKey: key,
});
export const characterId = object({ characterId: uuid });
export const fieldId = object({ characterId: uuid, fieldId: definitionId });
export const revisionCommand = { expectedRevision: revision, idempotencyKey: key };
const quantity = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const entryProperties = {
  entryId: uuid, slotId: definitionId, templateId: nullable(definitionId), values,
  quantity: Type.Optional(quantity),
};
const entrySource = Type.Optional(EntrySourceSchema);
export const entry = object({
  ...entryProperties,
  extensionId: Type.Optional({ ...uuid, description: "Extension of the entry's template; absent for base-system templates." }),
  source: entrySource,
});
export const entryId = object({ characterId: uuid, entryId: uuid });
export const addEntry = object({
  ...entryProperties, values: Type.Optional(values), ...revisionCommand,
  source: Type.Optional(Type.Union(EntrySourceSchema.anyOf, {
    description: "Campaign items: send the source from GET /characters/{characterId}/templates with a null templateId and no values or quantity.",
  })),
});
export const updateEntry = object({
  slotId: Type.Optional(definitionId), values: Type.Optional(values), quantity: Type.Optional(quantity),
  ...revisionCommand,
});
export const revisionCommandBody = object(revisionCommand);
export const resourceId = object({ characterId: uuid, resourceId: definitionId });
export const bumpResource = object({
  direction: Type.Union([Type.Literal("up"), Type.Literal("down")]), ...revisionCommand,
});
export const attachmentRevision = Type.Integer({ minimum: 0, maximum: 2_147_483_647 });
export const imageUpload = {
  description: Type.String({ minLength: 1, maxLength: 500 }),
  contentType: ImageDescriptorSchema.properties.contentType,
  dataBase64: Type.String({ minLength: 1, maxLength: Math.ceil(MAX_IMAGE_BYTES / 3) * 4 }),
};
export const setSystemImage = object({ ...revisionCommand, ...imageUpload });
const portraitCommand = {
  expectedCharacterRevision: revision, expectedPortraitRevision: attachmentRevision, idempotencyKey: key,
};
const entryImageCommand = {
  expectedCharacterRevision: revision, expectedImageRevision: attachmentRevision, idempotencyKey: key,
};
export const setPortrait = object({ ...portraitCommand, ...imageUpload });
export const setEntryImage = object({ ...entryImageCommand, ...imageUpload });
export const removePortrait = object(portraitCommand);
export const removeEntryImage = object(entryImageCommand);
export const portraitState = object({ revision: attachmentRevision, portrait: Type.Union([ImageDescriptorSchema, Type.Null()]) });
export const imageState = object({ revision: attachmentRevision, image: Type.Union([ImageDescriptorSchema, Type.Null()]) });
export const duplicateCharacter = object({ idempotencyKey: key });
export const setField = object({ value, expectedRevision: revision, idempotencyKey: key });
export const characterSummary = object({
  characterId: uuid, name: text, systemVersionId: uuid, entityDefinitionId: definitionId,
  revision, lifecycle, updatedAt: dateTime,
});
export const characterPage = object({ characters: Type.Array(characterSummary), nextCursor: nullable(cursor) });
export const characterPlacement = object({
  campaignId: uuid,
  controllers: Type.Array(uuid, { description: "Active members who control the attached character." }),
  placementGeneration: Type.Integer({ minimum: 0 }),
  returnOwnerId: Type.Union([uuid, Type.Null()], {
    description: "Account the adopted character returns to on departure; null for campaign-created sheets.",
  }),
});
export const characterSheet = object({
  ...characterSummary.properties,
  createdAt: dateTime,
  ownerId: Type.Union([uuid, Type.Null()], { description: "Standalone owner; null while attached to a campaign." }),
  campaign: Type.Union([characterPlacement, Type.Null()], { description: "Campaign placement; null for standalone characters." }),
  extensions: Type.Array(object({ extensionId: uuid, versionId: uuid }), {
    maxItems: 16,
    description: "Extension versions the character is built on, in addition to systemVersionId. Read-only in v1.",
  }),
  values,
  entries: Type.Array(entry),
  derivedValues: Type.Record(definitionId, scalar),
  validations: Type.Array(object({
    validationId: definitionId, targetDefinitionId: definitionId, message: text,
    severity: Type.Union([Type.Literal("warning"), Type.Literal("error")]),
  })),
});
export const characterMutation = object({ characterId: uuid, revision });
