import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Fastify from "fastify";
import openapiTS from "openapi-typescript";
import type { Pool } from "pg";

import { SystemDocumentV1Schema } from "../src/systems/implementation/package/schema/document.js";
import { SystemExportV1Schema } from "../src/systems/implementation/package/schema/export.js";
import { SystemPackageV1Schema } from "../src/systems/implementation/package/schema/package.js";
import { d20Document, d20Export } from "../src/systems/implementation/package/fixtures/d20.js";
import type { Characters } from "../src/characters/index.js";
import type { Campaigns } from "../src/campaigns/index.js";
import type { SystemRuntime } from "../src/systems/runtime.js";
import type { Identity } from "../src/identity/index.js";
import { buildCampaignsRoutes } from "../src/transport/http/campaigns.js";
import { buildCharactersRoutes } from "../src/transport/http/characters.js";
import { buildIdentityRoutes } from "../src/transport/http/identity.js";
import { buildPublicApi, publicApiPrefix } from "../src/transport/http/public-api/index.js";
import { buildOpenApiDocument } from "../src/transport/http/openapi.js";
import { buildSystemsRoutes } from "../src/transport/http/systems.js";
import type { SystemAuthoring } from "../src/systems/authoring.js";

const cwd = process.cwd();

const outputs = new Map<string, unknown>([
  ["docs/contracts/system-document-v1.schema.json", SystemDocumentV1Schema],
  ["docs/contracts/system-package-v1.schema.json", SystemPackageV1Schema],
  ["docs/contracts/system-export-v1.schema.json", SystemExportV1Schema],
  ["docs/contracts/examples/d20-system-export-v1.json", d20Export],
  ["docs/contracts/examples/d20-system-document-v1.json", d20Document],
]);

const checkMode = process.argv.includes("--check");
const diffs: string[] = [];

function emitJson(relativePath: string, value: unknown): void {
  const content = JSON.stringify(value, null, 2) + "\n";
  const absolutePath = resolve(cwd, relativePath);
  if (checkMode) {
    try {
      if (readFileSync(absolutePath, "utf8") !== content) diffs.push(relativePath);
    } catch {
      diffs.push(relativePath);
    }
  } else {
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, "utf8");
  }
}

for (const [relativePath, value] of outputs) emitJson(relativePath, value);

async function emitOpenApi(): Promise<void> {
  const app = Fastify({ logger: false });
  const identity: Identity = {
    personalTokens: {} as Identity["personalTokens"],
    getDisplayNames: async () => ({ ok: true, value: [] }),
    completeSignIn: async () => {
      throw new Error("not used");
    },
    resolveSession: async () => ({ state: "anonymous" }),
    signOut: async () => ({ ok: true, value: undefined }),
    getThemeDefault: async () => ({ ok: true, value: null }),
    setThemeDefault: async (_actorId, value) => ({ ok: true, value }),
  };
  void app.register(buildIdentityRoutes({ identity, cookieName: "session", secure: true }));
  void app.register(buildSystemsRoutes({ authoring: {} as SystemAuthoring }));
  void app.register(buildCharactersRoutes({ characters: {} as Characters }));
  // I6 Task 9: campaign routes ship in the same document. The handlers never
  // run during generation, so stub modules suffice (mirrors the Characters
  // stub above); the document itself comes from campaignsRouteDefinitions.
  void app.register(
    buildCampaignsRoutes({
      campaigns: {} as Campaigns,
      characters: {} as Characters,
      runtime: {} as SystemRuntime,
    }),
  );
  await app.register(buildPublicApi({
    identity, pool: {} as Pool, authoring: {} as SystemAuthoring, characters: {} as Characters,
    campaigns: {} as Campaigns, runtime: {} as SystemRuntime,
  }), { prefix: publicApiPrefix });
  await app.ready();
  try {
    emitJson("docs/contracts/openapi-v1.json", buildOpenApiDocument(app));
    const response = await app.inject(`${publicApiPrefix}/openapi.json`);
    if (response.statusCode !== 200) throw new Error("Public API contract route failed.");
    const publicContract = response.json();
    await openapiTS(publicContract);
    emitJson("docs/contracts/public-api-v1.json", publicContract);
  } finally {
    await app.close();
  }
}

await emitOpenApi();

function emitClientTypes(): void {
  const openApiRelativePath = "docs/contracts/openapi-v1.json";
  const schemaRelativePath = "web/src/api/schema.d.ts";
  const openApiPath = resolve(cwd, openApiRelativePath);
  const schemaPath = resolve(cwd, schemaRelativePath);

  const generated = execSync(`npx --yes openapi-typescript ${openApiPath}`, {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  }).toString();

  if (checkMode) {
    let current: string;
    try {
      current = readFileSync(schemaPath, "utf8");
    } catch {
      diffs.push(schemaRelativePath);
      return;
    }
    if (current !== generated) {
      diffs.push(schemaRelativePath);
    }
  } else {
    mkdirSync(dirname(schemaPath), { recursive: true });
    writeFileSync(schemaPath, generated, "utf8");
  }
}

emitClientTypes();

if (checkMode && diffs.length > 0) {
  console.error("Out-of-date contract artifacts:");
  for (const path of diffs) {
    console.error(`  ${path}`);
  }
  process.exitCode = 1;
}
