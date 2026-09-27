-- Indexes so the daily usage estimate only reads today's rows.
CREATE INDEX IF NOT EXISTS action_jobs_created ON action_jobs(created_at);
CREATE INDEX IF NOT EXISTS action_attempts_started ON action_attempts(started_at);
CREATE INDEX IF NOT EXISTS follow_checks_checked ON follow_checks(checked_at);
CREATE INDEX IF NOT EXISTS flows_last_click ON conversation_flows(link_last_click_at) WHERE link_last_click_at IS NOT NULL;
