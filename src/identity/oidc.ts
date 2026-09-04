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
