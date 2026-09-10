# Task 6 Report: Single-Use Invitations and Lost-Response Recovery

**Status:** DONE
**Branch:** `feat/i6-campaign-backend` (worktree `/home/jonas/dev/sweetroll/.worktrees/i6-backend`)
**Commit:** `feat(i6): Task 6 single-use invitations and recovery` (base `1d78031`)
**Date:** 2026-09-10

## What was built

- `migrations/0014_campaign_invitations.sql` (new; 0014 verified fresh): `campaign_invitations`
  (campaign FK CASCADE, issuer FK, `player`/`co_gm` role, UNIQUE `token_hash`,
  `pending`/`accepted`/`declined`/`revoked` status, revision, consuming actor +
  accepted membership generation, expiry) with page index. Hash-only by
  construction: no token column exists.
- `src/campaigns/invitations.ts` (new): `issue/list/review/accept/decline/rotate/revoke`
  owning spec §5/§8 input shapes. 32-byte `randomBytes` tokens (base64url),
  SHA-256 hex hash storage only; audit summaries and receipts carry metadata,
  never token bytes or hashes. Secret-bearing success DTOs (`token`) are
  distinct from metadata-only replays (`tokenUnavailable: true`, no `token`
  property). Review is read-only and returns only campaign identity, pinned
  version, inviter display name, intended role, expiry, invitation revision and
  access revision. Accept/decline requires token + campaign ID + expected
  invitation revision + reviewed access revision (never the admin campaign
  revision); any invitation/access change conflicts into re-review.
  Consumption locks campaign then invitation, so racing actors serialize to
  exactly one winner with a generic `not_found` "This invitation is
  unavailable." for every unknown/revoked/rotated/expired/consumed token.
  Active members get a definite `bad_request` without consuming the token.
  Accept replays confirm only while the same membership generation stays
  active (plus receipt-expiry check), otherwise `result_unavailable`; decline
  replays its own outcome the same way. Revoke is idempotent and never touches
  membership. Expiry resolves default 7d / max 30d / strictly future.
  Rate-limit is a bounded adapter-level per-actor sliding window on
  issue/review/consume (no HTTP mechanism exists in this slice), rejecting
  with `rate_limited` and no secrets in the error.
- Receipt-before-mutation discipline per task-2-report (pre-check outside the
  transaction, re-check after the row lock, `ReceiptRace` rollback + winner
  replay) on all five mutating commands. Same-key issue/rotate replays reload
  live metadata, so a later rotation/revoke is reflected without token bytes.
  Input hashes cover raw client input only: the clock-derived default expiry
  no longer turns exact retries into spurious mismatches (found by test).
- `src/campaigns/index.ts` + `persistence.ts` (wiring only): `Campaigns`
  interface gains the seven commands; module input gains `newToken` and
  `invitationRateLimit`; new `rate_limited`/`result_unavailable` error codes.
  Persistence adds invitation CRUD/lock/list/count/reactivate-or-insert
  membership/display-name/receipt-with-expiry queries; existing functions
  untouched.
- `src/platform/config.ts` + `config.test.ts`: `invitationExpiryDefaultDays`
  (7) / `invitationExpiryMaxDays` (30) with env overrides and
  default-must-not-exceed-max validation.
- `tests/integration/i3-app.ts`: fixture DDL pinned to 0014 (hash-only columns).
- `tests/integration/campaign-invitations.test.ts` (new, 16 tests): issue +
  metadata-only replay + mismatch; co-GM/player/outsider restrictions and
  expiry bounds + archived-issue conflict; review exact-keys/no-leak + generic
  collapse; single-use across actors + winner replay + stale-revision
  conflict; re-review after access change; rotation invalidating the old link
  + lost-rotation recovery; elevation refusal without consumption; decline
  semantics + replay; revoke of pending/consumed + rotate-after-consume
  conflict; two-actor race to one membership; join→leave→re-accept with a NEW
  invitation (new generation, controllers cleared, sheet stays returned,
  old-token and stale-receipt replays fail); archived/expired consumption;
  accept-receipt expiry; rate-limit rejection without token logging; member
  bound; GM-only listing with cursor pages and cross-scope rejection.
- `tests/integration/campaign-membership.test.ts`: the Task 3 SQL-simulated
  rejoin block was replaced with a real invitation-accept rejoin (gen 3 on the
  new accept; stale leave receipt still replays its gen-2 ack; second leave at
  the new revision). The surrounding test is otherwise unchanged — it still
  uniquely covers stale-removal-replay inertness and second-leave sequencing,
  so it was kept and noted here rather than deleted.
- `tests/integration/migrations.test.ts`: campaign table/index/constraint
  expectations extended to `campaign_invitations`, plus a dedicated 0014 test
  (fresh number, exact columns proving hash-only, hash uniqueness, role/status
  rejection, cascade on campaign delete).

## Test summary

- `campaign-invitations.test.ts`: **16/16 passed**; `campaign-membership` +
  `campaigns` + `migrations`: **29/29 passed** (all `--no-file-parallelism`,
  `TEST_DATABASE_URL=postgresql://sweetroll:sweetroll@127.0.0.1:5433/sweetroll`
  via the existing `/tmp` compose override; nonzero row/audit/receipt counts).
- Full integration: **22 files, 236/236 passed**; root `npm test`:
  **284/284 passed** (279 baseline + 5 expiry-config cases); `tsc --noEmit` clean.

## Concerns

- Content grants do not exist yet (Task 7), so "old grants stay invalid" is
  proven for controllers/claim-designation cleanup and non-restoration on
  rejoin; grant invalidation needs its own table before it can be covered.
- The in-memory rate limiter resets on restart and is per-replica; acceptable
  for this backend slice, but a shared store is needed if stateless replicas
  must enforce it jointly (HTTP concern, out of scope — no routes added).
- Review checkpoint for Task 9: the one-time-response exception (token only in
  the initial issue/rotate success, `tokenUnavailable` replays) and the rule
  that no secret enters generic receipt helpers are implemented and tested
  here, but OpenAPI/client contract generation is Task 9's to document.
- Pre-existing worktree modifications (`design_v2.md`, untracked plans doc)
  were left untouched; no design change was made, so no design-doc update.

## Fix round 1/5 (2026-09-10)

Two review findings fixed; nothing else touched (rate limiter, elevation
behavior, newToken override, revision-bump coupling, grants, HTTP/contracts
unchanged).

- I1 (Important): admin replays ignored receipt TTL. `replayAdminMetadata`
  (issue/rotate) and `replayRevoke` now take `loadReceiptWithExpiry` rows and
  return the same documented `result_unavailable` on lapse as
  accept/decline, checked before re-authorization or live-metadata reload.
  All admin receipt loads (pre-check, in-transaction race, `ReceiptRace`
  catch) moved from `loadReceipt` to `loadReceiptWithExpiry` in the
  issue/rotate/revoke paths. The live-metadata reload on a valid receipt is
  unchanged: a current receipt still reflects later rotation/revoke/consume
  without token bytes; only an expired receipt is refused.
- M1 (Minor): access-stale conflicts in accept/decline reported
  `campaign.revision` in `latestRevision`. Both now report
  `campaign.accessRevision` — the revision the caller must re-review
  against. Invitation-stale and all other conflict cursors unchanged.
- Tests (`tests/integration/campaign-invitations.test.ts`, 17 tests): new
  "expires admin receipts so stale issue replays become unavailable" mirrors
  the accept-expiry style (lapse the `campaign_invitation_issue` receipt via
  SQL, same-key replay yields `result_unavailable` with no stale metadata
  and mints no second row); the existing "requires re-review" test now
  asserts `latestRevision` equals the current access revision.

Verification (`TEST_DATABASE_URL=...@127.0.0.1:5433/sweetroll`,
`--no-file-parallelism`): campaign-invitations **17/17**;
membership+campaigns+migrations **29/29**; full vitest **50 files,
521/521**; root `npm test` **28 files, 284/284**; `tsc --noEmit` clean.
