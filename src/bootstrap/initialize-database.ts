import { Client } from "pg";

import { loadConfig } from "../platform/config.js";
import { createLogger } from "../platform/logging.js";
import { initializeDatabase } from "../platform/initialize-database.js";
import { seedReferenceTemplates } from "../systems/implementation/persistence/index.js";

const config = loadConfig();
const logger = createLogger(config.logLevel);
const client = new Client({ connectionString: config.databaseUrl });

try {
  await client.connect();
  await initializeDatabase(client);
  const seeded = await seedReferenceTemplates(client);
  if (seeded.systemsInserted > 0 || seeded.versionsInserted > 0) {
    logger.info(
      { systemsInserted: seeded.systemsInserted, versionsInserted: seeded.versionsInserted },
      "reference templates seeded",
    );
  }
  logger.info("database initialization complete");
} catch (error) {
  logger.error({ err: error }, "database initialization failed");
  process.exitCode = 1;
} finally {
  await client.end();
}
