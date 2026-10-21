-- Support center: tickets (type, state, priority, attachments), FAQ with videos, canned replies.
-- state: new | in_progress | waiting (waiting for the customer) | resolved. The old open/closed `status` is kept in step.
ALTER TABLE support_threads ADD COLUMN category TEXT NOT NULL DEFAULT 'question';   -- tech | question | billing | suggestion
ALTER TABLE support_threads ADD COLUMN state TEXT NOT NULL DEFAULT 'new';
ALTER TABLE support_threads ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal';    -- low | normal | high | urgent
ALTER TABLE support_threads ADD COLUMN closed_at INTEGER;
-- The old conversations become tickets.
UPDATE support_threads SET
  state = CASE
    WHEN status = 'closed' THEN 'resolved'
    WHEN last_from = 'owner' THEN 'waiting'
    WHEN EXISTS (SELECT 1 FROM support_messages m WHERE m.thread_id = support_threads.id AND m.sender = 'owner') THEN 'in_progress'
    ELSE 'new' END,
  closed_at = CASE WHEN status = 'closed' THEN updated_at END;
CREATE INDEX IF NOT EXISTS support_threads_state ON support_threads(state, closed_at);

-- One optional file per message (image ≤ 5 MB or video ≤ 25 MB) in R2; removed 30 days after the ticket is resolved.
ALTER TABLE support_messages ADD COLUMN att_key TEXT;
ALTER TABLE support_messages ADD COLUMN att_mime TEXT;
ALTER TABLE support_messages ADD COLUMN att_size INTEGER;
ALTER TABLE support_messages ADD COLUMN att_deleted_at INTEGER;

CREATE TABLE IF NOT EXISTS support_faq (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  video_url TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS support_canned (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
