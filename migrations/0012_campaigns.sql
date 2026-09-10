-- I6 campaign aggregate base (Task 2): campaign metadata/lifecycle,
-- relational membership with generation, audit trail and idempotency
-- receipts. Invitations, character placement, content and roll audiences
-- arrive in later migrations; this file must not be edited once applied.

CREATE TABLE campaigns (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id          uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  system_version_id uuid NOT NULL REFERENCES system_versions(id) ON DELETE RESTRICT,
  title             text NOT NULL,
  description       text NOT NULL DEFAULT '',
  status            text NOT NULL DEFAULT 'active',
  revision          integer NOT NULL DEFAULT 1,
  access_revision   integer NOT NULL DEFAULT 1,
  archived_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (revision > 0),
  CHECK (access_revision > 0),
  CHECK (status IN ('active', 'archived'))
);

CREATE INDEX campaigns_owner_page_idx
  ON campaigns (owner_id, created_at DESC, id DESC);

CREATE TABLE campaign_members (
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role        text NOT NULL,
  status      text NOT NULL DEFAULT 'active',
  generation  integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, user_id),
  CHECK (role IN ('owner', 'co_gm', 'player')),
  CHECK (status IN ('active', 'removed')),
  CHECK (generation >= 1)
);

CREATE INDEX campaign_members_user_idx
  ON campaign_members (user_id, status, campaign_id);

CREATE TABLE campaign_audit_records (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  actor_id    uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind        text NOT NULL,
  summary     text NOT NULL,
  request_id  text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX campaign_audit_records_page_idx
  ON campaign_audit_records (campaign_id, occurred_at DESC, id DESC);

CREATE TABLE campaign_command_executions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  command_kind    text NOT NULL,
  idempotency_key text NOT NULL,
  input_hash      text NOT NULL,
  campaign_id     uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  result_json     jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  UNIQUE (actor_id, command_kind, idempotency_key)
);

CREATE INDEX campaign_command_executions_expiry_idx
  ON campaign_command_executions (expires_at);
