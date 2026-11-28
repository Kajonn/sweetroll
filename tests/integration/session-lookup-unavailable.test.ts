import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { buildI3App, createI3Schema, dropI3Schema, type I3AppHandle } from "./i3-app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

// Mirrors the production pool's short acquire timeout (src/platform/database.ts).
async function makeApp(): Promise<I3AppHandle & { pool: Pool }> {
  const schema = `i3_session_${randomUUID().replaceAll("-", "")}`;
  await createI3Schema(databaseUrl!, schema);
  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: schema,
    max: 2,
    connectionTimeoutMillis: 250,
    onConnect: async (client) => {
      await client.query(`SET search_path TO ${schema}`);
    },
  });
  const handle = await buildI3App({ pool });
  cleanup = async () => {
    await handle.app.close();
    await pool.end();
    await dropI3Schema(databaseUrl!, schema);
  };
  return { ...handle, pool };
}

describeWithDatabase("session lookup when the database is unavailable", () => {
  it("keeps a valid session cookie and answers 503 while no connection is free", async () => {
    const { app, pool, users } = await makeApp();
    const held: PoolClient[] = [await pool.connect(), await pool.connect()];
    let busy;
    try {
      busy = await app.inject({ method: "GET", url: "/me/preferences", headers: { cookie: users.ada.cookie } });
    } finally {
      for (const client of held) client.release();
    }
    expect(busy.statusCode, busy.body).toBe(503);
    expect(busy.json()).toMatchObject({ error: { code: "temporarily_unavailable" } });
    expect(busy.headers["set-cookie"]).toBeUndefined();

    const recovered = await app.inject({ method: "GET", url: "/me/preferences", headers: { cookie: users.ada.cookie } });
    expect(recovered.statusCode, recovered.body).toBe(200);
  });
});
