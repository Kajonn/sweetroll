import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { SystemDocumentV1Schema } from "../src/systems/implementation/package/schema/document.js";
import { SystemExportV1Schema } from "../src/systems/implementation/package/schema/export.js";
import { SystemPackageV1Schema } from "../src/systems/implementation/package/schema/package.js";
import { d20Export } from "../src/systems/implementation/package/fixtures/d20.js";

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

if (checkMode && diffs.length > 0) {
  console.error("Out-of-date contract artifacts:");
  for (const path of diffs) {
    console.error(`  ${path}`);
  }
  process.exitCode = 1;
}
