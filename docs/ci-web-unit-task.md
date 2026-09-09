# CI `web` failures — diagnosed and fixed

## True cause (not flakes)

CI pasted log: `FAIL src/preview/sampleData.test.ts — Failed to resolve
import "json-canonicalize" from
"../src/systems/implementation/package/canonical.ts"`.

Chain: `web/src/preview/sampleData.test.ts` and `PreviewSheet.test.tsx`
import fixtures from ROOT `src/systems/...` (introduced in `1aa95d9`;
first present in run 8's tree — run 7 was green, runs 8+ red). Root
`canonical.ts` imports `json-canonicalize`, a root-only dependency. The
`web` CI job installed only `web/` dependencies, so root `node_modules`
was absent and the import was unresolvable. Local checkouts always have
root `node_modules`, so upward resolution hid it locally every time.

Reproduced locally by moving root `node_modules` aside and running the
web suite: identical `FAIL … json-canonicalize` errors in both preview
test files; restored immediately after.

## Fix

`.github/workflows/ci.yml`, `web` job: added root `npm ci` before the
`web/` install — mirroring the `web-e2e`/`web-offline` jobs, which always
had it. Docs/CI-only change; no product or test code touched.

## Earlier flake hardening (kept, still valid)

Commit `9df92eb` hardened two genuine timing races observed locally
(router lookup-button label swap → `findByRole`; session 5 ms sleep →
`vi.waitFor`). Those were real but incidental to the deterministic CI
failure. Full web suite repeatedly green locally (760/760).

## Watch

Next CI run should go fully green. If `web` fails again, copy the new
`FAIL` block — do not re-chase the flake theory without it.
