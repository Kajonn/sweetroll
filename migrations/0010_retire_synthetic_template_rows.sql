-- Retire the synthetic reference-template rows seeded by 0008.
--
-- The retired version rows stored packages whose embedded versionId never
-- matched the row id, so SystemRuntime (and therefore character creation)
-- rejected every template with "Published package version differs from the
-- request." Template rows now use the fixtures' own schema-valid package
-- identity (see REFERENCE_TEMPLATES); the seeder inserts those rows at boot
-- and migrate time.
--
-- No character can reference the retired versions: creation against them
-- always failed validation, and the characters table enforces RESTRICT, so
-- these deletes remove only the unusable template rows.
DELETE FROM system_versions
WHERE id IN (
  '11111111-1111-1111-1111-111111111a01',
  '11111111-1111-1111-1111-111111111a02',
  '11111111-1111-1111-1111-111111111a03'
);
DELETE FROM systems
WHERE id IN (
  '00000000-0000-0000-0000-000000000a01',
  '00000000-0000-0000-0000-000000000a02',
  '00000000-0000-0000-0000-000000000a03'
);
