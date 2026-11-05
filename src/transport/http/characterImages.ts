import { Type } from "@sinclair/typebox";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Characters } from "../../characters/index.js";
import type {
  PortraitCommand,
  PortraitError,
  SetPortraitInput,
} from "../../characters/images.js";
import type { CharactersRouteDefinition } from "./characters.js";

const Id = Type.String({ format: "uuid" });
const Params = Type.Object({ characterId: Id });
const ImageType = Type.Union([
  Type.Literal("image/png"),
  Type.Literal("image/jpeg"),
  Type.Literal("image/webp"),
]);
const Portrait = Type.Object({
  fileId: Id,
  description: Type.String(),
  contentType: ImageType,
  width: Type.Integer(),
  height: Type.Integer(),
  sizeBytes: Type.Integer(),
  checksum: Type.String(),
});
const State = Type.Object({
  revision: Type.Integer(),
  portrait: Type.Union([Portrait, Type.Null()]),
  requestId: Type.String(),
});
const ErrorDto = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    latestRevision: Type.Optional(Type.Integer()),
  }),
  requestId: Type.String(),
});
const Errors = Object.fromEntries(
  [400, 401, 404, 409, 413, 422, 500, 503].map((s) => [String(s), ErrorDto]),
);
const Command = {
  expectedCharacterRevision: Type.Integer({ minimum: 1 }),
  expectedPortraitRevision: Type.Integer({ minimum: 0 }),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 256 }),
};
const Path = "/characters/:characterId/portrait";
export const characterImageRoutes: readonly CharactersRouteDefinition[] = [
  {
    method: "get",
    path: Path,
    operationId: "get_character_portrait",
    schema: { params: Params, response: { "200": State, ...Errors } },
  },
  {
    method: "put",
    path: Path,
    operationId: "put_character_portrait",
    schema: {
      params: Params,
      body: Type.Object(
        {
          ...Command,
          description: Type.String({ minLength: 1, maxLength: 500 }),
          contentType: ImageType,
          dataBase64: Type.String({
            minLength: 1,
            maxLength: Math.ceil((5 * 1024 * 1024) / 3) * 4,
          }),
        },
        { additionalProperties: false },
      ),
      response: { "200": State, ...Errors },
    },
  },
  {
    method: "delete",
    path: Path,
    operationId: "delete_character_portrait",
    schema: {
      params: Params,
      body: Type.Object(Command, { additionalProperties: false }),
      response: { "200": State, ...Errors },
    },
  },
  ...(
    [
      ["/thumbnail", "get_character_portrait_thumbnail"],
      ["/:fileId", "get_character_portrait_image"],
      ["/:fileId/thumbnail", "get_character_portrait_image_thumbnail"],
    ] as const
  ).map(([suffix, operationId]) => ({
    method: "get" as const,
    path: Path + suffix,
    operationId,
    schema: {
      params: Type.Object({
        characterId: Id,
        ...(suffix.includes(":fileId") ? { fileId: Id } : {}),
      }),
      response: {
        "200": {
          schema: Type.String({ format: "binary" }),
          mediaType: "image/*",
        },
        ...Errors,
      },
    },
  })),
];
const Status: Record<PortraitError["code"], number> = {
  bad_request: 400,
  not_found: 404,
  conflict: 409,
  idempotency_mismatch: 409,
  result_unavailable: 409,
  too_large: 413,
  unprocessable: 422,
  temporarily_unavailable: 503,
  internal: 500,
};
export function characterImageHandlers(
  characters: Characters,
): Record<
  string,
  (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>
> {
  return Object.fromEntries(
    characterImageRoutes.map((route) => [
      route.operationId,
      async (request: FastifyRequest, reply: FastifyReply) => {
        reply
          .header("cache-control", "private, no-store")
          .header("x-content-type-options", "nosniff");
        const ctx = {
          actorId:
            request.auth.state === "authenticated" ? request.auth.actorId : "",
          requestId: request.id,
        };
        const params = request.params as {
          characterId: string;
          fileId?: string;
        };
        if (
          route.operationId !== "get_character_portrait" &&
          route.method === "get"
        ) {
          const result = await characters.openPortraitImage(ctx, {
            ...params,
            thumbnail: route.path.endsWith("thumbnail"),
          });
          if (!result.ok)
            return reply
              .code(Status[result.error.code])
              .send({ error: result.error, requestId: request.id });
          return reply.type(result.value.contentType).send(result.value.bytes);
        }
        const result =
          route.method === "put"
            ? await characters.setPortrait(ctx, {
                ...(request.body as SetPortraitInput),
                characterId: params.characterId,
              })
            : route.method === "delete"
              ? await characters.removePortrait(ctx, {
                  ...(request.body as PortraitCommand),
                  characterId: params.characterId,
                })
              : await characters.openPortrait(ctx, params);
        if (!result.ok)
          return reply
            .code(Status[result.error.code])
            .send({ error: result.error, requestId: request.id });
        return { ...result.value, requestId: request.id };
      },
    ]),
  );
}
