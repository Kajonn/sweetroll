# Personal adventure entries — 2026-10-07

Scope: PR #17, slice A of the adventure-specific custom items plan. Campaign templates, inherited actions, restricted audiences and proposals remain planned.

## Local verification

- Validation regressions were run red before the server implementation, then passed: bounded text, unknown keys, all four slot kinds, name-only backward compatibility and action refusal.
- Server unit suite: 387 passed, 9 database tests skipped without `TEST_DATABASE_URL`. First parallel run timed out in an unchanged campaign HTTP test; rerun with two workers passed.
- Web unit suite: 1,112 passed before the final failure-form regression. Final focused personal-entry/session run: 111 passed (101 session, 10 component).
- Both TypeScript checks and `node --import tsx scripts/generate-system-contracts.ts --check` passed. The standard contracts CLI cannot open its Unix IPC pipe in this workspace; using the Node import entry point runs the same check successfully.
- Production web build passed. Contracts use the existing values/quantity wire fields, without a new endpoint or schema shape.
- A focused session run initially hit an existing uncertain-500 timing assertion; the complete suite subsequently passed without changing that assertion.

## Added acceptance coverage

- Real PostgreSQL character lifecycle test: personal add, idempotent retry, outsider denial, stale update, successful update, export, remove and retained activity.
- Existing dynamic-objects browser journey expanded with personal description/notes/quantity, edit/reload and offline personal add/reconnect exactly once.
- Component tests: creation, legacy name-only editing, details/quantity edits, positive quantity gating and failed save retaining data.
- Offline session test: personal details and quantity persist into the frozen request and drain on reconnect.

## CI repair and Railway acceptance follow-up

CI #86 exposed a test expectation error in the personal-entry PostgreSQL lifecycle regression: a replayed response correctly sets `reconciliation.replayed: true`. The test now compares the complete response while accounting for that documented marker; production idempotency behavior is unchanged.

Tested code commit: `f2896a8f25f862fab9c0c8d71269c92de8bc5744`. CI #87 passed 397 server tests and 351 integration tests, plus TypeScript/contracts checks and the Docker build. Web, visual and offline jobs passed. The remaining browser failure and deployed GUI findings are recorded below.

Deployment target: isolated Railway project `sweetroll-items-preview`, service `sweetroll-items`, with its own `preview-postgres` database. Source pinned to the tested commit; production/acceptance sources in `proactive-expression` are unchanged. Deployment `e38094aa-c414-4ad1-8da7-bb007068d475`.

### Deployed GUI journey

Remote Chromium, existing signed-in preview test account, desktop viewport, Follow device/light appearance. Railway build and `/health/ready` succeeded for the pinned commit above.

1. Duplicated the existing Longsword Test Hero into a separate acceptance character. The original hero was not edited.
2. Added **Tower key acceptance** via Inventory → Custom entry, description **Opens the ancient tower gate.**, notes **Found by Ada — keep safe.**, quantity **3**. The saved sheet showed origin **Personal** and all details.
3. Opened Edit entry: quantity **0** disabled Save entry. Changed quantity to **2** and notes to **Used once — two keys remain.**; saved and reloaded. The details and ×2 persisted.
4. Used existing Longsword Attack (`d20 + Might`, Might 5, total 25) and Longsword Damage (`d8 + Might`, total 7). Both returned authoritative results.
5. Removed the personal key using the confirmation dialog. It left the inventory. Activity retained **Entry added**, **Entry updated**, both **Action used** events and **Entry removed**, plus the duplicate event.

A screenshot was captured after edit/reload and saved privately for the user. Automatic approval review rejected uploading preview-account/character imagery to GitHub, so it is deliberately excluded from this repository.

Deployment observation: the prior offline service worker intentionally kept the old frontend while its tab stayed open. Closing and reopening the preview activated the new build; this follows the existing coherent-build/no-skipWaiting policy. No app or deployment failure was observed.

CI #87's final shard initially timed out during Ubuntu package-mirror dependency installation, before running application tests. Only that shard was retried. Its retry ran the application tests and exposed a deterministic locator failure in `dynamicObjects.spec.ts`: after opening a populated personal-entry editor, exact `getByLabel("Notes")` included the textarea's initial text (`Found by Ada`) in the wrapping label text and could not resolve. It waited until the 240-second test timeout; context teardown then masked the original failure with “Failed to find context.”

The journey now uses accessible textbox names for description/notes during both online and offline creation and editing. It asserts the stored description and notes before editing, so missing or incorrectly hydrated fields fail at that step. A focused component regression opens an entry with both textareas already populated, finds their accessible names, edits notes and checks the complete update payload. The journey retains its existing timeout, zero retries, edit/reload and exactly-once offline assertions. No runtime or design behavior changed. Focused component tests: 11 passed; web TypeScript check passed. The PR pipeline verifies the new commit; its result will be recorded in the PR description.

Live offline toggling, GM/co-GM-specific acceptance, concurrent browser conflict and physical Android/iPad remain unclaimed; automated offline/conflict/authorization coverage is separate from this GUI journey.
