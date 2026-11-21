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
  previousTokenHash?: string | undefined;
};

/** Account-level theme default. Null means no default is set. */
export type ThemeDefault = "light" | "dark" | "system";
export type AccountPreferences = { theme_default: ThemeDefault | null; show_3d_dice: boolean; dice_color: string };
export const defaultDiceColor = "#4c79c9";
export const defaultPreferences: AccountPreferences = {theme_default:null,show_3d_dice:true,dice_color:defaultDiceColor};

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
  getDisplayNames(userIds: readonly UserId[]): Promise<Array<{ userId: UserId; displayName: string | null }>>;
  getPreferences(userId: UserId): Promise<AccountPreferences>;
  patchPreferences(userId: UserId, patch: Partial<AccountPreferences>): Promise<AccountPreferences>;
}

export function createIdentityRepository(pool: Pool): IdentityRepository {
  return {
    async upsertExternalIdentity(input) {
      return upsertExternalIdentityImpl(pool, input);
    },

    async createSession(input) {
      const result = await pool.query<{ id: string }>(
        `WITH revoked AS (
           UPDATE sessions SET revoked_at = now() WHERE token_hash = $4 AND revoked_at IS NULL
         )
         INSERT INTO sessions (user_id, token_hash, expires_at)
         VALUES ($1, $2, $3) RETURNING id`,
        [input.userId, input.tokenHash, input.expiresAt, input.previousTokenHash ?? null],
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
        `SELECT s.id, s.user_id, s.token_hash, s.expires_at, s.revoked_at
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND u.status = 'active'`,
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

    async getDisplayNames(userIds) {
      if (userIds.length === 0) return [];
      const result = await pool.query<{ id: string; display_name: string | null }>(
        "SELECT id, display_name FROM users WHERE id = ANY($1::uuid[])", [userIds],
      );
      return result.rows.map((row) => ({ userId: row.id, displayName: row.display_name?.trim() || null }));
    },

    async getPreferences(userId) {
      const {rows:[row]} = await pool.query<AccountPreferences>(
        "SELECT theme_default, show_3d_dice, dice_color FROM user_preferences WHERE user_id=$1", [userId],
      );
      return row ?? defaultPreferences;
    },

    async patchPreferences(userId, patch) {
      const {rows:[row]} = await pool.query<AccountPreferences>(
        `INSERT INTO user_preferences (user_id, theme_default, show_3d_dice, dice_color)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET
           theme_default = CASE WHEN $5 THEN EXCLUDED.theme_default ELSE user_preferences.theme_default END,
           show_3d_dice = CASE WHEN $6 THEN EXCLUDED.show_3d_dice ELSE user_preferences.show_3d_dice END,
           dice_color = CASE WHEN $7 THEN EXCLUDED.dice_color ELSE user_preferences.dice_color END,
           updated_at = now()
         RETURNING theme_default, show_3d_dice, dice_color`,
        [userId,patch.theme_default??null,patch.show_3d_dice??true,patch.dice_color??defaultDiceColor,
         patch.theme_default!==undefined,patch.show_3d_dice!==undefined,patch.dice_color!==undefined],
      );
      if (!row) throw Error("Account preference update returned no row.");
      return row;
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
