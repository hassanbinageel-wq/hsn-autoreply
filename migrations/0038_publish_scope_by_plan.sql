-- Publishing permission: asked automatically from every customer whose plan includes scheduling.
-- (The app is still in Meta development mode, where this only reaches accounts with a role in the app.)
INSERT INTO app_settings (key, value, updated_at) VALUES ('publish_scope', '"all"', CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(key) DO UPDATE SET value = '"all"', updated_at = excluded.updated_at;
