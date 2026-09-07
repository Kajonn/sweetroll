import { loadConfig, createLogger, createPool } from "../platform/index.js";
import { createIdentityModule } from "../identity/index.js";
import { createTestOidcClient } from "../identity/adapters/test.js";
import { createSystemAuthoringModule } from "../systems/authoring.js";
import { createCharactersModule } from "../characters/index.js";
import {
  createSystemPersistenceRepository,
  seedReferenceTemplates,
} from "../systems/implementation/persistence/index.js";
import { createSystemRuntime } from "../systems/runtime.js";
import { createPostgresPublishedPackageLoader } from "../systems/implementation/runtime/package-loader.js";
import { buildAuthHook } from "../transport/http/auth-hook.js";
import { buildDevSignInRoutes } from "../transport/http/dev-signin.js";
import {
  buildCharactersRoutes,
  buildHttpApp,
  buildIdentityRoutes,
  buildSystemsRoutes,
} from "../transport/http/index.js";

const config = loadConfig();
const logger = createLogger(config.logLevel);
const pool = createPool(config.databaseUrl);

// Reference template fixtures are global rows (NULL owner, link) used by
// CloneFromTemplate. They are inserted by migration 0008 and/or this seed call
// (idempotent — no-op once the rows are populated).
const seeded = await seedReferenceTemplates(pool);
if (seeded.systemsInserted > 0 || seeded.versionsReplaced > 0) {
  logger.info(
    { systemsInserted: seeded.systemsInserted, versionsReplaced: seeded.versionsReplaced },
    "reference templates seeded",
  );
}

// Non-production runs seed a deterministic test OIDC client so the dev sign-in
// route can authenticate. Production runs use an empty map: the production
// OIDC adapter is deferred, so /dev/signin is gated off and OIDC resolves no
// codes through this path (session resolve/sign-out over HTTP remain fully
// functional).
//
// Test-only exception for production-browser offline acceptance (Task 11):
// `SWEETROLL_TEST_AUTH=1` seeds two isolated test identities and registers
// `/dev/signin` even in production. The production UI never renders the dev
// sign-in panel, so browser contexts authenticate through that endpoint
// directly via the offline test-auth fixture — never through a production
// synthetic user or production UI affordance.
const testAuthEnabled = process.env.SWEETROLL_TEST_AUTH === "1";
const seed = new Map([
  ["code-dev", { displayName: "Dev User", email: "dev@example.com", provider: "test", subject: "dev-1" }],
  ["code-test-a", { displayName: "Offline Test A", email: "offline-a@example.com", provider: "test", subject: "offline-test-a" }],
  ["code-test-b", { displayName: "Offline Test B", email: "offline-b@example.com", provider: "test", subject: "offline-test-b" }],
]);

const identity = createIdentityModule({
  oidc:
    config.nodeEnv === "production" && !testAuthEnabled
      ? createTestOidcClient(new Map())
      : createTestOidcClient(seed),
  pool,
  sessionTtlMs: config.sessionTtlDays * 86_400_000,
});

const authoring = createSystemAuthoringModule({
  repo: createSystemPersistenceRepository(pool),
});

const runtime = createSystemRuntime({
  loadPackage: createPostgresPublishedPackageLoader(pool),
  authoritativeRollSecret: config.authoritativeRollSecret,
});

const characters = createCharactersModule({
  pool,
  runtime,
  authorizeVersionUse: authoring.authorizeVersionUse,
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

void app.register(
  buildIdentityRoutes({
    identity,
    cookieName: config.sessionCookieName,
    secure: config.cookieSecure,
    allowedOrigins: config.allowedOrigins,
  }),
);
void app.register(buildSystemsRoutes({ authoring }));
void app.register(buildCharactersRoutes({ characters }));
void app.register(
  buildDevSignInRoutes({
    identity,
    nodeEnv: config.nodeEnv,
    cookieName: config.sessionCookieName,
    secure: config.cookieSecure,
    maxAgeSeconds: config.sessionTtlDays * 86_400,
    allowInProduction: testAuthEnabled,
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
