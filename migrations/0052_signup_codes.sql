-- Email confirmation inside the sign-up form (before the account exists), used by the free plan.
CREATE TABLE IF NOT EXISTS signup_codes (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
