# Campaign inherited actions — verification record

Date: 2026-10-31. Status: local candidate; publication and remote verification blocked.

Scope: [execution plan](../superpowers/plans/2026-10-31-campaign-inherited-actions.md) and [contract](../superpowers/specs/2026-10-31-campaign-inherited-actions.md). Implementation is committed locally for PR #25. The remote branch still contains planning commit `2eae86b`; no CI or deployed result is claimed for the implementation.

## Completed local evidence

Node 24: 458 server/unit tests passed; ten database-backed tests in that command were skipped. Frontend: 1,164 tests passed. Backend/frontend typechecks and production builds pass. The canonical contract generator reports identical checked-in output; diff whitespace checks pass. Browser retries, timeout settings, assertions and visual baselines were not weakened.

Observed red → green regressions cover missing derived action projection/execution; pinned base/default validation; GM source selection/publication; typed defaults clearing; returned-copy controls without catalog data; immutable push provenance (cloned source); unsupported template-computed action dependencies; and using the caller transaction for source reads. Shared fixture tests compile the actual integration/browser fixture and exercise metadata/name-field separation, independent copies, hit/damage/nominal/resource parity, saved-pool binding preservation, removal, restoration and changed placed source.

## Not yet executed

- Real PostgreSQL integration and the ten DB-backed root tests, including immutable catalog revisions, permissions, transaction rollback and concurrent pushes.
- Canonical browser shards, production-worker recovery, retained visual suite and Docker build.
- Isolated deployed acceptance of the implementation. New shared browser journeys cover labeled GM authoring, player copies/actions/pushes, offline placement/value edits, archived/recovered stale reference review, committed-but-unseen push replay, co-GM conflicts, revised independent copies and returned play without catalog transport. They include responsive light/dark checks and scoped cleanup/readback, but require successful execution.

## Publication blocker

Automatic approval review rejected the push to `Kajonn/sweetroll` because it classified repository publication as requiring explicit user authorization. No connector or alternative export was used to bypass that rejection. User authorization to push is required before CI and deployment can finish.

Read-only Railway inspection verified `sweetroll-items` in isolated project `sweetroll-items-preview`, environment `8016a027-c65d-4991-a7e8-7f38ff54dbf7`, service `f75d2a0b-66a6-49b7-95cc-a24ff99ac6f8`. It remains pinned to main `ba8200b3a6dff4a22e3865a7f7db1aeeab59058e`, successful deployment `abf9286a-17ad-45a6-a7c2-bfe30409c60d`. No service configuration, deployment or remote database was changed. `proactive-expression` was untouched.

After push approval, await all seven verification jobs on the exact implementation head, deploy that head to the existing isolated preview, verify terminal success/readiness and served assets, then run `DERIVED_ACCEPTANCE_URL=https://sweetroll-items-production.up.railway.app web/node_modules/.bin/playwright test --config web/playwright.derived-acceptance.config.ts` with the config resolved from the repository root. Record failures/fixes and cleanup before closing C7. Wider physical Android/iPad, real-provider authentication and playtest G9 gates remain open. No migration/version-transition work is added before the first release tag.
