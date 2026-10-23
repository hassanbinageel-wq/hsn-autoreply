-- Who saw and who opened each offer (once per customer and kind), for the owner's offer details.
CREATE TABLE IF NOT EXISTS offer_events (
  offer_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                       -- view | click
  created_at INTEGER NOT NULL,
  PRIMARY KEY (offer_id, tenant_id, kind)
);
CREATE INDEX IF NOT EXISTS offer_events_tenant ON offer_events(tenant_id);
