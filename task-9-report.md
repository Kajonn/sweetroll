# Task 9 — Fix Round Report: harden character recovery and tools

## Scope
Fix round for all 5 Important + 5 Minor findings against Task 9
(`e7bc777 feat: add character recovery and management tools`). TDD with
red-first regressions for I1/I2/I3/I5. No subagents. Route wiring
deliberately left out (zero-risk only; see Wiring note).

## Fixes
- **I1** `ConflictReview.tsx` — Reapply disabled while
  `snapshot.error?.kind === "invalid"` (Discard stays enabled); new
  `character.conflict.invalidHint` correction copy; confirm dialog names
  dependent queued entries after the selection via
  `character.conflict.confirmDependents` (`{count}`, `{ids}`).
- **I2** `CharacterTools.tsx` MigrationDialog — read-only candidate-values
  summary (target version + definition-ID/value list, empty state) inside
  `aria-label="Migration preview"`, rendered before Commit.
- **I3** — ConfirmDialog Cancel now uses `t("character.conflict.cancel")`;
  minimal Tab-containment trap (`web/src/characters/dialogTrap.ts`,
  shared by ConflictReview confirm + all CharacterTools dialogs);
  dead `DialogShell` deleted.
- **I4** — 26 new `character.tools.*` / `character.conflict.*` keys in
  `messages.ts` (English values identical to the literals they replace);
  all Activity/Export/Migration dialog literals + ConfirmDialog fallback
  now go through `t()`. `aria-label="Migration preview"` kept literal per
  spec.
- **I5** `session.ts` — expired online-attempt branch now deletes the stale
  attempt after setting the block, so post-review re-invocation mints a
  fresh idempotency key; superseded migration-preview commit attempts are
  cleaned when committing a newer `previewId`. Note: deleting a superseded
  preview attempt assumes the old preview can never replay — acceptable
  because only the newest preview is committable, but an ambiguous
  superseded send could theoretically have executed server-side.
- **M1** — selection filtered to live `snapshot.entries` IDs via guarded
  `useEffect` (returns same reference when unchanged; no render loop).
- **M2** — Commit additionally disabled when
  `preview.sourceRevision !== confirmed` revision, with
  `character.tools.migrationStale` re-preview hint.
- **M3** — `ConflictReview` takes optional `now?: number` (defaults to
  `Date.now()`); ExportDialog shows explicit
  `character.tools.exportBlocked` hint instead of an implicit offline block.
- **M4** — `DialogShell` deleted; double-render reapply test collapsed to a
  single render; dead `readySnapshot()` guard deleted.
- **M5** — export anchor appended to `document.body` and removed in
  `try/finally` (outer `finally` still revokes the object URL).

## Wiring note (left unwired, no scope creep)
`ConflictReview`/`CharacterTools` still have zero consumers outside tests
(grep `web/src` confirms). No route integration was added; wiring remains
for Task 8 / route integration. Ledger: wire + smoke-test on the character
detail route when that task lands.

## Evidence
- Red first: 12 new regression tests failed pre-fix (5 ConflictReview, 5
  CharacterTools, 2 session), 67 pre-existing passed — exact set, no
  collateral failures.
- Post-fix focused: `vitest run
  src/characters/ConflictReview.test.tsx
  src/characters/CharacterTools.test.tsx src/characters/session.test.ts` →
  3 files, 79/79 passed.
- Full `npm run web:test` → 55 files, 450/450 passed.
- `npm run web:typecheck` → clean (no output).
- Two test-side corrections during green (not implementation bugs):
  invalid-case test selects before asserting Discard; injected-clock test
  uses `getAllByText` (expired banner + per-entry marker both match).
