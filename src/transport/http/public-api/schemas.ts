import { Type, type TProperties } from "@sinclair/typebox";
import {
  BooleanFieldV1Schema, DecimalFieldV1Schema, IntegerFieldV1Schema, MultiChoiceFieldV1Schema,
  ResourceFieldV1Schema, ResourceValueV1Schema, SingleChoiceFieldV1Schema, SystemDocumentV1Schema, TextFieldV1Schema,
} from "../../../systems/implementation/package/schema/document.js";
import { DefinitionIdSchema } from "../../../systems/implementation/package/schema/common.js";

export const object = <P extends TProperties>(properties: P) => Type.Object(properties, { additionalProperties: false });
const nullable = <T extends ReturnType<typeof Type.String> | ReturnType<typeof Type.Integer>>(schema: T) =>
  Type.Union([schema, Type.Null()]);
const page = (cursor: ReturnType<typeof Type.String>) => ({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  cursor: Type.Optional(cursor),
});

export const uuid = Type.String({ format: "uuid" });
export const definitionId = DefinitionIdSchema;
const text = Type.String();
const dateTime = Type.String({ format: "date-time" });
const lifecycle = Type.Union([Type.Literal("active"), Type.Literal("archived")]);
const cursor = Type.String({ minLength: 1, maxLength: 2048 });
const revision = Type.Integer({ minimum: 1, maximum: 2_147_483_647 });
const key = Type.String({ minLength: 1, maxLength: 128, pattern: "\\S" });
const scalar = Type.Union([text, Type.Number(), Type.Boolean(), Type.Null()]);
const value = Type.Union([scalar, Type.Array(Type.String()), ResourceValueV1Schema]);
const values = Type.Record(definitionId, value, { maxProperties: 512, additionalProperties: false });

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

const system = object({
  systemId: uuid, name: text,
  access: Type.Union([Type.Literal("private"), Type.Literal("link"), Type.Literal("public")]),
  lifecycle, createdAt: dateTime, updatedAt: dateTime,
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
export const createSystem = object({ name: Type.String({ minLength: 1, maxLength: 120, pattern: "\\S" }), idempotencyKey: key });
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
  entities: Type.Array(object({
    id: definitionId, label: text, kind: Type.Union([Type.Literal("playable"), Type.Literal("npc")]),
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
export const setField = object({ value, expectedRevision: revision, idempotencyKey: key });
const characterSummary = object({
  characterId: uuid, name: text, systemVersionId: uuid, entityDefinitionId: definitionId,
  revision, lifecycle, updatedAt: dateTime,
});
export const characterPage = object({ characters: Type.Array(characterSummary), nextCursor: nullable(cursor) });
export const characterSheet = object({
  ...characterSummary.properties,
  createdAt: dateTime,
  values,
  derivedValues: Type.Record(definitionId, scalar),
  validations: Type.Array(object({
    validationId: definitionId, targetDefinitionId: definitionId, message: text,
    severity: Type.Union([Type.Literal("warning"), Type.Literal("error")]),
  })),
});
export const characterMutation = object({ characterId: uuid, revision });
