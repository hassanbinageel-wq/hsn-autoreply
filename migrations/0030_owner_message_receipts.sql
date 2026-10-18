-- A permanent record per recipient of an owner message: delivered, read, opened the link, removed from the bell.
-- Kept even after the customer deletes the copy (or it expires); removed with the message itself.
CREATE TABLE IF NOT EXISTS owner_message_receipts (
  owner_message_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  delivered_at INTEGER NOT NULL,       -- first delivery
  last_delivered_at INTEGER NOT NULL,  -- latest (a reminder)
  read_at INTEGER,                     -- first read (kept)
  clicked_at INTEGER,                  -- first link open (kept)
  deleted_at INTEGER,                  -- removed from the bell by the customer (cleared by a reminder)
  PRIMARY KEY (owner_message_id, tenant_id)
);
CREATE INDEX IF NOT EXISTS owner_message_receipts_tenant ON owner_message_receipts(tenant_id);
INSERT OR IGNORE INTO owner_message_receipts (owner_message_id, tenant_id, delivered_at, last_delivered_at, read_at, clicked_at)
  SELECT owner_message_id, tenant_id, MIN(created_at), MAX(created_at), MIN(read_at), MIN(clicked_at)
    FROM app_notifications WHERE owner_message_id IS NOT NULL GROUP BY owner_message_id, tenant_id;
