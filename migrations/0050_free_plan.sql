-- A free plan the customer subscribes to without paying (price shown as text, e.g. «مجاناً"), first in the list.
ALTER TABLE plans ADD COLUMN free INTEGER NOT NULL DEFAULT 0;
INSERT OR IGNORE INTO plans (id, name, price_label, description, sort, limits, active, free, price_currency, price_period, updated_at) VALUES
 ('free', 'الباقة المجانية', 'مجاناً', 'للتجربة: ردود تلقائية على التعليقات', 0,
  '{"active_campaigns":1,"monthly_messages":100,"events":["comment"],"public_reply":false,"link_tracking":false,"inbox_manual":false,"telegram":false,"recover":false,"csv_export":false,"draws_per_month":0,"draw_video":false,"cards":false}',
  0, 1, 'SAR', 'month', 0);
-- The card price is now the plan's own price (the separate card-price box is gone).
UPDATE plans SET card_price_halalas = NULL WHERE card_price_halalas IS NOT NULL;
