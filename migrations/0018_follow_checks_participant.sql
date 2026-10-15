-- The dashboard's "new followers" count looks up earlier checks of the same person.
CREATE INDEX IF NOT EXISTS follow_checks_participant ON follow_checks(participant_id, checked_at);
