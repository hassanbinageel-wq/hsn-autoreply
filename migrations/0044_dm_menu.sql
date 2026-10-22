-- «القائمة التلقائية» in direct messages (the menu itself is a per-customer setting: dm_menu).
ALTER TABLE participants ADD COLUMN menu_sent_at INTEGER;   -- when this person last got the menu
CREATE TABLE IF NOT EXISTS dm_menu_taps (
  tenant_id INTEGER NOT NULL,
  node_key TEXT NOT NULL,
  taps INTEGER NOT NULL DEFAULT 0,
  last_at INTEGER,
  PRIMARY KEY (tenant_id, node_key)
);
