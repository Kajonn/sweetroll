import { readFile } from "node:fs/promises";
import { createTemplateRepository } from "../../src/campaigns/templatePersistence.js";
import { Client, Pool } from "pg";
import pino from "pino";
import type { FastifyInstance, FastifyPluginCallback } from "fastify";

import { createTestOidcClient } from "../../src/identity/adapters/test.js";
import { createIdentityModule, type Identity } from "../../src/identity/index.js";
import { createSystemAuthoringModule, type SystemAuthoring } from "../../src/systems/authoring.js";
import {
  createSystemPersistenceRepository,
} from "../../src/systems/implementation/persistence/index.js";
import { createPostgresPublishedPackageLoader } from "../../src/systems/implementation/runtime/package-loader.js";
import {
  createSystemRuntime,
  type SystemRuntime,
} from "../../src/systems/runtime.js";
import { createCharactersModule, type Characters } from "../../src/characters/index.js";
import type { SystemDocumentV1 } from "../../src/systems/implementation/package/schema/document.js";
import { d20Document } from "../../src/systems/implementation/package/fixtures/index.js";
import { buildHttpApp } from "../../src/transport/http/app.js";
import { buildAuthHook } from "../../src/transport/http/auth-hook.js";
import { buildCharactersRoutes } from "../../src/transport/http/characters.js";
import { buildDevSignInRoutes } from "../../src/transport/http/dev-signin.js";
import { buildIdentityRoutes } from "../../src/transport/http/identity.js";
import { buildSystemsRoutes } from "../../src/transport/http/systems.js";

export async function createI3Schema(databaseUrl: string, schema: string): Promise<void> {
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query(`SET search_path TO ${schema}`);
  await admin.query(await readFile(new URL("../../migrations/0001_current_schema.sql", import.meta.url), "utf8"));
  await admin.end();
}

export async function dropI3Schema(databaseUrl: string, schema: string): Promise<void> {
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
}

export function createI3Pool(databaseUrl: string, schema: string, max = 16): Pool {
  return new Pool({
    connectionString: databaseUrl,
    application_name: schema,
    max,
    onConnect: async (client) => {
      await client.query(`SET search_path TO ${schema}`);
    },
  });
}

export type I3Users = {
  ada: { actorId: string; cookie: string };
  bob: { actorId: string; cookie: string };
};

export type I3AppHandle = {
  app: FastifyInstance;
  identity: Identity;
  authoring: SystemAuthoring;
  characters: Characters;
  runtime: SystemRuntime;
  pool: Pool;
  users: I3Users;
};

export type BuildI3AppInput = {
  pool: Pool;
  /** Wraps the runtime (e.g. to count resolve calls); defaults to identity. */
  wrapRuntime?: (runtime: SystemRuntime) => SystemRuntime;
  rollSecret?: string;
  /**
   * I6 Task 9: extra route plugins needing the built modules. Fastify
   * forbids register() after boot, so dependents (campaign HTTP) register
   * here, before ready(), instead of after buildI3App returns.
   */
  extraRoutes?: (modules: {
    authoring: SystemAuthoring;
    characters: Characters;
    runtime: SystemRuntime;
  }) => FastifyPluginCallback | FastifyPluginCallback[];
};

export async function buildI3App(input: BuildI3AppInput): Promise<I3AppHandle> {
  const rollSecret = input.rollSecret ?? "a".repeat(32);
  const identity = createIdentityModule({
    oidc: createTestOidcClient(
      new Map([
        ["code-ada", { provider: "test", subject: "subAda", email: "ada@example.com", displayName: "Ada" }],
        ["code-bob", { provider: "test", subject: "subBob", email: "bob@example.com", displayName: "Bob" }],
        ["code-cara", { provider: "test", subject: "subCara", email: "cara@example.com", displayName: "Cara" }],
        ["code-dan", { provider: "test", subject: "subDan", email: "dan@example.com", displayName: "Dan" }],
      ]),
    ),
    pool: input.pool,
    sessionTtlMs: 3_600_000,
  });

  const authoring = createSystemAuthoringModule({
    repo: createSystemPersistenceRepository(input.pool),
  });

  const runtime = createSystemRuntime({
    loadPackage: createPostgresPublishedPackageLoader(input.pool),
    authoritativeRollSecret: rollSecret,
  });

  const effectiveRuntime = input.wrapRuntime === undefined ? runtime : input.wrapRuntime(runtime);

  const characters = createCharactersModule({
    campaignTemplates:createTemplateRepository(input.pool),
    pool: input.pool,
    runtime: effectiveRuntime,
    authorizeVersionUse: authoring.authorizeVersionUse,
    listAuthorizedVersions: authoring.listAuthorizedVersions,
  });

  const authHook = buildAuthHook({
    identity,
    cookieName: "session",
    secure: false,
    maxAgeSeconds: 3600,
  });

  const app = buildHttpApp({
    logger: pino({ level: "silent" }),
    pool: input.pool,
    authHook,
  });

  void app.register(buildIdentityRoutes({ identity, cookieName: "session", secure: false }));
  void app.register(buildSystemsRoutes({ authoring }));
  void app.register(buildCharactersRoutes({ characters }));
  void app.register(
    buildDevSignInRoutes({
      identity,
      nodeEnv: "test",
      cookieName: "session",
      secure: false,
      maxAgeSeconds: 3600,
    }),
  );

  if (input.extraRoutes !== undefined) {
    const routes = input.extraRoutes({ authoring, characters, runtime });
    for (const plugin of Array.isArray(routes) ? routes : [routes]) {
      void app.register(plugin);
    }
  }

  await app.ready();

  const users = {} as I3Users;
  for (const [code, key] of [
    ["code-ada", "ada"],
    ["code-bob", "bob"],
  ] as const) {
    const response = await app.inject({
      method: "POST",
      url: "/dev/signin",
      payload: { code, redirectUri: "http://localhost/cb" },
    });
    if (response.statusCode !== 200) {
      throw new Error(`dev/signin (${code}) failed: ${response.statusCode} ${response.body}`);
    }
    const body = response.json<{ userId: string }>();
    users[key] = { actorId: body.userId, cookie: idkCookieFromSetCookieResponse(response) };
  }

  return { app, identity, authoring, characters, runtime, pool: input.pool, users };
}

function idkCookieFromSetCookieResponse(response: {
  headers: { "set-cookie"?: string | string[] };
}): string {
  const setCookie = response.headers["set-cookie"];
  const header = Array.isArray(setCookie) ? setCookie[0] ?? "" : setCookie ?? "";
  return header.split(";")[0] ?? "";
}

/** Builds a d20 document whose v2 breaks the v1 schema (the same
 * transformation used by tests/integration/character-migration.test.ts). */
export function buildD20V2Document(): SystemDocumentV1 {
  const document = structuredClone(d20Document);
  const fields = document.entities[0]!.fields;
  const abilityIndex = fields.findIndex((f) => f.id === "ability");
  fields[abilityIndex]!.id = "ability_score";
  fields.splice(
    fields.findIndex((f) => f.id === "proficient"),
    1,
  );
  fields.push({
    kind: "integer",
    id: "level",
    label: "Level",
    default: 1,
    required: true,
    min: 1,
    max: 20,
    step: 1,
  });
  const abilityElement = document.sheets[0]!.sections[1]!.elements.find(
    (e) => e.kind === "field" && e.fieldId === "ability",
  );
  if (abilityElement?.kind === "field") abilityElement.fieldId = "ability_score";
  const abilityValid = document.expressions.find((e) => e.id === "ability_valid_expr");
  if (abilityValid) abilityValid.source = "fields.ability_score >= 3 && fields.ability_score <= 18";
  const validation = document.validations.find((v) => v.id === "ability_valid");
  if (validation) validation.targetId = "ability_score";
  return document;
}