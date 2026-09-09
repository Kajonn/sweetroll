import type { Pool } from "pg";

import type { AppError } from "./errors.js";
import type { OidcClient } from "./oidc.js";
import {
  createIdentityRepository,
  type IdentityRepository,
  type SessionId,
  type ThemeDefault,
  type UserId,
} from "./repository.js";
import { hashToken, newSessionToken } from "./util.js";

export type { AppError } from "./errors.js";
export type { ThemeDefault } from "./repository.js";
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
  resolveSession(token: string): Promise<AuthContext>;
  signOut(token: string): Promise<Result<void>>;
  getThemeDefault(actorId: UserId): Promise<Result<ThemeDefault | null>>;
  setThemeDefault(actorId: UserId, value: ThemeDefault | null): Promise<Result<ThemeDefault | null>>;
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
          return { state: "anonymous" as const };
        }
        return {
          state: "authenticated" as const,
          actorId: session.userId,
          sessionId: session.sessionId,
        };
      } catch {
        return { state: "anonymous" as const };
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

    async getThemeDefault(actorId) {
      try {
        return { ok: true, value: await repo.getThemeDefault(actorId) };
      } catch {
        return { ok: false, error: { code: "internal", message: "An internal error occurred." } };
      }
    },

    async setThemeDefault(actorId, value) {
      try {
        return { ok: true, value: await repo.setThemeDefault(actorId, value) };
      } catch {
        return { ok: false, error: { code: "internal", message: "An internal error occurred." } };
      }
    },
  };
}
