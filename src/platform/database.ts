import { Pool } from "pg";

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 250, max: 10 });
}
