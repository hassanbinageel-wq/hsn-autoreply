-- Important notifications inside the app (the bell): stock, disconnected account, failures, subscription, suggestions.
-- Written whether or not Telegram is set up; kept 90 days.
CREATE TABLE IF NOT EXISTS app_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  read_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS app_notifications_tenant ON app_notifications(tenant_id, created_at DESC);
