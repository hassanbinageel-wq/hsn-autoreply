-- Staff logins per plan (the owner can change them in «الباقات»): basic none, pro 1, max 3.
UPDATE plans SET limits = json_set(limits, '$.staff', CASE id WHEN 'pro' THEN 1 WHEN 'max' THEN 3 ELSE 0 END) WHERE json_extract(limits, '$.staff') IS NULL;
