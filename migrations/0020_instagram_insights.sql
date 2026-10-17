-- Instagram's own metrics, read through the official Insights API (permission instagram_business_manage_insights).
-- Snapshots, not live values: Meta's numbers are lifetime totals that can lag up to 48h, so each read is stored with
-- its time and the latest snapshot is what the dashboard shows. NULL = Meta returned nothing for that metric
-- (unavailable), which is different from 0.

CREATE TABLE IF NOT EXISTS media_insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES instagram_accounts(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL,
  content_type TEXT,                 -- POST | CAROUSEL | REELS | STORY
  captured_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok','empty','permission','error')),
  views INTEGER,
  reach INTEGER,
  likes INTEGER,
  comments INTEGER,
  shares INTEGER,
  saved INTEGER,
  replies INTEGER,                   -- stories only
  total_interactions INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS media_insights_media ON media_insights(account_id, media_id, captured_at DESC);

-- Account-level values: daily reach split by follower / non-follower, daily follower count, and follower
-- demographics (age, gender, country — Meta returns only the top groups and only from 100 followers).
CREATE TABLE IF NOT EXISTS account_insights (
  account_id INTEGER NOT NULL REFERENCES instagram_accounts(id) ON DELETE CASCADE,
  day TEXT NOT NULL,                 -- YYYY-MM-DD (the day the value belongs to; demographics: the capture day)
  metric TEXT NOT NULL,              -- reach | follower_count | follower_demographics
  breakdown TEXT NOT NULL DEFAULT '',-- follow_type | age | gender | country | ''
  dim TEXT NOT NULL DEFAULT '',      -- FOLLOWER / NON_FOLLOWER / 18-24 / F / SA ... ('' = total)
  value INTEGER NOT NULL,
  captured_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, day, metric, breakdown, dim)
);
