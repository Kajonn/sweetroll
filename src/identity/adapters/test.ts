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
