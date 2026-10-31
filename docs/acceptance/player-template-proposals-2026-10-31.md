# Player template proposals — D1 acceptance

Status: implementation in progress in PR #26; not a release claim.

Baseline: inherited-actions PR #25 merged as `455f967` and merged into this branch. Current schema is updated directly; no migration or prior-client conversion is added.

## Observed red → green

- Real PostgreSQL HTTP suite first returned missing-route 404 for submissions; implemented strict routes, private self/review scope, membership-generation receipts, decisions and export. Nine tests pass, including all four kinds, hostile content/unknown fields, own-only pagination, cross-scope cursor denial, same-key replay/mismatch, removal/rejoin, competing reviewers, private rejection and archived reads/writes.
- Strict HTTP rejection initially accepted unknown fields because Fastify stripped them. Reuse the existing strict compiler for proposal routes; hostile inputs now return 400 before writes.
- Injected failures at catalog revision insert, terminal update, activity, audit and success receipt prove all-or-nothing rollback. Quotas serialize under the campaign lock. Approved identity and original content survive later template edits/archival and expired receipts cannot republish.
- GUI tests began with a missing proposal component. Frozen submit retries, explicit conflict refresh, direct GM review and delayed GM-response discard on demotion now pass. A caller-cancellation regression was observed red before propagating AbortSignal through ApiClient.
- Canonical new dev-browser journey passed locally: 8.8 seconds, one worker, zero retries. Four identities, independent original personal entry, another player's direct-ID/list denial, GM approval, player placement, lost submit/approve responses with exact retry, lost reject response with reload/no POST, competing GM/co-GM decisions, GM export, removal/rejoin, keyboard primitives, axe and 320/360/768/1280 light/dark overflow checks. Run-created resources archived and read back.

## Verification still in progress

Full CI including PostgreSQL 17, browser/offline/visual and Docker; production-worker proposal journey and isolated Railway deployment/source/asset verification. Optional sheet prefill shortcut is not implemented: player copies presentation into the campaign suggestion form, which has no source-entry link. Physical-device, real-provider authentication and wider G9 playtests remain open.

## Preview isolation

Use `sweetroll-items-preview`, never `proactive-expression`. A separate `preview-d1-postgres` service holds this schema; the previous preview database remains intact. Record exact application SHA, deployment ID, served assets and hosted journey/cleanup results before claiming completion.
