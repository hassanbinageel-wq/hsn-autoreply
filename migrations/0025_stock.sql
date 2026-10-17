-- Stock: products know whether they are available; campaigns that link to a product react when it runs out.
ALTER TABLE store_products ADD COLUMN stock_status TEXT;          -- 'in' | 'out' | NULL (unknown)
ALTER TABLE store_products ADD COLUMN quantity INTEGER;
ALTER TABLE store_products ADD COLUMN stock_changed_at INTEGER;

-- stock_action when the linked product runs out:
--   notify   = keep sending and alert the merchant;
--   pause    = pause the campaign, alert, resume when back in stock;
--   waitlist = reply "out of stock — reply «بلغني»" instead of the link; people who ask get a message when it is back
--              (only while Instagram's 24-hour window from their message is open).
ALTER TABLE campaigns ADD COLUMN stock_action TEXT NOT NULL DEFAULT 'notify';
ALTER TABLE campaigns ADD COLUMN out_of_stock_text TEXT;
ALTER TABLE campaigns ADD COLUMN stock_out_at INTEGER;            -- set while the linked product is out of stock
ALTER TABLE campaigns ADD COLUMN stock_paused INTEGER NOT NULL DEFAULT 0;

-- People who asked to be told when the product is back (they replied «بلغني» themselves).
CREATE TABLE IF NOT EXISTS restock_waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  participant_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','sent','window_closed','failed')),
  requested_at INTEGER NOT NULL,
  ready_at INTEGER,                                               -- product back in stock: send now
  done_at INTEGER,
  error TEXT,
  UNIQUE (campaign_id, participant_id)
);
CREATE INDEX IF NOT EXISTS restock_waitlist_ready ON restock_waitlist(status, ready_at);
