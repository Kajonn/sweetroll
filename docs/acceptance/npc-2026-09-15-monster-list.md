# Acceptance: NPC/monster list slice (2026-09-15)

Slice: entity `kind` → creation-options → campaign NPC section (plan
`docs/superpowers/plans/2026-09-15-npc-monster-list.md`, spec
`docs/superpowers/specs/2026-09-15-npc-monster-list-design.md`, approach 1).
Branch `feat/npc-list`, base `757fb40169bc20c5e15db2c474d28911569f2b9b`.

## Tested commits (Tasks 1–4, all reviewed: spec ✅ / Approved)

- Task 1 `91a32c0844b7a77cbdece0766fe2ea0171dd13b3` — "feat(systems): add optional playable/npc entity kind"
- Task 2 `c81c426ac6cb14f35d61de5ab5d48e2b908f3402` — "feat(characters): carry playable/npc entity kind into creation-options"
- Task 3 `15f12a14852ad9805a6d0128d208c36339a3fc29` — "feat(creator): playable/NPC entity kind toggle"
- Task 4 `9477861eede3857e5dda3448c0a384109ff2f1f3` — "feat(campaigns): searchable NPC/monster section with client-side filter"

## Per-task commands + outcomes (from task reports, in worktree)

- Task 1: `npx vitest run src/systems/implementation/package/schema/document.test.ts` —
  red 1 failed / 17 passed pre-fix (accepts test; the new rejects row passed
  vacuously pre-fix via `additionalProperties: false`, corrected expectation),
  green 18/18 post-fix; `npm test` 29 files / 322 passed / 322.
- Task 2: `npx vitest run src/systems/runtime.test.ts` — red 2 failed / 40 passed
  → green 42/42; `tests/integration/character-creation-options.test.ts` 7/7
  (red shown via stash round-trip: old kind-less assertions vs new DTO,
  1 failed / 6 skipped); `npm test` 29 files / 323 passed / 323;
  `npm run contracts:generate` + `npm run contracts:check` PASS (`kind` in
  `openapi-v1.json` creation-options entities as required `["id","label","kind"]`
  + playable/npc anyOf, and in `web/src/api/schema.d.ts`).
  Ruling (carried): required DTO `kind` stands — server always emits it
  (runtime defaults `?? "playable"`), frontend+API ship lockstep (design §11/G9);
  a new client against an old server would fail creation-options validation.
- Task 3: `npx vitest run src/editor/EntityList.test.tsx` (from `web/`) — red
  2 failed / 13 passed → green 15/15; `npm test` (web) 102 files /
  1033 passed / 1033, twice consecutive after one unrelated `AppShell` settle
  flake (19/19 in isolation); `npm run typecheck` (web) clean.
  Adaptations: toggle assertion rewritten (brief's verbatim
  `objectContaining`-around-array never matches; same values via file's
  `find`+`toMatchObject` idiom) and conditional spread for
  `exactOptionalPropertyTypes` (absent stays absent = playable).
- Task 4: `npx vitest run src/campaigns/CampaignCharacters.test.tsx` — red
  2 failed / 9 passed → green 11/11; `npm test` (web) 102 files /
  1036 passed / 1036; `npm run typecheck` (web) clean; exit e2e
  `tests/e2e/npcListJourney.spec.ts` 1 passed (5.1s) on scratch DB
  `sweetroll_hard_npc` (ports 3116/5186), Chromium-only.
  Adaptations: kind-map `useQuery` before status guards (hooks rules);
  e2e appends the npc entity (d20 ships a single entity).

## Task 5 full verification (fresh, worktree HEAD `9477861` + docs-only plan copy)

- Root `npm test`: PASS — 29 files, 323/323.
- Root `npm run typecheck`: FAIL (exit 2) — 1 error,
  `src/transport/http/characters.test.ts(158,34)`: `makeCharacters` helper mock
  returns kind-less `entities`, missing required `kind`. Pre-existing committed
  branch state (file unmodified vs HEAD; Task 2 fixed the route-specific mock
  but missed this shared helper; no task ran root typecheck after Task 2).
  Product fix required → new task, out of scope for this record-only task.
- Root `npm run contracts:check`: PASS.
- Root `npm run build`: FAIL (exit 2) — same single tsc error as typecheck.
- Web `npm test`: PASS — 102 files, 1036/1036 (first run green, no flake).
- Web `npm run typecheck`: PASS — clean.
- Web `npm run build`: PASS — built in ~3s (chunk-size warning only).
- `git diff --check`: PASS — clean.

 Revised verdict: matrix GREEN after the one-line stub fix — root `npm run typecheck` exit 0, `characters.test.ts` 36/36, root `npm test` 29 files 323/323, `contracts:check` PASS. Slice ACCEPTED with the recorded limitations below.
 History: pre-fix matrix was RED (root typecheck + build exit 2 on the kind-less `makeCharacters` mock at `characters.test.ts(158,34)`), fixed by adding `kind: "playable"` to match the server default.

## Limitations

- E2e Chromium-only; no real devices; scratch-DB dev-server runs only.
- Fail-closed kind resolution (`catch → []`, offline → no query): NPC section
  silently hides when creation-options is unreachable.
- First-load offline is silent: the `npc.offline` status line only shows once
  kinds have resolved at least once (`CampaignCharacters.tsx:301-304`).
- Deferred minors (follow-ups, none gate-blocking): T3 `toMatchObject({kind})`
  vs `toBe` (test:64,69), regex testid (test:77), duplicate kind label text
  (EntityList.tsx:118-130), unverified nested-matcher claim (report C1);
  T4 `metadataApi!` assertion (CampaignCharacters.tsx:462), unexercised
  patch-fallback branch (spec:480-482), module-level `createdSystemIds`
  (spec:33).

## Explicit remaining gap

Per-campaign kind overrides are out of scope; preview-as-player untouched
(still open per GUI plan boxes 170/171, G9).
