-- Preserve legacy rows/receipts untouched; new authoritative grouped rolls
-- keep their versioned calculation beside the existing flat dice result.
ALTER TABLE character_rolls ADD COLUMN breakdown_json jsonb;
ALTER TABLE character_rolls ADD CONSTRAINT character_roll_breakdown_object
  CHECK (breakdown_json IS NULL OR jsonb_typeof(breakdown_json) = 'object');
