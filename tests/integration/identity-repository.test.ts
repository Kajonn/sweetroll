import { randomUUID } from "node:crypto";

import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createIdentityRepository } from "../../src/identity/repository.js";

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

describeWithDatabase("IdentityRepository", () => {
  const schema = `identity_repo_${randomUUID().replaceAll("-", "")}`;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    await admin.query(IDENTITY_DDL);
    await admin.end();
  });

  beforeEach(async () => {
    await pool.query(`SET search_path TO ${schema}`);
  });

  afterAll(async () => {
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    await pool.end();
  });

  async function upsert(provider: string, subject: string, email: string) {
    const repo = createIdentityRepository(pool);
    return repo.upsertExternalIdentity({ provider, subject, email, displayName: "Ada" });
  }

  it("maps repeated sign-ins for the same external identity to the same user", async () => {
    const first = await upsert("test", "subA", "ada@example.com");
    const second = await upsert("test", "subA", "ada-updated@example.com");

    expect(second.userId).toBe(first.userId);
    const { rows } = await pool.query<{ display_name: string | null }>(
      "SELECT display_name FROM users WHERE id = $1",
      [first.userId],
    );
    expect(rows[0]?.display_name).toBe("Ada");
  });

  it("creates a session, finds it by token hash, and revokes it", async () => {
    const { userId } = await upsert("test", "subB", "bob@example.com");
    const repo = createIdentityRepository(pool);
    const tokenHash = randomUUID().replaceAll("-", "");
    const expiresAt = new Date(Date.now() + 60_000);
    const created = await repo.createSession({ userId, tokenHash, expiresAt });

    const found = await repo.findSessionByTokenHash(tokenHash);
    expect(found?.sessionId).toBe(created.sessionId);
    expect(found?.userId).toBe(userId);

    await repo.revokeSessionByTokenHash(tokenHash);
    const revoked = await repo.findSessionByTokenHash(tokenHash);
    expect(revoked?.revokedAt).not.toBeNull();
  });

  it("returns null for an unknown token hash", async () => {
    const repo = createIdentityRepository(pool);
    expect(await repo.findSessionByTokenHash("no-such-hash")).toBeNull();
  });
});
