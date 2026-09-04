import { writeFileSync } from "node:fs";

import { d20Export, d6SuccessPoolExport, pbta2d6Export } from "../src/systems/implementation/package/fixtures/index.js";

const targets = [
  { name: "d20", value: d20Export, path: "docs/contracts/examples/d20-system-export-v1.json" },
  { name: "pbta2d6", value: pbta2d6Export, path: "docs/contracts/examples/pbta2d6-system-export-v1.json" },
  { name: "yzCountedSuccess", value: d6SuccessPoolExport, path: "docs/contracts/examples/yzCountedSuccess-system-export-v1.json" },
];

for (const target of targets) {
  writeFileSync(target.path, `${JSON.stringify(target.value, null, 2)}\n`);
  console.log(`wrote ${target.path}`);
}