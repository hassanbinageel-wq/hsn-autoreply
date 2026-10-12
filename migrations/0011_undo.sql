-- Last operations that can be reverted from the log (kept to the latest 10).
CREATE TABLE undo_ops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,                -- e.g. campaign.update, template.delete, draw.clear
  target TEXT NOT NULL,              -- e.g. campaign:12 (an operation can only be undone if it is the latest on its target)
  label TEXT NOT NULL,               -- Arabic description shown in the log
  payload TEXT,                      -- JSON snapshot needed to revert; NULL = too large to keep
  undone_at INTEGER,
  undone_by TEXT
);
