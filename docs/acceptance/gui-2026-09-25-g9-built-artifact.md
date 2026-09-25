# G9 built-artifact remainder verification (2026-09-25)

Scope: G9 built-artifact gate remainder only — sign-in return (`/cb` →
pre-sign-in path) and fully-offline shell reopening on the Task 4
single-artifact image, without Vite dev/preview. This record does NOT close
real-device checks, playtests, mockup capture, real-provider production auth
(OD-05), or any other G9 box. The GUI plan checklist is left untouched.

## Tested artifacts

- Commit: `025d7aa61d67ca5866dfdbbb837bd1c2e694a4b0` (`main`, clean)
- Image: `sweetroll:g9-verify-025d7aa` (`2349d410765c`), built via
  `DOCKER_CONFIG=/tmp/opencode/docker-cfg docker build -t sweetroll:g9-verify-025d7aa .`
  (Dockerfile multi-stage `web-build` included; no prior `web/dist` copy needed)
- Web build inside image: `buildId=build-muh9wmzh`
  (`/offline-manifest.json`: `index-BFGf1wBM.js`, `index-Ds8qfq-j.css`)
- Browser: Playwright Chromium headless 1.63.0, default viewport, default
  (light) theme. No dark-mode, text-enlargement, keyboard-only, or real-device
  runs claimed.

## Containers (both production, `SWEETROLL_SERVE_STATIC=1`, dev `sweetroll` DB)

```bash
docker run -d --name sweetroll-g9-verify --network sweetroll_default -p 3129:3129 \
  -e NODE_ENV=production -e PORT=3129 -e HOST=0.0.0.0 \
  -e DATABASE_URL=postgres://sweetroll:sweetroll@postgres:5432/sweetroll \
  -e AUTHORITATIVE_ROLL_SECRET=development-only-roll-secret-32-bytes \
  -e SWEETROLL_SERVE_STATIC=1 sweetroll:g9-verify-025d7aa
# startup: auth mode active: locked (dev sign-in routes disabled)

docker run -d --name sweetroll-g9-testauth --network sweetroll_default -p 3130:3130 \
  -e NODE_ENV=production -e PORT=3130 -e HOST=0.0.0.0 \
  -e DATABASE_URL=postgres://sweetroll:sweetroll@postgres:5432/sweetroll \
  -e AUTHORITATIVE_ROLL_SECRET=development-only-roll-secret-32-bytes \
  -e SWEETROLL_SERVE_STATIC=1 -e SWEETROLL_TEST_AUTH=1 sweetroll:g9-verify-025d7aa
# startup: auth mode active: test-auth (dev sign-in routes enabled)
```

## Curl matrix (locked artifact, port 3129, verbatim outcomes)

```text
ui-fallback 200 (content-type: text/html)                         /some-spa-route
campaign 200 (app shell, first 120 chars `<!doctype html>...`)    /campaigns/11111111-1111-1111-1111-111111111111
cb 200 (app shell)                                                /cb?code=x&state=y
api 404 {"code":"not_found","message":"Not found"} (application/json; charset=utf-8)  /api/unknown-route-xyz
manifest 200 / sw.js 200 / offline-manifest.json 200
metrics 200 / health/ready 200 / metrics/unknown 404 (application/json)
API precedence: /api/campaigns/abc → 400 {"error":{"code":"bad_request","message":"params/id must match format \"uuid\""}}
  (application/json — API route wins over SPA fallback, as designed)
Page build id: <meta ... offline-build-id" content="build-muh9wmzh"> matches /offline-manifest.json buildId
```

## Browser checks (test-auth artifact, port 3130, 7/7 pass)

Script: ad-hoc Playwright run against `http://localhost:3130` (no Vite
involved; removed after the run, not committed).

```text
PASS root-serves-shell
PASS sw.js-served (status=200)
PASS offline-manifest (buildId=build-muh9wmzh)
PASS test-auth-signin-on-artifact (POST /dev/signin code-test-a → 200, session issued)
PASS cb-restores-presignin-path (sessionStorage sweetroll:postSignin=/campaigns → /cb lands /campaigns)
PASS cb-defaults-to-characters (/cb with nothing stored lands /characters)
PASS offline-shell-reopening (service-worker controller=true, worker active=true, offline reload renders shell)
7/7 passed
```

The `/cb` leg refreshes the session (cookie already set by the completed
sign-in) and consumes the stashed path once, defaulting to `/characters`
(`web/src/router.tsx` `SignInCallbackRouteView`, `characters/identity.ts`
`takePostSigninPath`). Offline reopening ran with the controlling worker
after a ~3s install wait, then `context.setOffline(true)` + reload.

## Manual findings

None blocking. No data loss, no privileged-data disclosure observed in this
pass (display/media revocation paths were not exercised here — they remain
covered by the I7b `sceneDisplayJourney` record).

## Remaining limitations (explicit, still open)

- Sign-in exercised through the deterministic test-auth adapter
  (`code-test-a`/`code-test-b` with `SWEETROLL_TEST_AUTH=1`), not a real OIDC
  provider. OD-05 stays owner-deferred: real provider return, concurrent first
  sign-in → one user, expiry, revocation, secure sign-out.
- Chromium-only, anonymous + test-auth identities on the dev `sweetroll` DB;
  no real Android Chrome / iPad Safari, touch, virtual keyboard, PWA install,
  200% text, long-label, or contrast sign-off.
- No playtest sessions run (physical-table + remote script in
  `docs/acceptance/g9-2026-09-17-device-playtest.md` still pending).
- Mockup capture still blocked (historical HTTP 401); no shipped-template
  license claim.
- G9 plan boxes unchanged by this record; closing any box needs owner review.
