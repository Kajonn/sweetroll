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

    app.post("/systems", async (request, reply) => {
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
    });

    app.get("/systems", async (request, reply) => {
      const query = request.query as { limit?: string; cursor?: string } | undefined;
      const rawLimit = query?.limit;
      const limit = rawLimit === undefined ? 20 : Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return sendError(reply, badRequest("limit must be an integer from 1 through 100."), request.id);
      }
      const result = await authoring.list(ctxOf(request), { limit, cursor: query?.cursor ?? null });
      if (!result.ok) return sendError(reply, result.error, request.id);
      return { systems: result.value.systems, nextCursor: result.value.nextCursor, requestId: request.id };
    });

    app.get("/systems/:systemId", async (request, reply) => {
      const params = request.params as { systemId: string };
      const result = await authoring.open(ctxOf(request), params.systemId);
      if (!result.ok) return sendError(reply, result.error, request.id);
      return { workspace: result.value, requestId: request.id };
    });

    app.put("/systems/:systemId/draft", async (request, reply) => {
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
    });

    app.post("/systems/:systemId/preview", async (request, reply) => {
      const params = request.params as { systemId: string };
      const result = await authoring.previewDraft(ctxOf(request), { systemId: params.systemId });
      if (!result.ok) return sendError(reply, result.error, request.id);
      return { snapshot: result.value, requestId: request.id };
    });

    app.post("/systems/:systemId/publish", async (request, reply) => {
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
    });

    app.patch("/systems/:systemId", async (request, reply) => {
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
    });

    app.patch("/system-versions/:versionId", async (request, reply) => {
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
    });

    app.get("/system-versions/:versionId/export", async (request, reply) => {
      const params = request.params as { versionId: string };
      const result = await authoring.exportVersion(ctxOf(request), params.versionId);
      if (!result.ok) return sendError(reply, result.error, request.id);
      reply.header("content-type", "application/vnd.sweetroll.system+json;version=1");
      return result.value;
    });
  });