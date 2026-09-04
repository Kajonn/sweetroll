import type { FastifyPluginCallback } from "fastify";
import fp from "fastify-plugin";
import { Type } from "@sinclair/typebox";

import type { Identity } from "../../identity/index.js";

const BODY = Type.Object({ code: Type.String({ minLength: 1 }), redirectUri: Type.String({ minLength: 1 }) });
const RESP = Type.Object({ userId: Type.String(), sessionId: Type.String(), expiresAt: Type.String() });
const ERROR_ENVELOPE = Type.Object({
  error: Type.Object({ code: Type.String(), message: Type.String() }),
  requestId: Type.String(),
});
const SEEDED_CODES: ReadonlyArray<{ code: string; displayName: string; email: string }> = [
  { code: "code-dev", displayName: "Dev User", email: "dev@example.com" },
];

export type BuildDevSignInRoutesInput = {
  identity: Identity;
  nodeEnv: "development" | "production" | "test";
  cookieName?: string;
  secure?: boolean;
  maxAgeSeconds?: number;
};

export const buildDevSignInRoutes: (input: BuildDevSignInRoutesInput) => FastifyPluginCallback =
  ({ identity, nodeEnv, cookieName = "session", secure = false, maxAgeSeconds = 30 * 86_400 }) =>
  fp(async (app) => {
    if (nodeEnv === "production") return;
    app.post(
      "/dev/signin",
      {
        schema: { body: BODY, response: { 200: RESP, 400: ERROR_ENVELOPE } },
      },
      async (request, reply) => {
        const body = request.body as { code: string; redirectUri: string };
        const result = await identity.completeSignIn({
          code: body.code,
          redirectUri: body.redirectUri,
          previousToken: undefined,
        });
        if (!result.ok)
          return reply.code(400).send({
            error: { code: result.error.code, message: result.error.message },
            requestId: request.id,
          });
        reply.setCookie(cookieName, result.value.token, {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          secure,
          maxAge: maxAgeSeconds,
        });
        return {
          userId: result.value.userId,
          sessionId: result.value.sessionId,
          expiresAt: result.value.expiresAt.toISOString(),
        };
      },
    );

    app.get("/dev/signin/codes", async () => ({ codes: SEEDED_CODES }));
  });