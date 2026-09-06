import { Type, type TSchema } from "@sinclair/typebox";
import type { FastifyPluginCallback, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

import type { Identity } from "../../identity/index.js";

const UUID_FORMAT = "uuid";

const MeResponseDto = Type.Union([
  Type.Object({
    state: Type.Literal("authenticated"),
    userId: Type.String({ format: UUID_FORMAT }),
  }),
  Type.Object({
    state: Type.Literal("anonymous"),
  }),
]);

const ErrorEnvelopeDto = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
  }),
  requestId: Type.String(),
});

export type BuildIdentityRoutesInput = {
  identity: Identity;
  cookieName: string;
  secure: boolean;
  allowedOrigins?: ReadonlyArray<string>;
};

type HttpMethod = "get" | "post" | "put" | "patch" | "delete";
type RouteSchema = {
  body?: TSchema;
  params?: TSchema;
  querystring?: TSchema;
  response?: Record<string, TSchema>;
};

export type IdentityRouteDefinition = {
  method: HttpMethod;
  path: string;
  operationId: string;
  schema: RouteSchema;
};

export const identityRouteDefinitions: readonly IdentityRouteDefinition[] = [
  {
    method: "get",
    path: "/me",
    operationId: "get_me",
    schema: {
      response: {
        "200": MeResponseDto,
      },
    },
  },
  {
    method: "post",
    path: "/signout",
    operationId: "post_signout",
    schema: {
      response: {
        "204": Type.Null(),
        "403": ErrorEnvelopeDto,
      },
    },
  },
];

function isSameOrigin(origin: string, request: FastifyRequest, allowedOrigins: ReadonlyArray<string>): boolean {
  if (allowedOrigins.includes(origin)) return true;
  try {
    // Compare the Origin host (including port) against the request Host header.
    // Scheme is deliberately ignored: behind a TLS-terminating proxy (and in
    // tests) the request protocol is reported as http even though the
    // originating request is https, so a strict scheme comparison would reject
    // legitimate same-origin requests.
    return new URL(origin).host === request.host;
  } catch {
    return false;
  }
}

export const buildIdentityRoutes: (input: BuildIdentityRoutesInput) => FastifyPluginCallback =
  ({ identity, cookieName, secure, allowedOrigins = [] }) =>
  fp(async (app) => {
    app.addHook("onSend", async (request, reply) => {
      reply.header("x-request-id", request.id);
    });

    const clearCookieOptions = { httpOnly: true, sameSite: "lax" as const, path: "/", secure };

    app.get(
      "/me",
      { schema: { response: { "200": MeResponseDto } } },
      async (request) => {
        const auth = request.auth;
        if (auth.state === "anonymous") {
          return { state: "anonymous" as const };
        }
        return { state: "authenticated" as const, userId: auth.actorId };
      },
    );

    app.post(
      "/signout",
      { schema: { response: { "204": Type.Null(), "403": ErrorEnvelopeDto } } },
      async (request, reply) => {
        const origin = request.headers.origin;
        if (origin !== undefined && !isSameOrigin(origin, request, allowedOrigins)) {
          return reply.code(403).send({
            error: { code: "forbidden", message: "Cross-origin sign-out is not allowed." },
            requestId: request.id,
          });
        }
        const token = request.cookies[cookieName];
        if (token !== undefined && token.length > 0) {
          await identity.signOut(token);
        }
        reply.clearCookie(cookieName, clearCookieOptions);
        return reply.code(204).send();
      },
    );
  });
