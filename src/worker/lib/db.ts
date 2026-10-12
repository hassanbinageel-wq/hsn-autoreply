export async function first<T = any>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  return (await db.prepare(sql).bind(...params).first<T>()) ?? null;
}

export async function all<T = any>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const r = await db.prepare(sql).bind(...params).all<T>();
  return r.results ?? [];
}

export async function run(db: D1Database, sql: string, ...params: unknown[]): Promise<D1Result> {
  return db.prepare(sql).bind(...params).run();
}

export function isUniqueViolation(err: unknown): boolean {
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(String((err as Error)?.message ?? err));
}

/** The owner tenant: every row that existed before customers belongs to it. */
export const OWNER_TENANT = 1;

/**
 * Settings are per tenant. The owner keeps the original keys; other tenants use «t<id>:<key>»,
 * so the owner's data needed no migration.
 */
export function settingKey(tenantId: number, key: string): string {
  if (!Number.isInteger(tenantId) || tenantId < 1) throw new Error("invalid tenant");
  return tenantId === OWNER_TENANT ? key : `t${tenantId}:${key}`;
}

/** SQL condition (on app_settings.key) for one tenant's settings, and how to strip the prefix. */
export function tenantSettingsFilter(tenantId: number): { where: string; params: unknown[]; strip: (k: string) => string } {
  if (tenantId === OWNER_TENANT) return { where: "key NOT LIKE 't%:%'", params: [], strip: (k) => k };
  const prefix = `t${tenantId}:`;
  return { where: "substr(key, 1, ?) = ?", params: [prefix.length, prefix], strip: (k) => k.slice(prefix.length) };
}

export async function getSetting<T>(db: D1Database, tenantId: number, key: string, fallback: T): Promise<T> {
  const row = await first<{ value: string }>(db, "SELECT value FROM app_settings WHERE key = ?", settingKey(tenantId, key));
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export async function setSetting(db: D1Database, tenantId: number, key: string, value: unknown, now = Date.now()): Promise<void> {
  await run(
    db,
    "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    settingKey(tenantId, key),
    JSON.stringify(value),
    now,
  );
}

export async function audit(db: D1Database, tenantId: number, actor: string, action: string, target?: string, details?: unknown): Promise<void> {
  await run(
    db,
    "INSERT INTO audit_logs (tenant_id, at, actor, action, target, details) VALUES (?, ?, ?, ?, ?, ?)",
    tenantId,
    Date.now(),
    actor,
    action,
    target ?? null,
    details === undefined ? null : JSON.stringify(details).slice(0, 2000),
  );
}
