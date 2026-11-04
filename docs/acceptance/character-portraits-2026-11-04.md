# M1 character portraits — 2026-11-04

Implementation complete; CI and hosted acceptance are pending. M2/M3 and wider
human/device G9 gates remain open.

## Red → green

The first three module tests failed for missing portrait operations, then passed.
A duplication regression subsequently failed because the new character lost its
portrait; the source-locked copy now creates an independent authorized link to
retained immutable bytes. The HTTP workflow first failed with 404 for missing
routes, then passed. The UI tests first failed for absent controls, then passed
for exact uncertain-request retry, independent sheet play and private lifetime
cleanup/offline placeholders.

Ten PostgreSQL/filesystem integration cases pass, covering upload/replay/stale
revision/replace/remove, private byte access, ownership transfer, duplication,
HTTP and bounded requests, campaign adoption/return and GM/co-GM authority,
scanner/storage failures, competing uploads, count/byte quotas and archive/recovery.
The character and replay suites also pass (44 cases). Root tests pass 488 cases
with 10 database-dependent cases skipped; the full web suite passes 1,201 tests.
Root/web type checks, generated-contract checks and the production web build pass.
The broader database run caught the exact table-inventory assertion after adding
three current-schema tables; its expected inventory was updated and is being
rerun. No application-version migration or old-format conversion was added.

## Hosted protocol

`web/tests/hosted/characterPortraits.spec.ts` uses a real player, GM and unrelated
player. It covers GUI upload/reload/larger view/replace/remove, phone layout and
axe, private reads before adoption, GM disclosure after adoption, retained art on
return with GM access removed, and offline sheet edit/reconnect/roll.

The isolated preview uses fresh database `sweetroll_pr30_m1`, created on its own
Postgres service by a private temporary setup service. The prior database is
preserved. Record the tested commit, successful deployment and actual journey
outcome here before accepting M1.
