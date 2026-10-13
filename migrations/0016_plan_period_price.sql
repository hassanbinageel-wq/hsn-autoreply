-- When the current subscription period started (for the "days left" bar in the owner's customer list).
ALTER TABLE tenants ADD COLUMN plan_started_at INTEGER;
-- Existing subscriptions: assume a 30-day period ending at the current expiry.
UPDATE tenants SET plan_started_at = plan_expires_at - 2592000000 WHERE plan_expires_at IS NOT NULL;

-- Structured price set by the owner (price_label is generated from it, e.g. "99 ر.س / شهريًا").
ALTER TABLE plans ADD COLUMN price_amount REAL;
ALTER TABLE plans ADD COLUMN price_currency TEXT NOT NULL DEFAULT 'SAR';
ALTER TABLE plans ADD COLUMN price_period TEXT NOT NULL DEFAULT 'month';
