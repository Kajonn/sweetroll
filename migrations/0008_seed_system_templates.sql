-- Allow reference templates to exist with no owning user (the global
-- clone-from-template fixtures). Existing systems still require a non-null owner.
ALTER TABLE systems ALTER COLUMN owner_id DROP NOT NULL;

-- Seed three reference template systems (one per capability-matrix fixture).
-- The packages themselves are populated by loadReferenceTemplates() at migrate
-- or boot time so the SQL migration stays compact and the fixtures stay in sync
-- with src/systems/implementation/package/fixtures/.
INSERT INTO systems (id, owner_id, name, access, lifecycle, created_at, updated_at)
VALUES
  ('00000000-0000-0000-0000-000000000a01', NULL, 'Template: d20', 'link', 'active', now(), now()),
  ('00000000-0000-0000-0000-000000000a02', NULL, 'Template: PbtA 2d6', 'link', 'active', now(), now()),
  ('00000000-0000-0000-0000-000000000a03', NULL, 'Template: d6 success pool', 'link', 'active', now(), now())
ON CONFLICT (id) DO NOTHING;

-- One published version per template. package_json and checksum are placeholders;
-- loadReferenceTemplates() identifies them by checksum prefix "pending:" and
-- replaces them with the real compiled package and signed checksum.
INSERT INTO system_versions (id, system_id, semantic_version, checksum, package_json, release_notes, lifecycle, created_at)
VALUES
  ('11111111-1111-1111-1111-111111111a01', '00000000-0000-0000-0000-000000000a01', '1.0.0', 'pending:d20', '{}'::jsonb, 'Template seed', 'active', now()),
  ('11111111-1111-1111-1111-111111111a02', '00000000-0000-0000-0000-000000000a02', '1.0.0', 'pending:pbta-2d6', '{}'::jsonb, 'Template seed', 'active', now()),
  ('11111111-1111-1111-1111-111111111a03', '00000000-0000-0000-0000-000000000a03', '1.0.0', 'pending:d6-success-pool', '{}'::jsonb, 'Template seed', 'active', now())
ON CONFLICT (id) DO NOTHING;