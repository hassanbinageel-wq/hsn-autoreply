import { first } from "../lib/db";

/** Cloudflare free plan daily limits (reset at 00:00 UTC). */
export const FREE_LIMITS = { requests: 100_000, writes: 100_000 } as const;

/**
 * Approximate rows written per stored row, including index maintenance and the later status updates of the
 * same row (D1 counts every written row and index entry). Deliberately on the high side.
 */
const WRITE_COST = { event: 6, job: 10, attempt: 2, flow: 20, follow_check: 4, message: 6, click: 2, insight: 3, publish: 4 } as const;

export interface UsageEstimate {
  day_start: number;
  reset_at: number;
  requests: { used: number; limit: number; pct: number };
  writes: { used: number; limit: number; pct: number };
  counts: Record<string, number>;
}

/**
 * Today's usage estimated from what the system stored today (Cloudflare does not expose live quota counters to
 * the Worker itself). Good enough to warn well before a limit; the exact figures are in the Cloudflare dashboard.
 */
export async function estimateUsage(db: D1Database, now = Date.now()): Promise<UsageEstimate> {
  const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
  const n = async (sql: string) => (await first<{ n: number }>(db, sql, dayStart))?.n ?? 0;
  const [events, jobs, attempts, flows, followChecks, messages, clicks, insights, publishRows] = await Promise.all([
    n("SELECT COUNT(*) AS n FROM webhook_events WHERE received_at >= ?"),
    n("SELECT COUNT(*) AS n FROM action_jobs WHERE created_at >= ?"),
    n("SELECT COUNT(*) AS n FROM action_attempts WHERE started_at >= ?"),
    n("SELECT COUNT(*) AS n FROM conversation_flows WHERE created_at >= ?"),
    n("SELECT COUNT(*) AS n FROM follow_checks WHERE checked_at >= ?"),
    n("SELECT COUNT(*) AS n FROM messages WHERE created_at >= ?"),
    n("SELECT COALESCE(SUM(link_clicks), 0) AS n FROM conversation_flows WHERE link_last_click_at >= ?"),
    n("SELECT (SELECT COUNT(*) FROM media_insights WHERE captured_at >= ?1) + (SELECT COUNT(*) FROM account_insights WHERE captured_at >= ?1) AS n"),
    n("SELECT (SELECT COUNT(*) FROM publish_log WHERE at >= ?1) + (SELECT COUNT(*) FROM scheduled_media WHERE created_at >= ?1) AS n"),
  ]);
  const minutes = Math.floor((now - dayStart) / 60_000);
  // Requests: each webhook delivery, each link tap, each cron run, plus a margin for the app itself.
  const requests = Math.round((events + clicks + minutes) * 1.1);
  const writes = Math.round(
    events * WRITE_COST.event +
      jobs * WRITE_COST.job +
      attempts * WRITE_COST.attempt +
      flows * WRITE_COST.flow +
      followChecks * WRITE_COST.follow_check +
      messages * WRITE_COST.message +
      clicks * WRITE_COST.click +
      insights * WRITE_COST.insight +
      publishRows * WRITE_COST.publish,
  );
  const pct = (u: number, l: number) => Math.min(100, Math.round((u / l) * 1000) / 10);
  return {
    day_start: dayStart,
    reset_at: dayStart + 86_400_000,
    requests: { used: requests, limit: FREE_LIMITS.requests, pct: pct(requests, FREE_LIMITS.requests) },
    writes: { used: writes, limit: FREE_LIMITS.writes, pct: pct(writes, FREE_LIMITS.writes) },
    counts: { events, jobs, attempts, flows, follow_checks: followChecks, messages, clicks, insights, publish: publishRows },
  };
}

/** Free-plan limits of the other Cloudflare resources the service uses. */
export const FREE_STORAGE = {
  d1Bytes: 500 * 1024 * 1024, // D1 Free: 500 MB per database
  r2Bytes: 10 * 1024 ** 3, // R2: 10 GB-month free
  r2ClassA: 1_000_000, // uploads / writes per month
  r2ClassB: 10_000_000, // reads per month
} as const;

export interface Meter {
  key: string;
  label: string;
  used: number;
  limit: number;
  pct: number;
  unit: "count" | "bytes";
  period: "day" | "month" | "now";
  estimate: boolean;
  note: string;
}

/**
 * Everything the owner should watch on the free plan, as meters. Storage figures are exact (D1 reports its size;
 * every R2 file is uploaded and deleted by this system and recorded); request / write / R2-read figures are
 * estimates — the exact numbers are in the Cloudflare dashboard.
 */
export async function platformUsage(db: D1Database, r2Enabled: boolean, now = Date.now()): Promise<{ meters: Meter[]; generated_at: number }> {
  const daily = await estimateUsage(db, now);
  const size = (await db.prepare("SELECT 1").run()).meta.size_after ?? 0;
  const monthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
  const r2 = await first<{ bytes: number; files: number; uploads: number }>(
    db,
    `SELECT COALESCE(SUM(CASE WHEN deleted_at IS NULL THEN size END), 0) AS bytes, COALESCE(SUM(deleted_at IS NULL), 0) AS files,
            COALESCE(SUM(created_at >= ?), 0) AS uploads FROM scheduled_media`,
    monthStart,
  );
  const pct = (u: number, l: number) => Math.min(100, Math.round((u / l) * 1000) / 10);
  const m = (x: Omit<Meter, "pct">): Meter => ({ ...x, pct: pct(x.used, x.limit) });
  const meters: Meter[] = [
    m({ key: "requests", label: "طلبات الخادم اليوم", used: daily.requests.used, limit: daily.requests.limit, unit: "count", period: "day", estimate: true, note: "كل رسالة من Meta، وكل ضغطة رابط، وكل تشغيل للمهام. يتصفّر 03:00 بتوقيت السعودية." }),
    m({ key: "writes", label: "عمليات الكتابة في قاعدة البيانات اليوم", used: daily.writes.used, limit: daily.writes.limit, unit: "count", period: "day", estimate: true, note: "غالبًا أول حد يوصل له النظام. يتصفّر 03:00 بتوقيت السعودية." }),
    m({ key: "d1_size", label: "حجم قاعدة البيانات", used: size, limit: FREE_STORAGE.d1Bytes, unit: "bytes", period: "now", estimate: false, note: "الحد المجاني 500 ميجا لقاعدة البيانات. ينظف تلقائيًا حسب مدة الاحتفاظ في الإعدادات." }),
  ];
  if (r2Enabled) {
    meters.push(
      m({ key: "r2_size", label: "مساحة ملفات الجدولة (R2)", used: r2?.bytes ?? 0, limit: FREE_STORAGE.r2Bytes, unit: "bytes", period: "now", estimate: false, note: `${r2?.files ?? 0} ملف محفوظ الحين. الملفات تنحذف تلقائيًا بعد النشر.` }),
      m({ key: "r2_a", label: "عمليات رفع الملفات هذا الشهر (R2)", used: r2?.uploads ?? 0, limit: FREE_STORAGE.r2ClassA, unit: "count", period: "month", estimate: false, note: "كل ملف يرفعه عميل للجدولة = عملية وحدة." }),
      m({ key: "r2_b", label: "عمليات قراءة الملفات هذا الشهر (R2)", used: (r2?.uploads ?? 0) * 3, limit: FREE_STORAGE.r2ClassB, unit: "count", period: "month", estimate: true, note: "قراءة Meta للملف وقت النشر ومعاينات العميل (تقدير: 3 لكل ملف)." }),
    );
  }
  return { meters, generated_at: now };
}
