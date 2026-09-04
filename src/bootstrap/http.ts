import { loadConfig, createLogger, createPool } from "../platform/index.js";
import { createIdentityModule } from "../identity/index.js";
import { createTestOidcClient } from "../identity/adapters/test.js";
import { buildHttpApp } from "../transport/http/index.js";
import { buildAuthHook } from "../transport/http/auth-hook.js";

const config = loadConfig();
const logger = createLogger(config.logLevel);
const pool = createPool(config.databaseUrl);

// The production OIDC adapter is deferred; the deterministic test adapter
// with no codes satisfies the port for now (authenticates no one via OIDC,
// but session resolve/sign-out over HTTP are fully functional).
const identity = createIdentityModule({
  oidc: createTestOidcClient(new Map()),
  pool,
  sessionTtlMs: config.sessionTtlDays * 86_400_000,
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