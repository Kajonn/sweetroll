import { Type, type TSchema } from "@sinclair/typebox";
import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
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

const UnauthorizedEnvelopeDto = Type.Object({
  error: Type.Object({
    code: Type.Literal("unauthorized"),
    message: Type.String(),
  }),
  requestId: Type.String(),
});

const ThemeDefaultDto = Type.Union([
  Type.Literal("light"),
  Type.Literal("dark"),
  Type.Literal("system"),
]);

const PreferencesResponseDto = Type.Object({
  theme_default: Type.Union([ThemeDefaultDto, Type.Null()]),
});

const PatchPreferencesBodyDto = Type.Object({
  theme_default: Type.Optional(Type.Union([ThemeDefaultDto, Type.Null()])),
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
  {
    method: "get",
    path: "/me/preferences",
    operationId: "get_me_preferences",
    schema: {
      response: {
        "200": PreferencesResponseDto,
        "401": UnauthorizedEnvelopeDto,
      },
    },
  },
  {
    method: "patch",
    path: "/me/preferences",
    operationId: "patch_me_preferences",
    schema: {
      body: PatchPreferencesBodyDto,
      response: {
        "200": PreferencesResponseDto,
        "400": ErrorEnvelopeDto,
        "401": UnauthorizedEnvelopeDto,
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

    app.setErrorHandler((error: unknown, request, reply) => {
      const requestId = request.id;
      const err = error as { validation?: unknown; message?: string; statusCode?: number };
      if (err.validation !== undefined) {
        void reply.code(400).send({
          error: { code: "bad_request", message: err.message || "The request is invalid." },
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

    const requireActor = async (
      request: FastifyRequest,
      reply: FastifyReply,
    ): Promise<string | null> => {
      const auth = request.auth;
      if (auth.state === "anonymous") {
        await reply.code(401).send({
          error: { code: "unauthorized", message: "Authentication is required." },
          requestId: request.id,
        });
        return null;
      }
      return auth.actorId;
    };

    app.get(
      "/me/preferences",
      { schema: { response: { "200": PreferencesResponseDto, "401": UnauthorizedEnvelopeDto } } },
      async (request, reply) => {
        const actorId = await requireActor(request, reply);
        if (actorId === null) return;
        const result = await identity.getThemeDefault(actorId);
        if (!result.ok) {
          return reply.code(500).send({
            error: { code: result.error.code, message: result.error.message },
            requestId: request.id,
          });
        }
        return { theme_default: result.value };
      },
    );

    app.patch(
      "/me/preferences",
      {
        schema: {
          body: PatchPreferencesBodyDto,
          response: {
            "200": PreferencesResponseDto,
            "400": ErrorEnvelopeDto,
            "401": UnauthorizedEnvelopeDto,
          },
        },
      },
      async (request, reply) => {
        const actorId = await requireActor(request, reply);
        if (actorId === null) return;
        // PATCH is partial: an omitted theme_default leaves the stored
        // default untouched; an explicit null clears it.
        const body = (request.body ?? {}) as { theme_default?: "light" | "dark" | "system" | null };
        if (body.theme_default === undefined) {
          const current = await identity.getThemeDefault(actorId);
          if (!current.ok) {
            return reply.code(500).send({
              error: { code: current.error.code, message: current.error.message },
              requestId: request.id,
            });
          }
          return { theme_default: current.value };
        }
        const result = await identity.setThemeDefault(actorId, body.theme_default);
        if (!result.ok) {
          return reply.code(500).send({
            error: { code: result.error.code, message: result.error.message },
            requestId: request.id,
          });
        }
        return { theme_default: result.value };
      },
    );
  });
