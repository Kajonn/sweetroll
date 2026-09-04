ALTER TABLE system_versions
  ADD COLUMN lifecycle text NOT NULL DEFAULT 'published';

CREATE TABLE preview_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system_id       uuid NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  source_revision integer NOT NULL,
  package_json    jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL
);

CREATE INDEX preview_snapshots_system_id_idx
  ON preview_snapshots (system_id, created_at DESC);

CREATE FUNCTION system_versions_prevent_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.package_json IS DISTINCT FROM OLD.package_json
     OR NEW.checksum IS DISTINCT FROM OLD.checksum
     OR NEW.semantic_version IS DISTINCT FROM OLD.semantic_version THEN
    RAISE EXCEPTION 'published system versions are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER system_versions_immutable
  BEFORE UPDATE ON system_versions
  FOR EACH ROW EXECUTE FUNCTION system_versions_prevent_mutation();
