-- Plan upgrades: the customer asks, the owner reviews the usage and approves an amount (the price difference),
-- the customer pays it by card, and the plan changes with the same expiry date.
CREATE TABLE IF NOT EXISTS plan_upgrades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  from_plan TEXT NOT NULL,
  to_plan TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected | canceled | paid | done (approved for free)
  suggested INTEGER NOT NULL,               -- halalas, computed when asked
  amount INTEGER,                           -- halalas approved by the owner
  used_messages INTEGER NOT NULL DEFAULT 0, -- in the current cycle, when asked
  days_left INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  payment_id INTEGER,
  decided_by TEXT,
  decided_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS plan_upgrades_tenant ON plan_upgrades(tenant_id, id DESC);
CREATE INDEX IF NOT EXISTS plan_upgrades_status ON plan_upgrades(status, id DESC);
ALTER TABLE card_payments ADD COLUMN upgrade_id INTEGER;  -- set when the payment is an upgrade difference
