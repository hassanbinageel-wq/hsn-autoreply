-- Account email (for password recovery only) and one-time password reset links / email confirmation codes.
ALTER TABLE admin_users ADD COLUMN email TEXT;
ALTER TABLE admin_users ADD COLUMN email_verified_at INTEGER;   -- only a confirmed email receives reset links
CREATE UNIQUE INDEX IF NOT EXISTS admin_users_email ON admin_users(email COLLATE NOCASE) WHERE email_verified_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,          -- SHA-256 of the token in the link (the token itself is never stored)
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS password_resets_user ON password_resets(user_id);

CREATE TABLE IF NOT EXISTS email_codes (
  user_id INTEGER PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
