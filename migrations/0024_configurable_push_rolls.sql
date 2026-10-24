-- Saved-pool push lineage. Historical rows and receipt JSON remain untouched.
ALTER TABLE character_rolls
  ADD COLUMN parent_roll_id uuid,
  ADD COLUMN root_roll_id uuid,
  ADD COLUMN push_attempt integer,
  ADD COLUMN push_context_json jsonb,
  ADD COLUMN push_result_json jsonb,
  ADD COLUMN audience_actor_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD CONSTRAINT character_rolls_character_identity UNIQUE (character_id,id),
  ADD CONSTRAINT character_rolls_push_parent FOREIGN KEY (character_id,parent_roll_id) REFERENCES character_rolls(character_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT character_rolls_push_root FOREIGN KEY (character_id,root_roll_id) REFERENCES character_rolls(character_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT character_rolls_push_shape CHECK (
    (parent_roll_id IS NULL AND root_roll_id IS NULL AND push_attempt IS NULL AND push_context_json IS NULL AND push_result_json IS NULL AND audience_actor_id IS NULL)
    OR
    (root_roll_id IS NOT NULL AND push_attempt IS NOT NULL AND push_attempt BETWEEN 0 AND 10 AND push_context_json IS NOT NULL AND jsonb_typeof(push_context_json)='object' AND push_result_json IS NOT NULL AND jsonb_typeof(push_result_json)='object' AND audience_actor_id IS NOT NULL
      AND ((push_attempt=0 AND parent_roll_id IS NULL AND root_roll_id=id) OR (push_attempt>0 AND parent_roll_id IS NOT NULL AND parent_roll_id<>id AND root_roll_id<>id)))
  );
CREATE UNIQUE INDEX character_rolls_one_push_child ON character_rolls(parent_roll_id) WHERE parent_roll_id IS NOT NULL;
CREATE UNIQUE INDEX character_rolls_push_attempt ON character_rolls(root_roll_id,push_attempt) WHERE root_roll_id IS NOT NULL;
CREATE FUNCTION character_push_rolls_prevent_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.root_roll_id IS NOT NULL OR (TG_OP='UPDATE' AND NEW.root_roll_id IS NOT NULL) THEN
    RAISE EXCEPTION 'push-capable rolls are immutable';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER character_push_rolls_immutable BEFORE UPDATE OR DELETE ON character_rolls FOR EACH ROW EXECUTE FUNCTION character_push_rolls_prevent_mutation();
