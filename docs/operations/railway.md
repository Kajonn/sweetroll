# Deploy Sweetroll on Railway

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
| `COOKIE_SECURE` | `true` |
| `SWEETROLL_MEDIA_DIR` | `/app/data/media` |
| `AUTHORITATIVE_ROLL_SECRET` | Generate a new random secret with the command below; keep it stable across deployments. |
| `LOG_LEVEL` | `info` |
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

## Persistent images

Attach an app volume at exactly `/app/data/media`. A Dockerfile `VOLUME`
declaration does not provision a Railway volume. Railway mounts volumes as root;
the image normally runs as `node`. Railway documents `RAILWAY_RUN_UID=0` for
non-root images using these mounts. This runs the container as root; for a
non-root production runtime, implement and verify mount ownership initialization
followed by privilege dropping before removing that override. Do not use chmod 777.
The mounting/ownership check must happen at runtime: pre-deploy containers do not
have access to the media volume.

## Build, migrate, and start

`railway.json` specifies:

- Docker build from the repository root.
- Pre-deploy: `npm run start:migrate` using the compiled migration runner and
  production dependencies in the image. Migration failure blocks the deploy.
- Start: `node dist/bootstrap/http.js`.
- Readiness: `/health/ready`, with a 120-second startup allowance.
- One replica, and up to three restarts on failure.

The media volume is persistent; other container writes are disposable. Avoid
parallel deployments against the same database. Database migrations are not
rolled back automatically when rolling back an app image; back up before schema
changes and confirm compatibility before reverting an image.

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
