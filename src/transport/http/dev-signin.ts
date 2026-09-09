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
  /**
   * Test-only escape hatch for production-browser offline acceptance: when
   * true, the `/dev/signin` endpoint is registered even with
   * `nodeEnv === "production"`. The production UI never renders the dev
   * sign-in panel (it mounts only when `import.meta.env.MODE ===
   * "development"`), so browser contexts authenticate through this endpoint
   * directly via the test-auth fixture instead of any production UI.
   *
   * Callers derive this from `resolveAuthMode()` (single rule, shared with
   * bootstrap): pass `testAuthEnabled` (i.e. `SWEETROLL_TEST_AUTH=1`).
   */
  allowInProduction?: boolean;
};

/**
 * Auth mode for `/dev/*` registration. One rule, two call sites (this
 * plugin and `src/bootstrap/http.ts`):
 * - non-production → "dev": dev sign-in routes are registered.
 * - production + explicit `SWEETROLL_TEST_AUTH=1` → "test-auth": dev sign-in
 *   routes are registered for offline/prod-test configs only.
 * - production otherwise → "locked": no `/dev/*` routes.
 *
 * No production OIDC provider adapter exists; this gate only controls the
 * deterministic test adapter's sign-in route, never provider credentials
 * (there are none in-repo and none are invented here).
 */
export type AuthMode = "dev" | "test-auth" | "locked";

export function resolveAuthMode(
  nodeEnv: "development" | "production" | "test",
  testAuthEnabled: boolean,
): AuthMode {
  if (nodeEnv !== "production") return "dev";
  if (testAuthEnabled) return "test-auth";
  return "locked";
}

export const buildDevSignInRoutes: (input: BuildDevSignInRoutesInput) => FastifyPluginCallback =
  ({ identity, nodeEnv, cookieName = "session", secure = false, maxAgeSeconds = 30 * 86_400, allowInProduction = false }) =>
  fp(async (app) => {
    // `/dev/*` registers ONLY when nodeEnv !== "production" OR explicit
    // SWEETROLL_TEST_AUTH=1 (see resolveAuthMode).
    if (resolveAuthMode(nodeEnv, allowInProduction) === "locked") return;
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