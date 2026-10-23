-- Message top-ups: packs the owner sells (messages + price), bought by card when a customer runs out before the
-- cycle ends. A credit belongs to one usage cycle (30 days of the subscription) and is used after the plan's own.
CREATE TABLE IF NOT EXISTS topup_packs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  messages INTEGER NOT NULL,
  price_halalas INTEGER NOT NULL,
  badge TEXT,
  plan_ids TEXT,                            -- JSON array of plan ids that may buy it; NULL = every plan
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS message_credits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  cycle_key TEXT NOT NULL,                  -- usage_counters.month of the cycle it was added to
  messages INTEGER NOT NULL,
  pack_id INTEGER,
  payment_id INTEGER,
  amount INTEGER NOT NULL DEFAULT 0,        -- halalas paid (0 = added by the owner)
  source TEXT NOT NULL DEFAULT 'card',      -- card | owner
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS message_credits_tenant ON message_credits(tenant_id, cycle_key);
ALTER TABLE card_payments ADD COLUMN topup_pack_id INTEGER;
ALTER TABLE card_payments ADD COLUMN topup_messages INTEGER;

-- Example packs, off until the owner sets the prices and turns them on.
INSERT INTO topup_packs (messages, price_halalas, badge, plan_ids, active, sort, created_at, updated_at) VALUES
  (2000, 1500, NULL, NULL, 0, 1, 0, 0),
  (5000, 3500, 'الأكثر طلبًا', NULL, 0, 2, 0, 0),
  (10000, 6000, 'الأوفر', NULL, 0, 3, 0, 0);

-- Offers: a side box with a countdown, shown to every customer or chosen ones, linking where the owner chose.
CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT,
  cta TEXT,
  link TEXT NOT NULL DEFAULT '/subscription',
  theme TEXT NOT NULL DEFAULT 'violet',
  icon TEXT,
  starts_at INTEGER,
  ends_at INTEGER NOT NULL,
  audience TEXT NOT NULL DEFAULT 'all',     -- all | tenants
  tenant_ids TEXT,                          -- JSON array when audience = tenants
  active INTEGER NOT NULL DEFAULT 1,
  views INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS offers_active ON offers(active, ends_at);
