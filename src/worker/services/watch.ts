import type { Env } from "../env";
import { all, first, getSetting, OWNER_TENANT, setSetting } from "../lib/db";
import { cleanError } from "./diagnose";
import { notify } from "./notify";

/**
 * Every 10 minutes: problems that hit the whole service (not one customer) — a wave of failed sends, events that
 * fail to process, many accounts losing their connection at once, scheduled posts failing. (A quiet spell is not
 * one of them: see `checkSilence`.)
 * The owner is told once when it starts (again every 3 hours while it lasts), and once when it is back to normal.
 */

export type Issue = { key: string; text: string };

const MIN = 60_000;
const H = 3_600_000;
const REPEAT_MS = 3 * H;

export async function systemIssues(db: D1Database, now = Date.now(), prevKeys: string[] = []): Promise<Issue[]> {
  const issues: Issue[] = [];
  const since = now - 30 * MIN;

  // 1) failed sends across customers
  const jobs = await first<{ failed: number; ok: number; tenants: number }>(
    db,
    `SELECT COUNT(CASE WHEN j.status IN ('failed','uncertain') THEN 1 END) AS failed,
            COUNT(CASE WHEN j.status = 'accepted' THEN 1 END) AS ok,
            COUNT(DISTINCT CASE WHEN j.status IN ('failed','uncertain') THEN a.tenant_id END) AS tenants
       FROM action_jobs j JOIN instagram_accounts a ON a.id = j.account_id
      WHERE j.is_demo = 0 AND j.updated_at >= ?`,
    since,
  );
  if (jobs && jobs.failed >= 8 && jobs.failed >= jobs.ok && (jobs.tenants >= 2 || jobs.failed >= 15)) {
    const top = await first<{ e: string | null; n: number }>(
      db,
      `SELECT substr(last_error, 1, 160) AS e, COUNT(*) AS n FROM action_jobs
        WHERE is_demo = 0 AND status IN ('failed','uncertain') AND updated_at >= ? GROUP BY 1 ORDER BY n DESC LIMIT 1`,
      since,
    );
    issues.push({
      key: "sends",
      text: `📛 إرسال فاشل بكثرة: ${jobs.failed} فشل مقابل ${jobs.ok} نجح آخر 30 دقيقة، عند ${jobs.tenants} عميل${top?.e ? `\nأكثر خطأ: ${cleanError(top.e)}` : ""}`,
    });
  }

  // 2) events that failed to process
  const ev = await first<{ n: number }>(db, "SELECT COUNT(*) AS n FROM webhook_events WHERE is_demo = 0 AND status = 'failed' AND received_at >= ?", since);
  if ((ev?.n ?? 0) >= 5) issues.push({ key: "events", text: `⚙️ ${ev!.n} تعليق/رسالة فشلت معالجتها آخر 30 دقيقة (خلل في الخادم؟)` });

  // 4) many accounts lost their connection at once
  const reauth = await first<{ n: number }>(db, "SELECT COUNT(*) AS n FROM instagram_accounts WHERE is_demo = 0 AND status = 'needs_reauth' AND updated_at >= ?", now - 2 * H);
  if ((reauth?.n ?? 0) >= 3) issues.push({ key: "reauth", text: `🔌 ${reauth!.n} حسابات إنستقرام انقطع ربطها آخر ساعتين (تغيير من Meta أو مشكلة في التطبيق؟)` });

  // 5) scheduled publishing failing
  const posts = await first<{ n: number }>(db, "SELECT COUNT(*) AS n FROM scheduled_posts WHERE status IN ('failed','uncertain') AND updated_at >= ?", now - H);
  if ((posts?.n ?? 0) >= 3) issues.push({ key: "publish", text: `🗓️ ${posts!.n} منشورات مجدولة فشل نشرها آخر ساعة` });

  return issues;
}

/**
 * A quiet spell is usually just quiet (nights, weekends), so it is never a «service problem». The owner gets one calm
 * note (at most once a day) only when there are running campaigns, nothing arrived for 6 hours, and the same hours
 * were busy on most of the last 7 days. The owner can turn it off ("silence_alert" = false).
 */
export async function checkSilence(env: Env, now = Date.now()): Promise<boolean> {
  if (!(await getSetting<boolean>(env.DB, OWNER_TENANT, "silence_alert", true))) return false;
  const WINDOW = 6 * H;
  const DAY = 24 * H;
  const recent = await first<{ n: number }>(env.DB, "SELECT COUNT(*) AS n FROM webhook_events WHERE is_demo = 0 AND event_type != 'echo' AND received_at >= ?", now - WINDOW);
  if ((recent?.n ?? 0) > 0) return false;
  const running = await first<{ n: number }>(env.DB, "SELECT COUNT(*) AS n FROM campaigns WHERE status = 'active' AND deleted_at IS NULL");
  if (!running?.n) return false;
  let busyDays = 0;
  for (let d = 1; d <= 7; d++) {
    const r = await first<{ n: number }>(
      env.DB,
      "SELECT COUNT(*) AS n FROM webhook_events WHERE is_demo = 0 AND event_type != 'echo' AND received_at >= ? AND received_at < ?",
      now - d * DAY - WINDOW, now - d * DAY,
    );
    if ((r?.n ?? 0) >= 3) busyDays++;
  }
  if (busyDays < 4) return false;
  const last = await getSetting<number>(env.DB, OWNER_TENANT, "silence_notice_at", 0);
  if (now - last < DAY) return false;
  await setSetting(env.DB, OWNER_TENANT, "silence_notice_at", now);
  await notify(env, OWNER_TENANT, "usage", "ℹ️ هدوء غير معتاد: ما وصل أي تعليق أو رسالة من 6 ساعات، مع إن هذا الوقت عادةً فيه نشاط.\nغالبًا هدوء طبيعي — وإذا استمر، افتح «صحة العملاء» أو «التشخيص». (تقدر توقف هذا التنبيه من «صحة العملاء»)");
  return true;
}

type WatchState = { keys: string[]; since: number | null; last_alert: number | null };

export async function runSystemWatch(env: Env, now = Date.now()): Promise<"alert" | "recovered" | null> {
  if (Math.floor(now / MIN) % 10 !== 5) return null;
  await checkSilence(env, now).catch(() => false);
  const prev = await getSetting<WatchState>(env.DB, OWNER_TENANT, "system_watch", { keys: [], since: null, last_alert: null });
  const issues = await systemIssues(env.DB, now, prev.keys);
  const keys = issues.map((i) => i.key).sort();
  if (!keys.length) {
    if (!prev.keys.length) return null;
    await setSetting(env.DB, OWNER_TENANT, "system_watch", { keys: [], since: null, last_alert: null });
    const mins = prev.since ? Math.round((now - prev.since) / MIN) : null;
    await notify(env, OWNER_TENANT, "system", `✅ رجعت الخدمة طبيعية${mins ? ` (استمرت المشكلة تقريبًا ${mins} دقيقة)` : ""}`);
    return "recovered";
  }
  const isNew = keys.some((k) => !prev.keys.includes(k));
  const due = !prev.last_alert || now - prev.last_alert >= REPEAT_MS;
  await setSetting(env.DB, OWNER_TENANT, "system_watch", { keys, since: prev.since ?? now, last_alert: isNew || due ? now : prev.last_alert });
  if (!isNew && !due) return null;
  const head = isNew ? "🚨 تنبيه: مشكلة عامة في الخدمة" : "🚨 لا تزال المشكلة مستمرة";
  await notify(env, OWNER_TENANT, "system", `${head}\n${issues.map((i) => i.text).join("\n\n")}\n\nافتح «صحة العملاء» أو «التشخيص» لأي عميل للتفاصيل.`);
  return "alert";
}

/** Recent system alerts for tests/inspection. */
export const systemAlerts = (db: D1Database) => all<{ title: string; body: string | null }>(db, "SELECT title, body FROM app_notifications WHERE tenant_id = ? AND kind = 'system' ORDER BY id", OWNER_TENANT);
