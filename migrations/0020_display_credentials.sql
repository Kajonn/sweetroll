-- I7b display pairing + restricted projection (Task 3): single-use pairing
-- codes and revocable display credentials. Pairing codes hold only the
-- SHA-256 hash (plaintext is returned once and never persisted); redeem
-- deletes the code row, so unknown/expired/used codes collapse to a generic
-- not_found. Credentials hold only the secret hash with a nullable
-- revoked_at (revoke stamps it; reads require it NULL). Both tables cascade
-- with the campaign. This file must not be edited once applied.

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
