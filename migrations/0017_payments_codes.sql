-- Where customers pay: banks / exchange offices (with a small logo) and their accounts (several per provider, e.g. one per currency).
CREATE TABLE payment_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'bank',     -- bank | exchange
  logo TEXT,                             -- small data: URL (resized in the browser)
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE payment_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL REFERENCES payment_providers(id) ON DELETE CASCADE,
  holder TEXT NOT NULL,                  -- account name
  number TEXT NOT NULL,                  -- account number / IBAN
  currency TEXT,                         -- USD | SAR | YER | YER_SAN
  note TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX payment_accounts_provider ON payment_accounts(provider_id, sort);

-- Who used a code, kept even if the customer is deleted later.
ALTER TABLE activation_codes ADD COLUMN used_by_name TEXT;
ALTER TABLE activation_codes ADD COLUMN used_by_username TEXT;
UPDATE activation_codes SET
  used_by_name = (SELECT name FROM tenants WHERE id = activation_codes.used_by_tenant),
  used_by_username = (SELECT username FROM admin_users WHERE tenant_id = activation_codes.used_by_tenant ORDER BY id LIMIT 1)
WHERE used_by_tenant IS NOT NULL;

-- Only four currencies are offered now.
UPDATE plans SET price_currency = 'USD' WHERE price_currency NOT IN ('USD', 'SAR', 'YER', 'YER_SAN');
