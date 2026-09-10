-- I6 campaign character scope (Task 4): ownership union, placement
-- generation/history, controllers and claim designations, plus placement
-- scope on character history/receipts. This file must not be edited once applied.
--
-- Ownership union: standalone rows keep a non-null owner_id and NULL
-- campaign_id; attached rows have NULL owner_id and a non-null campaign_id.
-- Exactly one scope is enforced by CHECK; no dummy user ever owns a
-- zero-controller campaign character. Existing standalone rows are preserved
-- byte-identical (owner IDs untouched, placement_generation defaults to 1,
-- history scope NULL means standalone scope).

ALTER TABLE characters
  ALTER COLUMN owner_id DROP NOT NULL,
  ADD COLUMN campaign_id uuid REFERENCES campaigns(id) ON DELETE RESTRICT,
  ADD COLUMN placement_generation integer NOT NULL DEFAULT 1,
  ADD COLUMN return_owner_id uuid REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE characters ADD CONSTRAINT characters_ownership_scope_check
  CHECK ((owner_id IS NOT NULL AND campaign_id IS NULL)
      OR (owner_id IS NULL AND campaign_id IS NOT NULL));
ALTER TABLE characters ADD CONSTRAINT characters_placement_generation_check
  CHECK (placement_generation >= 1);
ALTER TABLE characters ADD CONSTRAINT characters_return_owner_scope_check
  CHECK (return_owner_id IS NULL OR campaign_id IS NOT NULL);

-- Historical placement records persist after detachment for audit and
-- history scoping. return_owner_id is immutable once written: only new
-- generations are ever inserted, never updates of past rows.
CREATE TABLE character_placements (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id      uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  generation        integer NOT NULL,
  campaign_id       uuid NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
  return_owner_id   uuid REFERENCES users(id) ON DELETE RESTRICT,
  started_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz,
  UNIQUE (character_id, generation),
  CHECK (generation >= 1)
);

CREATE INDEX character_placements_character_idx
  ON character_placements (character_id, generation DESC);

-- Active controllers of an attached character. Each pair must reference a
-- membership in the SAME campaign; active-status is enforced by the module
-- (removed members keep their row until departure cleanup deletes it).
CREATE TABLE character_controllers (
  character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  campaign_id  uuid NOT NULL,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (character_id, user_id),
  FOREIGN KEY (campaign_id, user_id) REFERENCES campaign_members (campaign_id, user_id) ON DELETE CASCADE
);

CREATE INDEX character_controllers_member_idx
  ON character_controllers (campaign_id, user_id);

-- GM claim designations: exactly one designated claimant per character.
-- Consumed atomically by the claim operation (DELETE ... RETURNING wins once).
CREATE TABLE character_claim_designations (
  character_id  uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  campaign_id   uuid NOT NULL,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  designated_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (character_id, user_id),
  FOREIGN KEY (campaign_id, user_id) REFERENCES campaign_members (campaign_id, user_id) ON DELETE CASCADE
);

-- Original placement scope for history/receipts. NULL means standalone scope
-- (all pre-0013 rows backfill to NULL without data rewrites); a non-null
-- campaign id pins the row to its original campaign placement. Returning a
-- character never relabels these rows.
ALTER TABLE character_rolls
  ADD COLUMN scope_campaign_id uuid REFERENCES campaigns(id) ON DELETE RESTRICT;
ALTER TABLE character_activity_events
  ADD COLUMN scope_campaign_id uuid REFERENCES campaigns(id) ON DELETE RESTRICT;
ALTER TABLE character_command_executions
  ADD COLUMN scope_campaign_id uuid REFERENCES campaigns(id) ON DELETE RESTRICT;
ALTER TABLE character_migrations
  ADD COLUMN scope_campaign_id uuid REFERENCES campaigns(id) ON DELETE RESTRICT;

-- Membership-scoped character paging for campaign reads.
CREATE INDEX characters_campaign_page_idx
  ON characters (campaign_id, updated_at DESC, id DESC)
  WHERE campaign_id IS NOT NULL;
