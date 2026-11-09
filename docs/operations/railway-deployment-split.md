# Railway acceptance and production

One Railway project contains two environments. Both build the same Sweetroll
repository. Acceptance uses the test sign-in fixture. Production runs in
locked mode until a real identity provider is ready. A locked production
deployment can be tested and does not require a release tag.

## Provision and configure

1. Record the existing services, domains, data volumes and last healthy
   deployments. Keep them until cutover passes. Rename the existing project
   Sweetroll and create the `acceptance` environment beside `production`.
2. In each environment, provision one Sweetroll app, private PostgreSQL 17 and
   private ClamAV, with separate database, media and scanner signature volumes.
   Place the app and database in the same region. Set private database and
   scanner references, distinct app secrets, `NODE_ENV=production`,
   `SWEETROLL_SERVE_STATIC=1`, and secure cookies. Follow the
   [volume and scanner setup](railway.md#image-storage-and-scanning-m0).
3. Set the app service's Dockerfile build, repository root, pre-deploy command
   `npm run start:db:init`, start command
   `sweetroll-entrypoint node dist/bootstrap/http.js`, and readiness check
   `/health/ready` with a 120-second timeout. Use Railway service settings or
   its supported infrastructure configuration for new services. The existing
   `railway.json` records the settings used by legacy services.
4. Set `SWEETROLL_TEST_AUTH=1` on the acceptance app service alone. Keep test
   auth out of production and shared variables. Acceptance must only contain
   test data because its deterministic sign-in is intended for testing.
5. Assign separate temporary HTTPS domains while the old services still own the
   final hostnames. The workflows explicitly target a service and environment.
   Disable overlapping GitHub autodeploy triggers on the replacement services
   before GitHub Actions takes ownership.

## GitHub Actions configuration

Create GitHub deployment environments named `acceptance` and `production`.
Restrict deployment to the `main` workflow ref for both. Set the following in
each environment using the IDs and URL for that environment.

| Key | Scope | Value |
| --- | --- | --- |
| `RAILWAY_TOKEN` | Environment secret | Railway project token scoped to this Railway environment |
| `RAILWAY_PROJECT_ID` | Environment variable | Shared Railway project UUID |
| `RAILWAY_ENVIRONMENT_ID` | Environment variable | Railway environment UUID |
| `RAILWAY_SERVICE_ID` | Environment variable | App service UUID |
| `RAILWAY_APP_URL` | Environment variable | HTTPS origin for that app |

Set repository variable `RAILWAY_ACCEPTANCE_AUTODEPLOY=true` after acceptance
is provisioned and its manual deployment has passed. Production dispatches
require a full commit SHA in current `main` history with successful push CI.
For production promotion, keep control of dispatch with maintainers and use
environment protection if required by repository policy.

The PR workflow takes a reviewed, same-repository PR number and a manual test
window of 0 to 30 minutes. It uses CI for the exact head SHA, runs a signed-in
browser smoke test, and then restores the newest verified `main`. A cancelled
or timed-out PR workflow triggers a recovery deployment of verified `main`.
All acceptance deploy and hosted test jobs use the same concurrency group.
GitHub can replace an older queued job with a newer one. If recovery fails or
was replaced in the queue, dispatch **Deploy verified main to Railway** with
target **acceptance**. The PR workflow refuses a changed schema baseline
before uploading. For a schema-changing test, coordinate a disposable database
reset before each switch between incompatible builds. Resume deployment only
after the new private database reference is set. Database resets are an
operator step.

For **Hosted scene acceptance**, supply the SHA and Railway deployment ID from
the same acceptance workflow summary. The job checks that deployment is current
and successful, confirms readiness, and checks the served frontend assets
against the requested checkout before running the scene journey.

## Cutover and recovery

1. Dispatch **Deploy verified main to Railway** to each replacement. Verify
   the intended SHA, Railway `SUCCESS`, readiness and GUI entry point. The
   acceptance smoke check signs in and signs out. Production checks that the
   fixture request leaves `/api/me` anonymous even when the SPA returns HTML
   with HTTP 200 for the sign-in path.
2. Move each final hostname to the corresponding verified replacement. Update
   each GitHub environment URL. Repeat the checks at the final hostnames and
   run a PR deploy/restore exercise on acceptance. Confirm the production
   deployment ID did not change during that exercise.
3. If a replacement fails, restore its hostname to the recorded old service.
   After both final URLs and the PR recovery exercise pass, remove the old
   app and database services, unused scanners and obsolete volumes. Confirm
   each environment has only its intended stack.
4. Keep release tags for application releases. Before opening production,
   verify real sign-in and backup/restore. Follow the
   [database policy](../../database/README.md) for released production data.

For changes to the Railway provisioning or token setup, see
[Railway environments](https://docs.railway.com/environments) and
[environment-scoped deployment tokens](https://railway.com/guides/lock-down-production-project).
