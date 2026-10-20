-- Card payments (Moyasar): a fixed price in Saudi riyals per plan, and every checkout with its state.
ALTER TABLE plans ADD COLUMN card_price_halalas INTEGER;    -- NULL = no card payment for this plan
CREATE TABLE IF NOT EXISTS card_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  plan_id TEXT NOT NULL,
  days INTEGER NOT NULL,
  amount INTEGER NOT NULL,             -- halalas
  currency TEXT NOT NULL DEFAULT 'SAR',
  provider TEXT NOT NULL DEFAULT 'moyasar',
  invoice_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'initiated',   -- initiated | paid | failed | expired | canceled
  paid_at INTEGER,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS card_payments_tenant ON card_payments(tenant_id, id DESC);
