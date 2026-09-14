-- I7b campaign scenes (Task 2): GM-composed fog/token scenes pinned to a
-- Task 1 background image. Fog ops and token records live as JSONB on the
-- scene row (no tactical grids, movement rules or lighting automation in
-- this slice); every mutation bumps `revision` under an optimistic guard.
-- `background_file_id` is intentionally not a foreign key: deleting a
-- pinned image (Task 1 hard delete) must keep working, and the pin is
-- enforced application-side at create/update time (same-campaign only).
-- This file must not be edited once applied.

CREATE TABLE scenes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  background_file_id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  fog_jsonb jsonb NOT NULL DEFAULT '[]'::jsonb,
  tokens_jsonb jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (revision > 0)
);

CREATE INDEX scenes_page_idx
  ON scenes (campaign_id, created_at DESC, id DESC);
