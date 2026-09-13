# Pre-Upgrade Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the issues identified by the project review and full verification before campaign-upgrade development, while retaining explicit release gates.

**Architecture:** Four independently reviewable plans cover runtime/test stabilization, claim discovery, durable note recovery, and acceptance. This index records dependencies and decisions; it does not approve new authorization contracts or claim implementation completion.

**Tech Stack:** TypeScript, PostgreSQL, Fastify, React 18, TanStack Query, Vitest, Playwright Chromium, GitHub Actions.

**Spec:** `design_v2.md` Sections 8-14 and 17; `docs/superpowers/specs/2026-09-11-i7-gm-app-design.md`; `docs/superpowers/plans/2026-09-08-gui-integration.md`.

## Global Constraints

- Planning baseline: `11aea84`, verified 2026-09-12. These documents are proposals, not authorization to execute or commit.
- Keep existing Module ownership, generated contracts, projection-driven character sheets, revision checks, and offline queues.
- Do not expand discovery or deleted-content access until the corresponding proposal is approved and recorded in `design_v2.md` and the I6 backend spec.
- No new provider choice, media/display work, campaign-upgrade implementation, player-note authoring, or policy-management feature is included here.
- Production sign-in remains owner-deferred. Do not turn deterministic test authentication into production acceptance.
- Never replace screenshot baselines merely to make a check pass. Never reset an existing development database.
- Execute regression-first; record commands and actual outcomes at the tested commit. Commit only when explicitly requested.

---

## Fresh Evidence

| Check at `11aea84` | Result |
| --- | --- |
| Backend unit | 306 passed |
| PostgreSQL integration, including load/concurrency | 295 passed |
| Frontend unit | 922 passed |
| Full Chromium browser suite | 27 passed, 4 failed |
| Production-build offline suite | 22 passed |
| Typechecks, generated contracts, backend/web/Docker builds | Passed |
| Isolated visual rerun on a fresh database | 10 passed |
| Campaign/GM journeys repeated twice | 1 passed, 5 failed across 6 executions |

The four original browser failures were the campaign audience locator, the phone GM retry, and library screenshots at 360/1280. Repetition also exposed the GM retry at desktop width. The library actual images contained `D20 System` and `G5 Exit Demo`, absent from the empty-library baselines. The existing five-baseline warning is historical, not a reproduction of five current visual failures.

Local traces and diffs from verification are in `web/test-results-verify-e2e/` and `web/test-results-verify-rerun/`; these untracked artifacts are not required committed inputs. Preserve evidence until the remediation has its own acceptance record.

## Issue Coverage

| ID | Issue / classification | Owner plan and gate |
| --- | --- | --- |
| R1 | GM bump retry enabled before refreshed revision reaches the handler; confirmed app defect | [Stabilization](2026-09-12-runtime-test-stabilization.md), Task 1; pre-upgrade |
| R2 | GM test waits for network response rather than rendered readiness; test defect | Stabilization, Task 1; pre-upgrade |
| R3 | Campaign audience locator matches both option and label; confirmed test defect | Stabilization, Task 2; pre-upgrade |
| R4 | Library visual cases inherit other journeys' persistent systems; confirmed isolation defect | Stabilization, Task 3; pre-upgrade |
| R5 | CI browser allowlist excludes campaign/GM journeys | Stabilization, Task 4; pre-upgrade |
| R6 | Ordinary player cannot discover a GM-designated character | [Claim discovery](2026-09-12-player-claim-discovery.md); contract approval, then pre-upgrade |
| R7 | List-level Hide and browser reload provide no durable recovery entry | [Content recovery](2026-09-12-content-recovery.md); contract approval, then pre-upgrade |
| R8 | Audience narrowing/revocation browser evidence uses the GM as selected recipient, not a real player | [Acceptance](2026-09-12-campaign-acceptance-release-gates.md), Task 1; pre-upgrade |
| R9 | Main checklist/status and acceptance findings lag GM Phase 1/2 and later fixes | Acceptance, Task 2; pre-upgrade evidence reconciliation |
| R10 | Dark-mode and broader responsive/accessibility campaign coverage missing | Acceptance, Task 3; automated checks pre-upgrade, full manual sign-off before I7 acceptance |
| R11 | Simultaneous authenticated GM devices/co-GM operation not fully demonstrated | Acceptance, Task 3; full Phase 4/I7 gate, targeted conflict proof in R1 |
| R12 | Real phone/iPad, installed-PWA, contrast, text enlargement, keyboard/touch evidence incomplete | Acceptance, Task 3; physical-device/release gate |
| R13 | Production OIDC sign-in and return not validated | Acceptance, Task 4; owner-deferred production gate |
| R14 | Built frontend/API deployment, SPA/API routing and offline reopening acceptance missing | Acceptance, Task 4; production-artifact gate |
| R15 | Hosted visual reference capture blocked by HTTP 401 in earlier records | Acceptance, Task 4; owner-supplied reference gate, not permission to invent approved values |
| R16 | Physical-table/remote playtests and operational recovery evidence missing | Acceptance, Task 4; Phase 4/G9 release gates |
| R17 | React `act(...)` warnings and web bundle-size warning | Acceptance, Task 5; non-blocking test/build hygiene |
| R18 | Docker dependency installation reported development dependency advisories | Acceptance, Task 5; triage first; pruned production install reported zero in that build, not a general security certification |

## Already Fixed / Explicitly Deferred

- Resource live-maximum mismatch was fixed by `72dc587`; retain its regression rather than reimplementing it.
- Campaign revocation/leave content-key prefix purge was fixed by `b5c2f55`; retain and extend its tests for any new query families.
- Retained-editor Hide/Recover stale revision was fixed during Phase 2; R7 is the separate recovery-after-list-hide/reload gap.
- True content pinning, preview-as-player, export presentation, and required-input board rolls remain explicitly scoped/deferred I7 follow-ups. Record their owners in acceptance; this plan does not silently implement them or declare the broader I7 requirements closed.
- GM offline mutations are not added. Existing standalone character offline capabilities remain mandatory regression coverage.
- I7 Phase 3 upgrades, then Phase 4 hardening, then I7b scenes/display remain the feature sequence. Finishing these remediation plans does not close those increments.

## Execution Order

1. Review the two proposed authorization contracts in the claim and recovery plans. Approve, amend, or explicitly defer each; a deferred issue remains open.
2. Execute stabilization Tasks 1-3. Runtime and locator fixes may proceed independently; fixture isolation must land before the full-suite CI switch.
3. Execute approved claim and recovery plans. They share transport/schema/frontend API files, so integrate sequentially rather than editing those files concurrently.
4. Execute acceptance Task 1 and automated portions of Task 3. Enable full browser coverage in CI with stabilization Task 4.
5. Run the complete verification matrix and reconcile current evidence in acceptance Task 2. Do not call the pre-upgrade gate green with outstanding R1-R9 failures or unapproved R6/R7 silently omitted.
6. Retain owner/device/deployment-dependent gates with named evidence requirements; revisit them before full I7/public release acceptance.

## Planning Completion Checklist

- [x] Owner approves or changes the R6/R7 proposals before their implementation.
  (Approved 2026-09-12, recorded in the I6 backend spec reconciliation note
  and `design_v2.md` §§5.3/4.1; implemented as `a5561d7`.)
- [x] Each executed task has a failing regression, passing targeted check, and preserved existing authorization/offline behavior.
  (Audited 2026-09-13 in `docs/acceptance/gui-2026-09-12-remediation.md`,
  checkbox-closure section: per-task table recorded. Stabilization T1–T4 have
  observed red evidence (index Fresh Evidence + runner failure-propagation
  unit test); acceptance T1 recorded red-first; R6/R7 red runs recorded
  2026-09-13 in an isolated revert worktree (backend 8 red / web 10 red, all
  new-behavior-specific; same files 61/61 + 19/19 green after restore; fresh
  canonical 32/32). Existing authorization/offline behavior preserved per the
  Task 2 matrix. Plan worker checkboxes remain unticked — they are proposal
  tracking, not evidence.)
- [x] R1-R9 are closed by evidence or explicitly remain blockers; R10 automated checks are recorded.
  (Evidence: Task 2 in `docs/acceptance/gui-2026-09-12-remediation.md` at
  `40c6142`, 2026-09-13. Single caveat: one unattributed first-run web-unit
  failure before three consecutive 943/943 reruns — capture the suite name if
  it recurs. R10–R18 manual/device/production gates remain visibly open.)
- [x] Production/deferred gates remain visibly open rather than being inferred from green deterministic tests.
  (Audited 2026-09-13, same section: GUI plan G0/G6/G7/G8/G9, Task 2 R10–R18
  list, `design_v2.md` §§13/13.2/I6-exception, Phase 2 limitations, I7 spec
  header — all state the gates open. No green run is cited for any of them.)
- [x] A fresh full-suite run, with no approved-baseline changes hidden in it, is linked from the GUI checklist.
  (Task 2 matrix at `40c6142`, linked from the GUI plan execution note.
  Last baseline-image change is `0680707` owner-approved re-baseline;
  `7d92b71` touched only spec files; reconciling visuals passed 10/10 with
  no snapshot update.)
