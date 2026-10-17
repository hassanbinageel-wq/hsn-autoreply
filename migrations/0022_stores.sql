-- Online stores (Salla first, Zid later) connected through each platform's official OAuth, read-only.
-- No shopper personal data is stored: orders keep only amounts, status, coupon, products and time.

CREATE TABLE IF NOT EXISTS stores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('salla','zid')),
  merchant_id TEXT NOT NULL,
  name TEXT,
  domain TEXT,
  avatar_url TEXT,
  token_ciphertext TEXT,
  token_iv TEXT,
  refresh_ciphertext TEXT,
  refresh_iv TEXT,
  token_expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','needs_reauth','disconnected')),
  last_error TEXT,
  products_synced_at INTEGER,
  connected_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (platform, merchant_id)
);
CREATE INDEX IF NOT EXISTS stores_tenant ON stores(tenant_id);

CREATE TABLE IF NOT EXISTS store_products (
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  name TEXT,
  url TEXT,
  image_url TEXT,
  price REAL,
  currency TEXT,
  status TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (store_id, product_id)
);

CREATE TABLE IF NOT EXISTS store_orders (
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL,
  reference TEXT,
  status TEXT,                      -- platform status slug (e.g. under_review, completed, canceled, refunded)
  total REAL,
  currency TEXT,
  coupon TEXT,                      -- upper-cased coupon code, for campaign attribution
  items TEXT NOT NULL DEFAULT '[]', -- JSON [{product_id, name, qty, amount}]
  ordered_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (store_id, order_id)
);
CREATE INDEX IF NOT EXISTS store_orders_time ON store_orders(store_id, ordered_at);
CREATE INDEX IF NOT EXISTS store_orders_coupon ON store_orders(store_id, coupon);

CREATE TABLE IF NOT EXISTS store_oauth_states (
  state_hash TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  client TEXT NOT NULL DEFAULT 'web',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

-- A campaign's discount code in the customer's store: orders that use it are counted for the campaign.
ALTER TABLE campaigns ADD COLUMN store_coupon TEXT;
