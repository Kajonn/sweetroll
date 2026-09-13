# Runtime and Test Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the confirmed GM revision-readiness bug and make the complete browser suite reliable locally and in CI.

**Architecture:** Keep command/read coordination within `SessionCharacterRow` and its controls, not a new session engine. Isolate browser journey and visual databases at test orchestration boundaries; run all journeys in CI without weakening assertions or concurrency budgets.

**Tech Stack:** React 18, TanStack Query, Vitest/Testing Library, Playwright, PostgreSQL, Node child processes, GitHub Actions.

**Spec:** `design_v2.md` Sections 8, 11.4, 12.2, 17.1; I7 GM spec Errors/conflicts and Testing/acceptance; [remediation index](2026-09-12-remediation-index.md), R1-R5.

## Global Constraints

- Proposal only. No backend authorization or production behavior beyond the stated readiness repair changes.
- Keep `npm run test:integration` with `--no-file-parallelism`; keep Playwright `workers: 1` and `retries: 0`.
- Keep real routed screenshots, existing baselines, exact-version fixtures, and actor/account teardown behavior.
- A known-success mutation followed by a failed read must be reported as a refresh failure, not a failed mutation to replay.
- Explicit retry after a definite 409 uses a fresh idempotency key only after rereading. Do not add automatic command retry or weaken uncertain-outcome handling.
- No broad hooks/component extraction. Keep new orchestration scripts test-only. Follow the index's commit and evidence constraints.

---

## Task 1: Make GM Commands Wait for a Usable Revision

**Files:** Modify `web/src/campaigns/SessionBoard.tsx`, `web/src/campaigns/SessionBoard.test.tsx`, `web/src/i18n/messages.ts`, `web/tests/e2e/gmSessionJourney.spec.ts`.

**Interfaces:** Keep existing `CharactersApi.open`, `bumpCharacterResource`, and `executeCharacterAction`. Change the row-local refresh callback from `() => void` to `() => Promise<void>`; coordinate a shared per-character busy/readiness flag across resource and action controls because they use the same revision.

- [ ] Add deferred-read component regressions using the existing `sheet()` fixture and QueryClient wrapper. Initial sheet revision is 7; successful bump advances the mocked read to 8. Before resolving that read, assert every mutation control for the same character is disabled and another click makes no second POST. Add the analogous 409 path and ensure the ready-to-retry notice is absent while loading.

```tsx
let resolveRefresh!: (value: { character: ReturnType<typeof sheet>; requestId: string }) => void;
const refreshing = new Promise<{ character: ReturnType<typeof sheet>; requestId: string }>(
  (resolve) => { resolveRefresh = resolve; },
);
// In the existing test setup, replace the open mock sequence:
charactersApi.open.mockReset()
  .mockResolvedValueOnce({ character: sheet(), requestId: "initial" })
  .mockReturnValueOnce(refreshing);
fireEvent.click(await screen.findByRole("button", { name: /increase health/i }));
await waitFor(() => expect(charactersApi.open).toHaveBeenCalledTimes(2));
expect(screen.getByRole("button", { name: /increase health/i })).toBeDisabled();
expect(screen.getByRole("button", { name: /roll strike/i })).toBeDisabled();
await act(async () => resolveRefresh({ character: sheet({ revision: 8 }), requestId: "fresh" }));
await waitFor(() => expect(screen.getByRole("button", { name: /increase health/i })).toBeEnabled());
```

Import `act` and `waitFor` from Testing Library. Finish the test with a new click asserting `expectedRevision: 8` and a new key. Repeat with a rejected refresh, explicit Refresh, offline transition, and unmount during the read; a rejection must never display “Reloaded”.

- [ ] Run `npm --prefix web test -- src/campaigns/SessionBoard.test.tsx`. Confirm the new disabled/readiness assertions fail on the current code.
- [ ] Implement row-owned readiness. Await `sheet.refetch({ throwOnError: true })` rather than discarding its promise; disable all same-character mutation controls while a mutation or required refresh is in progress. Distinguish mutation success, definite conflict, and refresh failure. Preserve the row and an explicit Refresh action after refresh failure, but do not enable stale mutation handlers. Clear readiness only once the returned sheet revision is applied to rendered controls. Do not merely move `setPending(false)` while leaving sibling buttons active.

```ts
// Row-local callback contract; callers await it and handle read failures separately.
const reloadSheet = async (): Promise<void> => {
  await sheet.refetch({ throwOnError: true });
};
// Shared rendering condition, in addition to existing resource bounds:
// disabled = !online || commandPending || refreshPending || !revisionReady
```

- [ ] Replace the browser test's intentional rapid-double-click race. Once commands are gated, that double-click must no longer generate a conflict. Use a second authenticated GM browser page to open the same character, bump through its UI, then issue the first page's stale command. Coordinate any intercepted GET with a deferred promise, not a 2.5-second sleep. Prove 409, visible refreshing state, disabled controls, release of the current GET, rendered updated resource value, then a successful explicit retry. Register response listeners before actions and assert the retry request's fresh revision/key. The primary journey remains UI-driven.

```ts
await expect(page.getByRole("button", { name: "Decrease Health" })).toBeDisabled();
// Release the deferred refresh here, then wait for rendered state, not only response headers.
await expect(page.getByText("9 / 10")).toBeVisible();
await expect(page.getByRole("button", { name: "Decrease Health" })).toBeEnabled();
```

- [ ] Run the component suite, `npm run web:typecheck`, and the two viewport browser cases with `--repeat-each=5` against a dedicated database. Verify mutations remain exactly-once and both layouts pass. Retain the existing live-max regression. Record browser resources and commands in the acceptance record from the acceptance plan.

## Task 2: Repair the Campaign Audience Assertions

**Files:** Modify `web/tests/e2e/campaignJourney.spec.ts`.

**Interfaces:** No application/API change. Existing content list is `getByRole("list", { name: "Campaign content" })`; reader content remains a separate assertion surface.

- [ ] Run the existing journey and preserve the strict-mode failure at lines 190/193 as the red regression.
- [ ] Scope the list assertion and the opened reader assertion separately. Do not use `.first()`, disable strict mode, or assert the hidden `<option>`.

```ts
const contentList = page.getByRole("list", { name: "Campaign content" });
await expect(contentList.getByText("All players", { exact: true })).toBeVisible();
await contentList.getByRole("button", { name: `Open ${noteTitle}` }).click();
await expect(page.getByText(noteBody, { exact: true })).toBeVisible();
await expect(page.locator("p").filter({ hasText: /^All players$/ })).toBeVisible();
```

- [ ] Rerun the entire journey twice and verify activity and leave/purge assertions now execute. This task does not claim to fix ordinary-player claiming: retain the recorded co-GM limitation until the claim plan replaces that fixture.

## Task 3: Isolate Browser Fixtures Without Bypassing Product Retention

**Files:** Create `web/scripts/run-e2e.mjs` and `web/scripts/run-e2e.test.ts`; modify `web/package.json`, `web/playwright.config.ts`, `web/tests/e2e/visual.spec.ts`, `README.md`. Inspect cleanup in `web/tests/e2e/creatorToCharacter.spec.ts`, `acceptance.spec.ts`, and GM journeys; change only demonstrated faulty cleanup expectations.

**Interfaces:** Canonical `npm --prefix web run test:e2e` becomes the orchestration entry point. Its required `E2E_DATABASE_ADMIN_URL` is a test-service connection with CREATE DATABASE permission, not a database to reset. Child Playwright processes receive `DATABASE_URL`, `CI=1`, and `SWEETROLL_E2E_SUITE=journeys|visual`. Direct `npx playwright test` remains available for targeted investigation with caller-managed test resources.

- [ ] Reproduce the order effect by running creator/campaign journeys then library screenshots in one disposable database; run visual alone in another. Preserve the images showing leftover system names. Check cleanup HTTP status codes: published/character-referenced systems may legitimately resist deletion; never add a product delete bypass to make tests clean up.
- [ ] Add runner tests proving distinct run-scoped database names, journeys excluding `visual.spec.ts`, visuals including only that file, both child suites executing even if the first fails, nonzero combined exit on either failure, and cleanup limited to databases successfully created by this invocation. Use Node/Vitest child-process and pg stubs with `// @vitest-environment node` in the runner test; do not expose a production database-management module. Define a test-importable `runE2e()` in the script and a guarded CLI entry so importing it cannot provision a database.
- [ ] Implement sequential isolated runs. Use root-installed `pg`, Node `crypto.randomUUID`, and `child_process.spawn` with inherited output. Generate safe identifiers from a fixed prefix plus hex suffix. Create one journey DB and one visual DB; migrate through the existing Playwright webServer command. In `finally`, close child processes/connections and drop only the exact databases recorded after successful creation. Missing admin URL or CREATE DATABASE permission is a clear setup error, never a skipped suite. Do not drop/empty the database named by the admin connection.

```js
const suffix = randomUUID().replaceAll("-", "");
const names = {
  journeys: `sweetroll_e2e_j_${suffix}`,
  visual: `sweetroll_e2e_v_${suffix}`,
};
// For each suite: CREATE DATABASE with the generated identifier, replace
// only the URL pathname, spawn local Playwright with suite env, await exit.
// Aggregate failures; always attempt the second suite and scoped cleanup.
```

```ts
// In playwright.config.ts, preserve one worker, zero retries and real webServers.
testMatch: process.env.SWEETROLL_E2E_SUITE === "visual"
  ? "**/visual.spec.ts" : "**/*.spec.ts",
testIgnore: process.env.SWEETROLL_E2E_SUITE === "journeys"
  ? ["**/visual.spec.ts"] : [],
```

- [ ] Give each phase a distinct output directory under ignored `web/test-results/`, including a run identifier; preserve failure traces after database cleanup. Honor termination without leaving a serving child; forward user test-selection flags explicitly and document that repeat counts must not exhaust the bounded catalog with accumulated fixtures. Do not forward one `--output` path to both phases.
- [ ] Treat no-tests-matched as an error in the canonical full run. For targeted direct Playwright repeats, provision enough isolation that old clones cannot push the selected version past the first catalog page; use exact version matching and supported pagination rather than silently switching to a different fixture. Keep database passwords out of setup error text and child-command logging.
- [ ] Assert the visual library's expected empty personal list before taking screenshots; keep the route and real API. Run the canonical full command twice from the same shell using the same admin service and prove both runs start fresh. Run runner unit tests, full web unit tests, and typecheck. No baseline regeneration is expected for this task.

## Task 4: Require the Whole Browser Suite in CI

**Files:** Modify `.github/workflows/ci.yml` and `README.md`; consume the Task 3 runner.

**Interfaces:** Existing PostgreSQL service supplies the test-only admin URL. Existing offline job remains independent. Dependencies: Tasks 1-3 green; include newly added claim/recovery/visibility specs when those plans land.

- [ ] Compare `npx playwright test --list` with the existing CI four-file allowlist to demonstrate the omitted campaign/GM cases.
- [ ] Replace that allowlist with the canonical runner. Keep root/web installs and browser installation. Supply `E2E_DATABASE_ADMIN_URL` from the existing CI PostgreSQL service, the existing roll secret, and `CI=1`; do not copy production credentials. Remove redundant migration of an unused shared browser DB.

```yaml
- run: npm run test:e2e
  working-directory: web
  env:
    E2E_DATABASE_ADMIN_URL: postgres://sweetroll:sweetroll@localhost:5432/sweetroll
- uses: actions/upload-artifact@v4
  if: failure()
  with:
    name: browser-failure-evidence
    path: web/test-results/
    retention-days: 7
```

- [ ] Retain offline, root/web unit, contracts, typechecks, Docker build, integration serialization and load budgets. Keep traces restricted to deterministic test data and the existing repository's artifact access; never log invitation tokens or cookies.
- [ ] Locally run the exact CI browser entry point. In a disposable branch when CI execution is authorized, deliberately fail a campaign assertion and verify the check fails and uploads evidence; remove the deliberate failure and verify green. Do not claim remote CI evidence if `gh`/remote access remains unavailable.
