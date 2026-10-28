import { readFile } from "node:fs/promises";
import type { Client } from "pg";

const INITIALIZATION_LOCK_ID = 1_938_465_725;

/** Initialize an empty test database. Schema changes require recreating it. */
export async function initializeDatabase(client: Client): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock($1)", [INITIALIZATION_LOCK_ID]);
    const result = await client.query<{ initialized: boolean }>(
      "SELECT to_regclass('users') IS NOT NULL AS initialized",
    );
    if (result.rows[0]?.initialized !== true) {
      await client.query(await readFile(new URL("../../database/schema.sql", import.meta.url), "utf8"));
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
