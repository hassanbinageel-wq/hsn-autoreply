-- v1.2: click tracking, automatic follow reminder, auto-attach new posts, inbox, notifications.
-- Additive only (forward-safe): new nullable/defaulted columns and new tables.

-- 1) Link click tracking: each delivered content message gets its own opaque redirect token.
ALTER TABLE conversation_flows ADD COLUMN link_token TEXT;
ALTER TABLE conversation_flows ADD COLUMN link_url TEXT;
ALTER TABLE conversation_flows ADD COLUMN link_clicks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation_flows ADD COLUMN link_first_click_at INTEGER;
ALTER TABLE conversation_flows ADD COLUMN link_last_click_at INTEGER;
CREATE UNIQUE INDEX flows_link_token ON conversation_flows(link_token) WHERE link_token IS NOT NULL;
ALTER TABLE campaigns ADD COLUMN track_clicks INTEGER NOT NULL DEFAULT 1;

-- 2) Automatic follow reminder (0 = off). Sent only inside the 24h messaging window.
ALTER TABLE campaigns ADD COLUMN follow_reminder_minutes INTEGER NOT NULL DEFAULT 0;

-- 6) Auto-attach posts/reels published after a point in time.
ALTER TABLE campaigns ADD COLUMN auto_new_media INTEGER NOT NULL DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN auto_new_since INTEGER;
ALTER TABLE campaigns ADD COLUMN auto_new_reels_only INTEGER NOT NULL DEFAULT 0;

-- 10) Inbox: conversation messages (inbound, bot, manual replies, replies sent from the Instagram app).
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES instagram_accounts(id) ON DELETE CASCADE,
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  source TEXT NOT NULL CHECK (source IN ('user','bot','manual','app')),
  kind TEXT,
  text TEXT,
  mid TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX messages_mid ON messages(mid) WHERE mid IS NOT NULL;
CREATE INDEX messages_participant ON messages(participant_id, id);
CREATE INDEX messages_created ON messages(created_at);
ALTER TABLE participants ADD COLUMN last_message_at INTEGER;
ALTER TABLE participants ADD COLUMN inbox_read_at INTEGER;
CREATE INDEX participants_last_message ON participants(last_message_at);
