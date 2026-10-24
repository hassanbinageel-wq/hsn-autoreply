-- Offers for subscribers of chosen plans (or everyone except them), and a real card discount on chosen plans that
-- only the customers the offer is for get while it runs.
ALTER TABLE offers ADD COLUMN plan_ids TEXT;            -- JSON plan ids for audience = plans | except_plans
ALTER TABLE offers ADD COLUMN discount_pct INTEGER;     -- 1..90, NULL = no discount (a banner only)
ALTER TABLE offers ADD COLUMN discount_plans TEXT;      -- JSON plan ids the discount applies to; NULL = every plan
ALTER TABLE card_payments ADD COLUMN offer_id INTEGER;  -- the offer whose discount this payment used
