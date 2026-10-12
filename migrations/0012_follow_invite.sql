-- Optional follow invitation for every campaign (Meta Spam policy: no follow-gating of content).
-- The follow REQUIREMENT stays available only on Instagram accounts the owner explicitly allows
-- (instagram_accounts.follow_gate_allowed, set from the admin panel). Existing accounts are the owner's own.
ALTER TABLE campaigns ADD COLUMN follow_invite INTEGER NOT NULL DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN follow_invite_text TEXT;
ALTER TABLE instagram_accounts ADD COLUMN follow_gate_allowed INTEGER NOT NULL DEFAULT 0;
UPDATE instagram_accounts SET follow_gate_allowed = 1;
