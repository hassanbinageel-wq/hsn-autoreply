-- New plan features: simulator, per-campaign stats, undo. On in "max" only (the owner can change it from the plans tab).
-- json_set keeps every other value the owner may already have edited (prices, limits).
UPDATE plans SET limits = json_set(limits, '$.simulator', json('true'), '$.campaign_stats', json('true'), '$.undo', json('true')) WHERE id = 'max';
UPDATE plans SET limits = json_set(limits, '$.simulator', json('false'), '$.campaign_stats', json('false'), '$.undo', json('false')) WHERE id != 'max';
