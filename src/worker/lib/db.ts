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

export async function getSetting<T>(db: D1Database, key: string, fallback: T): Promise<T> {
  const row = await first<{ value: string }>(db, "SELECT value FROM app_settings WHERE key = ?", key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export async function setSetting(db: D1Database, key: string, value: unknown, now = Date.now()): Promise<void> {
  await run(
    db,
    "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    key,
    JSON.stringify(value),
    now,
  );
}

export async function audit(db: D1Database, actor: string, action: string, target?: string, details?: unknown): Promise<void> {
  await run(
    db,
    "INSERT INTO audit_logs (at, actor, action, target, details) VALUES (?, ?, ?, ?, ?)",
    Date.now(),
    actor,
    action,
    target ?? null,
    details === undefined ? null : JSON.stringify(details).slice(0, 2000),
  );
}
