import type { Pool } from "pg";

import { createPersonalTokens } from "./personal-tokens.js";
import type { AppError } from "./errors.js";
import type { OidcClient } from "./oidc.js";
import {
  createIdentityRepository,
  type IdentityRepository,
  type SessionId,
  type AccountPreferences,
  type UserId,
} from "./repository.js";
import { hashToken, newSessionToken } from "./util.js";

export type { AppError } from "./errors.js";
export type { ThemeDefault, AccountPreferences } from "./repository.js";
export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };

export type SessionHandle = {
  token: string;
  userId: UserId;
  sessionId: SessionId;
  expiresAt: Date;
};

export type AuthContext =
  | { state: "authenticated"; actorId: UserId; sessionId: SessionId }
  | { state: "anonymous" }
  | { state: "session_expired" };

/** A session lookup result. `unavailable` means storage failed: the cookie may still be valid. */
export type SessionResolution = AuthContext | { state: "unavailable" };

export interface Identity {
  personalTokens: ReturnType<typeof createPersonalTokens>;
  completeSignIn(input: {
    code: string;
    redirectUri: string;
    previousToken: string | undefined;
  }): Promise<Result<SessionHandle>>;
  resolveSession(token: string): Promise<SessionResolution>;
  signOut(token: string): Promise<Result<void>>;
  /** Internal bounded projection. Callers must authorize the resource roster first. */
  getDisplayNames(userIds: readonly UserId[]): Promise<Result<Array<{ userId: UserId; displayName: string | null }>>>;
  getPreferences(actorId: UserId): Promise<Result<AccountPreferences>>;
  patchPreferences(actorId: UserId, patch: Partial<AccountPreferences>): Promise<Result<AccountPreferences>>;
}

export type CreateIdentityModuleInput = {
  oidc: OidcClient;
  pool: Pool;
  sessionTtlMs: number;
  allowPersonalTokens?: boolean;
};

export function createIdentityModule(input: CreateIdentityModuleInput): Identity {
  const repo: IdentityRepository = createIdentityRepository(input.pool);

  return {
    personalTokens: createPersonalTokens(input.pool, input.allowPersonalTokens === true),

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

        const token = newSessionToken();
        const expiresAt = new Date(Date.now() + input.sessionTtlMs);
        const { sessionId } = await repo.createSession({
          userId,
          tokenHash: hashToken(token),
          expiresAt,
          previousTokenHash: previousToken === undefined ? undefined : hashToken(previousToken),
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
        // Unknown and revoked tokens are anonymous. An expired (but otherwise
        // valid) session resolves distinctly so the UI can offer re-auth
        // instead of a generic signed-out view.
        if (session === null || session.revokedAt !== null) {
          return { state: "anonymous" as const };
        }
        if (session.expiresAt.getTime() <= Date.now()) {
          return { state: "session_expired" as const };
        }
        return {
          state: "authenticated" as const,
          actorId: session.userId,
          sessionId: session.sessionId,
        };
      } catch {
        // A failed lookup (for example a busy connection pool) says nothing
        // about the token. Reporting it as anonymous would sign the user out.
        return { state: "unavailable" as const };
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

    async getDisplayNames(userIds) {
      if (userIds.length > 100) return { ok: false, error: { code: "internal", message: "Display-name projection exceeds the page bound." } };
      try {
        return { ok: true, value: await repo.getDisplayNames(userIds) };
      } catch {
        return { ok: false, error: { code: "internal", message: "An internal error occurred." } };
      }
    },

    async getPreferences(actorId) {
      try {
        return { ok: true, value: await repo.getPreferences(actorId) };
      } catch {
        return { ok: false, error: { code: "internal", message: "An internal error occurred." } };
      }
    },

    async patchPreferences(actorId, patch) {
      try {
        return { ok: true, value: await repo.patchPreferences(actorId, patch) };
      } catch {
        return { ok: false, error: { code: "internal", message: "An internal error occurred." } };
      }
    },
  };
}
