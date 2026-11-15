// Prints the system document as JSON, for publishing to a running server:
//   npx tsx tests/integration/fixtures/dnd5e/write-document.ts > dnd5e-srd.json
//   python3 scripts/public-api-quickstart.py --base-url <origin> --document dnd5e-srd.json
import { dnd5eDocument } from "./document.js";

process.stdout.write(`${JSON.stringify(dnd5eDocument)}\n`);
