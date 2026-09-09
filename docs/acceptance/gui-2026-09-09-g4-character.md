# G4 acceptance (2026-09-09) — polished character play journey

Commits: `8d5f22a` (feat) + `8785c3b` (offline test repair), implemented on
branch `feat/g4-character-journey` (worktree `.worktrees/feat-g4-character-journey`,
since removed) and merged to `main` as a fast-forward. No design change
(`design_v2.md` untouched — no product behavior changed); OD-01 option A
(unlisted/link-only) behavior is unchanged, only its stale offline test was repaired.

## What changed

- `web/src/characters/types.ts`: `CreationVersionEntry`/`CreationVersions`
  derived from `operations["get_characters_creation_versions"]` (was hand-written).
- `CreateCharacter.tsx`: version picker is the primary entry in a shared
  `Panel` — readable `{systemName} {semanticVersion}` labels plus an
  `aria-hidden` short version ID (accessible name unchanged), loading /
  `EmptyState` / error + **retry** (`pickerQuery.refetch()`) states. Manual
  UUID entry is a labeled fallback panel preserving exact-version deep links
  and the unchanged `loadMetadata` path. Entity/name via shared
  `Select`/`FormField`; all submission/retry/recovery buttons are shared
  `Button`s. New i18n keys: `pickVersion.retry`, `pickVersion.manualTitle`,
  `pickVersion.manualHint`.
- `CharacterSheet.tsx`: shared `Button`s for resource bumps, action submits,
  and the roll-details toggle. Sync/offline text, diagnostics, completion
  (keeps `#character-completion` focus id), and projection section chrome are
  intentionally unchanged.
- `web/src/ui/Panel.tsx`: one-line type widening (`className?: string |
  undefined`) for `exactOptionalPropertyTypes` CSS-module use. No runtime change.
- Offline `creation-picker` test repaired (see below); new
  `publishOwnedClone` helper in `test-auth.ts`.

## OD-01 stale-test forensics (pre-existing, not G4-caused)

The offline picker journey timed out waiting for a `"Template: d20 1.0.0"`
button. Trace evidence: `GET /api/characters/creation-versions` → 200,
UI stuck on "Loading…" then the (old) empty state. Cause: seeds are
`access='link'`, `owner_id=NULL`, and `listAuthorizedVersions` (OD-01,
`7726eae`) enumerates owned + `public` only — an empty list for the test
user. The old render maps an empty array to zero buttons, so the timeout
would occur identically without the G4 restyle. Fix: the test publishes an
actor-owned clone via the real System Builder API (link use stays
authorized), selects it through the picker, and asserts the link-only seed
stays unlisted (`"Template: d20 1.0.0"` count 0; clone keeps document name
"D20 System", located by its `span[title=versionId]`).

## Evidence (all on the merged file tree unless noted)

- Worktree: root unit 28 files / 271 passed; web unit 68 files / 760 passed;
  `typecheck` (root + web), `contracts:check`, `git diff --check` clean.
- Integration (`TEST_DATABASE_URL=.../sweetroll`): 13 files / 126 passed.
- Dev-server e2e (isolated DB `sweetroll_g4`, backend 3110 / web 5174):
  `character-sheet.spec.ts` 6/6 — d20/PbtA/pool × 360/1280, keyboard bump,
  axe (serious/critical), no-overflow; acceptance 2, smoke 1, visual 10/10
  (locked baselines byte-identical, no pixel drift). Total 19/19.
- Production offline (isolated DB `sweetroll_i4remed`, backend 3100 /
  preview 4174, fresh `web:build`): 22/22, including the repaired
  versionless-picker → entity → create → deep-link journey.
- Merged-result verification on `main`: root `typecheck` clean; root unit
  28/271 (scoped `--exclude ".worktrees/**"` — unscoped runs crawl the
  removed worktree's `node_modules`, known config limitation); web unit
  68/760 on the final run (one earlier run showed a single failure in the
  known flaky pre-existing router creation test — transient
  `Loading version…`, also noted in the Task 12 report; no product change).

## Deliberate partials / deferred

- `FieldControl` internals, completion-section inputs, and `CharacterTools`
  dialogs keep their existing controls (shared `Select`/`NumberInput` would
  double-label them; projection chrome preserved per plan "render the
  existing server projection").
- Sync/offline/conflict presentation is unchanged (already truthful per
  session states); `SaveStatus` adoption is not claimed.
- Real Android Chrome / iPad Safari, 200% text enlargement, and long
  translated labels were NOT run — remain G9 work.
- E2E/offline evidence PNGs are run artifacts under
  `web/tests/{e2e,offline}/evidence/` and `web/test-results/`; deleted
  before commit, not baselines.
