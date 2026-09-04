# Identity Module and OIDC Port — Design

**Status:** Draft for review

## 1. Purpose

Implement I1 Task 2 from `design_v2.md`: the Identity Module, its replaceable OIDC port (with a deterministic test adapter in this step), the identity persistence migration, and the HTTP authentication hook that resolves sessions into an `AuthContext`. The concrete production OIDC adapter (e.g., Google) is explicitly deferred to a later step of I1; the seam that will host it is preserved now.

## 2. Scope

**In scope:**
- Identity Module exposing one `Identity` Interface, owning `users`, `external_identities`, and `sessions`.
- OIDC port (`OidcClient`) with a deterministic test adapter.
- SQL migration for the three identity tables.
- HTTP Adapter authentication hook that reads the session cookie, resolves the session through the Module, and attaches an `AuthContext` to each request.
- Module Interface contract tests against real PostgreSQL, and HTTP Adapter auth-hook tests.

**Out of scope (explicitly deferred):**
- Concrete production OIDC adapter (e.g., Google). A documented placeholder is present but not functional.
- Role-specific application shells, email/password auth, account deletion/conversion, admin flows.
- CSRF token issuance — deferred until state-changing endpoints exist; same-site cookies are set now.
- Redis/session store; sessions are ordinary PostgreSQL rows.
- Any System, Character, or Campaign behavior.

## 3. Constraints and design rules

Follows `design_v2.md` sections 11.1, 11.2, 11.4, 12, and 14:

- A Module exposes one Interface that callers and tests both use.
- Dependencies are injected at process composition, not created inside the implementation.
- No generic persistence seam; PostgreSQL behavior is tested with real PostgreSQL.
- A port exists because OIDC justifies two adapters (production and deterministic test).
- Provider tokens and claims never enter Systems Interfaces.
- Authentication occurs before a Module call; authorization occurs inside the owning Module.
- Opaque IDs; sessions stored as token hashes; secure HttpOnly SameSite cookies; rotation on sign-in.
- Structured allow-list logging; never log tokens, authorization codes, session cookies, or database URLs.
- Ordinary HTTP operations target p95 below 300 ms.

## 4. Files and source layout

```text
src/identity/
  index.ts              # Identity Interface + facade (single public Interface)
  errors.ts             # AppError helpers shared shape
  data.ts               # row decoding for users, external_identities, sessions
  repository.ts         # real-PostgreSQL SQL for identity tables (injected Pool)
  oidc.ts               # OidcClient port interface + types
  adapters/
    test.ts             # deterministic OIDC test adapter
src/transport/http/
  auth.ts               # AuthContext type + session-cookie parsing/attributes
  auth-hook.ts          # Fastify hook wiring identity.resolveSession
src/platform/
  config.ts             # + SESSION_TTL_DAYS, COOKIE_SECURE, SESSION_COOKIE_NAME
migrations/
  0001_create_identity.sql
```

## 5. Identity data model (migration `0001_create_identity.sql`)

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

- `users.id` is an opaque UUID (enumeration protection).
- `sessions.token_hash` stores a SHA-256 hash of the opaque session token, never the token itself.
- Composite unique `(provider, subject)` guarantees one local user per external identity.
- `status` uses the design's lifecycle vocabulary (`active`); reserved values `suspended`, `deleted` are accepted by the type guard but not exercised in this step.

## 6. OIDC port interface

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

- Adapters return normalized claims only; provider tokens never surface.
- **Test adapter** (`adapters/test.ts`): constructed with a `Map<code, VerifiedClaims>`; returns deterministic claims for a known code and rejects unknown codes with `invalid_authorization_code`.

## 7. Identity Module Interface

```typescript
export type SessionHandle = {
  token: string;      // opaque, high-entropy, returned to client only here
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
```

Method behavior:
- `completeSignIn`: `oidc.verifyAuthorizationCode` → upsert `external_identities` + `users` → create a session → if `previousToken` provided, revoke that session (rotation) → return the new opaque token.
- `resolveSession`: hash token, look up an active, unexpired, un-revoked session; return `authenticated`; otherwise `anonymous` (never `not_found` to avoid enumeration).
- `signOut`: hash token, revoke the session if present; idempotent.

Errors: `Result<T>` = `{ ok: true; value: T } | { ok: false; error: AppError }` where `AppError = { code; message; status? }`. Stable codes: `invalid_authorization_code`, `session_expired`, `internal`.

## 8. HTTP authentication hook

- New config: `SESSION_COOKIE_NAME` (default `session`), `SESSION_TTL_DAYS` (default 30), `COOKIE_SECURE` (default false; set true behind TLS).
- A Fastify `preHandler` hook reads the cookie named by config, calls `identity.resolveSession(token)`, and stores `request.auth: AuthContext`.
- Cookie attributes when set: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` if `COOKIE_SECURE`, `Max-Age = SESSION_TTL_DAYS`.
- The auth hook runs for all routes except it must not break anonymous health/metrics.
- `AuthContext` is the source of `actorId` in the Module `RequestContext` shape (§11.3). Wiring `actorId` into `RequestContext` for system endpoints is exercised by this hook; no system endpoints exist yet.

## 9. CSRF note

Same-site (`Lax`) cookies mitigate cross-site state-changing requests for same-origin web clients. Explicit per-request CSRF tokens are deferred until the first state-changing authenticated endpoint exists. Documented here so the follow-up is mandatory, not optional.

## 10. Testing

- **Identity Module** (real PostgreSQL, using the same unique-schema approach as `tests/integration/migrations.test.ts`):
  - signing in with a valid test code creates a user + external identity + session.
  - signing in again with the same subject maps to the same user (upsert).
  - session rotation revokes the previous session token.
  - `resolveSession` returns authenticated for a live token and anonymous for unknown/expired/revoked tokens.
  - `signOut` revokes the session and is idempotent.
- **OIDC test adapter**: returns claims for a known code; rejects unknown codes.
- **HTTP auth hook**: inject with a cookie sets `authenticated`; no cookie sets `anonymous`; revoked/expired token is anonymous.
- Contract tests use the `Identity` Interface and real PostgreSQL; the OIDC seam is satisfied by the deterministic test adapter.

## 11. Acceptance demonstration

Using real PostgreSQL and the deterministic test OIDC adapter: complete a sign-in with a known authorization code, resolve the issued session token to an authenticated context, rotate to a second session and confirm the first is revoked, sign out and confirm the token no longer resolves authenticated — all through the `Identity` Interface. The HTTP hook surfaces an anonymous vs authenticated request through an injected cookie.
