-- Inbox: conversation labels (inquiry / order / complaint / other) and saved replies.
-- inbox_label_source: 'auto' (suggested from the person's words, replaced by later messages) or 'manual' (kept).
ALTER TABLE participants ADD COLUMN inbox_label TEXT;
ALTER TABLE participants ADD COLUMN inbox_label_source TEXT;

CREATE TABLE IF NOT EXISTS saved_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS saved_replies_tenant ON saved_replies(tenant_id, uses DESC);
