-- The free plan is given once per Instagram account (it is the account that sends the replies), whichever
-- customer account it is connected to. Kept when a customer is deleted, so signing up again does not reset it.
CREATE TABLE IF NOT EXISTS free_claims (
  ig_user_id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  username TEXT,
  claimed_at INTEGER NOT NULL
);
-- Each free-plan activation, with a hash of the network address (not the address itself), to cap new free
-- accounts from one network per week.
CREATE TABLE IF NOT EXISTS free_activations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  ip_hash TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS free_activations_ip ON free_activations(ip_hash, at);
-- A free plan ended because its Instagram account had already used the free plan elsewhere.
CREATE TABLE IF NOT EXISTS free_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  ig_user_id TEXT NOT NULL,
  username TEXT,
  first_tenant_id INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS free_blocks_tenant ON free_blocks(tenant_id);
-- Customers already on the free plan with a connected account hold its claim.
INSERT OR IGNORE INTO free_claims (ig_user_id, tenant_id, username, claimed_at)
  SELECT a.ig_user_id, t.id, a.username, COALESCE(t.plan_started_at, t.updated_at)
    FROM tenants t JOIN plans p ON p.id = t.plan_id AND p.free = 1
    JOIN instagram_accounts a ON a.tenant_id = t.id AND a.is_demo = 0
   WHERE t.is_owner = 0;
