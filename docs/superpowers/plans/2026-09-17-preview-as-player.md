# Preview-as-player implementation plan (content slice)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Implementers never dispatch subagents.

**Goal:** Close the last G7 box (preview-as-player) for the content
surface: a GM picks a member and sees content list + reader exactly as
that member, through the real policy engine.

**Spec:** `docs/superpowers/specs/2026-09-17-preview-as-player-design.md` (binding authority; conflicts resolve against it).

## Global Constraints

- One deployable artifact; no new production service; no new auth machinery.
- The real `canReadContent` policy engine evaluates every preview row —
  never a UI-only approximation, never duplicated policy logic.
- Preview is read-only by construction: no mutation path accepts a preview identity.
- Preview data lives under `["campaigns", "preview", ...]` keys only and is purged on exit/unmount.
- TDD throughout: RED evidence before each GREEN (failing command + output quoted in the report).
- Regenerate contracts (`npm run contracts:generate`) and keep `npm run contracts:check` green.
- Record tested commits, commands, outcomes, and limitations in the Task 3 acceptance record. Chromium-only e2e; no real devices (G9).

## File map

| File | Responsibility |
| --- | --- |
| `src/campaigns/*` (module: follow `previewUpgrade` placement) | Preview projection over the real policy |
| `src/transport/http/campaigns.ts` (+ `.test.ts`) | `POST /campaigns/:id/content-preview` route + contract |
| `docs/contracts/openapi-v1.json`, `web/src/api/schema.d.ts` | Regenerated contracts |
| `web/src/campaigns/CampaignContent.tsx` (+ preview hook/picker) | Picker, banner, preview rendering, purge |
| `web/src/campaigns/api.ts`, `campaignQueries.ts` | Preview query seam |
| `web/tests/e2e/previewAsPlayer.spec.ts` (create) | Two-user exit demonstration |
| `docs/acceptance/gui-2026-09-17-preview-as-player.md` (create) | Acceptance record |

---

### Task 1: Preview projection endpoint (backend)

**Files:**
- Modify: `src/campaigns/` module (place beside `previewUpgrade`), `src/transport/http/campaigns.ts`
- Modify: `src/transport/http/campaigns.test.ts` (contract/matrix tests)
- Modify: `tests/integration/` (one parity test file, e.g. `campaign-content-preview.test.ts`)
- Regenerate: `docs/contracts/openapi-v1.json`, `web/src/api/schema.d.ts` via `npm run contracts:generate`

**Interfaces:**
- Consumes: `canReadContent` from `src/campaigns/policy.ts`; existing content list/reader row shapes; auth hook caller identity; upgrade-previews route pattern (`post_campaigns_id_upgrade_previews` in `src/transport/http/campaigns.ts`).
- Produces (used by Task 2): `POST /campaigns/:id/content-preview`, operation id `post_campaigns_id_content_preview`, in generated client types.

- [ ] **Step 1: Write failing contract tests.** In `src/transport/http/campaigns.test.ts`: GM caller + active-member target → 200 with list rows; member caller → 403; signed-out → 401; non-member target → 404; removed-member target → 404. Run: `npx vitest run src/transport/http/campaigns.test.ts` from root. Expected: FAIL (route absent).
- [ ] **Step 2: Implement the projection.** Module function evaluating existing `canReadContent` with the target's membership; route wiring with GM gate; request body `{ targetUserId, contentId? }`; list shape identical to the member's real list; single-item 404 identical to the real reader. Re-run Step 1 command. Expected: PASS.
- [ ] **Step 3: Parity test.** Integration test: seed GM-only + all-player + selected-player notes; assert preview rows for a member equal that member's real list rows field-for-field (name any excluded volatile fields in the report). Run: `TEST_DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll npx vitest run tests/integration/campaign-content-preview.test.ts --no-file-parallelism` from root (scratch DB if the dev DB is unavailable — never touch another project's postgres). Expected: PASS.
- [ ] **Step 4: Regenerate + verify.** `npm run contracts:generate`, `npm run contracts:check`, `npm run typecheck`, root `npm test`. Expected: all green.
- [ ] **Step 5: Commit.** `git add` only the Task 1 files; `git commit -m "feat(campaigns): add GM-only content preview projection endpoint"`.

---

### Task 2: Preview UI (frontend)

**Files:**
- Modify: `web/src/campaigns/CampaignContent.tsx` (picker + banner + preview rendering; new hook file if the picker exceeds ~80 lines)
- Modify: `web/src/campaigns/api.ts`, `web/src/campaigns/campaignQueries.ts` (preview seam through the injected API + `["campaigns", "preview", ...]` keys)
- Modify: `web/src/campaigns/CampaignContent.test.tsx` (or new test file for preview behavior)

**Interfaces:**
- Consumes: Task 1 endpoint via regenerated `CharactersApi`-style client types (no hand-written response types, no custom fetch); existing `audienceLabel` marks; `useCampaignMembers`-style roster for the picker (active members only).
- Produces (used by Task 3): working preview mode in the Content tab.

- [ ] **Step 1: Write failing UI tests.** GM view: picker lists active members; selecting one shows banner `Previewing as {name}` and hides author/edit/hide/reveal/grant controls; exit restores GM controls; preview cache keys removed on exit (assert via query client). Run: `npx vitest run src/campaigns/CampaignContent.test.tsx` from `web/`. Expected: FAIL (no preview UI).
- [ ] **Step 2: Implement preview mode.** Picker + banner + preview queries + purge-on-exit/unmount. No mutation affordance may render in preview. Re-run Step 1 command. Expected: PASS.
- [ ] **Step 3: Verify.** `npm test` + `npm run typecheck` from `web/`. Expected: green.
- [ ] **Step 4: Commit.** `git add` only the Task 2 files; `git commit -m "feat(campaigns): add preview-as-member mode to the content tab"`.

---

### Task 3: Two-user proof + acceptance (e2e and docs)

**Files:**
- Create: `web/tests/e2e/previewAsPlayer.spec.ts`
- Create: `docs/acceptance/gui-2026-09-17-preview-as-player.md`
- Modify: `docs/superpowers/plans/2026-09-08-gui-integration.md` (G7 box only)

**Interfaces:**
- Consumes: Tasks 1–2; two-context pattern from `web/tests/e2e/gmCoGmConflict.spec.ts`; dev-signin panel; scratch DB + dedicated ports + `CI=1` (global e2e pattern).

- [ ] **Step 1: Write the spec.** `web/tests/e2e/previewAsPlayer.spec.ts`, desktop viewport: owner creates campaign + GM-only and all-player notes through the UI; member context sees only the all-player note; owner enters preview-as-member and asserts the identical visible set (same titles, same audience marks) plus the read-only banner and no author/edit controls; owner exits and asserts GM controls return; member removed → preview entry fails with the error state. `workers: 1`, `retries: 0` untouched.
- [ ] **Step 2: Run to verify.** Fresh scratch DB in compose postgres (`sweetroll_preview_*`), dedicated `BACKEND_PORT`/`WEB_PORT`, `CI=1`. Expected: PASS (any mismatch is a reproduced defect for regression-first repair, never a weakened test).
- [ ] **Step 3: Full verification.** Root `npm test`, `TEST_DATABASE_URL=... npm run test:integration --no-file-parallelism`, `npm run typecheck`, `npm run contracts:check`, `npm run build`; web `npm test`, `npm run typecheck`, `npm run build`; canonical `npm run web:test:e2e` (now including the new spec); `git diff --check`. Record results in the acceptance record with limitations (Chromium-only, no real devices).
- [ ] **Step 4: Write the acceptance record + check the G7 box** with the evidence pointer. Preview stays content-only; broader surfaces remain future work (record, do not implement).
- [ ] **Step 5: Commit.** `git add` only the Task 3 files; `git commit -m "docs(g7): record preview-as-player acceptance and close G7"`.
