import { loadConfig, createLogger, createPool } from "../platform/index.js";
import { createIdentityModule } from "../identity/index.js";
import { createTestOidcClient } from "../identity/adapters/test.js";
import { createSystemAuthoringModule } from "../systems/authoring.js";
import { createSystemPersistenceRepository } from "../systems/implementation/persistence/index.js";
import { buildAuthHook } from "../transport/http/auth-hook.js";
import { buildDevSignInRoutes } from "../transport/http/dev-signin.js";
import { buildHttpApp, buildIdentityRoutes, buildSystemsRoutes } from "../transport/http/index.js";

const config = loadConfig();
const logger = createLogger(config.logLevel);
const pool = createPool(config.databaseUrl);

// Non-production runs seed a deterministic test OIDC client so the dev sign-in
// route can authenticate. Production runs use an empty map: the production
// OIDC adapter is deferred, so /dev/signin is gated off and OIDC resolves no
// codes through this path (session resolve/sign-out over HTTP remain fully
// functional).
const seed = new Map([
  ["code-dev", { displayName: "Dev User", email: "dev@example.com", provider: "test", subject: "dev-1" }],
]);

const identity = createIdentityModule({
  oidc: config.nodeEnv === "production" ? createTestOidcClient(new Map()) : createTestOidcClient(seed),
  pool,
  sessionTtlMs: config.sessionTtlDays * 86_400_000,
});

const authoring = createSystemAuthoringModule({
  repo: createSystemPersistenceRepository(pool),
});

const app = buildHttpApp({
  logger,
  pool,
  authHook: buildAuthHook({
    identity,
    cookieName: config.sessionCookieName,
    secure: config.cookieSecure,
    maxAgeSeconds: config.sessionTtlDays * 86_400,
  }),
});

void app.register(buildIdentityRoutes());
void app.register(buildSystemsRoutes({ authoring }));
void app.register(
  buildDevSignInRoutes({
    identity,
    nodeEnv: config.nodeEnv,
    cookieName: config.sessionCookieName,
    secure: config.cookieSecure,
    maxAgeSeconds: config.sessionTtlDays * 86_400,
  }),
);

const shutdown = async (signal: string) => {
  logger.info({ signal }, "shutting down HTTP process");
  await app.close();
  await pool.end();
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  logger.fatal({ err: error }, "HTTP process failed to start");
  await pool.end();
  process.exitCode = 1;
}
