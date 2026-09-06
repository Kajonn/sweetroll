import { Type, type TSchema } from "@sinclair/typebox";
import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";

import type {
  CharacterCommand,
  CharacterError,
  CharacterManagementCommand,
  CharacterView,
  Characters,
  CharacterCommandResult,
  CharacterActivityEvent,
} from "../../characters/index.js";

export type BuildCharactersRoutesInput = {
  characters: Characters;
};

const STATUS_BY_CODE: Record<CharacterError["code"], number> = {
  bad_request: 400,
  not_found: 404,
  conflict: 409,
  idempotency_mismatch: 409,
  command_in_progress: 409,
  invalid_value: 422,
  internal: 500,
  temporarily_unavailable: 503,
};

const badRequest = (message: string): CharacterError => ({ code: "bad_request", message });

// ---------------------------------------------------------------------------
// OpenAPI / TypeBox schemas
// ---------------------------------------------------------------------------

const UUID_FORMAT = "uuid";
const DATE_TIME_FORMAT = "date-time";

const RuntimeScalarDto = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);
const RuntimeValidationDto = Type.Object({
  validationId: Type.String(),
  severity: Type.Union([Type.Literal("error"), Type.Literal("warning")]),
  message: Type.String(),
  targetDefinitionId: Type.String(),
});
const RuntimeStateDto = Type.Object({
  schemaVersion: Type.Literal("1.0"),
  values: Type.Object({}, { additionalProperties: true }),
});
const RecordDto = Type.Record(Type.String(), RuntimeScalarDto);

const ReconciliationDto = Type.Object({
  characterId: Type.String({ format: UUID_FORMAT }),
  baseRevision: Type.Union([Type.Integer(), Type.Null()]),
  revision: Type.Integer(),
  packageChecksum: Type.String(),
  projectionVersion: Type.Literal("1.0"),
  commandExecutionId: Type.String(),
  replayExpiresAt: Type.String({ format: DATE_TIME_FORMAT }),
  replayed: Type.Boolean(),
  changedDefinitionIds: Type.Array(Type.String()),
  activityCursor: Type.Union([Type.String(), Type.Null()]),
  cacheDisposition: Type.Union([Type.Literal("retain"), Type.Literal("replace"), Type.Literal("purge")]),
});

const ProjectionChoiceDto = Type.Object({ id: Type.String(), label: Type.String() });
const ProjectionFieldConstraintsDto = Type.Object({
  required: Type.Optional(Type.Boolean()),
  min: Type.Optional(Type.Number()),
  max: Type.Optional(Type.Number()),
  step: Type.Optional(Type.Number()),
  minLength: Type.Optional(Type.Integer()),
  maxLength: Type.Optional(Type.Integer()),
  options: Type.Optional(Type.Array(ProjectionChoiceDto)),
});
const ProjectionActionInputDto = Type.Object({
  id: Type.String(),
  label: Type.String(),
  valueType: Type.Union([
    Type.Literal("integer"),
    Type.Literal("decimal"),
    Type.Literal("boolean"),
    Type.Literal("text"),
  ]),
  required: Type.Boolean(),
  default: RuntimeScalarDto,
});
const ProjectionFieldDto = Type.Object({
    kind: Type.Literal("field"),
    id: Type.String(),
    fieldId: Type.String(),
    label: Type.String(),
    fieldKind: Type.Union([
      Type.Literal("text"),
      Type.Literal("integer"),
      Type.Literal("decimal"),
      Type.Literal("boolean"),
      Type.Literal("singleChoice"),
      Type.Literal("multiChoice"),
      Type.Literal("computed"),
      Type.Literal("image"),
    ]),
    value: Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null(), Type.Array(Type.String())]),
    editable: Type.Boolean(),
    constraints: ProjectionFieldConstraintsDto,
    validations: Type.Array(RuntimeValidationDto),
  });
const ProjectionElementDto = Type.Union([
  Type.Object({
    kind: Type.Literal("heading"),
    id: Type.String(),
    text: Type.String(),
    level: Type.Union([Type.Literal(2), Type.Literal(3)]),
  }),
  ProjectionFieldDto,
  Type.Object({
    kind: Type.Literal("resource"),
    id: Type.String(),
    resourceId: Type.String(),
    label: Type.String(),
    value: Type.Object({ current: Type.Number(), max: Type.Number() }),
    min: Type.Number(),
    max: Type.Number(),
    step: Type.Number(),
    resetTo: Type.Union([Type.Literal("min"), Type.Literal("max")]),
    validations: Type.Array(RuntimeValidationDto),
  }),
  Type.Object({
    kind: Type.Literal("action"),
    id: Type.String(),
    actionId: Type.String(),
    label: Type.String(),
    actionKind: Type.Union([Type.Literal("roll"), Type.Literal("resourceBump")]),
    inputs: Type.Array(ProjectionActionInputDto),
    validations: Type.Array(RuntimeValidationDto),
  }),
]);
const ProjectionDto = Type.Object({
  projectionVersion: Type.Literal("1.0"),
  systemId: Type.String({ format: UUID_FORMAT }),
  versionId: Type.String({ format: UUID_FORMAT }),
  packageChecksum: Type.String(),
  entityId: Type.String(),
  entityLabel: Type.String(),
  completionFields: Type.Optional(Type.Array(ProjectionFieldDto)),
  sheets: Type.Array(
    Type.Object({
      id: Type.String(),
      label: Type.String(),
      sections: Type.Array(
        Type.Object({
          id: Type.String(),
          label: Type.String(),
          elements: Type.Array(ProjectionElementDto),
        }),
      ),
    }),
  ),
  derivedValues: RecordDto,
  validations: Type.Array(RuntimeValidationDto),
});

const CharacterViewDto = Type.Object({
  characterId: Type.String({ format: UUID_FORMAT }),
  ownerId: Type.String({ format: UUID_FORMAT }),
  name: Type.String(),
  systemVersionId: Type.String({ format: UUID_FORMAT }),
  entityDefinitionId: Type.String(),
  revision: Type.Integer(),
  lifecycle: Type.Union([Type.Literal("active"), Type.Literal("archived")]),
  archivedAt: Type.Union([Type.String({ format: DATE_TIME_FORMAT }), Type.Null()]),
  createdAt: Type.String({ format: DATE_TIME_FORMAT }),
  updatedAt: Type.String({ format: DATE_TIME_FORMAT }),
  state: RuntimeStateDto,
  derivedValues: RecordDto,
  validations: Type.Array(RuntimeValidationDto),
  projection: ProjectionDto,
  reconciliation: ReconciliationDto,
});

const CharacterSummaryDto = Type.Object({
  characterId: Type.String({ format: UUID_FORMAT }),
  name: Type.String(),
  entityDefinitionId: Type.String(),
  systemVersionId: Type.String({ format: UUID_FORMAT }),
  revision: Type.Integer(),
  lifecycle: Type.Union([Type.Literal("active"), Type.Literal("archived")]),
  updatedAt: Type.String({ format: DATE_TIME_FORMAT }),
});

const CharacterCreationOptionsDto = Type.Object({
  versionId: Type.String({ format: UUID_FORMAT }),
  packageChecksum: Type.String(),
  entities: Type.Array(
    Type.Object({
      id: Type.String({ minLength: 1 }),
      label: Type.String({ minLength: 1 }),
    }),
  ),
});

const DiceDto = Type.Object({
  sides: Type.Integer(),
  value: Type.Integer(),
  kept: Type.Boolean(),
});
const RollBindingDto = Type.Object({
  scope: Type.Union([Type.Literal("fields"), Type.Literal("inputs")]),
  definitionId: Type.String(),
  value: RuntimeScalarDto,
});
const RollDto = Type.Object({
  actionId: Type.String(),
  expression: Type.String(),
  dice: Type.Array(DiceDto),
  bindings: Type.Array(RollBindingDto),
  total: Type.Number(),
  output: Type.String(),
});

const CharacterCommandResultDto = Type.Object({
  character: CharacterViewDto,
  roll: Type.Union([RollDto, Type.Null()]),
});

const ActivityEventDto = Type.Object({
  id: Type.String(),
  characterRevision: Type.Integer(),
  kind: Type.String(),
  payload: Type.Object({}, { additionalProperties: true }),
  rollId: Type.Union([Type.String(), Type.Null()]),
  requestId: Type.String(),
  occurredAt: Type.String({ format: DATE_TIME_FORMAT }),
});

const MigrationPreviewDto = Type.Object({
  previewId: Type.String(),
  characterId: Type.String({ format: UUID_FORMAT }),
  sourceRevision: Type.Integer(),
  sourceVersionId: Type.String({ format: UUID_FORMAT }),
  targetVersionId: Type.String({ format: UUID_FORMAT }),
  candidateState: RuntimeStateDto,
  candidateProjection: ProjectionDto,
  warnings: Type.Array(Type.String()),
  expiresAt: Type.String({ format: DATE_TIME_FORMAT }),
});

const CharacterExportDto = Type.Object({
  schemaVersion: Type.Literal("1.0"),
  mediaType: Type.Literal("application/vnd.sweetroll.character+json;version=1"),
  characterId: Type.String({ format: UUID_FORMAT }),
  name: Type.String(),
  entityDefinitionId: Type.String(),
  lifecycle: Type.Union([Type.Literal("active"), Type.Literal("archived")]),
  createdAt: Type.String({ format: DATE_TIME_FORMAT }),
  updatedAt: Type.String({ format: DATE_TIME_FORMAT }),
  systemVersionId: Type.String({ format: UUID_FORMAT }),
  packageChecksum: Type.String(),
  revision: Type.Integer(),
  state: RuntimeStateDto,
  migrationLineage: Type.Array(
    Type.Object({
      fromVersionId: Type.String({ format: UUID_FORMAT }),
      toVersionId: Type.String({ format: UUID_FORMAT }),
      committedAt: Type.String({ format: DATE_TIME_FORMAT }),
    }),
  ),
});

const CharacterErrorEnvelope = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    latestRevision: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    diagnostics: Type.Optional(Type.Array(RuntimeValidationDto)),
    changedDefinitionIds: Type.Optional(Type.Array(Type.String())),
    activityCursor: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    cacheDisposition: Type.Optional(
      Type.Union([Type.Literal("retain"), Type.Literal("replace"), Type.Literal("purge")]),
    ),
  }),
  requestId: Type.String(),
});

const UnauthorizedEnvelope = Type.Object({
  error: Type.Object({
    code: Type.Literal("unauthorized"),
    message: Type.String(),
  }),
  requestId: Type.String(),
});

const ErrorResponses = {
  "400": CharacterErrorEnvelope,
  "401": UnauthorizedEnvelope,
  "404": CharacterErrorEnvelope,
  "409": CharacterErrorEnvelope,
  "422": CharacterErrorEnvelope,
  "500": CharacterErrorEnvelope,
  "503": CharacterErrorEnvelope,
};

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

const CreateCharacterBody = Type.Object({
  systemVersionId: Type.String({ format: UUID_FORMAT }),
  entityDefinitionId: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  initialValues: Type.Optional(Type.Object({}, { additionalProperties: true })),
  idempotencyKey: Type.String({ minLength: 1 }),
});

const ListCharactersQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  cursor: Type.Optional(Type.String()),
});

const CreationOptionsQuery = Type.Object({
  systemVersionId: Type.String({ format: UUID_FORMAT }),
});

const CharacterIdParams = Type.Object({ characterId: Type.String({ format: UUID_FORMAT }) });
const FieldSetParams = Type.Object({
  characterId: Type.String({ format: UUID_FORMAT }),
  fieldId: Type.String({ minLength: 1 }),
});
const ResourceBumpParams = Type.Object({
  characterId: Type.String({ format: UUID_FORMAT }),
  resourceId: Type.String({ minLength: 1 }),
});
const ExecuteActionParams = Type.Object({
  characterId: Type.String({ format: UUID_FORMAT }),
  actionId: Type.String({ minLength: 1 }),
});
const CommitMigrationParams = Type.Object({
  characterId: Type.String({ format: UUID_FORMAT }),
  previewId: Type.String({ minLength: 1 }),
});
const RollbackMigrationParams = Type.Object({
  characterId: Type.String({ format: UUID_FORMAT }),
  migrationId: Type.String({ minLength: 1 }),
});

const SetFieldBody = Type.Object({
  value: Type.Unknown(),
  expectedRevision: Type.Integer(),
  idempotencyKey: Type.String({ minLength: 1 }),
});
const BumpResourceBody = Type.Object({
  direction: Type.Union([Type.Literal("up"), Type.Literal("down")]),
  expectedRevision: Type.Integer(),
  idempotencyKey: Type.String({ minLength: 1 }),
});
const ExecuteActionBody = Type.Object({
  inputs: Type.Optional(Type.Object({}, { additionalProperties: true })),
  expectedRevision: Type.Integer(),
  idempotencyKey: Type.String({ minLength: 1 }),
});
const ManageCharacterBody = Type.Union([
  Type.Object({
    command: Type.Literal("rename"),
    name: Type.String({ minLength: 1 }),
    expectedRevision: Type.Integer(),
    idempotencyKey: Type.String({ minLength: 1 }),
  }),
  Type.Object({
    command: Type.Literal("archive"),
    expectedRevision: Type.Integer(),
    idempotencyKey: Type.String({ minLength: 1 }),
  }),
  Type.Object({
    command: Type.Literal("recover"),
    expectedRevision: Type.Integer(),
    idempotencyKey: Type.String({ minLength: 1 }),
  }),
]);
const TransferOwnershipBody = Type.Object({
  toUserId: Type.String({ format: UUID_FORMAT }),
  expectedRevision: Type.Integer(),
  idempotencyKey: Type.String({ minLength: 1 }),
});
const CreateMigrationPreviewBody = Type.Object({
  targetVersionId: Type.String({ format: UUID_FORMAT }),
  mappings: Type.Optional(Type.Object({}, { additionalProperties: true })),
  defaults: Type.Optional(Type.Object({}, { additionalProperties: true })),
});
const CommitMigrationBody = Type.Object({
  expectedRevision: Type.Integer(),
  idempotencyKey: Type.String({ minLength: 1 }),
});
const RollbackMigrationBody = Type.Object({
  idempotencyKey: Type.String({ minLength: 1 }),
});

type HttpMethod = "get" | "post" | "put" | "patch" | "delete";
export type RouteResponse = TSchema | { schema: TSchema; mediaType?: string };
type RouteSchema = {
  body?: TSchema;
  params?: TSchema;
  querystring?: TSchema;
  response?: Record<string, RouteResponse>;
};
export type CharactersRouteDefinition = {
  method: HttpMethod;
  path: string;
  operationId: string;
  schema: RouteSchema;
};

export const charactersRouteDefinitions: readonly CharactersRouteDefinition[] = [
  {
    method: "post",
    path: "/characters",
    operationId: "post_characters",
    schema: {
      body: CreateCharacterBody,
      response: {
        "201": Type.Object({ character: CharacterViewDto, requestId: Type.String() }),
        ...ErrorResponses,
      },
    },
  },
  {
    method: "get",
    path: "/characters",
    operationId: "get_characters",
    schema: {
      querystring: ListCharactersQuery,
      response: {
        "200": Type.Object({
          characters: Type.Array(CharacterSummaryDto),
          nextCursor: Type.Union([Type.String(), Type.Null()]),
          requestId: Type.String(),
        }),
        "400": CharacterErrorEnvelope,
        "401": UnauthorizedEnvelope,
        "500": CharacterErrorEnvelope,
        "503": CharacterErrorEnvelope,
      },
    },
  },
  {
    method: "get",
    path: "/characters/creation-options",
    operationId: "get_characters_creation_options",
    schema: {
      querystring: CreationOptionsQuery,
      response: {
        "200": Type.Object({ data: CharacterCreationOptionsDto, requestId: Type.String() }),
        "400": CharacterErrorEnvelope,
        "401": UnauthorizedEnvelope,
        "404": CharacterErrorEnvelope,
        "422": CharacterErrorEnvelope,
        "500": CharacterErrorEnvelope,
        "503": CharacterErrorEnvelope,
      },
    },
  },
  {
    method: "get",
    path: "/characters/:characterId",
    operationId: "get_characters_characterId",
    schema: {
      params: CharacterIdParams,
      response: {
        "200": Type.Object({ character: CharacterViewDto, requestId: Type.String() }),
        "401": UnauthorizedEnvelope,
        "404": CharacterErrorEnvelope,
        "500": CharacterErrorEnvelope,
        "503": CharacterErrorEnvelope,
      },
    },
  },
  {
    method: "post",
    path: "/characters/:characterId/fields/:fieldId/set",
    operationId: "post_characters_characterId_fields_fieldId_set",
    schema: {
      params: FieldSetParams,
      body: SetFieldBody,
      response: {
        "200": Type.Object({ result: CharacterCommandResultDto, requestId: Type.String() }),
        ...ErrorResponses,
      },
    },
  },
  {
    method: "post",
    path: "/characters/:characterId/resources/:resourceId/bump",
    operationId: "post_characters_characterId_resources_resourceId_bump",
    schema: {
      params: ResourceBumpParams,
      body: BumpResourceBody,
      response: {
        "200": Type.Object({ result: CharacterCommandResultDto, requestId: Type.String() }),
        ...ErrorResponses,
      },
    },
  },
  {
    method: "post",
    path: "/characters/:characterId/actions/:actionId",
    operationId: "post_characters_characterId_actions_actionId",
    schema: {
      params: ExecuteActionParams,
      body: ExecuteActionBody,
      response: {
        "200": Type.Object({ result: CharacterCommandResultDto, requestId: Type.String() }),
        ...ErrorResponses,
      },
    },
  },
  {
    method: "patch",
    path: "/characters/:characterId",
    operationId: "patch_characters_characterId",
    schema: {
      params: CharacterIdParams,
      body: ManageCharacterBody,
      response: {
        "200": Type.Object({ result: CharacterCommandResultDto, requestId: Type.String() }),
        ...ErrorResponses,
      },
    },
  },
  {
    method: "post",
    path: "/characters/:characterId/ownership-transfer",
    operationId: "post_characters_characterId_ownership_transfer",
    schema: {
      params: CharacterIdParams,
      body: TransferOwnershipBody,
      response: {
        "200": Type.Object({ result: CharacterCommandResultDto, requestId: Type.String() }),
        ...ErrorResponses,
      },
    },
  },
  {
    method: "get",
    path: "/characters/:characterId/activity",
    operationId: "get_characters_characterId_activity",
    schema: {
      params: CharacterIdParams,
      querystring: ListCharactersQuery,
      response: {
        "200": Type.Object({
          events: Type.Array(ActivityEventDto),
          nextCursor: Type.Union([Type.String(), Type.Null()]),
          requestId: Type.String(),
        }),
        "400": CharacterErrorEnvelope,
        "401": UnauthorizedEnvelope,
        "404": CharacterErrorEnvelope,
        "500": CharacterErrorEnvelope,
        "503": CharacterErrorEnvelope,
      },
    },
  },
  {
    method: "post",
    path: "/characters/:characterId/exports",
    operationId: "post_characters_characterId_exports",
    schema: {
      params: CharacterIdParams,
      response: {
        "200": { schema: CharacterExportDto, mediaType: "application/vnd.sweetroll.character+json;version=1" },
        "401": UnauthorizedEnvelope,
        "404": CharacterErrorEnvelope,
        "500": CharacterErrorEnvelope,
        "503": CharacterErrorEnvelope,
      },
    },
  },
  {
    method: "post",
    path: "/characters/:characterId/migration-previews",
    operationId: "post_characters_characterId_migration_previews",
    schema: {
      params: CharacterIdParams,
      body: CreateMigrationPreviewBody,
      response: {
        "201": Type.Object({ preview: MigrationPreviewDto, requestId: Type.String() }),
        ...ErrorResponses,
      },
    },
  },
  {
    method: "post",
    path: "/characters/:characterId/migrations/:previewId/commit",
    operationId: "post_characters_characterId_migrations_previewId_commit",
    schema: {
      params: CommitMigrationParams,
      body: CommitMigrationBody,
      response: {
        "200": Type.Object({ result: CharacterCommandResultDto, requestId: Type.String() }),
        ...ErrorResponses,
      },
    },
  },
  {
    method: "post",
    path: "/characters/:characterId/migrations/:migrationId/rollback",
    operationId: "post_characters_characterId_migrations_migrationId_rollback",
    schema: {
      params: RollbackMigrationParams,
      body: RollbackMigrationBody,
      response: {
        "200": Type.Object({ result: CharacterCommandResultDto, requestId: Type.String() }),
        ...ErrorResponses,
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

function toFastifyResponses(response: Record<string, RouteResponse> | undefined): Record<string, TSchema> | undefined {
  if (response === undefined) return undefined;
  const out: Record<string, TSchema> = {};
  for (const [status, value] of Object.entries(response)) {
    out[status] = "schema" in value ? value.schema : value;
  }
  return out;
}

export const buildCharactersRoutes: (input: BuildCharactersRoutesInput) => FastifyPluginCallback =
  ({ characters }) =>
  async (app) => {
    app.addHook("onSend", async (request, reply) => {
      reply.header("x-request-id", request.id);
    });

    app.addHook("preHandler", async (request, reply) => {
      if (request.auth.state !== "authenticated") {
        return reply.code(401).send({
          error: { code: "unauthorized", message: "Authentication is required." },
          requestId: request.id,
        });
      }
    });

    app.setErrorHandler((error: unknown, request, reply) => {
      const requestId = request.id;
      const err = error as { validation?: unknown; message?: string; statusCode?: number };
      if (err.validation !== undefined) {
        const message = err.message || "The request is invalid.";
        void reply.code(400).send({
          error: { code: "bad_request", message },
          requestId,
        });
        return;
      }
      const status = err.statusCode ?? 500;
      const code = status === 401 ? "unauthorized" : "internal";
      void reply.code(status).send({
        error: {
          code,
          message: status >= 500 ? "An internal error occurred." : err.message ?? "",
        },
        requestId,
      });
    });

    const ctxOf = (request: FastifyRequest) => ({
      actorId: request.auth.state === "authenticated" ? request.auth.actorId : "",
      requestId: request.id,
    });

    const sendError = (reply: FastifyReply, error: CharacterError, requestId: string) => {
      // The wire contract requires purge on EVERY inaccessible-character response. The
      // module's legacy play-path (open/apply/create) misses the flag, so the adapter
      // normalizes bare not_found errors to the purge shape here.
      const normalized =
        error.code === "not_found" && error.cacheDisposition === undefined
          ? { ...error, cacheDisposition: "purge" as const }
          : error;
      return reply.code(STATUS_BY_CODE[normalized.code]).send({
        error: {
          code: normalized.code,
          message: normalized.message,
          ...(normalized.latestRevision === undefined ? {} : { latestRevision: normalized.latestRevision }),
          ...(normalized.diagnostics === undefined ? {} : { diagnostics: normalized.diagnostics }),
          ...(normalized.changedDefinitionIds === undefined
            ? {}
            : { changedDefinitionIds: normalized.changedDefinitionIds }),
          ...(normalized.activityCursor === undefined ? {} : { activityCursor: normalized.activityCursor }),
          ...(normalized.cacheDisposition === undefined
            ? {}
            : { cacheDisposition: normalized.cacheDisposition }),
        },
        requestId,
      });
    };

    const setReadHeaders = (
      reply: FastifyReply,
      revision: number,
      packageChecksum: string,
      projectionVersion: string,
    ) => {
      reply.header("cache-control", "private");
      reply.header("etag", `"${revision}-${packageChecksum}-${projectionVersion}"`);
      reply.header("x-resource-revision", String(revision));
    };

    const toCharacterDto = (view: CharacterView): unknown => ({
      ...view,
      archivedAt: view.archivedAt === null ? null : view.archivedAt.toISOString(),
      createdAt: view.createdAt.toISOString(),
      updatedAt: view.updatedAt.toISOString(),
    });

    const toCommandResultDto = (result: CharacterCommandResult): unknown => ({
      character: toCharacterDto(result.character),
      roll: result.roll,
    });

    const toActivityEventDto = (event: CharacterActivityEvent): unknown => ({
      ...event,
      occurredAt: event.occurredAt.toISOString(),
    });

    type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown;
    const handlers: Record<string, Handler> = {
      post_characters: async (request, reply) => {
        const body = request.body as {
          systemVersionId: string;
          entityDefinitionId: string;
          name: string;
          initialValues?: Record<string, unknown>;
          idempotencyKey: string;
        };
        const result = await characters.create(ctxOf(request), {
          systemVersionId: body.systemVersionId,
          entityDefinitionId: body.entityDefinitionId,
          name: body.name,
          ...(body.initialValues === undefined ? {} : { initialValues: body.initialValues }),
          idempotencyKey: body.idempotencyKey,
        });
        if (!result.ok) return sendError(reply, result.error, request.id);
        return reply.code(201).send({ character: toCharacterDto(result.value), requestId: request.id });
      },

      get_characters: async (request, reply) => {
        const query = request.query as { limit?: string; cursor?: string } | undefined;
        const rawLimit = query?.limit;
        const limit = rawLimit === undefined ? 20 : Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
          return sendError(reply, badRequest("limit must be an integer from 1 through 100."), request.id);
        }
        const result = await characters.list(ctxOf(request), { limit, cursor: query?.cursor ?? null });
        if (!result.ok) return sendError(reply, result.error, request.id);
        reply.header("cache-control", "private");
        return {
          characters: result.value.characters,
          nextCursor: result.value.nextCursor,
          requestId: request.id,
        };
      },

      get_characters_creation_options: async (request, reply) => {
        const query = request.query as { systemVersionId: string };
        const result = await characters.creationOptions(ctxOf(request), {
          systemVersionId: query.systemVersionId,
        });
        if (!result.ok) return sendError(reply, result.error, request.id);
        return { data: result.value, requestId: request.id };
      },

      get_characters_characterId: async (request, reply) => {
        const params = request.params as { characterId: string };
        const result = await characters.open(ctxOf(request), params.characterId);
        if (!result.ok) return sendError(reply, result.error, request.id);
        const view = result.value;
        setReadHeaders(
          reply,
          view.reconciliation.revision,
          view.reconciliation.packageChecksum,
          view.reconciliation.projectionVersion,
        );
        return { character: toCharacterDto(view), requestId: request.id };
      },

      post_characters_characterId_fields_fieldId_set: async (request, reply) => {
        const params = request.params as { characterId: string; fieldId: string };
        const body = request.body as { value: unknown; expectedRevision: number; idempotencyKey: string };
        const command: CharacterCommand = {
          kind: "setField",
          characterId: params.characterId,
          fieldId: params.fieldId,
          value: body.value,
          expectedRevision: body.expectedRevision,
          idempotencyKey: body.idempotencyKey,
        };
        const result = await characters.apply(ctxOf(request), command);
        if (!result.ok) return sendError(reply, result.error, request.id);
        return { result: toCommandResultDto(result.value), requestId: request.id };
      },

      post_characters_characterId_resources_resourceId_bump: async (request, reply) => {
        const params = request.params as { characterId: string; resourceId: string };
        const body = request.body as {
          direction: "up" | "down";
          expectedRevision: number;
          idempotencyKey: string;
        };
        const command: CharacterCommand = {
          kind: "bumpResource",
          characterId: params.characterId,
          resourceId: params.resourceId,
          direction: body.direction,
          expectedRevision: body.expectedRevision,
          idempotencyKey: body.idempotencyKey,
        };
        const result = await characters.apply(ctxOf(request), command);
        if (!result.ok) return sendError(reply, result.error, request.id);
        return { result: toCommandResultDto(result.value), requestId: request.id };
      },

      post_characters_characterId_actions_actionId: async (request, reply) => {
        const params = request.params as { characterId: string; actionId: string };
        const body = request.body as {
          inputs?: Record<string, unknown>;
          expectedRevision: number;
          idempotencyKey: string;
        };
        const command: CharacterCommand = {
          kind: "executeAction",
          characterId: params.characterId,
          actionId: params.actionId,
          inputs: body.inputs ?? {},
          expectedRevision: body.expectedRevision,
          idempotencyKey: body.idempotencyKey,
        };
        const result = await characters.apply(ctxOf(request), command);
        if (!result.ok) return sendError(reply, result.error, request.id);
        return { result: toCommandResultDto(result.value), requestId: request.id };
      },

      patch_characters_characterId: async (request, reply) => {
        const params = request.params as { characterId: string };
        const body = request.body as {
          command: "rename" | "archive" | "recover";
          name?: string;
          expectedRevision: number;
          idempotencyKey: string;
        };
        const command: CharacterManagementCommand =
          body.command === "rename"
            ? {
                kind: "rename",
                characterId: params.characterId,
                name: body.name as string,
                expectedRevision: body.expectedRevision,
                idempotencyKey: body.idempotencyKey,
              }
            : body.command === "archive"
              ? {
                  kind: "archive",
                  characterId: params.characterId,
                  expectedRevision: body.expectedRevision,
                  idempotencyKey: body.idempotencyKey,
                }
              : {
                  kind: "recover",
                  characterId: params.characterId,
                  expectedRevision: body.expectedRevision,
                  idempotencyKey: body.idempotencyKey,
                };
        const result = await characters.manage(ctxOf(request), command);
        if (!result.ok) return sendError(reply, result.error, request.id);
        return { result: toCommandResultDto(result.value), requestId: request.id };
      },

      post_characters_characterId_ownership_transfer: async (request, reply) => {
        const params = request.params as { characterId: string };
        const body = request.body as { toUserId: string; expectedRevision: number; idempotencyKey: string };
        const command: CharacterManagementCommand = {
          kind: "transferOwnership",
          characterId: params.characterId,
          toUserId: body.toUserId,
          expectedRevision: body.expectedRevision,
          idempotencyKey: body.idempotencyKey,
        };
        const result = await characters.manage(ctxOf(request), command);
        if (!result.ok) return sendError(reply, result.error, request.id);
        return { result: toCommandResultDto(result.value), requestId: request.id };
      },

      get_characters_characterId_activity: async (request, reply) => {
        const params = request.params as { characterId: string };
        const query = request.query as { limit?: string; cursor?: string } | undefined;
        const rawLimit = query?.limit;
        const limit = rawLimit === undefined ? 20 : Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
          return sendError(reply, badRequest("limit must be an integer from 1 through 100."), request.id);
        }
        const result = await characters.listActivity(ctxOf(request), {
          characterId: params.characterId,
          limit,
          cursor: query?.cursor ?? null,
        });
        if (!result.ok) return sendError(reply, result.error, request.id);
        reply.header("cache-control", "private");
        return {
          events: result.value.events.map(toActivityEventDto),
          nextCursor: result.value.nextCursor,
          requestId: request.id,
        };
      },

      post_characters_characterId_exports: async (request, reply) => {
        const params = request.params as { characterId: string };
        const result = await characters.exportCharacter(ctxOf(request), { characterId: params.characterId });
        if (!result.ok) return sendError(reply, result.error, request.id);
        const document = result.value;
        setReadHeaders(reply, document.revision, document.packageChecksum, document.schemaVersion);
        reply.header("content-type", "application/vnd.sweetroll.character+json;version=1");
        // Pre-serialize as a Buffer so the vendor content-type isn't rewritten to
        // include Fastify's default `; charset=utf-8`.
        return Buffer.from(JSON.stringify(document), "utf8");
      },

      post_characters_characterId_migration_previews: async (request, reply) => {
        const params = request.params as { characterId: string };
        const body = request.body as {
          targetVersionId: string;
          mappings?: Record<string, string>;
          defaults?: Record<string, unknown>;
        };
        const result = await characters.previewMigration(ctxOf(request), {
          characterId: params.characterId,
          targetVersionId: body.targetVersionId,
          ...(body.mappings === undefined ? {} : { mappings: body.mappings }),
          ...(body.defaults === undefined ? {} : { defaults: body.defaults }),
        });
        if (!result.ok) return sendError(reply, result.error, request.id);
        return reply.code(201).send({ preview: result.value, requestId: request.id });
      },

      post_characters_characterId_migrations_previewId_commit: async (request, reply) => {
        const params = request.params as { characterId: string; previewId: string };
        const body = request.body as { expectedRevision: number; idempotencyKey: string };
        const result = await characters.commitMigration(ctxOf(request), {
          characterId: params.characterId,
          previewId: params.previewId,
          expectedRevision: body.expectedRevision,
          idempotencyKey: body.idempotencyKey,
        });
        if (!result.ok) return sendError(reply, result.error, request.id);
        return { result: toCommandResultDto(result.value), requestId: request.id };
      },

      post_characters_characterId_migrations_migrationId_rollback: async (request, reply) => {
        const params = request.params as { characterId: string; migrationId: string };
        const body = request.body as { idempotencyKey: string };
        const result = await characters.rollbackMigration(ctxOf(request), {
          characterId: params.characterId,
          migrationId: params.migrationId,
          idempotencyKey: body.idempotencyKey,
        });
        if (!result.ok) return sendError(reply, result.error, request.id);
        return { result: toCommandResultDto(result.value), requestId: request.id };
      },
    };

    for (const route of charactersRouteDefinitions) {
      const response = toFastifyResponses(route.schema.response);
      const schema = response === undefined ? route.schema : { ...route.schema, response };
      app[route.method](route.path, { schema }, handlers[route.operationId]!);
    }
  };
