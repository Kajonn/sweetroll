# Campaign Acceptance and Release Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish truthful multi-account, responsive, operational and release evidence for the delivered campaign work, without treating deferred features as complete.

**Architecture:** Extend real-HTTP browser acceptance and targeted cache regressions, then reconcile the existing GUI checklist. Device/provider/production work is explicitly gated; where an implementation design is absent, the task produces a reviewed design and evidence requirements rather than guessing infrastructure choices.

**Tech Stack:** Existing Playwright/Vitest suites, real PostgreSQL/API, shared PWA, GitHub Actions, existing Docker deployment and observability tooling.

**Spec:** `design_v2.md` Sections 9.1, 10, 11, 14, 17.1, 17.9-17.10; GUI plan G7/G9; [remediation index](2026-09-12-remediation-index.md), R8-R18.

## Global Constraints

- No acceptance check is checked solely because a document or mock exists. Record tested commit, commands, actual result, browser/device, theme and limitations.
- Do not claim production OIDC, physical-device operation, deployment, or remote CI verification from deterministic local Chromium results.
- Do not expand preview-as-player, pinning, exports, images/display, required-input board actions, or offline GM writes in this plan.
- New authorization/cache failures found by Task 1 block acceptance and receive their own regression-first repair; never weaken the test to fit current behavior.
- Keep server policy authoritative. All private browser caches and in-flight results use actor/generation lifetimes; membership and visibility loss must purge relevant private data.
- Use test data only for uploaded traces. Never record real credentials, invitation tokens, or personal campaign content in committed evidence.

---

## Task 1: Prove Visibility With Actual Player Accounts

**Files:** Create `web/tests/e2e/campaignVisibility.spec.ts`; modify `web/src/campaigns/CampaignContent.test.tsx`, `CampaignDetail.session.test.tsx` where coverage is missing. If a failing test proves a defect, modify only the responsible `CampaignContent.tsx`/`CampaignDetail.tsx` query lifecycle. Add evidence to `docs/acceptance/gui-2026-09-12-remediation.md` during execution.

**Interfaces:** Reuse real invitations, content audience/grant commands, `CampaignsApi.listContent/openContent`, and existing actor-lifetime QueryClient cleanup. No impersonation endpoint and no new production policy interface.

- [ ] Seed GM and ordinary player contexts with distinct supported deterministic identities. Do not silently invent extra sign-in codes. Use the same player first as granted then ungranted; use a separate authenticated campaign for cross-campaign denial. If a second ordinary player is needed, extend deterministic test fixtures explicitly, never production startup identity behavior.
- [ ] Add the full matrix: GM-only hidden from player, all-player readable, selected-player readable only while granted, owner-only private according to actual policy, guessed cross-campaign IDs generic 404. Assert response bodies as well as visible DOM. The GM must not access a player's owner-only note merely by being GM.

```ts
const denied = await playerContext.request.get(`/api/content/${noteId}`);
expect(denied.status()).toBe(404);
expect(await denied.text()).not.toContain(secretBody);
```

- [ ] Prove narrowing/revocation after a player has opened and cached the note. GM removes the grant through UI; player focus/reconnect must perform real authorization revalidation. Assert the old body/title disappears from the mounted reader and corresponding query cache, and cannot return through Back, refresh, offline reopening, or a delayed pre-revocation response. Do not inspect only a CSS-hidden element. Add deterministic component tests with deferred promises and an injected QueryClient for exact cache assertions.
- [ ] Prove campaign membership revocation/leave with an already-open reader and session content. Retain existing prefix purge regressions and include new claim/hidden query families as they land. Test A-to-B account switching and sign-out while a read is in flight.
- [ ] Run targeted tests to red before any discovered lifecycle repair. Typical failure paths to inspect are a detail 404 that unmounts a reader without removing its cached body, list refresh that silently removes a row but leaves a selected reader mounted, and a cancelled request that still resolves into the old lifetime. Fix only reproduced paths and rerun component plus real-browser cases.
- [ ] Run this spec through the full-suite runner from stabilization, then production-offline tests. These cases must execute in CI, not remain an optional acceptance script. Keep the ordinary-player claim test and durable recovery journey in their owning plans rather than duplicating them here.

## Task 2: Reconcile Current Evidence and Milestone Status

**Files:** Create `docs/acceptance/gui-2026-09-12-remediation.md`; update `docs/superpowers/plans/2026-09-08-gui-integration.md`, `docs/superpowers/specs/2026-09-11-i7-gm-app-design.md`, `docs/acceptance/gui-2026-09-12-g7-gm-phase2.md`, and status notes in `design_v2.md` where current evidence supports them.

**Interfaces:** Consumes the stabilization, claim, recovery and visibility results. Produces an evidence-linked current status, not new product behavior.

- [ ] Preserve historical counts and failures as dated records. Add current notes that GM Phase 1/2 landed, while full I7 remains open; identify the already-fixed live-max/editor-recovery/cache-prefix findings by commit. Do not erase the original report or rewrite its tested commit.
- [ ] Replace the stale assumption of five current visual mismatches with the actual baseline evidence: full-suite two library failures from fixture contamination; isolated fresh-DB visual suite 10/10. After isolation repair, record new full-suite results; require human inspection for any actual future baseline change.
- [ ] Run and record the full matrix with required DB variables set: root `npm test`, `npm run test:integration`, `npm run typecheck`, `npm run contracts:check`, `npm run build`; web `npm test`, `npm run typecheck`, `npm run build`, canonical `npm run test:e2e`, `npm run test:offline`; root `docker build` and `git diff --check`. Use dedicated offline DB and ports, `CI=1`, and the production-test auth settings in `web/playwright.offline.config.ts`. Never report skipped DB suites as passing.
- [ ] State production-build offline tests use Vite preview; they do not prove the final frontend/API deployment artifact. Record warnings separately from failed assertions and infrastructure blockers.
- [ ] Assign retained feature gaps explicitly to I7 follow-up/Phase 4 or G8/G9. Preview-as-player, true content pinning and the broader I7 acceptance demonstration remain open despite narrow Phase 2 completion. Include any owner-approved deferral text rather than widening exceptions by inference.

## Task 3: Responsive, Accessible and Multi-Device Acceptance

**Files:** Modify `web/tests/e2e/gmSessionJourney.spec.ts`, `campaignVisibility.spec.ts`, `campaignJourney.spec.ts`; add `web/tests/e2e/campaignAccessibility.spec.ts` for independent route-level checks; record evidence in the remediation acceptance document. Application CSS/control edits are conditional on reproduced findings only.

**Interfaces:** Reuse shared theme controls, routed GM/player views, existing axe integration and revision-safe commands. Depends on stabilization Task 1; claim/recovery cases join once approved and implemented.

- [ ] Parameterize representative campaign flows for light/dark and 360/768/1280 widths, plus a 320px overflow probe. Exercise create, members, content/Hidden, claim, Session and full-width sheet navigation without mock-only rendering. Test long names/descriptions, empty/loading/offline/permission states and 200% text enlargement.

```ts
await page.setViewportSize({ width: 360, height: 800 });
await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
// Select Follow device through the existing theme control before assertions.
expect(await page.evaluate(() =>
  document.documentElement.scrollWidth <= window.innerWidth + 1,
)).toBe(true);
```

- [ ] Reuse the existing `@axe-core/playwright` pattern; assert WCAG 2.2 AA-relevant automated checks and keyboard navigation/focus restoration. Check dialogs, audience labels, confirmation, resource controls, 44px targets and readable pending/conflict states. Record that axe alone does not prove contrast/touch/text-enlargement acceptance.
- [ ] Extend the two authenticated GM-page conflict proof to co-GM content edits and independent resources: no clobbered acknowledged updates, explicit 409 refresh/retry on shared edits, independent operation on unrelated resources. Use two isolated contexts, not merely two tabs sharing one query cache; retain polling/revision refresh instead of adding websocket/SSE.
- [ ] Arrange owner-assisted Android Chrome and iPad Safari checks in portrait/landscape, touch, virtual keyboard and installed PWA. Record actual OS/browser/device versions and installation/reopening evidence. If devices are unavailable, leave these gates blocked; emulated widths are not replacements.
- [ ] Require human contrast/visual review in both themes with screenshots, long labels and text enlargement. Do not claim the unavailable mockup's exact typography/palette has been validated.

## Task 4: Preserve and Resolve External Release Gates

**Files:** `docs/ui/visual-reference.md`, `docs/ui/reference/`, `Dockerfile`, `src/bootstrap/http.ts`, `src/platform/config.ts`, `web/src/api/client.ts`, `web/src/offline/worker.ts`, `web/build/offline-assets.ts`, `README.md`, `design_v2.md`, and a separately approved deployment/auth implementation plan when decisions are supplied. `web/dist/sw.js` is generated output, never a manual edit target.

**Interfaces:** This task is decision/evidence work until the named external prerequisites are supplied. It must not invent a real OIDC adapter, cloud platform, or media service under the guise of a bugfix.

- [ ] Reference gate: ask for an accessible republished mockup or owner-provided captures; recheck its response, then capture representative views and record approved visual values. If inaccessible, retain the dated blocked status and existing provisional-theme limitations.
- [ ] Authentication gate: ask whether the owner wishes to reopen the production-provider decision. If yes, obtain issuer, intended deployment origin and callback/logout requirements, then write/approve a production auth plan using the existing Identity port. Acceptance must include real provider sign-in/return, concurrent first sign-in yielding one user, expired sessions, revocation and secure sign-out. Do not commit client secrets. If no, keep production blocked and deterministic testing clearly labeled.
- [ ] Deployment gate: inspect the actual Docker artifact and selected production host before writing changes. Prepare a separately reviewed plan to serve built frontend and API together, with SPA fallback excluding API routes, same-origin `/api`, callback routing, CSS/fonts, correct MIME/cache headers and service-worker scope. Acceptance must use the built artifact without Vite dev/preview and prove deep-link refresh, sign-in return and fully offline shell reopening. A successful current Docker build alone does not close this gate.
- [ ] Operational gate: inventory actual health/metrics/logging, SLO dashboards, alerts and backup tooling. Obtain a non-production restore target and test-data backup; execute a restore drill with recovery measurements and an incident runbook exercise. Retain session-burst load budgets; run the existing character/campaign load tests without competing load. Do not run destructive restore drills on development/production data.
- [ ] Playtest gate: after I7b is implemented, schedule one physical-table and one remote session with four players, phone GM/player use, and a separate restricted tablet display. Capture usability/data-loss/disclosure findings and close blockers before public release. Before I7b, two authenticated GM devices can prove I7 behavior, not restricted display security.

## Task 5: Triage Non-Blocking Verification Warnings

**Files:** Tests emitting warnings, initially `web/src/campaigns/CampaignSettings.test.tsx`, `web/src/editor/DocumentEditor.test.tsx`; `web/vite.config.ts` and dependency lockfiles only after demonstrated need and approval for behavior/dependency changes.

**Interfaces:** No production feature. These tasks may follow pre-upgrade blockers; exploitable production security findings take precedence if discovered.

- [ ] Run the full web unit suite and identify exact React `act(...)` warning sources. Use `userEvent`/awaited interactions and resolved deferred work in those tests; do not globally suppress console warnings or add arbitrary sleeps. Require unchanged assertions and passing focused/full suites.
- [ ] Record the current web bundle warning: main JS approximately 679 kB minified / 182 kB gzip at verification. Measure cold-load and installed/offline behavior before recommending route-level splitting. Do not raise the warning threshold merely to hide it. If a measured budget is missed, write a bounded splitting plan preserving service-worker asset caching and deep links.
- [ ] Run `npm audit` and `npm audit --omit=dev` in both root and web packages; record advisory IDs, severity, affected versions, runtime versus build-tool exposure and fixed versions. The Docker install reported four development-inclusive advisories, while its pruned production install reported zero. Triage current results, not historical counts. Never run `npm audit fix --force`; plan minimal compatible upgrades with contracts, builds, browser and offline regression checks.
- [ ] Put confirmed warnings/advisories and their dispositions in the acceptance record. Do not represent warning cleanup as remediation of the actual GM retry or authorization gaps.
