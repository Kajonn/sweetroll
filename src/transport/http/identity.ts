import { Type, type TSchema } from "@sinclair/typebox";
import type { FastifyPluginCallback } from "fastify";
import fp from "fastify-plugin";

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
];

export const buildIdentityRoutes: () => FastifyPluginCallback = () =>
  fp(async (app) => {
    app.addHook("onSend", async (request, reply) => {
      reply.header("x-request-id", request.id);
    });

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
  });
