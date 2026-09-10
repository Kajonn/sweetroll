-- I6 campaign roll audiences and atomic activity (Task 8): one shared
-- wire/storage vocabulary (owner_only/gm_only/campaign) for character rolls,
-- plus campaign activity references to rolls. This file must not be edited
-- once applied.
--
-- character_rolls.audience widens from owner-only to the campaign vocabulary.
-- Existing standalone rows keep 'owner_only' byte-identical; the default
-- stays 'owner_only' so standalone behavior is unchanged.
--
-- campaign_activity_events gains an optional roll source. Activity rows carry
-- source references only, never roll bindings, inputs, note bodies or sheet
-- state; visibility is evaluated against CURRENT roll/content state at read
-- time (see Task 7 predicates, extended here for rolls). Request IDs
-- correlate multiple events from one command and are deliberately NOT unique.

ALTER TABLE character_rolls
  DROP CONSTRAINT character_rolls_audience_check,
  ADD CONSTRAINT character_rolls_audience_check
    CHECK (audience IN ('owner_only', 'gm_only', 'campaign'));

-- Roll source for campaign activity: one 'roll_executed' event per campaign
-- roll, committed atomically with the roll, character result and receipt.
ALTER TABLE campaign_activity_events
  ADD COLUMN source_roll_id uuid REFERENCES character_rolls(id) ON DELETE RESTRICT;

ALTER TABLE campaign_activity_events
  DROP CONSTRAINT campaign_activity_events_kind_check,
  ADD CONSTRAINT campaign_activity_events_kind_check
    CHECK (kind IN (
      'content_created',
      'content_updated',
      'content_deleted',
      'content_recovered',
      'content_grants_replaced',
      'roll_executed'
    ));
