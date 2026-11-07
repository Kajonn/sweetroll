import { Type, type Static } from "@sinclair/typebox";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import type { Identity } from "../../identity/index.js";
import { personalTokenScopes } from "../../identity/personal-tokens.js";
import { strictInputCompiler } from "./strictValidation.js";

const path = "/me/personal-tokens";
const scope = Type.Union(personalTokenScopes.map((value) => Type.Literal(value)));
const tokenMetadata = Type.Object({
  id: Type.String({ format: "uuid" }),
  label: Type.String(),
  scopes: Type.Array(scope),
  createdAt: Type.String({ format: "date-time" }),
  expiresAt: Type.String({ format: "date-time" }),
});
const issueBody = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 80, pattern: "\\S" }),
  scopes: Type.Array(scope, { minItems: 1, maxItems: personalTokenScopes.length, uniqueItems: true }),
  expiresInDays: Type.Integer({ minimum: 1, maximum: 90 }),
}, { additionalProperties: false });
const tokenId = Type.Object({ tokenId: Type.String({ format: "uuid" }) });

export function buildPersonalTokenRoutes({
  identity,
}: { identity: Identity }): FastifyPluginAsync {
  return async (app) => {
    const tokens = identity.personalTokens;
    app.addHook("onRequest", async (_request, reply) => {
      reply.header("cache-control", "no-store");
    });

    function fail(request: FastifyRequest, reply: FastifyReply, status: number, code: string, message: string) {
      return reply.code(status).send({ error: { code, message }, requestId: request.id });
    }

    async function authorize(request: FastifyRequest, reply: FastifyReply) {
      if (request.auth.state !== "authenticated") {
        return fail(request, reply, 401, "unauthorized", "Sign in to manage API tokens.");
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        if (!tokens.enabled) {
          return fail(request, reply, 403, "forbidden", "Personal access tokens are unavailable.");
        }
      }
    }

    app.addHook("preHandler", authorize);
    app.get(path, {
      schema: { response: { 200: Type.Object({ enabled: Type.Boolean(), tokens: Type.Array(tokenMetadata) }) } },
    }, async (request) => {
      if (request.auth.state !== "authenticated") return;
      return { enabled: tokens.enabled, tokens: await tokens.list(request.auth.actorId) };
    });
    app.post<{ Body: Static<typeof issueBody> }>(path, {
      bodyLimit: 4096,
      validatorCompiler: strictInputCompiler,
      schema: { body: issueBody, response: { 201: Type.Object({ ...tokenMetadata.properties, token: Type.String() }) } },
    }, async (request, reply) => {
      if (request.auth.state !== "authenticated") return;
      const actorId = request.auth.actorId;
      const issued = await tokens.issue(actorId, { ...request.body, label: request.body.label.trim() });
      if (issued === null) return fail(request, reply, 409, "token_limit", "Revoke an active token before creating another.");
      request.log.info({ actorId, tokenId: issued.id, requestId: request.id }, "personal access token issued");
      return reply.code(201).send(issued);
    });
    app.delete<{ Params: Static<typeof tokenId> }>(`${path}/:tokenId`, {
      schema: { params: tokenId },
    }, async (request, reply) => {
      if (request.auth.state !== "authenticated") return;
      const actorId = request.auth.actorId;
      if (!await tokens.revoke(actorId, request.params.tokenId)) {
        return fail(request, reply, 404, "not_found", "The token does not exist.");
      }
      request.log.info({ actorId, tokenId: request.params.tokenId, requestId: request.id }, "personal access token revoked");
      return reply.code(204).send();
    });
  };
}
