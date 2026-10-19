-- Staff logins: an account holder (role 'owner') adds staff (role 'staff') with only the sections they choose.
ALTER TABLE admin_users ADD COLUMN role TEXT NOT NULL DEFAULT 'owner';   -- owner = the account holder | staff
ALTER TABLE admin_users ADD COLUMN perms TEXT NOT NULL DEFAULT '[]';     -- staff: JSON list of section keys (src/shared/staff.ts)
ALTER TABLE admin_users ADD COLUMN display_name TEXT;                     -- staff: shown in the app and the audit log
ALTER TABLE admin_users ADD COLUMN disabled_at INTEGER;                   -- staff: switched off (cannot sign in)
ALTER TABLE admin_users ADD COLUMN created_by INTEGER;
ALTER TABLE messages ADD COLUMN sent_by TEXT;                             -- inbox: the staff member who wrote a manual reply
