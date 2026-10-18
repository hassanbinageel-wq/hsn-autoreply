-- Owner messages kept as a history (to remind or delete them later), and an expiry for every bell notification.
CREATE TABLE IF NOT EXISTS owner_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER,                    -- NULL = every active customer (a notice)
  kind TEXT NOT NULL,                   -- message | service
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  keep_days INTEGER NOT NULL,
  reminders INTEGER NOT NULL DEFAULT 0,
  reminded_at INTEGER,
  created_at INTEGER NOT NULL
);
ALTER TABLE app_notifications ADD COLUMN expires_at INTEGER;
ALTER TABLE app_notifications ADD COLUMN owner_message_id INTEGER;
CREATE INDEX IF NOT EXISTS app_notifications_owner_message ON app_notifications(owner_message_id);
