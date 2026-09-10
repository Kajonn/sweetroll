-- I6 campaign content, grants and source-scoped activity (Task 7): relational
-- content visibility, same-campaign membership grants, minimal activity
-- references, and the campaign roll-audience default column (STORAGE ONLY;
-- Task 8 wires roll behavior). This file must not be edited once applied.
--
-- Visibility is always evaluated against CURRENT content state (audience,
-- grants, soft-delete) at read time: activity rows carry source references
-- only, never note bodies, roll bindings or sheet state. Request IDs
-- correlate multiple events from one command and are deliberately NOT unique.

CREATE TABLE campaign_content_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  creator_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  audience text NOT NULL,
  title text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  tags text[] NOT NULL DEFAULT '{}',
  revision integer NOT NULL DEFAULT 1,
  access_revision integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active',
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (audience IN ('gm_only', 'all_players', 'selected_players', 'owner_only')),
  CHECK (status IN ('active', 'deleted')),
  CHECK (revision > 0),
  CHECK (access_revision > 0),
  CHECK (deleted_at IS NULL OR status = 'deleted')
);

CREATE INDEX campaign_content_items_page_idx
  ON campaign_content_items (campaign_id, created_at DESC, id DESC);

-- Grants target a membership in the SAME campaign (composite FK, mirroring
-- character_controllers). Active-status is module-enforced: removed members
-- keep their row until departure cleanup deletes it, and rejoin never
-- reactivates a deleted grant.
CREATE TABLE campaign_content_grants (
  content_id uuid NOT NULL REFERENCES campaign_content_items(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (content_id, user_id),
  FOREIGN KEY (campaign_id, user_id) REFERENCES campaign_members (campaign_id, user_id) ON DELETE CASCADE
);

CREATE INDEX campaign_content_grants_member_idx
  ON campaign_content_grants (campaign_id, user_id);

-- Minimal source references: one row per content lifecycle/grant event with
-- the originating request ID for correlation. No bodies, bindings or state.
CREATE TABLE campaign_activity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind text NOT NULL,
  source_content_id uuid REFERENCES campaign_content_items(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind IN (
    'content_created',
    'content_updated',
    'content_deleted',
    'content_recovered',
    'content_grants_replaced'
  ))
);

CREATE INDEX campaign_activity_events_page_idx
  ON campaign_activity_events (campaign_id, occurred_at DESC, id DESC);

-- Roll audience default (Task 8 behavior; storage only here).
ALTER TABLE campaigns
  ADD COLUMN roll_audience_default text NOT NULL DEFAULT 'campaign',
  ADD CONSTRAINT campaigns_roll_audience_default_check
    CHECK (roll_audience_default IN ('owner_only', 'gm_only', 'campaign'));
