-- HSN AutoReply — initial schema (Cloudflare D1 / SQLite)
-- All timestamps are INTEGER milliseconds since epoch (UTC).
-- All Meta identifiers are TEXT.


CREATE TABLE admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Only one admin may ever exist (no public registration).
CREATE UNIQUE INDEX admin_users_singleton ON admin_users ((1));

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,               -- SHA-256 of the opaque session token
  user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('web','device')),
  csrf_token TEXT,                   -- web sessions only
  device_label TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expires ON sessions(expires_at);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,       -- SHA-256 of the random state
  user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  client TEXT NOT NULL CHECK (client IN ('web','app')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE instagram_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ig_user_id TEXT NOT NULL UNIQUE,   -- Instagram professional account ID (webhook entry.id)
  app_scoped_id TEXT,                -- "id" returned by /me (app-scoped)
  username TEXT,
  name TEXT,
  profile_picture_url TEXT,
  account_type TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  token_ciphertext TEXT,             -- AES-GCM encrypted long-lived token (never returned by the API)
  token_iv TEXT,
  token_key_version INTEGER,
  token_expires_at INTEGER,
  token_refreshed_at INTEGER,
  scopes TEXT NOT NULL DEFAULT '[]',
  webhook_fields TEXT NOT NULL DEFAULT '[]',
  webhook_status TEXT NOT NULL DEFAULT 'unknown',   -- unknown | subscribed | failed | not_subscribed
  last_webhook_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','needs_reauth','disconnected')),
  follow_check_support TEXT NOT NULL DEFAULT 'unknown', -- unknown | supported | unsupported
  follow_check_note TEXT,
  last_error TEXT,
  api_version TEXT,
  connected_at INTEGER,
  disconnected_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE media_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES instagram_accounts(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('media','story')),
  media_type TEXT,
  media_product_type TEXT,
  caption TEXT,
  permalink TEXT,
  thumbnail_url TEXT,               -- preview only; videos are never stored
  posted_at INTEGER,
  expires_at INTEGER,               -- stories: posted_at + 24h
  fetched_at INTEGER NOT NULL,
  UNIQUE (account_id, media_id)
);
CREATE INDEX media_cache_kind ON media_cache(account_id, kind, posted_at DESC);

CREATE TABLE campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER REFERENCES instagram_accounts(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('comment','story_reply','story_mention')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','archived')),
  priority INTEGER NOT NULL DEFAULT 100,
  scope TEXT NOT NULL DEFAULT 'all' CHECK (scope IN ('all','selected')),
  match_all INTEGER NOT NULL DEFAULT 0,
  unify_alef INTEGER NOT NULL DEFAULT 1,
  include_replies INTEGER NOT NULL DEFAULT 0,
  require_follow INTEGER NOT NULL DEFAULT 0,
  opening_text TEXT,
  follow_request_text TEXT,
  follow_reminder_text TEXT,
  verify_error_text TEXT,
  final_text TEXT NOT NULL DEFAULT '',
  final_url TEXT,
  public_reply_enabled INTEGER NOT NULL DEFAULT 0,
  public_reply_text TEXT,
  public_reply_on_dm_fail TEXT NOT NULL DEFAULT 'none' CHECK (public_reply_on_dm_fail IN ('none','fallback')),
  public_reply_fallback_text TEXT,
  schedule_start INTEGER,
  schedule_end INTEGER,
  timezone TEXT NOT NULL DEFAULT 'Asia/Aden',
  per_user_cooldown_hours INTEGER NOT NULL DEFAULT 24,
  max_deliveries_per_user INTEGER NOT NULL DEFAULT 1,
  max_verify_attempts INTEGER NOT NULL DEFAULT 5,
  verify_cooldown_seconds INTEGER NOT NULL DEFAULT 30,
  process_old_events INTEGER NOT NULL DEFAULT 0,
  activated_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX campaigns_active ON campaigns(type, status, priority DESC);

CREATE TABLE campaign_media (
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL,
  PRIMARY KEY (campaign_id, media_id)
);
CREATE INDEX campaign_media_media ON campaign_media(media_id);

CREATE TABLE campaign_keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('include','exclude')),
  match_type TEXT NOT NULL CHECK (match_type IN ('exact','word','contains'))
);
CREATE INDEX campaign_keywords_campaign ON campaign_keywords(campaign_id);

CREATE TABLE templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('public','opening','follow_request','reminder','final','error','mention')),
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedup_key TEXT NOT NULL UNIQUE,     -- e.g. comment:<comment_id>, msg:<mid>, postback:<mid>
  account_ig_id TEXT NOT NULL,
  event_type TEXT NOT NULL,           -- comment | story_reply | story_mention | message | postback | quick_reply | echo | other
  sender_id TEXT,
  sender_username TEXT,
  media_id TEXT,
  text TEXT,
  payload TEXT NOT NULL,              -- normalized event JSON (minimal, no raw secrets)
  event_time INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processed','ignored','failed')),
  reason TEXT,
  campaign_id INTEGER,
  flow_id INTEGER,
  processed_at INTEGER
);
CREATE INDEX webhook_events_received ON webhook_events(received_at DESC);
CREATE INDEX webhook_events_status ON webhook_events(status, received_at DESC);

CREATE TABLE participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES instagram_accounts(id) ON DELETE CASCADE,
  igsid TEXT NOT NULL,                -- Instagram-scoped ID of the user
  username TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  last_user_message_at INTEGER,       -- last inbound DM (opens the standard messaging window)
  consent_at INTEGER,                 -- first qualifying inbound message (User Profile API consent)
  last_follow_status TEXT,
  last_follow_checked_at INTEGER,
  demo_follow_script TEXT,            -- demo only: scripted follow-check outcomes
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (account_id, igsid)
);

CREATE TABLE conversation_flows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES instagram_accounts(id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  trigger_event_id INTEGER,
  trigger_type TEXT NOT NULL,
  source_comment_id TEXT,
  source_media_id TEXT,
  state TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 0,
  start_token TEXT NOT NULL UNIQUE,   -- opaque, server-verified button payload
  verify_token TEXT NOT NULL UNIQUE,
  private_reply_status TEXT,          -- action status of the one private reply
  public_reply_status TEXT,
  content_status TEXT,
  verify_attempts INTEGER NOT NULL DEFAULT 0,
  verify_window_start INTEGER,
  last_verify_at INTEGER,
  last_follow_result TEXT,
  content_delivered_at INTEGER,
  state_reason TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX flows_participant ON conversation_flows(participant_id, state, updated_at DESC);
CREATE INDEX flows_campaign ON conversation_flows(campaign_id, state);
-- At most one open (non-terminal) flow per campaign + participant.
CREATE UNIQUE INDEX flows_one_open ON conversation_flows(campaign_id, participant_id)
  WHERE state NOT IN ('content_sent','verification_unavailable','expired','failed','cancelled');

-- Used by the per-minute expiry sweep (keeps D1 rows-read low on the free plan).
CREATE INDEX flows_open_expires ON conversation_flows(expires_at)
  WHERE state NOT IN ('content_sent','verification_unavailable','expired','failed','cancelled');

CREATE TABLE follow_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flow_id INTEGER REFERENCES conversation_flows(id) ON DELETE CASCADE,
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  result TEXT NOT NULL CHECK (result IN ('following','not_following','unknown','needs_interaction','temporary_error','unsupported')),
  field_present INTEGER NOT NULL DEFAULT 0,
  http_status INTEGER,
  error_code TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  checked_at INTEGER NOT NULL
);
CREATE INDEX follow_checks_flow ON follow_checks(flow_id, checked_at DESC);

CREATE TABLE action_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER,
  kind TEXT NOT NULL,                 -- process_event | private_reply | public_reply | send_dm | follow_check | refresh_token
  purpose TEXT,                       -- opening | follow_request | reminder | content | verify_error | mention ...
  flow_id INTEGER,
  campaign_id INTEGER,
  event_id INTEGER,
  dedup_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL DEFAULT '{}',
  is_demo INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','accepted','retry_scheduled','uncertain','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  run_at INTEGER NOT NULL,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  external_call_started_at INTEGER,   -- set right before the Meta request; used to detect uncertain outcomes
  result TEXT,                        -- e.g. {"message_id": "..."}
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX action_jobs_due ON action_jobs(status, run_at);
CREATE INDEX action_jobs_flow ON action_jobs(flow_id);
CREATE INDEX action_jobs_campaign ON action_jobs(campaign_id, status);

CREATE TABLE action_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES action_jobs(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  outcome TEXT,
  http_status INTEGER,
  error_code TEXT,
  error_message TEXT,
  retry_after_ms INTEGER
);
CREATE INDEX action_attempts_job ON action_attempts(job_id);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT
);
CREATE INDEX audit_logs_at ON audit_logs(at DESC);

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO app_settings (key, value, updated_at) VALUES
  ('automation_enabled', 'true', 0),
  ('timezone', '"Asia/Aden"', 0),
  ('retention_days', '90', 0),
  ('dedup_retention_days', '30', 0),
  ('any_reply_counts_as_start', 'true', 0),
  ('global_user_hourly_limit', '10', 0);

INSERT INTO templates (kind, name, body, created_at, updated_at) VALUES
  ('opening', 'تمهيدي — طلب ابدأ', 'حياك الله {{first_name|يا غالي}} 🙌 رد بكلمة ابدأ عشان أتحقق من المتابعة وأرسل لك المحتوى.', 0, 0),
  ('follow_request', 'طلب متابعة', 'باقي خطوة بسيطة 🔥 تابع حسابنا {{account_link}} ثم ارجع هنا واضغط «تحقّق من المتابعة» (أو اكتب: تحقق) عشان أوصلك المحتوى.', 0, 0),
  ('reminder', 'تذكير لطيف', 'لسا ما ظهرت لنا متابعتك 🙏 تأكد إنك تابعت {{account_link}} ثم جرّب «تحقق» بعد دقيقة.', 0, 0),
  ('error', 'تعذر التحقق', 'ما قدرنا نتحقق من المتابعة الآن ⏳ جرّب تكتب «تحقق» بعد شوي.', 0, 0),
  ('public', 'رد عام — شيّك الخاص', 'شيّك الخاص لإكمال الخطوات 🙌', 0, 0),
  ('final', 'المحتوى النهائي', 'تفضل 🎁 {{content_url}}', 0, 0),
  ('mention', 'شكر على المنشن', 'تسلم على المنشن 🙌 هذه هديتنا لك: {{content_url}}', 0, 0);
