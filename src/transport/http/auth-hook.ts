import type { FastifyPluginCallback, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

import type { Identity } from "../../identity/index.js";

declare module "fastify" {
  interface FastifyContextConfig {
    bearerOnly?: boolean;
  }
  interface FastifyRequest {
    auth: import("../../identity/index.js").AuthContext;
  }
}

export type BuildAuthHookInput = {
  identity: Identity;
  cookieName: string;
  secure: boolean;
  allowedOrigins?: readonly string[];
};

function permitsCookieWrite(request: FastifyRequest, secure: boolean, allowedOrigins: readonly string[]): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return request.headers["sec-fetch-site"] === "same-origin";
  try {
    const source = new URL(origin);
    if (source.origin !== origin || (source.protocol !== "http:" && source.protocol !== "https:")) return false;
    if (allowedOrigins.includes(origin)) return true;
    // Use the original Host, even when IP rate limits trust a proxy hop.
    // Secure deployments terminate TLS at ingress.
    const host = request.headers.host;
    return host !== undefined
      && origin === new URL(`${secure ? "https" : request.protocol}://${host}`).origin;
  } catch {
    return false;
  }
}

export const buildAuthHook: (input: BuildAuthHookInput) => FastifyPluginCallback =
  ({ identity, cookieName, secure, allowedOrigins = [] }) =>
  fp(async (app) => {
    app.addHook("onRequest", async (request, reply) => {
      if (request.routeOptions.config.bearerOnly === true) return;
      const raw = request.cookies[cookieName];
      if (raw === undefined || raw.length === 0) {
        request.auth = { state: "anonymous" };
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS"
        && !permitsCookieWrite(request, secure, allowedOrigins)) {
        return reply.code(403).send({
          error: { code: "forbidden", message: "A same-origin request is required." },
          requestId: request.id,
        });
      }
      const result = await identity.resolveSession(raw);
      // Unresolvable sessions clear the cookie. Expired sessions surface
      // distinctly (so the UI can offer re-auth) while still clearing the
      // dead cookie like anonymous ones.
      if (result.state === "anonymous" || result.state === "session_expired") {
        reply.clearCookie(cookieName, { httpOnly: true, sameSite: "lax", path: "/", secure });
        request.auth = result;
        return;
      }
      request.auth = result;
    });
  });
