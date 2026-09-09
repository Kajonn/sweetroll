-- Account-level theme default (G6 player app, Task 4).
--
-- Nullable: NULL (or a missing row) means no account default, so the
-- per-device preference -- or the OS setting when the device follows it --
-- applies. Per-device overrides stay client-side in localStorage; only the
-- default syncs through GET/PATCH /me/preferences. A preference is account
-- data, not a security event, so no audit row is written.
CREATE TABLE user_preferences (
  user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  theme_default text CHECK (theme_default IN ('light', 'dark', 'system')),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
