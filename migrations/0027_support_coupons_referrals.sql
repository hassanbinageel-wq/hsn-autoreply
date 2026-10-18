-- In-app support: a customer opens a conversation with the owner; both sides reply.
CREATE TABLE IF NOT EXISTS support_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  last_from TEXT NOT NULL DEFAULT 'customer' CHECK (last_from IN ('customer','owner')),
  customer_read_at INTEGER,
  owner_read_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS support_threads_tenant ON support_threads(tenant_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS support_threads_updated ON support_threads(status, updated_at DESC);
CREATE TABLE IF NOT EXISTS support_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
  sender TEXT NOT NULL CHECK (sender IN ('customer','owner')),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS support_messages_thread ON support_messages(thread_id, id);

-- Subscription discount codes (shown on the plans page; the code travels with the payment receipt).
CREATE TABLE IF NOT EXISTS sub_coupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  percent INTEGER NOT NULL CHECK (percent BETWEEN 1 AND 100),
  plan_ids TEXT,                      -- JSON array of plan ids; NULL = every plan
  expires_at INTEGER,
  max_uses INTEGER,
  uses INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  created_at INTEGER NOT NULL
);

-- Referrals: each customer can share a code; a new customer who signs up with it gives both sides bonus days.
ALTER TABLE tenants ADD COLUMN referral_code TEXT;
ALTER TABLE tenants ADD COLUMN referred_by INTEGER;
ALTER TABLE tenants ADD COLUMN referral_rewarded_at INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS tenants_referral_code ON tenants(referral_code) WHERE referral_code IS NOT NULL;

-- Google Analytics / store reports: UTM tags on a campaign's link (on by default).
ALTER TABLE campaigns ADD COLUMN utm INTEGER NOT NULL DEFAULT 1;
