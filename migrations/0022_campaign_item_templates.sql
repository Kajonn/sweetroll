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
ALTER TABLE campaign_item_templates ADD CONSTRAINT campaign_template_current_content_fk
  FOREIGN KEY(id,content_revision) REFERENCES campaign_item_template_revisions(template_id,content_revision)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE campaign_activity_events DROP CONSTRAINT campaign_activity_events_kind_check;
ALTER TABLE campaign_activity_events ADD CONSTRAINT campaign_activity_events_kind_check
  CHECK (kind IN ('content_created','content_updated','content_deleted','content_recovered','content_grants_replaced','roll_executed','template_create','template_update','template_archive','template_recover'));
