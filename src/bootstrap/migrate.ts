import { fileURLToPath } from "node:url";

import { Client } from "pg";

import { loadConfig } from "../platform/config.js";
import { createLogger } from "../platform/logging.js";
import { runMigrations } from "../platform/migrations.js";

const config = loadConfig();
const logger = createLogger(config.logLevel);
const client = new Client({ connectionString: config.databaseUrl });
const directory = fileURLToPath(new URL("../../migrations", import.meta.url));

try {
  await client.connect();
  await runMigrations(client, directory);
  logger.info("database migrations complete");
} catch (error) {
  logger.error({ err: error }, "database migrations failed");
  process.exitCode = 1;
} finally {
  await client.end();
}
