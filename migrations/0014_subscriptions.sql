-- Subscriptions: plans (limits editable by the owner), activation codes, monthly usage counters.
CREATE TABLE plans (
  id TEXT PRIMARY KEY,                -- basic | pro | max
  name TEXT NOT NULL,
  price_label TEXT,                   -- shown on the pricing page, e.g. "99 ر.س / شهريًا"
  description TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  limits TEXT NOT NULL,               -- JSON (src/shared/plans.ts PlanLimits)
  active INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
INSERT INTO plans (id, name, price_label, description, sort, limits, updated_at) VALUES
 ('basic', 'أساسي', NULL, 'للبداية: ردود تلقائية على التعليقات', 1,
  '{"active_campaigns":3,"monthly_messages":1000,"events":["comment"],"public_reply":false,"link_tracking":false,"inbox_manual":false,"telegram":false,"recover":false,"csv_export":false,"draws_per_month":0,"draw_video":false,"cards":false}', 0),
 ('pro', 'احترافي', NULL, 'كل الأحداث مع الإشعارات والرد اليدوي', 2,
  '{"active_campaigns":null,"monthly_messages":5000,"events":["comment","story_reply","story_mention"],"public_reply":true,"link_tracking":true,"inbox_manual":true,"telegram":true,"recover":true,"csv_export":true,"draws_per_month":1,"draw_video":false,"cards":false}', 0),
 ('max', 'الكامل', NULL, 'كل المزايا: سحوبات غير محدودة مع الفيديو وبطاقات التهنئة', 3,
  '{"active_campaigns":null,"monthly_messages":20000,"events":["comment","story_reply","story_mention"],"public_reply":true,"link_tracking":true,"inbox_manual":true,"telegram":true,"recover":true,"csv_export":true,"draws_per_month":null,"draw_video":true,"cards":true}', 0);

ALTER TABLE tenants ADD COLUMN plan_id TEXT;
ALTER TABLE tenants ADD COLUMN plan_expires_at INTEGER;
ALTER TABLE tenants ADD COLUMN expiry_notice_at INTEGER;

-- Only a hash of each code is stored; the code itself is shown once to the owner.
CREATE TABLE activation_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash TEXT NOT NULL UNIQUE,
  hint TEXT NOT NULL,                 -- last 4 characters, to recognise a code in the list
  plan_id TEXT NOT NULL,
  days INTEGER NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by_tenant INTEGER,
  revoked_at INTEGER
);
CREATE INDEX activation_codes_created ON activation_codes(created_at DESC);

-- Messages sent per customer per month (one small row per customer and month).
CREATE TABLE usage_counters (
  tenant_id INTEGER NOT NULL,
  month TEXT NOT NULL,                -- YYYY-MM (UTC)
  messages INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, month)
);
