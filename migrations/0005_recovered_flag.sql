-- Marks comments that were picked up by the recovery (their webhook never arrived), to list them in the app.
ALTER TABLE webhook_events ADD COLUMN recovered INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS webhook_events_recovered ON webhook_events(received_at) WHERE recovered = 1;
