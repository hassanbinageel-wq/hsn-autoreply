-- Multi-tenant (customers). Tenant 1 is the owner: every existing row belongs to it.
CREATE TABLE tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  is_owner INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO tenants (id, name, is_owner, status, created_at, updated_at)
VALUES (1, 'المالك', 1, 'active', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);

-- More than one login is now allowed (one or more per tenant).
DROP INDEX IF EXISTS admin_users_singleton;
ALTER TABLE admin_users ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX admin_users_tenant ON admin_users(tenant_id);

ALTER TABLE instagram_accounts ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE campaigns ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE templates ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE card_designs ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE draws ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE audit_logs ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE undo_ops ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;

CREATE INDEX instagram_accounts_tenant ON instagram_accounts(tenant_id);
CREATE INDEX campaigns_tenant ON campaigns(tenant_id, status);
CREATE INDEX templates_tenant ON templates(tenant_id);
CREATE INDEX card_designs_tenant ON card_designs(tenant_id);
CREATE INDEX draws_tenant ON draws(tenant_id, id DESC);
CREATE INDEX audit_logs_tenant ON audit_logs(tenant_id, at DESC);
CREATE INDEX undo_ops_tenant ON undo_ops(tenant_id, id DESC);
