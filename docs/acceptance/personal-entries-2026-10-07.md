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

## Release gates

Push was rejected by automatic approval review because it required explicit authorization to upload committed source changes. No new CI run was triggered; database and browser results remain pending. No deployed GUI, physical Android or iPad Safari result is claimed. GM/co-GM personal-entry acceptance and a concurrent browser conflict remain open. No production deployment or Railway source change is included.
