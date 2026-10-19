-- Changing the password from Settings: the new password waits (hashed) until the code emailed to the confirmed address is entered.
CREATE TABLE IF NOT EXISTS password_changes (
  user_id INTEGER PRIMARY KEY,
  new_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
