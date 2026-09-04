import type { FastifyPluginCallback } from "fastify";
import fp from "fastify-plugin";

import type { Identity } from "../../identity/index.js";

declare module "fastify" {
  interface FastifyRequest {
    auth: import("../../identity/index.js").AuthContext;
  }
}

export type BuildAuthHookInput = {
  identity: Identity;
  cookieName: string;
  secure: boolean;
  maxAgeSeconds: number;
};

export const buildAuthHook: (input: BuildAuthHookInput) => FastifyPluginCallback =
  ({ identity, cookieName, secure, maxAgeSeconds }) =>
  fp(async (app) => {
    app.addHook("preHandler", async (request, reply) => {
      const raw = request.cookies[cookieName];
      if (raw === undefined || raw.length === 0) {
        request.auth = { state: "anonymous" };
        return;
      }
      const result = await identity.resolveSession(raw);
      if (result.state === "anonymous") {
        reply.clearCookie(cookieName, { httpOnly: true, sameSite: "lax", path: "/", secure });
        request.auth = { state: "anonymous" };
        return;
      }
      reply.setCookie(cookieName, raw, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure,
        maxAge: maxAgeSeconds,
      });
      request.auth = result;
    });
  });
