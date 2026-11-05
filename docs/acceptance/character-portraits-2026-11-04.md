# M1 character portraits — 2026-11-04

M1 automated feature acceptance complete: hosted journey and CI #209 passed. M2/M3 and wider
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

## Deployed result

Application `17206059358689538f184f976204e3bd0443400b`, isolated preview
deployment `028161dd-e889-4f04-a416-afa46afe6d06`, reached SUCCESS. The hosted
journey passed in 40.7 seconds with three independently authenticated contexts:

| Check | Result |
| --- | --- |
| Player GUI upload, reload, larger view, replace and remove | PASS |
| Real scanner/normalization path and stripped EXIF | PASS |
| Server commits, response is deliberately dropped, exact body/key retry | PASS |
| GM and unrelated player denied before adoption, including byte reads | PASS |
| GM sheet and roster can show the adopted portrait; unrelated player still denied | PASS |
| Return retains player art and removes former GM access | PASS |
| 360 px routed screenshot and axe | PASS, no violations |
| Offline placeholder, queued sheet edit, reconnect and authoritative roll | PASS |
| Created character and campaign archived | PASS |

The [phone screenshot](assets/character-portrait-360-2026-11-04.png) was inspected.
It shows the character heading before the portrait and controls, followed by the
existing linear sheet. Images are no-store; no image bytes enter the sheet queue.
The failed lost-response interception run ended with a request still in flight;
the runner now sets its context proxy explicitly and waits for the bounded upload
before retry. This changes no application network or authentication policy.

## Follow-up and CI

The first deployed run found duplicate/nested main landmarks. CI #207 also caught
an unlabeled-role placeholder in the NPC roster. Both gained failing regression
tests, then passed with a named sheet section and a valid image placeholder role.
The portrait now lives after the sheet heading inside its system presentation
scope. All 55 focused UI cases pass. The full current-schema integration rerun
passes 370/370 cases with the normal test/hook budgets.

CI #207's only backend failure was a creation p95 of 300.004943 ms against the
unchanged 300 ms budget. CI #208 passes backend verification, web, all three
journey shards and visual checks. Its offline suite caught an ambiguous old
section selector after the landmark correction; it now targets the named
Roll result region and keeps the existing detail assertions. Final CI on that
selector/runner follow-up is pending. No performance budget or accessibility
check was relaxed. M1 remains pending that final CI result; M2/M3 remain open.

CI [#209](https://github.com/Kajonn/sweetroll/actions/runs/41859815673) on
`6076f8a6be21057a414bb898e312f8f997e5507c` passed all jobs, including the unchanged
production-worker offline journey with the named roll-result selector. The tested
application remains `1720605`; the follow-up changes tests/evidence only. M1 is
accepted. M2 and M3 remain separate unfinished stages.
