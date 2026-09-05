import { Type, type TSchema } from "@sinclair/typebox";
import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

import type {
  AppError,
  CreateDraftSource,
  SystemAuthoring,
} from "../../systems/authoring.js";

export type BuildSystemsRoutesInput = {
  authoring: SystemAuthoring;
};

const STATUS_BY_CODE: Record<AppError["code"], number> = {
  bad_request: 400,
  not_found: 404,
  conflict: 409,
  idempotency_mismatch: 409,
  invalid_package: 422,
  internal: 500,
};

const badRequest = (message: string): AppError => ({ code: "bad_request", message });

function isValidSource(source: unknown): source is CreateDraftSource {
  if (typeof source !== "object" || source === null) return false;
  const candidate = source as Record<string, unknown>;
  if (candidate.kind === "blank") return typeof candidate.name === "string" && candidate.name.length > 0;
  if (candidate.kind === "clone") return typeof candidate.versionId === "string";
  if (candidate.kind === "import") return typeof candidate.content === "string";
  return false;
}

// ---------------------------------------------------------------------------
// OpenAPI / TypeBox schemas
// ---------------------------------------------------------------------------

const UUID_FORMAT = "uuid";
const DATE_TIME_FORMAT = "date-time";

const DiagnosticDto = Type.Object({
  code: Type.String(),
  path: Type.String(),
  message: Type.String(),
});

const ErrorEnvelope = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    latestRevision: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    diagnostics: Type.Optional(Type.Array(DiagnosticDto)),
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

const TemplateDto = Type.Object({
  templateId: Type.String(),
  label: Type.String(),
  versionId: Type.String({ format: UUID_FORMAT }),
});

const ListTemplatesResponseDto = Type.Object({
  templates: Type.Array(TemplateDto),
  requestId: Type.String(),
});

const SystemSummaryDto = Type.Object({
  systemId: Type.String({ format: UUID_FORMAT }),
  name: Type.String(),
  access: Type.String(),
  lifecycle: Type.Union([Type.Literal("active"), Type.Literal("archived")]),
  createdAt: Type.String({ format: DATE_TIME_FORMAT }),
  updatedAt: Type.String({ format: DATE_TIME_FORMAT }),
});

const DraftViewDto = Type.Object({
  revision: Type.Integer(),
  document: Type.Object({}, { additionalProperties: true }),
  sourceChecksum: Type.String(),
  updatedBy: Type.String({ format: UUID_FORMAT }),
  updatedAt: Type.String({ format: DATE_TIME_FORMAT }),
});

const VersionSummaryDto = Type.Object({
  versionId: Type.String({ format: UUID_FORMAT }),
  systemId: Type.String({ format: UUID_FORMAT }),
  semanticVersion: Type.String(),
  checksum: Type.String(),
  releaseNotes: Type.String(),
  lifecycle: Type.String(),
  createdAt: Type.String({ format: DATE_TIME_FORMAT }),
});

const AssessmentDto = Type.Object({
  ok: Type.Boolean(),
  diagnostics: Type.Array(DiagnosticDto),
});

const WorkspaceDto = Type.Object({
  system: SystemSummaryDto,
  draft: Type.Union([DraftViewDto, Type.Null()]),
  versions: Type.Array(VersionSummaryDto),
  assessment: AssessmentDto,
});

const CreateDraftBody = Type.Object({
  source: Type.Union([
    Type.Object({ kind: Type.Literal("blank"), name: Type.String({ minLength: 1 }) }),
    Type.Object({ kind: Type.Literal("clone"), versionId: Type.String({ format: UUID_FORMAT }) }),
    Type.Object({ kind: Type.Literal("import"), content: Type.String({ minLength: 1 }) }),
  ]),
  idempotencyKey: Type.String({ minLength: 1 }),
});

const ListSystemsQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  cursor: Type.Optional(Type.String()),
});

const SystemIdParams = Type.Object({
  systemId: Type.String({ format: UUID_FORMAT }),
});

const SaveDraftBody = Type.Object({
  expectedRevision: Type.Union([Type.Integer(), Type.Null()]),
  document: Type.Object({}, { additionalProperties: true }),
});

const PublishBody = Type.Object({
  expectedRevision: Type.Integer(),
  semanticVersion: Type.String({ pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+$" }),
  releaseNotes: Type.String(),
  idempotencyKey: Type.String({ minLength: 1 }),
});

const ChangeSystemLifecycleBody = Type.Object({
  lifecycle: Type.Union([Type.Literal("active"), Type.Literal("archived")]),
});

const DeprecateVersionBody = Type.Object({
  lifecycle: Type.Literal("deprecated"),
});

const VersionIdParams = Type.Object({
  versionId: Type.String({ format: UUID_FORMAT }),
});

const SnapshotDto = Type.Object({
  snapshotId: Type.String({ format: UUID_FORMAT }),
  systemId: Type.String({ format: UUID_FORMAT }),
  sourceRevision: Type.Integer(),
  package: Type.Object({}, { additionalProperties: true }),
  expiresAt: Type.String({ format: DATE_TIME_FORMAT }),
});

const PublishedVersionDto = Type.Object({
  versionId: Type.String({ format: UUID_FORMAT }),
  systemId: Type.String({ format: UUID_FORMAT }),
  semanticVersion: Type.String(),
  checksum: Type.String(),
  package: Type.Object({}, { additionalProperties: true }),
  releaseNotes: Type.String(),
  lifecycle: Type.String(),
  createdAt: Type.String({ format: DATE_TIME_FORMAT }),
});

const LifecycleResultDto = Type.Object({
  kind: Type.Union([Type.Literal("system"), Type.Literal("version")]),
  systemId: Type.String({ format: UUID_FORMAT }),
  versionId: Type.Optional(Type.String({ format: UUID_FORMAT })),
  lifecycle: Type.String(),
});

const ErrorResponses = {
  "400": ErrorEnvelope,
  "401": UnauthorizedEnvelope,
  "404": ErrorEnvelope,
  "409": ErrorEnvelope,
  "422": ErrorEnvelope,
  "500": ErrorEnvelope,
};

type HttpMethod = "get" | "post" | "put" | "patch" | "delete";
type RouteSchema = {
  body?: TSchema;
  params?: TSchema;
  querystring?: TSchema;
  response?: Record<string, TSchema>;
};
export type SystemsRouteDefinition = {
  method: HttpMethod;
  path: string;
  operationId: string;
  schema: RouteSchema;
};

export const systemsRouteDefinitions: readonly SystemsRouteDefinition[] = [
  {
    method: "get",
    path: "/templates",
    operationId: "get_templates",
    schema: {
      response: {
        "200": ListTemplatesResponseDto,
        "401": UnauthorizedEnvelope,
        "500": ErrorEnvelope,
      },
    },
  },
  {
    method: "post",
    path: "/systems",
    operationId: "post_systems",
    schema: {
      body: CreateDraftBody,
      response: {
        "201": Type.Object({ workspace: WorkspaceDto, requestId: Type.String() }),
        ...ErrorResponses,
      },
    },
  },
  {
    method: "get",
    path: "/systems",
    operationId: "get_systems",
    schema: {
      querystring: ListSystemsQuery,
      response: {
        "200": Type.Object({
          systems: Type.Array(SystemSummaryDto),
          nextCursor: Type.Union([Type.String({ format: UUID_FORMAT }), Type.Null()]),
          requestId: Type.String(),
        }),
        "400": ErrorEnvelope,
        "401": UnauthorizedEnvelope,
        "500": ErrorEnvelope,
      },
    },
  },
  {
    method: "get",
    path: "/systems/:systemId",
    operationId: "get_system",
    schema: {
      params: SystemIdParams,
      response: {
        "200": Type.Object({ workspace: WorkspaceDto, requestId: Type.String() }),
        "401": UnauthorizedEnvelope,
        "404": ErrorEnvelope,
        "500": ErrorEnvelope,
      },
    },
  },
  {
    method: "get",
    path: "/systems/:systemId/versions",
    operationId: "get_systems_systemId_versions",
    schema: {
      params: SystemIdParams,
      response: {
        "200": Type.Object({
          versions: Type.Array(VersionSummaryDto),
          requestId: Type.String(),
        }),
        "401": UnauthorizedEnvelope,
        "404": ErrorEnvelope,
        "500": ErrorEnvelope,
      },
    },
  },
  {
    method: "put",
    path: "/systems/:systemId/draft",
    operationId: "put_systems_draft",
    schema: {
      params: SystemIdParams,
      body: SaveDraftBody,
      response: {
        "200": Type.Object({ workspace: WorkspaceDto, requestId: Type.String() }),
        ...ErrorResponses,
      },
    },
  },
  {
    method: "post",
    path: "/systems/:systemId/preview",
    operationId: "post_systems_preview",
    schema: {
      params: SystemIdParams,
      response: {
        "200": Type.Object({ snapshot: SnapshotDto, requestId: Type.String() }),
        "401": UnauthorizedEnvelope,
        "404": ErrorEnvelope,
        "422": ErrorEnvelope,
        "500": ErrorEnvelope,
      },
    },
  },
  {
    method: "post",
    path: "/systems/:systemId/publish",
    operationId: "post_systems_publish",
    schema: {
      params: SystemIdParams,
      body: PublishBody,
      response: {
        "200": Type.Object({ version: PublishedVersionDto, requestId: Type.String() }),
        ...ErrorResponses,
      },
    },
  },
  {
    method: "patch",
    path: "/systems/:systemId",
    operationId: "patch_systems_systemId",
    schema: {
      params: SystemIdParams,
      body: ChangeSystemLifecycleBody,
      response: {
        "200": Type.Object({ lifecycle: LifecycleResultDto, requestId: Type.String() }),
        "400": ErrorEnvelope,
        "401": UnauthorizedEnvelope,
        "404": ErrorEnvelope,
        "500": ErrorEnvelope,
      },
    },
  },
  {
    method: "patch",
    path: "/system-versions/:versionId",
    operationId: "patch_system_versions_versionId",
    schema: {
      params: VersionIdParams,
      body: DeprecateVersionBody,
      response: {
        "200": Type.Object({ lifecycle: LifecycleResultDto, requestId: Type.String() }),
        "400": ErrorEnvelope,
        "401": UnauthorizedEnvelope,
        "404": ErrorEnvelope,
        "500": ErrorEnvelope,
      },
    },
  },
  {
    method: "get",
    path: "/system-versions/:versionId/export",
    operationId: "get_system_versions_export",
    schema: {
      params: VersionIdParams,
      response: {
        "200": Type.Object({
          schemaVersion: Type.String(),
          mediaType: Type.String(),
          exportedAt: Type.String(),
          package: Type.Object({}, { additionalProperties: true }),
        }),
        "401": UnauthorizedEnvelope,
        "404": ErrorEnvelope,
        "500": ErrorEnvelope,
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export const buildSystemsRoutes: (input: BuildSystemsRoutesInput) => FastifyPluginCallback =
  ({ authoring }) =>
  fp(async (app) => {
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

    const sendError = (reply: FastifyReply, error: AppError, requestId: string) =>
      reply.code(STATUS_BY_CODE[error.code]).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.latestRevision === undefined ? {} : { latestRevision: error.latestRevision }),
          ...(error.diagnostics === undefined ? {} : { diagnostics: error.diagnostics }),
        },
        requestId,
      });

    type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown;
    const handlers: Record<string, Handler> = {
      get_templates: async (request) => ({
        templates: [
          {
            templateId: "d20",
            label: "d20 sample",
            versionId: "11111111-1111-1111-1111-111111111a01",
          },
          {
            templateId: "pbta2d6",
            label: "PbtA 2d6 sample",
            versionId: "11111111-1111-1111-1111-111111111a02",
          },
          {
            templateId: "d6success",
            label: "d6 success pool sample",
            versionId: "11111111-1111-1111-1111-111111111a03",
          },
        ],
        requestId: request.id,
      }),
      post_systems: async (request, reply) => {
        const body = request.body as { source?: unknown; idempotencyKey?: unknown } | undefined;
        if (
          body === undefined ||
          typeof body.idempotencyKey !== "string" ||
          body.idempotencyKey.length === 0 ||
          !isValidSource(body.source)
        ) {
          return sendError(reply, badRequest("The request body is invalid."), request.id);
        }
        const result = await authoring.createDraft(ctxOf(request), {
          source: body.source,
          idempotencyKey: body.idempotencyKey,
        });
        if (!result.ok) return sendError(reply, result.error, request.id);
        return reply.code(201).send({ workspace: result.value, requestId: request.id });
      },

      get_systems: async (request, reply) => {
        const query = request.query as { limit?: string; cursor?: string } | undefined;
        const rawLimit = query?.limit;
        const limit = rawLimit === undefined ? 20 : Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
          return sendError(reply, badRequest("limit must be an integer from 1 through 100."), request.id);
        }
        const result = await authoring.list(ctxOf(request), { limit, cursor: query?.cursor ?? null });
        if (!result.ok) return sendError(reply, result.error, request.id);
        return { systems: result.value.systems, nextCursor: result.value.nextCursor, requestId: request.id };
      },

      get_system: async (request, reply) => {
        const params = request.params as { systemId: string };
        const result = await authoring.open(ctxOf(request), params.systemId);
        if (!result.ok) return sendError(reply, result.error, request.id);
        return { workspace: result.value, requestId: request.id };
      },

      get_systems_systemId_versions: async (request, reply) => {
        const params = request.params as { systemId: string };
        const result = await authoring.listVersions(ctxOf(request), { systemId: params.systemId });
        if (!result.ok) return sendError(reply, result.error, request.id);
        return { versions: result.value.versions, requestId: request.id };
      },

      put_systems_draft: async (request, reply) => {
        const params = request.params as { systemId: string };
        const body = request.body as { expectedRevision?: unknown; document?: unknown } | undefined;
        if (
          body === undefined ||
          (typeof body.expectedRevision !== "number" && body.expectedRevision !== null) ||
          typeof body.document !== "object" ||
          body.document === null
        ) {
          return sendError(reply, badRequest("The request body is invalid."), request.id);
        }
        const result = await authoring.saveDraft(ctxOf(request), {
          systemId: params.systemId,
          expectedRevision: body.expectedRevision as number | null,
          document: body.document,
        });
        if (!result.ok) return sendError(reply, result.error, request.id);
        return { workspace: result.value, requestId: request.id };
      },

      post_systems_preview: async (request, reply) => {
        const params = request.params as { systemId: string };
        const result = await authoring.previewDraft(ctxOf(request), { systemId: params.systemId });
        if (!result.ok) return sendError(reply, result.error, request.id);
        return { snapshot: result.value, requestId: request.id };
      },

      post_systems_publish: async (request, reply) => {
        const params = request.params as { systemId: string };
        const body = request.body as
          | { expectedRevision?: unknown; semanticVersion?: unknown; releaseNotes?: unknown; idempotencyKey?: unknown }
          | undefined;
        if (
          body === undefined ||
          typeof body.expectedRevision !== "number" ||
          typeof body.semanticVersion !== "string" ||
          typeof body.releaseNotes !== "string" ||
          typeof body.idempotencyKey !== "string" ||
          body.idempotencyKey.length === 0
        ) {
          return sendError(reply, badRequest("The request body is invalid."), request.id);
        }
        const result = await authoring.publish(ctxOf(request), {
          systemId: params.systemId,
          expectedRevision: body.expectedRevision,
          semanticVersion: body.semanticVersion,
          releaseNotes: body.releaseNotes,
          idempotencyKey: body.idempotencyKey,
        });
        if (!result.ok) return sendError(reply, result.error, request.id);
        return { version: result.value, requestId: request.id };
      },

      patch_systems_systemId: async (request, reply) => {
        const params = request.params as { systemId: string };
        const body = request.body as { lifecycle?: unknown } | undefined;
        if (body === undefined || (body.lifecycle !== "active" && body.lifecycle !== "archived")) {
          return sendError(reply, badRequest("lifecycle must be active or archived."), request.id);
        }
        const result = await authoring.changeLifecycle(ctxOf(request), {
          kind: "system",
          systemId: params.systemId,
          lifecycle: body.lifecycle,
        });
        if (!result.ok) return sendError(reply, result.error, request.id);
        return { lifecycle: result.value, requestId: request.id };
      },

      patch_system_versions_versionId: async (request, reply) => {
        const params = request.params as { versionId: string };
        const body = request.body as { lifecycle?: unknown } | undefined;
        if (body === undefined || body.lifecycle !== "deprecated") {
          return sendError(reply, badRequest("lifecycle must be deprecated."), request.id);
        }
        const result = await authoring.changeLifecycle(ctxOf(request), {
          kind: "version",
          versionId: params.versionId,
          lifecycle: "deprecated",
        });
        if (!result.ok) return sendError(reply, result.error, request.id);
        return { lifecycle: result.value, requestId: request.id };
      },

      get_system_versions_export: async (request, reply) => {
        const params = request.params as { versionId: string };
        const result = await authoring.exportVersion(ctxOf(request), params.versionId);
        if (!result.ok) return sendError(reply, result.error, request.id);
        reply.header("content-type", "application/vnd.sweetroll.system+json;version=1");
        return result.value;
      },
    };

    for (const route of systemsRouteDefinitions) {
      app[route.method](route.path, { schema: route.schema }, handlers[route.operationId]!);
    }
  });
