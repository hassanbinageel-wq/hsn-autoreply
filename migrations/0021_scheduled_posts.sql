-- Scheduled publishing through the official Content Publishing API (instagram_business_content_publish).
-- Files live in the private R2 bucket only until the post is published (then they are deleted); Meta fetches them
-- through short-lived signed links on /m/*.

CREATE TABLE IF NOT EXISTS scheduled_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL REFERENCES instagram_accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('IMAGE','CAROUSEL','REELS','STORY')),
  caption TEXT,
  publish_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','scheduled','publishing','published','failed','cancelled','uncertain')),
  share_to_feed INTEGER NOT NULL DEFAULT 1,      -- reels: also show in the profile grid
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,  -- runs on this post once it is live
  container_id TEXT,                             -- the container to publish (carousel: the parent)
  children TEXT,                                 -- carousel: JSON list of child container ids, in order
  publish_requested_at INTEGER,                  -- media_publish was called (never call it twice blindly)
  media_id TEXT,
  permalink TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error TEXT,
  published_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS scheduled_posts_due ON scheduled_posts(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS scheduled_posts_tenant ON scheduled_posts(tenant_id, publish_at);

CREATE TABLE IF NOT EXISTS scheduled_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES scheduled_posts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'item' CHECK (role IN ('item','cover')),
  r2_key TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  deleted_at INTEGER,                            -- removed from R2 after publishing / cancelling
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS scheduled_media_post ON scheduled_media(post_id, position);

-- What the publisher did, step by step (shown to the customer).
CREATE TABLE IF NOT EXISTS publish_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES scheduled_posts(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  step TEXT NOT NULL,
  ok INTEGER NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS publish_log_post ON publish_log(post_id, at);
