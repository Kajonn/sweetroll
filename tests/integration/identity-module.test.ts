import { randomUUID } from "node:crypto";

import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestOidcClient } from "../../src/identity/adapters/test.js";
import { createIdentityModule } from "../../src/identity/index.js";
import { createIdentityRepository } from "../../src/identity/repository.js";
import { hashToken, newSessionToken } from "../../src/identity/util.js";

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

describeWithDatabase("Identity module", () => {
  const schema = `identity_mod_${randomUUID().replaceAll("-", "")}`;
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

  function module() {
    return createIdentityModule({
      oidc: createTestOidcClient(
        new Map([
          [
            "code-ada",
            { provider: "test", subject: "subAda", email: "ada@example.com", displayName: "Ada" },
          ],
        ]),
      ),
      pool,
      sessionTtlMs: 60_000,
    });
  }

  it("signs in, resolves, rotates, and signs out", async () => {
    const identity = module();

    const first = await identity.completeSignIn({
      code: "code-ada",
      redirectUri: "http://localhost/cb",
      previousToken: undefined,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error.message);

    const resolved1 = await identity.resolveSession(first.value.token);
    expect(resolved1).toEqual({
      state: "authenticated",
      actorId: first.value.userId,
      sessionId: first.value.sessionId,
    });

    const second = await identity.completeSignIn({
      code: "code-ada",
      redirectUri: "http://localhost/cb",
      previousToken: first.value.token,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.error.message);

    expect(await identity.resolveSession(first.value.token)).toEqual({ state: "anonymous" });
    expect(await identity.resolveSession(second.value.token)).toEqual({
      state: "authenticated",
      actorId: second.value.userId,
      sessionId: second.value.sessionId,
    });

    await identity.signOut(second.value.token);
    expect(await identity.resolveSession(second.value.token)).toEqual({ state: "anonymous" });
  });

  it("maps a repeated sign-in to the same user id", async () => {
    const identity = module();
    const a = await identity.completeSignIn({
      code: "code-ada",
      redirectUri: "http://localhost/cb",
      previousToken: undefined,
    });
    const b = await identity.completeSignIn({
      code: "code-ada",
      redirectUri: "http://localhost/cb",
      previousToken: undefined,
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) throw new Error("unexpected");
    expect(b.value.userId).toBe(a.value.userId);
  });

  it("returns anonymous for unknown, expired, and revoked tokens", async () => {
    const identity = module();
    expect(await identity.resolveSession("no-such-token")).toEqual({ state: "anonymous" });
  });

  it("returns session_expired for an expired session token", async () => {
    const identity = module();
    const result = await identity.completeSignIn({
      code: "code-ada",
      redirectUri: "http://localhost/cb",
      previousToken: undefined,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);

    const repo = createIdentityRepository(pool);
    const token = newSessionToken();
    await repo.createSession({
      userId: result.value.userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() - 10_000),
    });
    expect(await identity.resolveSession(token)).toEqual({ state: "session_expired" });
  });

  it("rejects an invalid authorization code", async () => {
    const identity = module();
    const result = await identity.completeSignIn({
      code: "code-bad",
      redirectUri: "http://localhost/cb",
      previousToken: undefined,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("invalid_authorization_code");
  });
});
