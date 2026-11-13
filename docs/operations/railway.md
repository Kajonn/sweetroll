# Deploy Sweetroll on Railway

Follow the [deployment and cutover runbook](railway-deployment-split.md) for
the acceptance and production split, GitHub Actions settings and PR testing.

This configuration targets a single app instance, a PostgreSQL service, and a
persistent media volume. The repository-root Dockerfile builds both the frontend
and backend. No separate frontend service or Vite server is needed.

## Application login is a separate prerequisite

Signing into Railway with GitHub authorizes hosting administration, not Sweetroll
users. The current backend has no real production OIDC provider adapter.
This configuration leaves production authentication locked: the app can become
healthy and serve its login screen, but authenticated user journeys remain
blocked until real login or a separately protected staging-login flow is added.
Do not enable the deterministic `SWEETROLL_TEST_AUTH` adapter on an unprotected
internet deployment. It is not a password-protected staging login.

## Create the project

1. Create a Railway project and add PostgreSQL (use PostgreSQL 17 to match CI).
   Keep it in the same region as the app; an available European region is a
   suitable choice for Swedish players. Use a separate staging database.
2. Add a service from GitHub and select `Kajonn/sweetroll`. If the repository
   is missing, grant the Railway GitHub integration access to that repository;
   GitHub login alone may not install that integration.
3. Select the branch containing this configuration, or `main` after merging it.
   Keep the service root at the repository root. Railway detects `railway.json`
   and uses `Dockerfile`; do not select `web/` as the root.
4. Before the first successful deploy, configure the variables and media volume
   below. A deployment started before DATABASE_URL is configured will fail;
   redeploy after completing setup.
5. Use one replica. Provision PostgreSQL storage separately from the app volume.
   Enable PostgreSQL and media-volume backups and follow the existing
   [backup/restore procedure](backup-restore.md).

## App service variables

Set these in the Railway app service's Variables panel. Configuration as code
controls build/deploy settings; it does not create databases, volumes, domains,
or secret variables.

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` if the DB service is named `Postgres`; otherwise select its DATABASE_URL via Railway's variable-reference picker. Use the private URL. |
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` |
| `SWEETROLL_SERVE_STATIC` | `1` |
| `COOKIE_SECURE` | Defaults to `true` in production. |
| `METRICS_TOKEN` | Optional. Use a separate random secret for metrics scraping. |
| `TRUSTED_PROXY_CIDRS` | Optional comma-separated addresses or CIDRs of trusted forwarding proxies. |
| `SWEETROLL_MEDIA_DIR` | `/app/data/media` |
| `AUTHORITATIVE_ROLL_SECRET` | Generate a new random secret with the command below; keep it stable across deployments. |
| `LOG_LEVEL` | `info` |
| `SWEETROLL_PRUNE_INTERVAL_MS` | Optional. Expired-row prune interval in milliseconds; default `3600000` (one hour), `0` disables. See below. |
| `RAILWAY_RUN_UID` | `0`, for Railway's root-owned media-volume mount (see below). |

Allow Railway to supply `PORT`; the backend reads it. Do not copy the local
`.env.example` database URL or development roll secret into hosting settings.
Leave `SWEETROLL_TEST_AUTH` unset. For the same-origin frontend/API setup,
`ALLOWED_ORIGINS` can remain unset; do not configure a wildcard origin.

Generate the secret on your own machine and paste only its output into the
Railway secret variable, never into a commit:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

## Metrics and display request limits

`/metrics` returns 404 unless `METRICS_TOKEN` is set. Generate a separate
random value using the command above, store it in the service and scraper
secret settings, and send it over HTTPS as `Authorization: Bearer <token>`.
Missing or incorrect credentials receive 401. The health endpoints remain
available to Railway without a token.

Display redemption allows 10 attempts per minute per client IP and 120
failed attempts (wrong, expired or unknown code) per minute per process. Once
the failure budget is spent, further wrong codes receive 429, but a correct
code still redeems. By default it uses the TCP peer address. If an ingress
proxy shares one peer address for many clients, configure
`TRUSTED_PROXY_CIDRS` with the actual forwarding proxy addresses and verify
that ingress appends or replaces the client entry in `X-Forwarded-For`.
Leave the variable unset if those addresses cannot be verified. While it is
unset, the service logs one warning after the first request that carries
`X-Forwarded-For`: "request carried X-Forwarded-For but TRUSTED_PROXY_CIDRS is
unset". Seeing it means per-IP limits are keyed on the proxy address.

## Expired-row pruning

Each HTTP process deletes rows that stopped being usable more than seven days
ago: expired idempotency and image receipts, expired command executions
(abandoned pending claims only after their lease has also lapsed), preview
snapshots, expired or revoked sessions and personal tokens, never-consumed
invitations past expiry and expired display codes. It deletes at most 1000 rows
per statement and stops after 30 seconds per run. A PostgreSQL advisory lock
lets only one replica prune at a time. Each run logs `expired rows pruned` with
per-table counts (`event: prune_completed`); failures log `prune_failed` and
retry at the next interval. Audit, activity, rolls, characters, content and
consumed or revoked invitations are never pruned.

## Persistent images

Attach an app volume at exactly `/app/data/media`. A Dockerfile `VOLUME`
declaration does not provision a Railway volume. Railway mounts volumes as root;
the image normally runs as `node`. Railway documents `RAILWAY_RUN_UID=0` for
non-root images using these mounts. This runs the container as root; for a
non-root production runtime, implement and verify mount ownership initialization
followed by privilege dropping before removing that override. Do not use chmod 777.
The mounting/ownership check must happen at runtime: pre-deploy containers do not
have access to the media volume.

## Build, initialize, and start

`railway.json` specifies:

- Docker build from the repository root.
- Pre-deploy: `npm run start:db:init` using the compiled database initializer and
  production dependencies in the image. Initialization failure blocks the deploy.
- Start: `node dist/bootstrap/http.js`.
- Readiness: `/health/ready`, with a 120-second startup allowance.
- One replica, and up to three restarts on failure.

The media volume is persistent; other container writes are disposable. The app
uses disposable test databases. Recreate them after schema changes, then run the
initializer; there is no database-version conversion or automatic reset. See
[database policy](../../database/README.md).

A successful deploy and a ready health check do not show that the schema is
current. The initializer leaves a non-empty database as it is, so a deploy of a
commit that changed `database/schema.sql` onto an older database starts normally
and then fails at run time: on 2026-11-12 rolls and draws returned HTTP 500 on
acceptance until the database was recreated. When `database/schema.sql` differs
between the deployed and the new commit, point the service at a new empty
database before deploying, and confirm with one roll after the deploy.

## Domain and verification

Generate a Railway domain in Networking and target the service's HTTP port.
Railway supplies HTTPS. After deployment, verify:

1. `/health/live` and `/health/ready` return 200 with JSON.
2. `/` and a browser deep link such as `/characters/new` return the frontend HTML.
3. `/api/me` returns JSON with `state: anonymous` before sign-in, not HTML or 404.
4. `/api/unknown-route` returns 404, not the frontend HTML fallback.
5. Complete the separate login prerequisite before attempting authenticated GUI
   tests. Once available, verify session cookies and sign-out over HTTPS.
6. Upload a disposable image after login, redeploy, and verify it still loads.
   Health/readiness checks alone do not verify media-volume write permissions.

If `/api/me` returns 404, confirm that this branch's API mounting change is in the
image and `SWEETROLL_SERVE_STATIC=1`. In this mode, `/api` is the external API
prefix. Restricted-display background image requests also use `/api` before
the backend-provided relative image path. Existing backend-only clients and Vite development retain the old routes
when that flag is absent.

## Provider references

- [Configuration as code](https://docs.railway.com/config-as-code/reference)
- [GitHub deployments](https://docs.railway.com/deployments/github-autodeploys)
- [Pre-deploy commands](https://docs.railway.com/deployments/pre-deploy-command)
- [Volumes and ownership](https://docs.railway.com/volumes)
- [Public networking](https://docs.railway.com/networking/public-networking)


## Image storage and scanning (M0)

Image uploads require `SWEETROLL_CLAMD_HOST` (private ClamD network address),
optional `SWEETROLL_CLAMD_PORT` (3310 by default), and a real persistent volume
mounted at `/app/data`. Never expose the scanner's unauthenticated TCP endpoint
publicly. An unavailable scanner returns 503 and writes no accepted image.
The official `clamav/clamav:1.4` service uses a signature volume at
`/var/lib/clamav`; verify signature refresh and scanner readiness in its logs.

Railway mounts volumes as root. Set `RAILWAY_RUN_UID=0` for volume initialization
and keep the repository start command `sweetroll-entrypoint node dist/bootstrap/http.js` (one line). The entrypoint initializes the two private
storage directories, then drops to the existing `node` user with `su-exec`.
Do not replace this with a permanently root application process. Docker without
an attached Railway volume still starts as the image's unprivileged node user.

Uploads use PNG/JPEG/WebP, 5 MiB, one frame and 4096 px limits. They are scanned
before full decode and re-encoded without metadata. Campaign quotas are 100 MiB
and 256 retained images, serialized under the campaign lock. Referenced scene
background/token art cannot be removed. Include metadata, stored checksums and
private media bytes in the same recovery point; derivative caches may be rebuilt.
Verify a real authorized upload after every storage configuration change and
again after redeploy. Health alone does not prove storage persistence.


## Current image hosting setup (2026-11-05)

The main and acceptance services now have the image scanner, persistent media
and separate current-schema test databases configured. See the
[deployment inventory and verification](railway-2026-11-05.md). Both services
retain locked sign-in; provisioning media does not enable the test-auth adapter.
Pre-release app/database state may be reset completely under the owner's
[explicit development-state policy](../../database/README.md).
