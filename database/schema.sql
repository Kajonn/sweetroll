-- Current development schema. Initialize an empty database; rebuild disposable
-- test databases after schema changes. No historical app-version upgrades.

-- Identity
CREATE TABLE users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text,
  locale       text NOT NULL DEFAULT 'en',
  status       text NOT NULL DEFAULT 'active',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE external_identities (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider   text NOT NULL,
  subject    text NOT NULL,
  email      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, subject)
);

CREATE TABLE sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);

-- Systems
-- NULL owners identify global reference templates.
CREATE TABLE systems (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid REFERENCES users(id) ON DELETE RESTRICT,
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
  lifecycle        text NOT NULL DEFAULT 'published',
  compatibility_findings_json jsonb NOT NULL DEFAULT '[]'::jsonb,
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

-- Authoring
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

-- User preferences
CREATE TABLE user_preferences (
  user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  theme_default text CHECK (theme_default IN ('light', 'dark', 'system')),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Campaigns
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
  roll_audience_default text NOT NULL DEFAULT 'campaign',
  CONSTRAINT campaigns_roll_audience_default_check CHECK (roll_audience_default IN ('owner_only', 'gm_only', 'campaign')),
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

-- Characters
-- A character has exactly one custody scope: a standalone owner or a campaign.
-- History/receipts retain their original scope_campaign_id after character return.
CREATE TABLE characters (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id             uuid REFERENCES users(id) ON DELETE RESTRICT,
  system_version_id    uuid NOT NULL REFERENCES system_versions(id) ON DELETE RESTRICT,
  entity_definition_id text NOT NULL,
  name                 text NOT NULL,
  revision             integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  state_json           jsonb NOT NULL,
  visibility           text NOT NULL DEFAULT 'owner_only' CHECK (visibility = 'owner_only'),
  lifecycle            text NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'archived')),
  archived_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  campaign_id uuid REFERENCES campaigns(id) ON DELETE RESTRICT,
  placement_generation integer NOT NULL DEFAULT 1,
  return_owner_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT characters_ownership_scope_check CHECK ((owner_id IS NOT NULL AND campaign_id IS NULL) OR (owner_id IS NULL AND campaign_id IS NOT NULL)),
  CONSTRAINT characters_placement_generation_check CHECK (placement_generation >= 1),
  CONSTRAINT characters_return_owner_scope_check CHECK (return_owner_id IS NULL OR campaign_id IS NOT NULL)
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
  UNIQUE (actor_id, command_kind, idempotency_key),
  scope_campaign_id uuid REFERENCES campaigns(id) ON DELETE RESTRICT
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
  breakdown_json jsonb,
  CONSTRAINT character_roll_breakdown_object CHECK (breakdown_json IS NULL OR jsonb_typeof(breakdown_json) = 'object'),
  bindings_json      jsonb NOT NULL,
  total              double precision NOT NULL,
  rendered_output    text NOT NULL,
  audience           text NOT NULL DEFAULT 'owner_only' CHECK (audience IN ('owner_only', 'gm_only', 'campaign')),
  request_id         text NOT NULL,
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  scope_campaign_id uuid REFERENCES campaigns(id) ON DELETE RESTRICT
);

CREATE TABLE character_activity_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id       uuid NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
  character_revision integer NOT NULL CHECK (character_revision >= 1),
  kind               text NOT NULL,
  payload_json       jsonb NOT NULL,
  roll_id            uuid REFERENCES character_rolls(id) ON DELETE RESTRICT,
  request_id         text NOT NULL,
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  scope_campaign_id uuid REFERENCES campaigns(id) ON DELETE RESTRICT
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

-- Campaign character placement
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

CREATE TABLE character_claim_designations (
  character_id  uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  campaign_id   uuid NOT NULL,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  designated_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (character_id, user_id),
  FOREIGN KEY (campaign_id, user_id) REFERENCES campaign_members (campaign_id, user_id) ON DELETE CASCADE
);

CREATE INDEX characters_campaign_page_idx
  ON characters (campaign_id, updated_at DESC, id DESC)
  WHERE campaign_id IS NOT NULL;

-- Invitations
CREATE TABLE campaign_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  issued_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  intended_role text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending',
  revision integer NOT NULL DEFAULT 1,
  consuming_actor_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  accepted_membership_generation integer,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (intended_role IN ('player', 'co_gm')),
  CHECK (status IN ('pending', 'accepted', 'declined', 'revoked')),
  CHECK (revision > 0),
  CHECK (accepted_membership_generation IS NULL OR accepted_membership_generation >= 1)
);

CREATE INDEX campaign_invitations_campaign_page_idx
  ON campaign_invitations (campaign_id, created_at DESC, id DESC);

-- Content and activity
-- Activity stores source references; authorization is evaluated at read time.
CREATE TABLE campaign_content_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  creator_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  audience text NOT NULL,
  title text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  tags text[] NOT NULL DEFAULT '{}',
  revision integer NOT NULL DEFAULT 1,
  access_revision integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active',
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (audience IN ('gm_only', 'all_players', 'selected_players', 'owner_only')),
  CHECK (status IN ('active', 'deleted')),
  CHECK (revision > 0),
  CHECK (access_revision > 0),
  CHECK (deleted_at IS NULL OR status = 'deleted')
);

CREATE INDEX campaign_content_items_page_idx
  ON campaign_content_items (campaign_id, created_at DESC, id DESC);

CREATE TABLE campaign_content_grants (
  content_id uuid NOT NULL REFERENCES campaign_content_items(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (content_id, user_id),
  FOREIGN KEY (campaign_id, user_id) REFERENCES campaign_members (campaign_id, user_id) ON DELETE CASCADE
);

CREATE INDEX campaign_content_grants_member_idx
  ON campaign_content_grants (campaign_id, user_id);

CREATE TABLE campaign_activity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind text NOT NULL,
  source_roll_id uuid REFERENCES character_rolls(id) ON DELETE RESTRICT,
  source_content_id uuid REFERENCES campaign_content_items(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind IN (
    'content_created',
    'content_updated',
    'content_deleted',
    'content_recovered',
    'content_grants_replaced',
    'roll_executed',
    'template_create',
    'template_update',
    'template_archive',
    'template_recover'
  ))
);

CREATE INDEX campaign_activity_events_page_idx
  ON campaign_activity_events (campaign_id, occurred_at DESC, id DESC);

-- Roll export
CREATE INDEX character_rolls_scope_campaign_page_idx
  ON character_rolls (scope_campaign_id, id);

-- Media
CREATE TABLE media_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name text NOT NULL,
  media_type text NOT NULL,
  size_bytes integer NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  checksum text NOT NULL,
  storage_key text NOT NULL UNIQUE,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (media_type IN ('image/png', 'image/jpeg', 'image/webp')),
  CHECK (size_bytes > 0),
  CHECK (width > 0),
  CHECK (height > 0),
  CHECK (revision > 0)
);

CREATE INDEX media_files_page_idx
  ON media_files (campaign_id, created_at DESC, id DESC);

-- Scenes
-- Background identity is checked by the module; deleting media may orphan a scene.
CREATE TABLE scenes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  background_file_id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  fog_jsonb jsonb NOT NULL DEFAULT '[]'::jsonb,
  tokens_jsonb jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (revision > 0)
);

CREATE INDEX scenes_page_idx
  ON scenes (campaign_id, created_at DESC, id DESC);

-- Display access
CREATE TABLE display_codes (
  code_hash text PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE display_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  secret_hash text NOT NULL UNIQUE,
  revoked_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX display_credentials_page_idx
  ON display_credentials (campaign_id, created_at DESC, id DESC);

-- Campaign item templates
CREATE TABLE campaign_item_templates (
  id uuid PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  creator_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('item','spell','talent','effect')),
  audience text NOT NULL DEFAULT 'all_players' CHECK (audience='all_players'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>=1),
  content_revision integer NOT NULL DEFAULT 1 CHECK (content_revision>=1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX campaign_item_templates_page_idx ON campaign_item_templates(campaign_id,status,id);
CREATE TABLE campaign_item_template_revisions (
  template_id uuid NOT NULL REFERENCES campaign_item_templates(id) ON DELETE CASCADE,
  content_revision integer NOT NULL CHECK (content_revision>=1),
  author_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  content_json jsonb NOT NULL CHECK (jsonb_typeof(content_json)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(template_id,content_revision)
);
-- Resolve the current-content reference after both sides of the cycle exist.
ALTER TABLE campaign_item_templates ADD CONSTRAINT campaign_template_current_content_fk
  FOREIGN KEY(id,content_revision) REFERENCES campaign_item_template_revisions(template_id,content_revision)
  DEFERRABLE INITIALLY DEFERRED;
