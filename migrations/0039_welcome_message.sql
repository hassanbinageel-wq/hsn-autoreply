-- Thank-you message a few minutes after a customer signs up (existing customers are marked as already welcomed).
ALTER TABLE tenants ADD COLUMN welcome_sent_at INTEGER;
UPDATE tenants SET welcome_sent_at = created_at;
