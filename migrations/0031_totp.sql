-- Two-step login (authenticator app codes) — offered to the owner. The secret is encrypted with TOKEN_ENC_KEY;
-- recovery codes are stored as SHA-256 hashes only.
ALTER TABLE admin_users ADD COLUMN totp_ciphertext TEXT;
ALTER TABLE admin_users ADD COLUMN totp_iv TEXT;
ALTER TABLE admin_users ADD COLUMN totp_enabled_at INTEGER;   -- NULL = set up but not confirmed yet (or off)
ALTER TABLE admin_users ADD COLUMN totp_last_step INTEGER;    -- last accepted 30-second step (no code is accepted twice)
ALTER TABLE admin_users ADD COLUMN totp_recovery TEXT;        -- JSON array of SHA-256 hashes of unused recovery codes
