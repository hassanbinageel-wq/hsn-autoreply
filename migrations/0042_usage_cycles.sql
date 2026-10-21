-- Monthly limits now renew every 30 days of the subscription (from plan_started_at) instead of on the 1st of the
-- month. Carry this calendar month's usage into each customer's current cycle so nothing is reset by the change.
INSERT INTO usage_counters (tenant_id, month, messages)
SELECT u.tenant_id,
       'c' || COALESCE(t.plan_started_at, t.created_at) || '-' ||
         MAX(0, (CAST(strftime('%s', 'now') AS INTEGER) * 1000 - COALESCE(t.plan_started_at, t.created_at)) / 2592000000),
       u.messages
  FROM usage_counters u JOIN tenants t ON t.id = u.tenant_id
 WHERE u.month = strftime('%Y-%m', 'now')
ON CONFLICT(tenant_id, month) DO UPDATE SET messages = MAX(messages, excluded.messages);
