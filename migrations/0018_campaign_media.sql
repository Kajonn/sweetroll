-- I7b campaign media files (Task 1): private original image storage. Bytes
-- live on local disk at data/media/<storage_key> (never served by a static
-- route); Postgres holds the validated metadata only. This file must not be
-- edited once applied.

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
