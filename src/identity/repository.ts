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

/** Account-level theme default. Null means no default is set. */
export type ThemeDefault = "light" | "dark" | "system";

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
  getThemeDefault(userId: UserId): Promise<ThemeDefault | null>;
  setThemeDefault(userId: UserId, value: ThemeDefault | null): Promise<ThemeDefault | null>;
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

    async getThemeDefault(userId) {
      const result = await pool.query<{ theme_default: ThemeDefault | null }>(
        "SELECT theme_default FROM user_preferences WHERE user_id = $1",
        [userId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        return null;
      }
      return row.theme_default;
    },

    async setThemeDefault(userId, value) {
      const result = await pool.query<{ theme_default: ThemeDefault | null }>(
        `INSERT INTO user_preferences (user_id, theme_default, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (user_id)
         DO UPDATE SET theme_default = EXCLUDED.theme_default, updated_at = now()
         RETURNING theme_default`,
        [userId, value],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("setThemeDefault returned no row");
      }
      return row.theme_default;
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
    // Serialize concurrent first-sign-ins for the same external identity.
    // The second caller blocks here until the first commits, then observes
    // the committed row in the SELECT below and returns the canonical userId
    // instead of inserting an orphan user. Transaction-scoped, so no schema
    // change and no explicit unlock is needed.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
      input.provider,
      input.subject,
    ]);
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
    const row = createdUser.rows[0];
    if (row === undefined) {
      throw new Error("upsertExternalIdentity returned no user row");
    }
    const userId = row.id;
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
