-- Store analytics: profit and order breakdowns.
-- Orders keep money lines and coarse facts only: no shopper name, phone, email or street address.
-- customer_hash is a keyed one-way hash of the platform's customer id (to tell new from returning buyers).
ALTER TABLE store_orders ADD COLUMN subtotal REAL;
ALTER TABLE store_orders ADD COLUMN discount REAL;
ALTER TABLE store_orders ADD COLUMN shipping REAL;
ALTER TABLE store_orders ADD COLUMN tax REAL;
ALTER TABLE store_orders ADD COLUMN payment_method TEXT;
ALTER TABLE store_orders ADD COLUMN customer_hash TEXT;
ALTER TABLE store_orders ADD COLUMN city TEXT;
CREATE INDEX IF NOT EXISTS idx_store_orders_customer ON store_orders (store_id, customer_hash);

-- Unit cost: read from the platform when the merchant set one; the cost entered in HSN wins.
ALTER TABLE store_products ADD COLUMN cost REAL;
ALTER TABLE store_products ADD COLUMN cost_manual REAL;

-- Cost as a percentage of the selling price, for products without a unit cost.
ALTER TABLE stores ADD COLUMN default_cost_pct REAL;
