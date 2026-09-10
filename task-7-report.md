# Task 7 Report: Content, Grants, Source-Scoped History and Export Projection

**Status:** DONE
**Branch:** `feat/i6-campaign-backend` (worktree `/home/jonas/dev/sweetroll/.worktrees/i6-backend`)
**Commit:** `feat(i6): Task 7 content grants history and export projection` (base `b68cf19`)
**Date:** 2026-09-10

## What was built

- `migrations/0015_campaign_content_activity.sql` (new; **0014 was taken** by
  `0014_campaign_invitations.sql`, so the brief's `0014_campaign_content_rolls.sql`
  landed as 0015 — verified free, no applied migration edited):
  `campaign_content_items` (campaign FK CASCADE, creator FK, 4-audience CHECK,
  bounded text/tags in module, revision + access_revision > 0, active/deleted
  status with `deleted_at`-implies-deleted CHECK, page index);
  `campaign_content_grants` (PK pair, composite same-campaign FK to
  `campaign_members` mirroring `character_controllers`, member index);
  `campaign_activity_events` (stable event ID, campaign/actor FKs, 5 content
  kinds, nullable content source FK, `request_id` with deliberately NO unique
  constraint, `(campaign_id, occurred_at, id)` page index);
  `campaigns.roll_audience_default` (`owner_only`/`gm_only`/`campaign`,
  default `'campaign'`) as **STORAGE ONLY — no command reads or writes it;
  Task 8 wires behavior**.
- `src/campaigns/policy.ts`: `canReadContent` (active membership always,
  including creator access; gm_only → GM; all_players → any active member;
  selected_players → GM or granted; owner_only → creating member only, no GM
  override), `canManageContent` (creator or GM-on-readable), 
...[truncated 5832 chars]