import type { Env } from "../env";
import { all, first, getSetting, OWNER_TENANT, setSetting } from "../lib/db";
import { cleanError } from "./diagnose";
import { notify } from "./notify";

/**
 * Every 10 minutes: problems that hit the whole service (not one customer) — a wave of failed sends, events that
 * fail to process, Meta going silent, many accounts losing their connection at once, scheduled posts failing.
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

  // 3) Meta went silent: nothing for 3 hours although the day before was busy
  const quiet = await first<{ recent: number; before: number }>(
    db,
    `SELECT COUNT(CASE WHEN received_at >= ? THEN 1 END) AS recent, COUNT(CASE WHEN received_at < ? THEN 1 END) AS before
       FROM webhook_events WHERE is_demo = 0 AND event_type != 'echo' AND received_at >= ?`,
    now - 3 * H,
    now - 3 * H,
    now - 27 * H,
  );
  // (once reported, it stays reported until something arrives again)
  if (quiet && quiet.recent === 0 && (quiet.before >= 24 || prevKeys.includes("silence"))) issues.push({ key: "silence", text: "🔇 ما وصل أي تعليق أو رسالة من Meta من 3 ساعات، مع إن اليوم اللي قبله كان فيه نشاط — ممكن انقطاع عند Meta أو مشكلة في الـ webhook." });

  // 4) many accounts lost their connection at once
  const reauth = await first<{ n: number }>(db, "SELECT COUNT(*) AS n FROM instagram_accounts WHERE is_demo = 0 AND status = 'needs_reauth' AND updated_at >= ?", now - 2 * H);
  if ((reauth?.n ?? 0) >= 3) issues.push({ key: "reauth", text: `🔌 ${reauth!.n} حسابات إنستقرام انقطع ربطها آخر ساعتين (تغيير من Meta أو مشكلة في التطبيق؟)` });

  // 5) scheduled publishing failing
  const posts = await first<{ n: number }>(db, "SELECT COUNT(*) AS n FROM scheduled_posts WHERE status IN ('failed','uncertain') AND updated_at >= ?", now - H);
  if ((posts?.n ?? 0) >= 3) issues.push({ key: "publish", text: `🗓️ ${posts!.n} منشورات مجدولة فشل نشرها آخر ساعة` });

  return issues;
}

type WatchState = { keys: string[]; since: number | null; last_alert: number | null };

export async function runSystemWatch(env: Env, now = Date.now()): Promise<"alert" | "recovered" | null> {
  if (Math.floor(now / MIN) % 10 !== 5) return null;
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
