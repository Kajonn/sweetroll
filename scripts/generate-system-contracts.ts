import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Fastify from "fastify";

import { SystemDocumentV1Schema } from "../src/systems/implementation/package/schema/document.js";
import { SystemExportV1Schema } from "../src/systems/implementation/package/schema/export.js";
import { SystemPackageV1Schema } from "../src/systems/implementation/package/schema/package.js";
import { d20Export } from "../src/systems/implementation/package/fixtures/d20.js";
import type { Characters } from "../src/characters/index.js";
import type { Identity } from "../src/identity/index.js";
import { buildCharactersRoutes } from "../src/transport/http/characters.js";
import { buildIdentityRoutes } from "../src/transport/http/identity.js";
import { buildOpenApiDocument } from "../src/transport/http/openapi.js";
import { buildSystemsRoutes } from "../src/transport/http/systems.js";
import type { SystemAuthoring } from "../src/systems/authoring.js";

const cwd = process.cwd();

const outputs = new Map<string, unknown>([
  ["docs/contracts/system-document-v1.schema.json", SystemDocumentV1Schema],
  ["docs/contracts/system-package-v1.schema.json", SystemPackageV1Schema],
  ["docs/contracts/system-export-v1.schema.json", SystemExportV1Schema],
  ["docs/contracts/examples/d20-system-export-v1.json", d20Export],
]);

const checkMode = process.argv.includes("--check");
const diffs: string[] = [];

for (const [relativePath, value] of outputs) {
  const content = JSON.stringify(value, null, 2) + "\n";
  const absolutePath = resolve(cwd, relativePath);

  if (checkMode) {
    try {
      const existing = readFileSync(absolutePath, "utf8");
      if (existing !== content) {
        diffs.push(relativePath);
      }
    } catch {
      diffs.push(relativePath);
    }
  } else {
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, "utf8");
  }
}

async function emitOpenApi(): Promise<void> {
  const app = Fastify({ logger: false });
  const identity: Identity = {
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
  await app.ready();
  try {
    const doc = buildOpenApiDocument(app);
    const content = JSON.stringify(doc, null, 2) + "\n";
    const relativePath = "docs/contracts/openapi-v1.json";
    const absolutePath = resolve(cwd, relativePath);

    if (checkMode) {
      let existing: string;
      try {
        existing = readFileSync(absolutePath, "utf8");
      } catch {
        diffs.push(relativePath);
        return;
      }
      if (existing !== content) {
        diffs.push(relativePath);
      }
    } else {
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, content, "utf8");
    }
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
