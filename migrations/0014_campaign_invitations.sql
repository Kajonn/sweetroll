-- I6 campaign invitations (Task 6): single-use bearer tokens with hash-only
-- storage, explicit intended role/expiry, and a revisioned admin lifecycle.
-- Plaintext tokens never persist: only the SHA-256 token hash is stored, and
-- idempotency receipts carry invitation metadata without token bytes.
-- This file must not be edited once applied.

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
