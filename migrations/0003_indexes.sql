-- Keep the per-minute notification checks cheap on D1 "rows read" (free tier: 5M/day).
CREATE INDEX IF NOT EXISTS action_jobs_status_updated ON action_jobs(status, updated_at);
CREATE INDEX IF NOT EXISTS flows_created ON conversation_flows(created_at);
