-- Random Comment Picker (السحب العشوائي للفائزين).
CREATE TABLE draws (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('media','story')),
  media_id TEXT NOT NULL,
  media_permalink TEXT,
  media_caption TEXT,
  media_thumb TEXT,
  media_comments_count INTEGER,       -- as reported by Instagram (may differ from what the API returns)
  winners_count INTEGER NOT NULL,
  starts_at INTEGER,
  ends_at INTEGER,
  timezone TEXT,
  include_replies INTEGER NOT NULL DEFAULT 0,
  keyword TEXT,
  exclude_own INTEGER NOT NULL DEFAULT 1,
  excluded_accounts TEXT NOT NULL DEFAULT '[]',
  entry_mode TEXT NOT NULL DEFAULT 'per_person' CHECK (entry_mode IN ('per_person','per_comment')),
  allow_repeat_winner INTEGER NOT NULL DEFAULT 0,
  exclude_previous_winners INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','drawing','drawn')),
  fetch_status TEXT NOT NULL DEFAULT 'idle' CHECK (fetch_status IN ('idle','partial','complete','error')),
  fetch_state TEXT,                   -- resumable pagination state (JSON)
  fetch_error TEXT,
  fetched_count INTEGER NOT NULL DEFAULT 0,
  fetch_updated_at INTEGER,
  eligible_count INTEGER,             -- frozen at draw time
  unique_people INTEGER,
  drawn_at INTEGER,
  draw_request_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX draws_campaign ON draws(campaign_id, id DESC);

CREATE TABLE draw_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draw_id INTEGER NOT NULL REFERENCES draws(id) ON DELETE CASCADE,
  comment_id TEXT NOT NULL,
  author_id TEXT,
  author_username TEXT,
  text TEXT,
  created_time INTEGER,
  parent_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('comment','reply','story_reply')),
  eligible INTEGER,                   -- frozen at draw time (NULL before)
  exclude_reason TEXT,
  UNIQUE (draw_id, comment_id)
);
CREATE INDEX draw_entries_draw ON draw_entries(draw_id, eligible);

CREATE TABLE draw_winners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draw_id INTEGER NOT NULL REFERENCES draws(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  entry_id INTEGER NOT NULL REFERENCES draw_entries(id),
  identity_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','replaced')),
  replaced_reason TEXT,
  replaced_at INTEGER,
  replaced_by INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX draw_winners_draw ON draw_winners(draw_id, position);
CREATE INDEX draw_winners_identity ON draw_winners(identity_key, status);
