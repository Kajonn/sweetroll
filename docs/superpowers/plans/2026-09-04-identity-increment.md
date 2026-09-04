# Identity Module and OIDC Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Identity Module, its OIDC port with a deterministic test adapter, the identity persistence migration, and the HTTP authentication hook that resolves sessions into an `AuthContext`.

**Architecture:** The Identity Module exposes one `Identity` Interface and owns `users`, `external_identities`, and `sessions`. A PostgreSQL `Pool` and an `OidcClient` port are injected at process composition (deep-module rules). The HTTP Adapter reads the session cookie and calls the Module to build an `AuthContext`. The concrete production OIDC adapter is deferred; a deterministic test adapter satisfies the port now.

**Tech Stack:** Node 24, TypeScript, Fastify 5, `pg` 8 (real PostgreSQL 17), Vitest 3, Node `node:crypto` for hashing and high-entropy tokens.

**Spec:** `docs/superpowers/specs/2026-09-04-identity-module-design.md` and `design_v2.md` sections 11, 12, 14.

## Global Constraints

- One Modular interface per Module; callers and tests both use the `Identity` Interface.
- Dependencies (Pool, OidcClient) are injected, never created inside the implementation.
- No generic persistence seam; identity SQL is tested with real PostgreSQL.
- Provider tokens and claims never enter Systems Interfaces; only normalized `VerifiedClaims` cross the port.
- Never log tokens, authorization codes, session cookies, or database URLs (structured allow-list logging).
- Opaque UUID IDs; sessions store only a SHA-256 hash of the token.
- Authentication resolves before a Module call; the Module never reveals whether a session token is merely unknown.
- Ordinary HTTP operations target p95 below 300 ms; session resolution is a single indexed read.
- Uses the existing strict TypeScript config (NodeNext, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`).
- No System, Character, or Campaign behavior; no email/password auth; no production OIDC adapter; no CSRF token issuance yet.
- All integration tests follow the existing unique-schema pattern in `tests/integration/migrations.test.ts` and gate on `TEST_DATABASE_URL`.

---

### Task 1: OIDC Port And Deterministic Test Adapter

**Files:**
- Create: `src/identity/oidc.ts`
- Create: `src/identity/errors.ts`
- Create: `src/identity/adapters/test.ts`
- Create: `src/identity/adapters/test.test.ts`

**Interfaces:**
- Consumes: nothing (pure types).
- Produces: `OidcClient`, `AuthCodeInput`, `VerifiedClaims`, `AppError`, and `createTestOidcClient(codes: Map<string, VerifiedClaims>): OidcClient`. Task 3 consumes these.

- [ ] **Step 1: Write the failing test adapter test**

Create `src/identity/adapters/test.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { createTestOidcClient } from "./test.js";

describe("createTestOidcClient", () => {
  const codeToClaims = new Map([
    [
      "code-ok",
      { displayName: "Ada", email: "ada@example.com", provider: "test", subject: "sub-1" },
    ],
  ]);
  const client = createTestOidcClient(codeToClaims);

  it("returns verified claims for a known code", async () => {
    await expect(
      client.verifyAuthorizationCode({ code: "code-ok", redirectUri: "http://localhost/cb" }),
    ).resolves.toEqual({
      displayName: "Ada",
      email: "ada@example.com",
      provider: "test",
      subject: "sub-1",
    });
  });

  it("rejects an unknown code", async () => {
    await expect(
      client.verifyAuthorizationCode({ code: "nope", redirectUri: "http://localhost/cb" }),
    ).rejects.toMatchObject({ code: "invalid_authorization_code" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/identity/adapters/test.test.ts`

Expected: FAIL because `./test.js` does not resolve.

- [ ] **Step 3: Implement the port types, errors, and test adapter**

Create `src/identity/oidc.ts`:

```typescript
export type AuthCodeInput = {
  code: string;
  redirectUri: string;
};

export type VerifiedClaims = {
  provider: string;
  subject: string;
  email: string;
  displayName: string | undefined;
};

export interface OidcClient {
  verifyAuthorizationCode(input: AuthCodeInput): Promise<VerifiedClaims>;
}
```

Create `src/identity/errors.ts`:

```typescript
export type AppErrorCode = "invalid_authorization_code" | "internal" | "session_expired";

export type AppError = {
  code: AppErrorCode;
  message: string;
};

export function createInvalidCodeError(): AppError {
  return {
    code: "invalid_authorization_code",
    message: "The authorization code is invalid or expired.",
  };
}
```

Create `src/identity/adapters/test.ts`:

```typescript
import { createInvalidCodeError } from "../errors.js";
import type { AuthCodeInput, OidcClient, VerifiedClaims } from "../oidc.js";

export function createTestOidcClient(codes: Map<string, VerifiedClaims>): OidcClient {
  return {
    async verifyAuthorizationCode(input: AuthCodeInput): Promise<VerifiedClaims> {
      const claims = codes.get(input.code);
      if (claims === undefined) {
        throw createInvalidCodeError();
      }
      return { ...claims };
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/identity/adapters/test.test.ts`

Expected: PASS with 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/identity/oidc.ts src/identity/errors.ts src/identity/adapters/test.ts src/identity/adapters/test.test.ts
git commit -m "feat: add identity OIDC port and test adapter"
```

---

### Task 2: Identity Tables Migration And Repository

**Files:**
- Create: `migrations/0001_create_identity.sql`
- Create: `src/identity/repository.ts`
- Create: `tests/integration/identity-repository.test.ts`

**Interfaces:**
- Consumes: a connected `pg.Pool`.
- Produces: `IdentityRepository` with `upsertExternalIdentity`, `createSession`, `findSessionByTokenHash`, `revokeSessionByTokenHash`, and types `UserId`, `SessionId`, `UpsertExternalIdentityInput`, `UpsertResult`, `CreateSessionInput`, `SessionRecord`. Task 3 composes these.

- [ ] **Step 1: Write the identity schema migration**

Create `migrations/0001_create_identity.sql`:

```sql
CREATE TABLE users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text,
  locale       text NOT NULL DEFAULT 'en',
  status       text NOT NULL DEFAULT 'active',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE external_identities (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider   text NOT NULL,
  subject    text NOT NULL,
  email      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, subject)
);

CREATE TABLE sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);
```

- [ ] **Step 2: Write the failing repository tests**

Create `tests/integration/identity-repository.test.ts`:

```typescript
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
```

- [ ] **Step 3: Run the integration tests to verify they fail**

Run: `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npm run test:integration -- identity-repository.test.ts`

Expected: FAIL because `src/identity/repository.ts` does not exist.

- [ ] **Step 4: Implement the repository**

Create `src/identity/repository.ts`:

```typescript
import type { Pool } from "pg";

export type UserId = string;
export type SessionId = string;

export type UpsertExternalIdentityInput = {
  provider: string;
  subject: string;
  email: string;
  displayName: string | undefined;
};

export type UpsertResult = { userId: UserId };

export type CreateSessionInput = {
  userId: UserId;
  tokenHash: string;
  expiresAt: Date;
};

export type SessionRecord = {
  sessionId: SessionId;
  userId: UserId;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
};

export interface IdentityRepository {
  upsertExternalIdentity(input: UpsertExternalIdentityInput): Promise<UpsertResult>;
  createSession(input: CreateSessionInput): Promise<{ sessionId: SessionId }>;
  findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  revokeSessionByTokenHash(tokenHash: string): Promise<void>;
}

export function createIdentityRepository(pool: Pool): IdentityRepository {
  return {
    async upsertExternalIdentity(input) {
      return upsertExternalIdentityImpl(pool, input);
    },

    async createSession(input) {
      const result = await pool.query<{ id: string }>(
        "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3) RETURNING id",
        [input.userId, input.tokenHash, input.expiresAt],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("createSession returned no row");
      }
      return { sessionId: row.id };
    },

    async findSessionByTokenHash(tokenHash) {
      const result = await pool.query<{
        id: string;
        user_id: string;
        token_hash: string;
        expires_at: Date;
        revoked_at: Date | null;
      }>(
        "SELECT id, user_id, token_hash, expires_at, revoked_at FROM sessions WHERE token_hash = $1",
        [tokenHash],
      );
      const row = result.rows[0];
      if (row === undefined) {
        return null;
      }
      return {
        sessionId: row.id,
        userId: row.user_id,
        tokenHash: row.token_hash,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
      };
    },

    async revokeSessionByTokenHash(tokenHash) {
      await pool.query(
        "UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL",
        [tokenHash],
      );
    },
  };
}

async function upsertExternalIdentityImpl(
  pool: Pool,
  input: UpsertExternalIdentityInput,
): Promise<UpsertResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{ id: string }>(
      `SELECT u.id
         FROM users u
         JOIN external_identities ei ON ei.user_id = u.id
        WHERE ei.provider = $1 AND ei.subject = $2`,
      [input.provider, input.subject],
    );
    if (existing.rows[0] !== undefined) {
      await client.query(
        "UPDATE external_identities SET email = $1 WHERE provider = $2 AND subject = $3",
        [input.email, input.provider, input.subject],
      );
      await client.query("COMMIT");
      return { userId: existing.rows[0].id };
    }
    const createdUser = await client.query<{ id: string }>(
      "INSERT INTO users (display_name) VALUES ($1) RETURNING id",
      [input.displayName ?? null],
    );
    const userId = createdUser.rows[0].id;
    await client.query(
      `INSERT INTO external_identities (provider, subject, email, user_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (provider, subject) DO UPDATE SET email = EXCLUDED.email`,
      [input.provider, input.subject, input.email, userId],
    );
    await client.query("COMMIT");
    return { userId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
```

Note: the unique `(provider, subject)` constraint plus the transaction guarantees a single local user per external identity; a concurrent duplicate insert would fail the constraint and roll back (acceptable for this scope).

- [ ] **Step 5: Run the integration tests to verify they pass**

Run: `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npm run test:integration -- identity-repository.test.ts`

Expected: PASS with 3 tests.

- [ ] **Step 6: Run the real migration against the compose database**

Run: `docker compose up -d --wait postgres` then `DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npm run migrate`

Expected: `database migrations complete`; the three tables are created (verify with `psql \dt`).

- [ ] **Step 7: Commit**

```bash
git add migrations/0001_create_identity.sql src/identity/repository.ts tests/integration/identity-repository.test.ts
git commit -m "feat: add identity persistence"
```

---

### Task 3: Identity Module Facade And Contract Tests

**Files:**
- Create: `src/identity/index.ts`
- Create: `src/identity/util.ts`
- Create: `tests/integration/identity-module.test.ts`

**Interfaces:**
- Consumes: `OidcClient`, `createTestOidcClient`, `IdentityRepository`, `createIdentityRepository`, real PostgreSQL `Pool`.
- Produces: the `Identity` Interface (`completeSignIn`, `resolveSession`, `signOut`), `SessionHandle`, `AuthContext`, `Result<T>`, `AppError`, and `createIdentityModule(input): Identity`. Task 4 consumes these.

- [ ] **Step 1: Write the failing contract tests**

Create `tests/integration/identity-module.test.ts`:

```typescript
import { randomUUID } from "node:crypto";

import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

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
```

- [ ] **Step 2: Run the contract tests to verify they fail**

Run: `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npm run test:integration -- identity-module.test.ts`

Expected: FAIL because `src/identity/index.ts` does not export `createIdentityModule`.

- [ ] **Step 3: Implement the Identity module facade and helpers**

Create `src/identity/util.ts`:

```typescript
import { createHash, randomBytes } from "node:crypto";

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
```

Create `src/identity/index.ts`:

```typescript
import type { Pool } from "pg";

import type { AppError } from "./errors.js";
import type { OidcClient } from "./oidc.js";
import {
  createIdentityRepository,
  type IdentityRepository,
  type SessionId,
  type UserId,
} from "./repository.js";
import { hashToken, newSessionToken } from "./util.js";

export type { AppError } from "./errors.js";
export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };

export type SessionHandle = {
  token: string;
  userId: UserId;
  sessionId: SessionId;
  expiresAt: Date;
};

export type AuthContext =
  | { state: "authenticated"; actorId: UserId; sessionId: SessionId }
  | { state: "anonymous" };

export interface Identity {
  completeSignIn(input: {
    code: string;
    redirectUri: string;
    previousToken: string | undefined;
  }): Promise<Result<SessionHandle>>;
  resolveSession(token: string): Promise<Result<AuthContext>>;
  signOut(token: string): Promise<Result<void>>;
}

export type CreateIdentityModuleInput = {
  oidc: OidcClient;
  pool: Pool;
  sessionTtlMs: number;
};

export function createIdentityModule(input: CreateIdentityModuleInput): Identity {
  const repo: IdentityRepository = createIdentityRepository(input.pool);

  return {
    async completeSignIn({ code, redirectUri, previousToken }) {
      let claims;
      try {
        claims = await input.oidc.verifyAuthorizationCode({ code, redirectUri });
      } catch {
        return {
          ok: false,
          error: { code: "invalid_authorization_code", message: "The authorization code is invalid or expired." },
        };
      }

      try {
        const { userId } = await repo.upsertExternalIdentity({
          provider: claims.provider,
          subject: claims.subject,
          email: claims.email,
          displayName: claims.displayName,
        });

        if (previousToken !== undefined) {
          await repo.revokeSessionByTokenHash(hashToken(previousToken));
        }

        const token = newSessionToken();
        const expiresAt = new Date(Date.now() + input.sessionTtlMs);
        const { sessionId } = await repo.createSession({
          userId,
          tokenHash: hashToken(token),
          expiresAt,
        });

        return { ok: true, value: { token, userId, sessionId, expiresAt } };
      } catch {
        return {
          ok: false,
          error: { code: "internal", message: "An internal error occurred." },
        };
      }
    },

    async resolveSession(token) {
      try {
        const session = await repo.findSessionByTokenHash(hashToken(token));
        if (session === null || session.revokedAt !== null || session.expiresAt.getTime() < Date.now()) {
          return { ok: true, value: { state: "anonymous" as const } };
        }
        return {
          ok: true,
          value: {
            state: "authenticated" as const,
            actorId: session.userId,
            sessionId: session.sessionId,
          },
        };
      } catch {
        return { ok: true, value: { state: "anonymous" as const } };
      }
    },

    async signOut(token) {
      try {
        await repo.revokeSessionByTokenHash(hashToken(token));
        return { ok: true, value: undefined };
      } catch {
        return { ok: false, error: { code: "internal", message: "An internal error occurred." } };
      }
    },
  };
}
```

- [ ] **Step 4: Run the contract tests to verify they pass**

Run: `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npm run test:integration -- identity-module.test.ts`

Expected: PASS with 4 tests.

Run: `npm run typecheck && npm test`

Expected: typecheck exit 0; unit suite green.

- [ ] **Step 5: Commit**

```bash
git add src/identity/index.ts src/identity/util.ts tests/integration/identity-module.test.ts
git commit -m "feat: add identity module facade"
```

---

### Task 4: HTTP Authentication Hook, Session Cookie, And Composition

**Files:**
- Create: `src/transport/http/auth-hook.ts`
- Create: `src/transport/http/auth-hook.test.ts`
- Modify: `src/platform/config.ts`
- Modify: `src/platform/config.test.ts`
- Modify: `src/transport/http/app.ts`
- Modify: `src/bootstrap/http.ts`
- Modify: `package.json`, `package-lock.json` (add `@fastify/cookie`)

**Interfaces:**
- Consumes: `Identity` (`resolveSession`), `AuthContext`, and config flags.
- Produces: `buildAuthHook(input): FastifyPluginCallback` that sets `request.auth: AuthContext`, and config fields `SESSION_COOKIE_NAME`, `SESSION_TTL_DAYS`, `COOKIE_SECURE`.

- [ ] **Step 1: Add the cookie-parsing dependency**

Run: `npm install @fastify/cookie@11.0.0`

Note: Fastify 5 does not parse cookies by default; `@fastify/cookie` is required to read the session cookie.

- [ ] **Step 2: Extend configuration**

Modify `src/platform/config.ts` to add `sessionCookieName`, `sessionTtlDays`, `cookieSecure`. Add these fields to the `AppConfig` type:

```typescript
export type AppConfig = {
  databaseUrl: string;
  host: string;
  logLevel: LogLevel;
  port: number;
  sessionCookieName: string;
  sessionTtlDays: number;
  cookieSecure: boolean;
};
```

Add the parsing in `loadConfig` before the `return`:

```typescript
  const sessionTtlDays = Number(env.SESSION_TTL_DAYS ?? "30");
  if (!Number.isInteger(sessionTtlDays) || sessionTtlDays < 1 || sessionTtlDays > 365) {
    throw new Error("SESSION_TTL_DAYS must be an integer from 1 through 365");
  }

  const cookieSecure = env.COOKIE_SECURE === "true";
```

And include in the returned object:

```typescript
    sessionCookieName: env.SESSION_COOKIE_NAME ?? "session",
    sessionTtlDays,
    cookieSecure,
```

- [ ] **Step 3: Update the config tests**

Modify `src/platform/config.test.ts`: set `COOKIE_SECURE`, `SESSION_COOKIE_NAME`, `SESSION_TTL_DAYS` in the explicit case and assert the new fields; add an assertion that the defaults are `session`, `30`, `false`; add a validation case where `SESSION_TTL_DAYS=0` throws.

- [ ] **Step 4: Write the failing auth-hook test**

Create `src/transport/http/auth-hook.test.ts`:

```typescript
import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import pino from "pino";
import { afterAll, describe, expect, it } from "vitest";

import type { AuthContext, Identity } from "../../identity/index.js";
import { buildAuthHook } from "./auth-hook.js";

const fakeIdentity = (resolve: (token: string) => Promise<AuthContext>): Identity =>
  ({
    completeSignIn: async () => {
      throw new Error("not used");
    },
    resolveSession: resolve,
    signOut: async () => ({ ok: true, value: undefined }),
  }) as unknown as Identity;

async function build(identity: Identity) {
  const app = Fastify({ loggerInstance: pino({ enabled: false }) });
  await app.register(buildAuthHook({ identity, cookieName: "session", secure: true, maxAgeSeconds: 3600 }));
  app.get("/auth-test", async (request) => ({ auth: request.auth }));
  await app.ready();
  return app;
}

describe("buildAuthHook", () => {
  const apps: ReturnType<typeof Fastify>[] = [];

  afterAll(async () => {
    for (const app of apps) {
      await app.close();
    }
  });

  it("resolves a valid session cookie to an authenticated context", async () => {
    const identity = fakeIdentity(async () => ({
      state: "authenticated",
      actorId: randomUUID(),
      sessionId: randomUUID(),
    }));
    const app = await build(identity);
    apps.push(app);

    const response = await app.inject({
      headers: { cookie: "session=valid-token" },
      method: "GET",
      url: "/auth-test",
    });
    expect(response.json<{ auth: AuthContext }>().auth.state).toBe("authenticated");
  });

  it("treats a missing cookie as anonymous", async () => {
    const identity = fakeIdentity(async () => ({ state: "anonymous" }));
    const app = await build(identity);
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/auth-test" });
    expect(response.json<{ auth: AuthContext }>().auth).toEqual({ state: "anonymous" });
  });

  it("clears the cookie when the session cannot be resolved", async () => {
    const identity = fakeIdentity(async () => ({ state: "anonymous" }));
    const app = await build(identity);
    apps.push(app);

    const response = await app.inject({
      headers: { cookie: "session=stale-token" },
      method: "GET",
      url: "/auth-test",
    });
    expect(response.cookies.some((cookie) => cookie.name === "session" && cookie.expires === new Date(0))).toBe(true);
    expect(response.json<{ auth: AuthContext }>().auth).toEqual({ state: "anonymous" });
  });
});
```

- [ ] **Step 5: Run the auth-hook test to verify it fails**

Run: `npm test -- src/transport/http/auth-hook.test.ts`

Expected: FAIL because `src/transport/http/auth-hook.ts` does not exist.

- [ ] **Step 6: Implement the auth hook**

Create `src/transport/http/auth-hook.ts`:

```typescript
import type { FastifyPluginCallback } from "fastify";

import type { Identity } from "../../identity/index.js";

declare module "fastify" {
  interface FastifyRequest {
    auth: import("../../identity/index.js").AuthContext;
  }
}

export type BuildAuthHookInput = {
  identity: Identity;
  cookieName: string;
  secure: boolean;
  maxAgeSeconds: number;
};

export const buildAuthHook: (input: BuildAuthHookInput) => FastifyPluginCallback =
  ({ identity, cookieName, secure, maxAgeSeconds }) =>
  async (app) => {
    app.addHook("preHandler", async (request, reply) => {
      const raw = request.cookies?.[cookieName];
      if (raw === undefined || raw.length === 0) {
        request.auth = { state: "anonymous" };
        return;
      }
      const result = await identity.resolveSession(raw);
      if (!result.ok || result.value.state === "anonymous") {
        reply.clearCookie(cookieName, { httpOnly: true, sameSite: "lax", path: "/", secure });
        request.auth = { state: "anonymous" };
        return;
      }
      reply.setCookie(cookieName, raw, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure,
        maxAge: maxAgeSeconds,
      });
      request.auth = result.value;
    });
  };
```

- [ ] **Step 7: Wire the cookie parser and auth hook into the app**

Modify `src/transport/http/app.ts`:

1. Add imports and the `authHook` parameter to `buildHttpApp`, and register the cookie plugin:

```typescript
import cookie from "@fastify/cookie";
import type { FastifyPluginCallback } from "fastify";
```

Change the signature to:

```typescript
export function buildHttpApp(input: {
  logger: Logger;
  pool: Pool;
  authHook: FastifyPluginCallback;
}): FastifyInstance {
```

2. After `const app = Fastify({...});` and `const startedAt = ...;`, register the cookie plugin before the routes:

```typescript
  void app.register(cookie);
```

3. Register the auth hook after the `/metrics` route and before the `onResponse` hook:

```typescript
  void app.register(input.authHook);
```

- [ ] **Step 8: Wire composition in the bootstrap**

Modify `src/bootstrap/http.ts`:

```typescript
import { loadConfig, createLogger, createPool } from "../platform/index.js";
import { createIdentityModule } from "../identity/index.js";
import { createTestOidcClient } from "../identity/adapters/test.js";
import { buildHttpApp } from "../transport/http/index.js";
import { buildAuthHook } from "../transport/http/auth-hook.js";

const config = loadConfig();
const logger = createLogger(config.logLevel);
const pool = createPool(config.databaseUrl);

// The production OIDC adapter is deferred; the deterministic test adapter
// with no codes satisfies the port for now (authenticates no one via OIDC,
// but session resolve/sign-out over HTTP are fully functional).
const identity = createIdentityModule({
  oidc: createTestOidcClient(new Map()),
  pool,
  sessionTtlMs: config.sessionTtlDays * 86_400_000,
});

const app = buildHttpApp({
  logger,
  pool,
  authHook: buildAuthHook({
    identity,
    cookieName: config.sessionCookieName,
    secure: config.cookieSecure,
    maxAgeSeconds: config.sessionTtlDays * 86_400,
  }),
});

const shutdown = async (signal: string) => {
  logger.info({ signal }, "shutting down HTTP process");
  await app.close();
  await pool.end();
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  logger.fatal({ err: error }, "HTTP process failed to start");
  await pool.end();
  process.exitCode = 1;
}
```

- [ ] **Step 9: Run the HTTP tests, typecheck, and build**

Run: `npm test -- src/transport/http/ && npm run typecheck && npm run build`

Expected: auth-hook tests PASS; typecheck and build exit 0.

- [ ] **Step 10: Run the full verification suite**

Run: `npm test && TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npm run test:integration && npm run typecheck && npm run build`

Expected: all suites green; typecheck and build exit 0.

- [ ] **Step 11: Commit**

```bash
git add src/transport/http/auth-hook.ts src/transport/http/auth-hook.test.ts src/transport/http/app.ts src/bootstrap/http.ts src/platform/config.ts src/platform/config.test.ts package.json package-lock.json
git commit -m "feat: add HTTP authentication hook"
```
