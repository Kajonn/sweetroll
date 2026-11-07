import { Type } from "@sinclair/typebox";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { AppError, RequestContext } from "../../systems/authoring.js";
import type { ExtensionAuthoring } from "../../systems/extensions.js";
import type { SystemsRouteDefinition } from "./systems.js";

// System extensions, stage E2 (design 6.8). Sharing, archive/restore and
// deletion of an extension use PATCH/DELETE /systems/:systemId; version
// deprecation uses PATCH /system-versions/:versionId; template art uses the
// system image routes. Those routes accept extension IDs unchanged.

const UUID = { format: "uuid" } as const;
const DATE_TIME = { format: "date-time" } as const;

const Diagnostic = Type.Object({ code: Type.String(), path: Type.String(), message: Type.String() });
const ErrorEnvelope = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    latestRevision: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    diagnostics: Type.Optional(Type.Array(Diagnostic)),
  }),
  requestId: Type.String(),
});
const Unauthorized = Type.Object({
  error: Type.Object({ code: Type.Literal("unauthorized"), message: Type.String() }),
  requestId: Type.String(),
});
const Errors = {
  "400": ErrorEnvelope,
  "401": Unauthorized,
  "404": ErrorEnvelope,
  "409": ErrorEnvelope,
  "422": ErrorEnvelope,
  "500": ErrorEnvelope,
};

const ExtensionSummaryDto = Type.Object({
  extensionId: Type.String(UUID),
  baseSystemId: Type.String(UUID),
  name: Type.String(),
  access: Type.String(),
  lifecycle: Type.String(),
  owned: Type.Boolean(),
  createdAt: Type.String(DATE_TIME),
  updatedAt: Type.String(DATE_TIME),
});

const ExtensionVersionDto = Type.Object({
  versionId: Type.String(UUID),
  extensionId: Type.String(UUID),
  semanticVersion: Type.String(),
  checksum: Type.String(),
  releaseNotes: Type.String(),
  lifecycle: Type.String(),
  builtAgainstVersionId: Type.String(UUID),
  createdAt: Type.String(DATE_TIME),
});

const ExtensionWorkspaceDto = Type.Object({
  extension: ExtensionSummaryDto,
  draft: Type.Union([
    Type.Object({
      revision: Type.Integer(),
      document: Type.Object({}, { additionalProperties: true }),
      baseVersionId: Type.String(UUID),
      sourceChecksum: Type.String(),
      updatedBy: Type.String(UUID),
      updatedAt: Type.String(DATE_TIME),
    }),
    Type.Null(),
  ]),
  versions: Type.Array(ExtensionVersionDto),
  assessment: Type.Object({
    ok: Type.Boolean(),
    diagnostics: Type.Array(Diagnostic),
    warnings: Type.Array(Diagnostic),
  }),
});

const SystemIdParams = Type.Object({ systemId: Type.String(UUID) });
const ExtensionIdParams = Type.Object({ extensionId: Type.String(UUID) });

export const extensionRouteDefinitions: readonly SystemsRouteDefinition[] = [
  {
    method: "post",
    path: "/systems/:systemId/extensions",
    operationId: "post_systems_extensions",
    schema: {
      params: SystemIdParams,
      body: Type.Object({
        baseVersionId: Type.String(UUID),
        name: Type.String({ minLength: 1, maxLength: 120 }),
        idempotencyKey: Type.String({ minLength: 1, maxLength: 256 }),
      }),
      response: { "201": Type.Object({ workspace: ExtensionWorkspaceDto, requestId: Type.String() }), ...Errors },
    },
  },
  {
    method: "get",
    path: "/systems/:systemId/extensions",
    operationId: "get_systems_extensions",
    schema: {
      params: SystemIdParams,
      querystring: Type.Object({
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        cursor: Type.Optional(Type.String(UUID)),
      }),
      response: {
        "200": Type.Object({
          extensions: Type.Array(Type.Composite([
            ExtensionSummaryDto,
            Type.Object({ latestVersion: Type.Union([ExtensionVersionDto, Type.Null()]) }),
          ])),
          nextCursor: Type.Union([Type.String(UUID), Type.Null()]),
          requestId: Type.String(),
        }),
        ...Errors,
      },
    },
  },
  {
    method: "get",
    path: "/extensions/:extensionId",
    operationId: "get_extension",
    schema: {
      params: ExtensionIdParams,
      response: { "200": Type.Object({ workspace: ExtensionWorkspaceDto, requestId: Type.String() }), ...Errors },
    },
  },
  {
    method: "put",
    path: "/extensions/:extensionId/draft",
    operationId: "put_extensions_draft",
    schema: {
      params: ExtensionIdParams,
      body: Type.Object({
        expectedRevision: Type.Integer({ minimum: 1 }),
        document: Type.Object({}, { additionalProperties: true }),
        baseVersionId: Type.Optional(Type.String(UUID)),
      }),
      response: { "200": Type.Object({ workspace: ExtensionWorkspaceDto, requestId: Type.String() }), ...Errors },
    },
  },
  {
    method: "post",
    path: "/extensions/:extensionId/preview",
    operationId: "post_extensions_preview",
    schema: {
      params: ExtensionIdParams,
      response: {
        "200": Type.Object({
          preview: Type.Object({
            baseVersionId: Type.String(UUID),
            package: Type.Object({}, { additionalProperties: true }),
            warnings: Type.Array(Diagnostic),
          }),
          requestId: Type.String(),
        }),
        ...Errors,
      },
    },
  },
  {
    method: "post",
    path: "/extensions/:extensionId/publish",
    operationId: "post_extensions_publish",
    schema: {
      params: ExtensionIdParams,
      body: Type.Object({
        expectedRevision: Type.Integer({ minimum: 1 }),
        semanticVersion: Type.String({ pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+$" }),
        releaseNotes: Type.String({ maxLength: 10_000 }),
        idempotencyKey: Type.String({ minLength: 1, maxLength: 256 }),
        acknowledgeBreaking: Type.Boolean(),
      }),
      response: {
        "200": Type.Object({
          version: Type.Composite([
            ExtensionVersionDto,
            Type.Object({ package: Type.Object({}, { additionalProperties: true }) }),
          ]),
          requestId: Type.String(),
        }),
        ...Errors,
      },
    },
  },
];

type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
type Helpers = {
  ctxOf: (request: FastifyRequest) => RequestContext;
  sendError: (reply: FastifyReply, error: AppError, requestId: string) => unknown;
};

export function extensionHandlers(extensions: ExtensionAuthoring, { ctxOf, sendError }: Helpers): Record<string, Handler> {
  return {
    post_systems_extensions: async (request, reply) => {
      const { systemId } = request.params as { systemId: string };
      const body = request.body as { baseVersionId: string; name: string; idempotencyKey: string };
      const result = await extensions.createExtension(ctxOf(request), { systemId, ...body });
      if (!result.ok) return sendError(reply, result.error, request.id);
      return reply.code(201).send({ workspace: result.value, requestId: request.id });
    },
    get_systems_extensions: async (request, reply) => {
      const { systemId } = request.params as { systemId: string };
      const query = request.query as { limit?: number; cursor?: string };
      const result = await extensions.list(ctxOf(request), {
        systemId,
        limit: query.limit ?? 20,
        cursor: query.cursor ?? null,
      });
      if (!result.ok) return sendError(reply, result.error, request.id);
      return { ...result.value, requestId: request.id };
    },
    get_extension: async (request, reply) => {
      const { extensionId } = request.params as { extensionId: string };
      const result = await extensions.open(ctxOf(request), extensionId);
      if (!result.ok) return sendError(reply, result.error, request.id);
      return { workspace: result.value, requestId: request.id };
    },
    put_extensions_draft: async (request, reply) => {
      const { extensionId } = request.params as { extensionId: string };
      const body = request.body as { expectedRevision: number; document: unknown; baseVersionId?: string };
      const result = await extensions.saveDraft(ctxOf(request), {
        extensionId,
        expectedRevision: body.expectedRevision,
        document: body.document,
        ...(body.baseVersionId === undefined ? {} : { baseVersionId: body.baseVersionId }),
      });
      if (!result.ok) return sendError(reply, result.error, request.id);
      return { workspace: result.value, requestId: request.id };
    },
    post_extensions_preview: async (request, reply) => {
      const { extensionId } = request.params as { extensionId: string };
      const result = await extensions.preview(ctxOf(request), extensionId);
      if (!result.ok) return sendError(reply, result.error, request.id);
      return { preview: result.value, requestId: request.id };
    },
    post_extensions_publish: async (request, reply) => {
      const { extensionId } = request.params as { extensionId: string };
      const body = request.body as {
        expectedRevision: number;
        semanticVersion: string;
        releaseNotes: string;
        idempotencyKey: string;
        acknowledgeBreaking: boolean;
      };
      const result = await extensions.publish(ctxOf(request), { extensionId, ...body });
      if (!result.ok) return sendError(reply, result.error, request.id);
      return { version: result.value, requestId: request.id };
    },
  };
}
