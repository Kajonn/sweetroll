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
-- Expired-row pruning (src/platform/prune.ts): when a session stopped working.
CREATE INDEX sessions_unusable_at_idx
  ON sessions ((LEAST(expires_at, COALESCE(revoked_at, 'infinity'::timestamptz))));

CREATE TABLE personal_access_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  label      text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  scopes     text[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 6
    AND scopes <@ ARRAY['systems:read', 'systems:write', 'characters:read', 'characters:write',
                        'campaigns:read', 'campaigns:write']),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX personal_access_tokens_user_active_idx
  ON personal_access_tokens (user_id) WHERE revoked_at IS NULL;
CREATE INDEX personal_access_tokens_unusable_at_idx
  ON personal_access_tokens ((LEAST(expires_at, COALESCE(revoked_at, 'infinity'::timestamptz))));

CREATE TABLE public_api_rate_limits (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bucket      text NOT NULL CHECK (bucket IN ('general', 'validate', 'publish', 'upload')),
  window_at   timestamptz NOT NULL,
  hits        integer NOT NULL CHECK (hits > 0),
  PRIMARY KEY (user_id, bucket)
);

-- Systems
-- NULL owners identify global reference templates.
CREATE TABLE systems (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid REFERENCES users(id) ON DELETE RESTRICT,
  name       text NOT NULL,
  access     text NOT NULL DEFAULT 'private',
  lifecycle  text NOT NULL DEFAULT 'active',
  -- System extensions (design 6.8): an extension is a systems row of kind
  -- 'extension' that adds templates to exactly one base system.
  kind       text NOT NULL DEFAULT 'system' CHECK (kind IN ('system', 'extension')),
  base_system_id uuid REFERENCES systems(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'extension') = (base_system_id IS NOT NULL))
);
CREATE INDEX systems_extensions_by_base ON systems (base_system_id, created_at DESC, id DESC)
  WHERE kind = 'extension';

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
  -- Extension versions: the base system version they were compiled against.
  built_against_version_id uuid REFERENCES system_versions(id) ON DELETE RESTRICT,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (system_id, semantic_version)
);

-- Extension drafts: the base system version used for preview and validation.
ALTER TABLE system_drafts
  ADD COLUMN base_version_id uuid REFERENCES system_versions(id) ON DELETE RESTRICT;

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
CREATE INDEX idempotency_receipts_expiry_idx ON idempotency_receipts (expires_at);

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
CREATE INDEX preview_snapshots_expiry_idx ON preview_snapshots (expires_at);

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
  -- Design 6.7: the version used before the most recent upgrade; the only revert target.
  previous_system_version_id uuid REFERENCES system_versions(id) ON DELETE RESTRICT,
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

-- Design 6.8 (decision X7): the campaign composition. Attached characters'
-- character_extensions always equal this set. `added_by` records whether the
-- GM chose the extension or an adopted character brought it.
CREATE TABLE campaign_extensions (
  campaign_id           uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  extension_id          uuid NOT NULL REFERENCES systems(id) ON DELETE RESTRICT,
  extension_version_id  uuid NOT NULL REFERENCES system_versions(id) ON DELETE RESTRICT,
  added_by              text NOT NULL CHECK (added_by IN ('campaign', 'character')),
  added_by_character_id uuid, -- informational; the character may later leave or be purged
  added_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, extension_id)
);

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
  -- Design 6.7: the version used before the most recent upgrade; the only revert target.
  previous_system_version_id uuid REFERENCES system_versions(id) ON DELETE RESTRICT,
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

-- Character-owned immutable safe art; authorization always follows a parent link.
-- Design 6.8: extension versions a character is built on (one version per
-- extension). Published versions are immutable; RESTRICT keeps used versions.
CREATE TABLE character_extensions (
  character_id         uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  extension_id         uuid NOT NULL REFERENCES systems(id) ON DELETE RESTRICT,
  extension_version_id uuid NOT NULL REFERENCES system_versions(id) ON DELETE RESTRICT,
  PRIMARY KEY (character_id, extension_id)
);
CREATE INDEX character_extensions_by_version ON character_extensions (extension_version_id);

CREATE TABLE character_image_assets (
  id uuid PRIMARY KEY,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  storage_key uuid NOT NULL,
  media_type text NOT NULL CHECK (media_type IN ('image/png','image/jpeg','image/webp')),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 4096),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 4096),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),
  thumbnail_bytes integer NOT NULL CHECK (thumbnail_bytes BETWEEN 1 AND 65536),
  checksum text NOT NULL,
  thumbnail_checksum text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX character_image_assets_owner_idx ON character_image_assets(created_by);
CREATE INDEX character_image_assets_campaign_idx ON character_image_assets(campaign_id);
CREATE TABLE character_portraits (
  character_id uuid PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  asset_id uuid REFERENCES character_image_assets(id) ON DELETE RESTRICT,
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  revision integer NOT NULL CHECK (revision >= 1)
);
CREATE TABLE character_image_receipts (
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  input_hash text NOT NULL,
  result_json jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(actor_id,idempotency_key)
);
CREATE INDEX character_image_receipts_expiry_idx ON character_image_receipts (expires_at);

-- Immutable item art is retained across published systems, campaign catalogs
-- and disclosed character copies. Owning Modules authorize their parent links.
CREATE TABLE item_image_assets (
  id uuid PRIMARY KEY,
  storage_key uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  media_type text NOT NULL CHECK (media_type IN ('image/png','image/jpeg','image/webp')),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 4096),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 4096),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),
  thumbnail_bytes integer NOT NULL CHECK (thumbnail_bytes BETWEEN 1 AND 65536),
  checksum text NOT NULL,
  thumbnail_checksum text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX item_image_assets_uploader_idx ON item_image_assets(created_by);
CREATE INDEX item_image_assets_campaign_idx ON item_image_assets(campaign_id);
CREATE TABLE system_image_permissions (
  system_id uuid NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES item_image_assets(id) ON DELETE RESTRICT,
  PRIMARY KEY(system_id,asset_id)
);
CREATE TABLE item_image_receipts (
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  input_hash text NOT NULL,
  result_json jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(actor_id,idempotency_key)
);
CREATE INDEX item_image_receipts_expiry_idx ON item_image_receipts (expires_at);
CREATE TABLE character_entry_images (
  character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  entry_id uuid NOT NULL,
  pinned_asset_id uuid REFERENCES item_image_assets(id) ON DELETE RESTRICT,
  asset_id uuid REFERENCES item_image_assets(id) ON DELETE RESTRICT,
  description text NOT NULL DEFAULT '' CHECK (length(description)<=500),
  overridden boolean NOT NULL DEFAULT true,
  revision integer NOT NULL CHECK (revision>=0),
  PRIMARY KEY(character_id,entry_id)
);

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
  breakdown_json jsonb NOT NULL,
  CONSTRAINT character_roll_breakdown_object CHECK (jsonb_typeof(breakdown_json) = 'object'),
  bindings_json      jsonb NOT NULL,
  total              double precision NOT NULL,
  rendered_output    text NOT NULL,
  audience           text NOT NULL DEFAULT 'owner_only' CHECK (audience IN ('owner_only', 'gm_only', 'campaign')),
  request_id         text NOT NULL,
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  scope_campaign_id uuid REFERENCES campaigns(id) ON DELETE RESTRICT,
  parent_roll_id uuid,
  root_roll_id uuid,
  push_attempt integer,
  push_context_json jsonb,
  push_result_json jsonb,
  audience_actor_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT character_rolls_character_identity UNIQUE (character_id,id),
  CONSTRAINT character_rolls_push_parent FOREIGN KEY (character_id,parent_roll_id) REFERENCES character_rolls(character_id,id) ON DELETE RESTRICT,
  CONSTRAINT character_rolls_push_root FOREIGN KEY (character_id,root_roll_id) REFERENCES character_rolls(character_id,id) ON DELETE RESTRICT,
  CONSTRAINT character_rolls_push_shape CHECK (
    (parent_roll_id IS NULL AND root_roll_id IS NULL AND push_attempt IS NULL AND push_context_json IS NULL AND push_result_json IS NULL AND audience_actor_id IS NULL)
    OR
    (root_roll_id IS NOT NULL AND push_attempt IS NOT NULL AND push_attempt BETWEEN 0 AND 10 AND push_context_json IS NOT NULL AND jsonb_typeof(push_context_json)='object' AND push_result_json IS NOT NULL AND jsonb_typeof(push_result_json)='object' AND audience_actor_id IS NOT NULL
      AND ((push_attempt=0 AND parent_roll_id IS NULL AND root_roll_id=id) OR (push_attempt>0 AND parent_roll_id IS NOT NULL AND parent_roll_id<>id AND root_roll_id<>id)))
  )
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
CREATE INDEX campaign_invitations_pending_expiry_idx
  ON campaign_invitations (expires_at) WHERE status = 'pending';

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
    'template_recover',
    'system_version_upgraded',
    'system_version_reverted',
    'extension_added',
    'extension_removed'
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
  -- Player-safe map version: changes only with fog or a different background.
  image_revision integer NOT NULL DEFAULT 1,
  fog_jsonb jsonb NOT NULL DEFAULT '[]'::jsonb,
  tokens_jsonb jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (revision > 0),
  CHECK (image_revision > 0)
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
CREATE INDEX display_codes_expiry_idx ON display_codes (expires_at);

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
  audience text NOT NULL DEFAULT 'all_players' CHECK (audience IN ('all_players','gm_only','selected_players')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>=1),
  content_revision integer NOT NULL DEFAULT 1 CHECK (content_revision>=1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE TABLE campaign_item_template_grants (
  template_id uuid NOT NULL REFERENCES campaign_item_templates(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  membership_generation integer NOT NULL CHECK (membership_generation>=1),
  PRIMARY KEY(template_id,user_id)
);
CREATE INDEX campaign_item_templates_page_idx ON campaign_item_templates(campaign_id,status,id);
CREATE TABLE campaign_item_template_revisions (
  template_id uuid NOT NULL REFERENCES campaign_item_templates(id) ON DELETE CASCADE,
  content_revision integer NOT NULL CHECK (content_revision>=1),
  author_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  content_json jsonb NOT NULL CHECK (jsonb_typeof(content_json)='object'),
  image_asset_id uuid REFERENCES item_image_assets(id) ON DELETE RESTRICT,
  image_description text NOT NULL DEFAULT '' CHECK (length(image_description)<=500),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(template_id,content_revision)
);
-- Resolve the current-content reference after both sides of the cycle exist.
ALTER TABLE campaign_item_templates ADD CONSTRAINT campaign_template_current_content_fk
  FOREIGN KEY(id,content_revision) REFERENCES campaign_item_template_revisions(template_id,content_revision)
  DEFERRABLE INITIALLY DEFERRED;

-- Private immutable player suggestions. Publication is a terminal atomic decision.
CREATE TABLE campaign_item_proposals (
  id uuid PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  submitter_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  membership_generation integer NOT NULL CHECK (membership_generation >= 1),
  kind text NOT NULL CHECK (kind IN ('item','spell','talent','effect')),
  content_json jsonb NOT NULL CHECK (jsonb_typeof(content_json)='object' AND octet_length(content_json::text)<=32768),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  decision_actor_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  decided_at timestamptz,
  decision_reason text CHECK (length(decision_reason)<=2000),
  approved_template_id uuid UNIQUE REFERENCES campaign_item_templates(id) ON DELETE RESTRICT,
  CHECK (
    (status='pending' AND revision=1 AND decision_actor_id IS NULL AND decided_at IS NULL AND decision_reason IS NULL AND approved_template_id IS NULL)
    OR (status='approved' AND revision=2 AND decision_actor_id IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NULL AND approved_template_id IS NOT NULL)
    OR (status='rejected' AND revision=2 AND decision_actor_id IS NOT NULL AND decided_at IS NOT NULL AND approved_template_id IS NULL)
  )
);
CREATE INDEX campaign_proposals_page_idx ON campaign_item_proposals(campaign_id,status,id);
CREATE INDEX campaign_proposals_self_idx ON campaign_item_proposals(campaign_id,submitter_id,membership_generation,status,id);
-- Proposal text and its terminal decision remain immutable. Pending artwork has
-- its own revision and must be explicitly reviewed by an approver.
CREATE TABLE campaign_proposal_images (
  proposal_id uuid PRIMARY KEY REFERENCES campaign_item_proposals(id) ON DELETE CASCADE,
  asset_id uuid REFERENCES item_image_assets(id) ON DELETE RESTRICT,
  description text NOT NULL DEFAULT '' CHECK (length(description)<=500),
  revision integer NOT NULL CHECK (revision>=1)
);
CREATE FUNCTION guard_campaign_proposal_image() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_id uuid;
BEGIN
  IF TG_OP='DELETE' THEN parent_id=OLD.proposal_id; ELSE parent_id=NEW.proposal_id; END IF;
  IF EXISTS(SELECT 1 FROM campaign_item_proposals WHERE id=parent_id AND status<>'pending') THEN
    RAISE EXCEPTION 'Decided suggestion artwork is immutable';
  END IF;
  IF TG_OP='UPDATE' AND NEW.proposal_id IS DISTINCT FROM OLD.proposal_id THEN
    RAISE EXCEPTION 'Suggestion artwork cannot change parent';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER campaign_proposal_image_immutable BEFORE INSERT OR UPDATE OR DELETE ON campaign_proposal_images FOR EACH ROW EXECUTE FUNCTION guard_campaign_proposal_image();
CREATE FUNCTION guard_campaign_proposal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
    OR NEW.submitter_id IS DISTINCT FROM OLD.submitter_id OR NEW.membership_generation IS DISTINCT FROM OLD.membership_generation
    OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.content_json IS DISTINCT FROM OLD.content_json
    OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.status = 'pending' THEN
    RAISE EXCEPTION 'Campaign suggestion content and terminal decisions are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER campaign_proposal_immutable BEFORE UPDATE ON campaign_item_proposals FOR EACH ROW EXECUTE FUNCTION guard_campaign_proposal();
