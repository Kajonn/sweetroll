# Real login — staged implementation and acceptance

**Status:** Proposed, 2026-11-05. Planning authorized; no provider selected or credentials provisioned by this document. No implementation or real-provider acceptance claimed.

**Goal:** A GM or player can sign into deployed Sweetroll, return to their intended page or invitation, play with their own data, and sign out safely without a test code.

**Recommendation for OD-05:** Start with Google OpenID Connect, using the server-side Authorization Code flow with S256 PKCE. Keep the Identity port provider-independent. Consider passwordless email in a later, separately scoped increment; it needs a delivery provider, abuse controls and a deliberate account-linking policy. Do not build passwords or operate a new identity server for this first increment. Google is a proposed first provider, not an approved exclusive long-term choice.

## Existing foundation and gaps

Reuse `src/identity/index.ts`, `oidc.ts`, `repository.ts` and the existing hashed opaque session tokens, external-identity mapping and first-sign-in concurrency protection. The current port only accepts code/redirect URI; it has no PKCE/nonce transaction context. `src/bootstrap/http.ts` always wires a deterministic adapter, with an empty code map in locked production. Production login therefore cannot work by adding variables alone.

Reuse `src/transport/http/identity.ts`, `auth-hook.ts`, the frontend identity/cache purge boundaries, Account screen and `/cb` return route. Existing `/cb` refreshes application identity; it is not an OIDC code-exchange handler. Session cookies are HttpOnly/SameSite=Lax; keep absolute server-side expiry authoritative instead of accidentally extending it by reissuing cookies on reads. Existing test auth and browser evidence do not validate a real provider.

## Intended user experience

1. A signed-out screen offers **Continue with Google** and explains that signing in creates an account on first use. Keep the invitation or requested page as a validated local return target.
2. A full-page redirect opens Google's sign-in/consent screen. Request only `openid email profile`; no Google APIs, Drive access, refresh tokens or background access.
3. The backend validates the callback, creates a normal Sweetroll session, then redirects to `/cb` without provider tokens or authorization parameters. `/cb` refreshes identity and restores the server-validated destination.
4. Cancellation, timeout or unavailable provider shows a recoverable sign-in error with Retry. Never silently replace the account or lose an invitation.
5. Expired-session reauthentication follows the existing offline queue/account isolation rules. Signing into another account must never replay the former account's pending work. Explicit sign-out uses server revocation and the existing local purge barrier; if revocation fails, report/retry the failure instead of claiming a completed server logout.
6. Sweetroll logout ends the local session, not the user's Google browser session. Offer account selection on a fresh login so shared devices can choose another account. Paired displays keep their separate credential-only flow.

## Architecture and security contract

- Identity owns short-lived login transactions and their repository. Each transaction has random state, nonce, PKCE verifier, fixed issuer/client/callback binding, a validated local return path, browser binding and expiry (proposed 10 minutes). Store state/browser-binding hashes; keep verifier/nonce server-side. Bound outstanding transactions and remove expired/consumed rows. PostgreSQL storage supports callbacks after app restarts and avoids sticky-session assumptions.
- Bind initiation to an HttpOnly Secure SameSite=Lax host-only browser cookie. Match state and browser binding before exchange. Atomically consume the transaction once; replay/expired/missing bindings fail closed. Handle parallel tabs explicitly without overwriting their state. A failed/uncertain exchange requires a fresh start, not transaction reuse.
- Extend the existing OIDC port with the transaction-derived PKCE and expected nonce context. The production adapter uses a maintained OIDC library (recommended `openid-client`, exact compatible version pinned at implementation), discovery/JWKS verification, signature/algorithm, issuer, audience/authorized party, expiry and nonce checks. Never hand-roll token verification. Discovery issuer is operator configuration, never request input; HTTPS only outside local tests; bounded network timeouts and safe provider errors.
- Proposed public endpoints: `GET /api/auth/login` and `GET /api/auth/callback`. Login accepts only a validated relative return target; callback URI is a fixed configured URL. Never derive issuer/callback/origin from untrusted Host or forwarded headers. Keep anonymous exemptions exact and test prefixed routing. Existing `/api/me` and `/api/signout` remain normal session interfaces.
- Validate return paths with one shared policy: same-origin app routes only; reject schemes, protocol-relative URLs, encoded redirect tricks, backslashes and auth-loop targets. An invalid target falls back to `/characters`. Preserve invitation identifiers without logging their sensitive query parameters. Remove provider query parameters before serving the SPA; callback responses use no-store and no-referrer headers.
- Key users by verified issuer and stable subject, never by email. Require the verified-email claim for this initial Google flow. Email changes do not change ownership; equal emails across subjects/providers never merge accounts. Test users/data are not automatically reassigned to real Google accounts. First use provisions one canonical local user, including concurrent first logins.
- Reuse the session format/cookie settings and revoke the previous session on successful reauthentication. Make revocation and new session creation failure behavior explicit in module tests. No provider token enters browser storage, application APIs, media URLs or ordinary logs. Keep local account authorization independent of provider claims.
- Confirm existing CSRF protection on authenticated mutations and sign-out, including an explicit absent-Origin policy. Origin checks must use the configured public origin behind Railway, not broad trust in forwarding headers. Add bounded login/callback abuse controls consistent with existing HTTP infrastructure; document their per-instance limits rather than claiming distributed protection.
- Redact callback query strings, codes, tokens, cookies, verifier, nonce and state from application/proxy logs, traces and test artifacts. Log only sanitized failure categories, request ID and auth mode. Exclude auth routes from service-worker/offline caches and analytics capture.
- Explicit auth modes: locked, deterministic test, real OIDC. Reject conflicting real/test configuration. Partial real-OIDC configuration fails startup with secret-free diagnostics; absent configuration retains locked mode. Real mode never registers `/dev/signin` or `/dev/signin/codes`. Preserve deterministic tests only in designated test environments.

## Delivery sequence (test-driven)

Every implementation task starts with failing behavior tests, then the smallest change following the existing module/repository/HTTP/frontend split. Record red and green commands/results. Use current schema baseline changes only; no pre-release migrations or obsolete-version transition tests.

### L0 — Confirm provider and deployment inputs

- [ ] Owner confirms Google-first or names an alternative OIDC issuer; resolve OD-05 only after this decision.
- [ ] Identify the Google Cloud project owner and register a Web application OAuth client for acceptance. Configure consent branding/audience/test users as required by the provider's current console. Check production publishing/verification requirements separately; do not assume testing configuration is launch-ready.
- [ ] Record exact acceptance origin and authorized callback below. Use a separate client for production so acceptance credentials and redirect configuration are isolated.
- [ ] Place secrets directly into service variables through the authorized connection; never commit or paste them into plans, PRs, logs or chat. Code work can proceed with a local protocol fixture while external setup is pending, but real acceptance cannot.

### L1 — Backend transaction and OIDC adapter

- [ ] Add failing repository/module tests for one-use/expiry/browser binding, parallel tabs, concurrent canonical user creation and provider errors. Add protocol tests with a local issuer/JWKS fixture for valid and invalid signatures, wrong issuer/audience/nonce, expiry, key rotation, PKCE mismatch and timeouts.
- [ ] Add the transaction repository/current schema, minimally extend `src/identity/oidc.ts` and module methods, implement `src/identity/adapters/oidc.ts`, then run the shared adapter contract against deterministic and protocol-fixture adapters where applicable. Provider-specific checks remain explicit production-adapter tests.
- [ ] Add HTTP login/callback routes, cookie issuance, configured-origin/return validation, no-store/redaction and exact auth exemptions. Exercise real prefixed `/api` registration and the combined Docker artifact. Reuse the identity session service rather than creating a second session system in the routes.
- [ ] Add configuration validation and bootstrap selection; verify locked/test/real modes and secret-free failures. Tests prove callbacks survive restart, consumed callbacks cannot replay, and a failed exchange creates no session.

### L2 — Frontend entry, return and session lifecycle

- [ ] First add failing UI/browser tests for sign-in entry, invitation/deep-link return, cancellation/retry, expired sessions, logout failure/retry and switching accounts with queued offline work.
- [ ] Add one reusable sign-in entry to existing signed-out/Account surfaces. Use full-page navigation to the backend; keep provider exchange out of React. Reconcile `/cb` and `storePostSigninPath` so the validated server target is authoritative, not a stale sessionStorage value.
- [ ] Preserve focus, accessible pending/error states, translations, phone layout and online-required guidance. Test cached offline pages without exposing previous-account data or caching provider responses. Display pairing stays outside Google login.

### L3 — Railway acceptance and real-provider evidence

- [ ] Verify acceptance source branch, commit, successful deployment and database/media isolation. Deploy implementation to the intended acceptance/branch service; do not change the ordinary `sweetroll` production source for testing.
- [ ] Configure acceptance OIDC variables and exact provider redirect, leave `SWEETROLL_TEST_AUTH` unset, and prove deterministic routes cannot authenticate.
- [ ] Run real-provider browser sign-in with at least two independently controlled Google accounts (GM/player), including first use, repeat use, account selection, cancellation, direct invitation return, logout and expired-session recovery. Provider MFA/consent may require user interaction; never record secrets or call a fixture-provider pass real Google acceptance.
- [ ] Repeat the existing ordered one-GM/three-player protocol when four real test accounts are available. Until then record the actual actor count and leave this real-provider multi-user gate open. Include portraits, item art and scene backgrounds; redeploy and recheck image retention on this acceptance service.
- [ ] Exercise Android Chrome and iPad Safari, touch keyboards and installed-PWA reopen/return. Agent browser automation is useful evidence but cannot close physical-device checks.
- [ ] Record source/deployment, safe screenshots, exact tests, callback/log privacy checks, findings, remaining gates and scoped fixture cleanup in `docs/acceptance/real-login-YYYY-MM-DD.md`. Archive created fixtures without claiming provider account deletion. Required CI and local protocol tests must pass before merge; real acceptance is a distinct gate.

### L4 — Enable the normal app after acceptance

- [ ] Register/configure a separate production client and callback; check consent/audience eligibility for intended users. Apply only after real acceptance and the normal deployment decision.
- [ ] Verify health, sign-in/out, forbidden deterministic routes and basic GM/player authorization on the deployed artifact. Keep media/scanner settings intact.
- [ ] Recovery: disable login via locked mode or restore the previous deployment/configuration; define whether existing sessions must be revoked separately. Disabling new sign-in alone does not revoke active sessions. Preserve PostgreSQL/media unless an explicitly chosen pre-release reset is needed. No compatibility/migration implementation belongs here before the first release tag.

## Proposed configuration (not implemented variables)

| Setting | Acceptance | Normal app |
| --- | --- | --- |
| `SWEETROLL_PUBLIC_ORIGIN` | `https://sweetroll-acceptance-production.up.railway.app` | `https://sweetroll-production.up.railway.app` |
| `SWEETROLL_OIDC_ISSUER` | `https://accounts.google.com` | same issuer, separate client |
| `SWEETROLL_OIDC_CLIENT_ID` | acceptance Web client ID | production Web client ID |
| `SWEETROLL_OIDC_CLIENT_SECRET` | acceptance Railway secret | separate production Railway secret |
| Registered callback | `https://sweetroll-acceptance-production.up.railway.app/api/auth/callback` | `https://sweetroll-production.up.railway.app/api/auth/callback` |
| `SWEETROLL_TEST_AUTH` | unset | unset |

Derive callback from the validated configured origin plus the fixed route, or validate an explicit callback against that origin; choose one convention in L1 and document it. Reuse existing secure-cookie/allowed-origin settings, with production HTTPS enforced. Do not add a generic dynamic provider-admin UI.

## Completion and exclusions

The first login increment is complete when required CI passes, real Google login on acceptance creates/resolves the correct local accounts, invitation return and session/logout/privacy checks pass, and the acceptance record clearly states remaining human/device gates. Updating configuration alone or passing local issuer tests cannot close real-provider acceptance. Google access revocation is not automatic Sweetroll session revocation; sessions retain their documented local TTL unless locally revoked. Provider-wide logout/back-channel revocation, session-management UI, email magic links, additional social providers, account linking, password recovery, billing and public release are separate scope.

## Primary implementation references

- [Google OpenID Connect server flow and claim validation](https://developers.google.com/identity/openid-connect/openid-connect)
- [Google Web server OAuth setup and exact redirects](https://developers.google.com/identity/protocols/oauth2/web-server)
- [openid-client maintained implementation and PKCE examples](https://github.com/panva/openid-client)
- [openid-client authorization-code validation checks](https://github.com/panva/openid-client/blob/main/docs/functions/authorizationCodeGrant.md)

Checked 2026-11-05. Recheck provider console requirements and the pinned library API during implementation. This plan extends design Sections 11–12, 18.1 OD-05 and 18.2; it does not mark those release gates accepted.
