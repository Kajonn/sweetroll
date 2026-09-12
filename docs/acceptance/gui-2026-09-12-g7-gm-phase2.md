# G7 GM content/session Phase 2 acceptance (I7 exit demonstration)

Date: 2026-09-12. Branch `feat/i7-gm-phase2-content-session`. Tree: Task 4
closeout (`web/src/campaigns/CampaignDetail.tsx` hoisted roster + GM-gated
Session tab + Content tab GM props + session-key revocation purge,
`campaign.detail.tabs.session` i18n key, `CampaignDetailRouteView`
charactersApi pass-through, `web/src/campaigns/CampaignDetail.session.test.tsx`,
`web/tests/e2e/gmSessionJourney.spec.ts`, the ContentEditor delete-receipt
fix below, and this note, committed together as the Task 4 closeout change).
Only checks actually run are listed; anything not listed was not run.

## Exit demonstration (new, Task 4)

`web/tests/e2e/gmSessionJourney.spec.ts` — "I7 exit: GM content and session
through UI", parameterized over viewports 360×640 and 1280×800 (one test per
viewport, same flow). Chromium headless:

1. GM seeding as `code-test-a` (isolated context, real HTTP): actor-owned
   d20 clone published through the real System Builder API (clone → save
   draft unchanged → publish 1.0.0), because the seeded reference templates
   are link-access/unlisted (OD-01) and versionless enumeration never offers
    them; no other writes provisioned; read-only GETs for catalog/directory.
2. GM `code-test-a` via the dev sign-in panel (code field filled) creates
   the campaign entirely through the UI: `/campaigns/new` → select the
   seeded clone version → title `G7 GM Session <uid>` → Create campaign →
   detail opens at `/campaigns/:id` with the campaign heading.
3. `/campaigns` lists the newly created campaign (fire-and-forget
   list-invalidation from Phase 1 Task 3 — follow-up confirmation) → open
   it back up.
4. Content tab as the owner: the GM create form authors a note with the
   `all_players` audience → `Note saved.`, list mark `All players`.
5. The note is narrowed to `selected_players` with a grant to the GM's own
   roster row (checkbox labelled by the short user-id prefix) → list mark
   `Selected players`.
6. Fresh detail load (the edit editor holds the pre-save revision, so a
   revision-guarded Hide from it would correctly 409 — the same re-read
   discipline the Phase 1 e2e uses), re-open the note, Hide behind the
   confirm dialog → the editor stays mounted on the deleted view with its
   working Recover button (Task 2 deleted-view retention, now backed by
   the delete receipt — see fix below).
7. Recover behind the confirm dialog → dialog closes, the list shows the
   restored note (`Selected players`) again.
8. Characters tab: a campaign character is created through the UI (name +
   system version ID + Load entity options + entity `character` + New
   campaign character). Success opens the new sheet through the
   `onOpenCharacter` seam; the flow heads back to the campaign detail.
9. Session tab (GM-only): `Latest content` shows the recovered note,
   `Recent activity` shows the authoring events (`Content created` et al.),
   the `Characters` directory lists the new hero.
10. Expanding the hero loads the sheet (Health 10/10, Check roll action —
    its only input is optional, so the board offers Execute rather than
    the open-sheet path).
11. Health is bumped down through a deterministic 409: a 2.5s route delay
    on the character GET keeps the first bump's sheet refetch in flight,
    so the immediate second bump carries the stale revision and the
    server answers 409 → `Health changed. Reloaded — retry the bump.`;
    the retry (fresh revision, fresh key) lands 10 → 9 → 8 (`8 / 10`).
    Decreases, not increases: Health starts at its 10/10 bound and the
    server 422s an up-bump as out of bounds (see findings).
12. Check is rolled with the default `campaign` audience: the request
    carries `audience: "campaign"` on the wire, and the board shows its
    generic uncertain-outcome notice (structured roll objects are never
    stringified into result text — kind-agnostic rendering discipline).

## Gates actually run (2026-09-12, this tree)

From `web/` (env
`CI=1 DATABASE_URL=postgres://sweetroll:sweetroll@localhost:5432/sweetroll_e2e
AUTHORITATIVE_ROLL_SECRET=development-only-roll-secret-32-bytes`; Playwright
started its own backend `npm run migrate && npm run dev:http` + `npm run web:dev`
per `playwright.config.ts`):

- `npx playwright test tests/e2e/gmSessionJourney.spec.ts` — **2/2 pass**
  (22.7s total; 360×640 and 1280×800).
- `npm run test` — **93 files / 910 tests pass** (includes the new
  `CampaignDetail.session.test.tsx`: owner sees the Session tab, player
  does not — TDD RED verified first, no Session tab before wiring; and
  the new ContentEditor delete-receipt test — TDD RED verified first,
  Recover used the stale revision before the fix).
- `npm run typecheck` — clean.

From repo root:

- `npm run contracts:check` — pass.

Browser/device/theme matrix actually run: Playwright Chromium headless only,
viewports 360×640 and 1280×800. Theme: default (light in headless) — no
dark-mode e2e in this task. No real-device runs (see limitations).

## Fix required by the exit flow (Task 2 defect)

`ContentEditor.attemptDelete` retained the deleted view by re-reading via
`openContent`, but `openContent` 404s on deleted rows by backend contract —
so the fallback always kept the stale pre-delete revision and the
in-session Recover always 409'd. The DELETE `/content/:id` receipt already
carries the deleted view at its fresh revision (OpenAPI `delete_content_id`
200 schema), so the editor now retains the receipt's view (runtime-narrowed:
matching contentId, `deleted` status, numeric revision), keeping the
re-read as a secondary path and the stale fallback last. Frontend-only:
`DeleteContentResponse` type + `deleteContent` signature in
`web/src/campaigns/{types,api}.ts`; no backend/schema change; fresh keys
and 409 discipline untouched. Pinned by the new unit test (receipt used
when re-read 404s; pre-existing re-read test still passes for the other
path).

## Fixture

Per-run owned d20 clone (name kept "D20 System", 1.0.0) via API; unique
`G7 GM Session <uid>` / note / hero names per viewport run (no
campaign/character DELETE endpoint; shared `sweetroll_e2e` DB). GM
`code-test-a` only — no invitee in this flow (the selected_players grant
targets the GM's own roster row). The seeded version is located through
the same `creation-versions` catalog (limit 25) the UI reads, and the nth
same-label button is clicked (prior runs leave same-named clones in the
shared DB). Dev sign-in panel used (dev server), so no
`SWEETROLL_TEST_AUTH` escape hatch was needed. Tokens: none in this flow
(no invitations). Idempotency keys caller-minted fresh per attempt.

## Screenshots

None taken (the spec captures no screenshots; all assertions are DOM/text
based). Failure-trace screenshots taken during development confirmed the
Session tab rendered and the hero row listed before the assertions were
corrected (see findings).

## Findings

- During development the e2e first failed asserting `All players` after
  the save: `getByText` matched the hidden Audience `<option>`, not the
  list mark. Audience-mark assertions are scoped to the `Campaign content`
  list. No implementation change.
- The edit editor holds the pre-save revision, so Hide-from-it after a
  save 409s by design; the spec reloads and re-opens the note first (same
  re-read discipline as Phase 1). No implementation change.
- Recovery reports through the parent (dialog closes, list restores), not
  a "Note saved." flag — the spec asserts that. No implementation change.
- Character creation navigates to the new sheet via `onOpenCharacter`; the
  spec asserts that URL/heading, then returns to the detail for the
  Session tab. No implementation change.
- `page.locator("select")` counting broke on the theme dropdown: the spec
  waits for the `character` entity option instead, with loader retries.
  No implementation change.
- The hero name renders twice per directory row (span + Open button): the
  spec asserts the Open button (strict-mode). No implementation change.
- Board Increase stays enabled at Health 10/10 (disabled only at element
  min/max 0/30) while the server 422s the up-bump as out of bounds; the
  spec dances down (10 → 9 → 409 → 8) instead. Pre-existing UI/server
  bound mismatch, out of this plan's scope — recorded, not changed.
- Board roll rendering never stringifies structured roll objects (only
  string/number results render as text); the spec asserts the
  uncertain-outcome notice plus the wire audience. No implementation
  change (malformed_response discipline).
- `design_v2.md` §17 untouched: Session wiring matches the plan (hoisted
  `useCampaignMembers` with identical params → deduped request, GM gate
  on owner/co_gm, optional generation/online props, `["campaigns",
  "session", campaignId]` prefix purge on revocation).

## Limitations (open)

- Production OIDC: no real-provider validation (owner decision); GM
  sign-in proven on seeded dev codes only.
- No physical phone/tablet runs, no standalone install proof, no
  dark-mode runs; phone coverage is the 360×640 Chromium viewport only.
- Full e2e suite (other specs) not re-run in this task; change surface is
  the campaign detail route (one new GM tab, additive i18n key, one new
  optional prop), the ContentEditor delete path (receipt retention), and
  the `deleteContent` response type (now contract-accurate).
- E2E ran against a shared `sweetroll_e2e` Postgres (unique names per
  run; prior runs' campaigns/clones remain but are selected by exact id,
  so they do not interfere).
