CREATE TABLE systems (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name       text NOT NULL,
  access     text NOT NULL DEFAULT 'private',
  lifecycle  text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE system_drafts (
  system_id       uuid PRIMARY KEY REFERENCES systems(id) ON DELETE CASCADE,
  revision        integer NOT NULL DEFAULT 1,
  document_json   jsonb NOT NULL,
  source_checksum text NOT NULL,
  updated_by      uuid NOT NULL REFERENCES users(id),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE system_versions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system_id        uuid NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  semantic_version text NOT NULL,
  checksum         text NOT NULL UNIQUE,
  package_json     jsonb NOT NULL,
  release_notes    text NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (system_id, semantic_version)
);

CREATE TABLE idempotency_receipts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  command_kind text NOT NULL,
  key          text NOT NULL,
  input_hash   text NOT NULL,
  result_json  jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  UNIQUE (actor_id, command_kind, key)
);

CREATE TABLE system_audit_records (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system_id   uuid NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  actor_id    uuid NOT NULL REFERENCES users(id),
  kind        text NOT NULL,
  summary     text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  request_id  text NOT NULL
);

CREATE INDEX system_drafts_updated_at_idx ON system_drafts (updated_at DESC);
CREATE INDEX system_versions_system_id_idx ON system_versions (system_id, created_at DESC);
CREATE INDEX system_audit_records_system_id_idx ON system_audit_records (system_id, occurred_at DESC);
