-- Google Analytics links (UTM) become a plan feature: on in the top plan, off in the others (editable in «الباقات»).
UPDATE plans SET limits = json_set(limits, '$.utm', CASE WHEN id = 'max' THEN json('true') ELSE json('false') END) WHERE json_extract(limits, '$.utm') IS NULL;
-- New default order of plan points (strongest features first); the owner can reorder again.
DELETE FROM app_settings WHERE key = 'feature_order';
