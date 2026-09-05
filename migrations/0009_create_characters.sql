ALTER TABLE system_versions
  ADD COLUMN compatibility_findings_json jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE system_versions
   SET lifecycle = 'published'
 WHERE lifecycle = 'active';

ALTER TABLE system_versions
  ALTER COLUMN lifecycle SET DEFAULT 'published';

CREATE TABLE characters (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id             uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  system_version_id    uuid NOT NULL REFERENCES system_versions(id) ON DELETE RESTRICT,
  entity_definition_id text NOT NULL,
  name                 text NOT NULL,
  revision             integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  state_json           jsonb NOT NULL,
  visibility           text NOT NULL DEFAULT 'owner_only' CHECK (visibility = 'owner_only'),
  lifecycle            text NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'archived')),
  archived_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX characters_owner_page_idx
  ON characters (owner_id, lifecycle, updated_at DESC, id DESC);

CREATE TABLE character_command_executions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id              uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  command_kind          text NOT NULL,
  idempotency_key       text NOT NULL,
  input_hash            text NOT NULL,
  character_id          uuid REFERENCES characters(id) ON DELETE RESTRICT,
  preallocated_ids_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  execution_id          uuid NOT NULL UNIQUE,
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
  lease_expires_at      timestamptz NOT NULL,
  result_json           jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL,
  UNIQUE (actor_id, command_kind, idempotency_key)
);

CREATE INDEX character_command_executions_expiry_idx
  ON character_command_executions (expires_at);

CREATE TABLE character_rolls (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id       uuid NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
  actor_id           uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action_id          text NOT NULL,
  execution_id       uuid NOT NULL UNIQUE,
  expression         text NOT NULL,
  dice_json          jsonb NOT NULL,
  bindings_json      jsonb NOT NULL,
  total              double precision NOT NULL,
  rendered_output    text NOT NULL,
  audience           text NOT NULL DEFAULT 'owner_only' CHECK (audience = 'owner_only'),
  request_id         text NOT NULL,
  occurred_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE character_activity_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id       uuid NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
  character_revision integer NOT NULL CHECK (character_revision >= 1),
  kind               text NOT NULL,
  payload_json       jsonb NOT NULL,
  roll_id            uuid REFERENCES character_rolls(id) ON DELETE RESTRICT,
  request_id         text NOT NULL,
  occurred_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX character_activity_events_page_idx
  ON character_activity_events (character_id, occurred_at DESC, id DESC);

CREATE TABLE character_audit_records (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id uuid NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
  actor_id     uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind         text NOT NULL,
  summary      text NOT NULL,
  request_id   text NOT NULL,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE character_migration_previews (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id             uuid NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
  owner_id                 uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  source_revision          integer NOT NULL CHECK (source_revision >= 1),
  source_version_id        uuid NOT NULL REFERENCES system_versions(id) ON DELETE RESTRICT,
  source_checksum          text NOT NULL,
  target_version_id        uuid NOT NULL REFERENCES system_versions(id) ON DELETE RESTRICT,
  target_checksum          text NOT NULL,
  mapping_json             jsonb NOT NULL,
  candidate_state_json     jsonb NOT NULL,
  candidate_projection_json jsonb NOT NULL,
  warnings_json            jsonb NOT NULL,
  preview_checksum         text NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  expires_at               timestamptz NOT NULL,
  consumed_at              timestamptz
);

CREATE INDEX character_migration_previews_expiry_idx
  ON character_migration_previews (expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE character_migrations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id          uuid NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
  preview_id            uuid NOT NULL UNIQUE REFERENCES character_migration_previews(id) ON DELETE RESTRICT,
  source_version_id     uuid NOT NULL REFERENCES system_versions(id) ON DELETE RESTRICT,
  target_version_id     uuid NOT NULL REFERENCES system_versions(id) ON DELETE RESTRICT,
  before_state_json     jsonb NOT NULL,
  after_state_json      jsonb NOT NULL,
  commit_revision       integer NOT NULL CHECK (commit_revision >= 2),
  rollback_deadline     timestamptz NOT NULL,
  actor_id              uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_id            text NOT NULL,
  committed_at          timestamptz NOT NULL DEFAULT now(),
  rollback_revision     integer CHECK (rollback_revision >= 1),
  rolled_back_at        timestamptz
);
