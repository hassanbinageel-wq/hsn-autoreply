-- One row per real tap on a tracked campaign link: when, and the visitor's OS family read from the browser's
-- User-Agent (approximate). Feeds the activity heatmap and "devices of campaign link visitors".
CREATE TABLE IF NOT EXISTS link_clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flow_id INTEGER NOT NULL REFERENCES conversation_flows(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL,
  clicked_at INTEGER NOT NULL,
  os TEXT NOT NULL CHECK (os IN ('android','ios','other','unknown'))
);
CREATE INDEX IF NOT EXISTS link_clicks_account ON link_clicks(account_id, clicked_at);
CREATE INDEX IF NOT EXISTS link_clicks_flow ON link_clicks(flow_id);
