import type { Pool } from "pg";
import { hashToken, newSessionToken } from "./util.js";

export const personalTokenScopes = ["systems:read", "systems:write", "characters:read", "characters:write"] as const;
export type PersonalTokenScope = (typeof personalTokenScopes)[number];

type TokenMetadata = {
  id: string;
  label: string;
  scopes: PersonalTokenScope[];
  createdAt: Date;
  expiresAt: Date;
};

type TokenRow = Omit<TokenMetadata, "createdAt" | "expiresAt"> & { created_at: Date; expires_at: Date };

function metadata(row: TokenRow): TokenMetadata {
  return { id: row.id, label: row.label, scopes: row.scopes, createdAt: row.created_at, expiresAt: row.expires_at };
}

export function createPersonalTokens(pool: Pool, enabled: boolean) {
  return {
    enabled,

    async issue(actorId: string, input: { label: string; scopes: PersonalTokenScope[]; expiresInDays: number }) {
      if (!enabled) return null;
      const token = `sr_pat_${newSessionToken()}`;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Serialize issuance per account, including when it has no tokens yet.
        const user = await client.query("SELECT id FROM users WHERE id = $1 AND status = 'active' FOR UPDATE", [actorId]);
        if (user.rowCount !== 1) {
          await client.query("ROLLBACK");
          return null;
        }
        const result = await client.query<TokenRow>(
          `INSERT INTO personal_access_tokens (user_id, token_hash, label, scopes, expires_at)
           SELECT $1, $2, $3, $4, now() + make_interval(days => $5)
           WHERE (SELECT count(*) FROM personal_access_tokens
                   WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()) < 20
           RETURNING id, label, scopes, created_at, expires_at`,
          [actorId, hashToken(token), input.label, input.scopes, input.expiresInDays],
        );
        await client.query("COMMIT");
        const row = result.rows[0];
        return row === undefined ? null : { ...metadata(row), token };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async list(actorId: string): Promise<TokenMetadata[]> {
      if (!enabled) return [];
      const result = await pool.query<TokenRow>(
        `SELECT id, label, scopes, created_at, expires_at FROM personal_access_tokens
          WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
          ORDER BY created_at DESC, id DESC`,
        [actorId],
      );
      return result.rows.map(metadata);
    },

    async revoke(actorId: string, tokenId: string): Promise<boolean> {
      if (!enabled) return false;
      const result = await pool.query(
        `UPDATE personal_access_tokens SET revoked_at = COALESCE(revoked_at, now())
          WHERE user_id = $1 AND id = $2`,
        [actorId, tokenId],
      );
      return result.rowCount === 1;
    },

    async resolve(token: string): Promise<{ actorId: string; scopes: PersonalTokenScope[] } | null> {
      if (!enabled || !/^sr_pat_[A-Za-z0-9_-]{43}$/.test(token)) return null;
      const result = await pool.query<{ user_id: string; scopes: PersonalTokenScope[] }>(
        `SELECT t.user_id, t.scopes
           FROM personal_access_tokens t JOIN users u ON u.id = t.user_id
          WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND t.expires_at > now() AND u.status = 'active'`,
        [hashToken(token)],
      );
      const row = result.rows[0];
      return row === undefined ? null : { actorId: row.user_id, scopes: row.scopes };
    },
  };
}
