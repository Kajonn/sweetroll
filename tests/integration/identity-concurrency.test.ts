import { randomUUID } from "node:crypto";

import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestOidcClient } from "../../src/identity/adapters/test.js";
import { createIdentityModule } from "../../src/identity/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;

const IDENTITY_DDL = `
  CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name text,
    locale text NOT NULL DEFAULT 'en',
    status text NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE external_identities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider text NOT NULL,
    subject text NOT NULL,
    email text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, subject)
  );
  CREATE TABLE sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz
  );
  CREATE INDEX sessions_user_id_idx ON sessions (user_id);
`;

describeWithDatabase("Identity first-sign-in concurrency", () => {
  const schema = `identity_conc_${randomUUID().replaceAll("-", "")}`;
  let pool: Pool;

  beforeAll(async () => {
    // Pin the schema on EVERY pooled connection (not just one checkout):
    // the 8 concurrent first-sign-ins check out 8 connections, and a bare
    // beforeEach SET would leave most of them on the default search_path.
    pool = new Pool({
      connectionString: databaseUrl,
      application_name: schema,
      onConnect: async (client) => {
        await client.query(`SET search_path TO ${schema}`);
      },
    });
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    await admin.query(IDENTITY_DDL);
    await admin.end();
  });

  afterAll(async () => {
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    await pool.end();
  });

  it("8 concurrent first sign-ins resolve to one canonical user", async () => {
    const codes = new Map(
      Array.from({ length: 8 }, (_, index) => [
        `code-conc-${index}`,
        {
          provider: "test",
          subject: "subConc",
          email: `conc-${index}@example.com`,
          displayName: "Conc",
        },
      ]),
    );
    const identity = createIdentityModule({
      oidc: createTestOidcClient(codes),
      pool,
      sessionTtlMs: 60_000,
    });

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        identity.completeSignIn({
          code: `code-conc-${index}`,
          redirectUri: "http://localhost/cb",
          previousToken: undefined,
        }),
      ),
    );
    const userIds = results.map((result) => {
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      return result.value.userId;
    });
    expect(new Set(userIds).size).toBe(1);

    const users = await pool.query<{ count: string }>("SELECT COUNT(*) AS count FROM users");
    expect(Number(users.rows[0]?.count ?? "0")).toBe(1);
    const links = await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM external_identities WHERE provider = $1 AND subject = $2",
      ["test", "subConc"],
    );
    expect(Number(links.rows[0]?.count ?? "0")).toBe(1);
  });
});
