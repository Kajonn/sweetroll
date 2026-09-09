# TASK (open): CI `web` job fails `npm test` on every push since run 8

## Symptom

`web` (`npm test` in `web/`) fails on CI runs 8, 9, 10, 11 (four straight,
across four different trees); `verify`, `web-e2e`, `web-offline` pass on
run 11. Step duration (~36 s) is consistent with the suite running and a
test failing, but step logs need repo rights and could not be read during
diagnosis (API: 403; check-runs carry no output).

## What was already tried (2026-09-09)

- Hardened two observed flakes and pushed as `9df92eb` (run 11 still fails):
  - `web/src/router.test.tsx` "creates through the router…": synchronous
    `getByRole("Look up version")` raced the metadata pending-label swap;
    now `findByRole`.
  - `web/src/characters/session.test.ts` "never starts a second send…":
    fixed 5 ms sleep raced the IDB/lock pipeline; now `vi.waitFor`
    (file's own convention). Sequential-send semantics preserved.
- Ruled out by local reproduction (~25 full-suite greens, plus targeted runs):
  worker-count flags, 4-core and 1-core `taskset`, `TZ=UTC` (one coincidental
  single-run flake, then green incl. a base-file control run), fresh `npm ci`
  vs stale `node_modules`, `CI=true`, 3× concurrent suites, and the G4
  `CreateCharacter` render change (base-file swap control: 760/760).

## Suspected area

A *different*, rarely-locally-flaky timing test that the slower/shared CI
runner hits reliably — or CI-runner conditions exceeding the 1 s default
`vi.waitFor`/`findByRole` waits. Remaining fixed-sleep races in `web/src`
(not yet hardened): `session.test.ts:770` (5 ms), `:2154/:2188` (10 ms),
`CreateCharacter.test.tsx` several 20 ms sleeps, `listVersions`/`listTemplates`
25 ms, `CharacterRoute.test.tsx:273` (50 ms), plus `setTimeout(0)` yields.

## Next steps for whoever takes this

1. Open Actions → latest run → `web` job → copy the `FAIL …` block (names
   the test; everything above is blind without it).
2. Harden exactly that test (poll/wait instead of fixed sleeps or
   synchronous queries); do not bulk-rewrite all sleeps blind.
3. If the failure is a >1 s stall on CI only, raise that test's timeout
   explicitly rather than loosening the whole suite.
4. Re-push and confirm the `web` job green; CI has been red since run 8,
   so any green run also needs a glance at whether earlier failures were
   the same test.
