import { Pool } from "pg";
import type { Logger } from "pino";

export function createPool(databaseUrl: string, logger: Logger): Pool {
  const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 250, max: 10 });
  // I7 hardening: without an "error" listener, node-postgres rethrows
  // idle-client errors uncaught and kills the backend process on abrupt DB
  // loss. The listener only prevents process death (dead idle clients are
  // reaped by pg Pool; fresh connections are dialed on demand), so
  // /health/ready can report 503 and recover instead.
  pool.on("error", (error) => {
    logger.error({ err: error }, "postgres pool idle client error");
  });
  return pool;
}
