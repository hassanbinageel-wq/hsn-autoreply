import { all, first } from "../lib/db";
import { INSTAGRAM_SCOPES } from "../meta/client";
import { getEntitlement, monthlyMessages } from "./plans";

/**
 * Owner-only diagnosis of one customer: everything the server knows that explains «it doesn't reply» —
 * subscription, Instagram connection, webhooks, campaigns, recent events and failures, scheduled posts, store.
 * Contains no tokens, no message texts and no follower names (only counts, states and error codes), so the
 * report can be downloaded and shared for support.
 */

export type Check = { area: string; level: "ok" | "warn" | "bad" | "info"; title: string; fix?: string };

const DAY = 86_400_000;
const H = 3_600_000;

/** Error texts may quote ids or long opaque strings: keep the readable part only. */
export const cleanError = (e: string | null | undefined): string | null =>
  e ? e.replace(/[A-Za-z0-9_\-]{32,}/g, "[…]").replace(/\s+/g, " ").trim().slice(0, 240) : null;

export async function diagnoseTenant(db: D1Database, tenantId: number, appVersion: string, now = Date.now()) {
  const t = await first<{ id: number; name: string; status: string; plan_id: string | null; plan_expires_at: number | null; created_at: number }>(
    db,
    "SELECT id, name, status, plan_id, plan_expires_at, created_at FROM tenants WHERE id = ?",
    tenantId,
  );
  if (!t) return null;
  const checks: Check[] = [];
  const add = (area: string, level: Check["level"], title: string, fix?: string) => checks.push({ area, level, title, ...(fix ? { fix } : {}) });

  // ---- subscription
  const ent = await getEntitlement(db, tenantId, now);
  const used = await monthlyMessages(db, tenantId, now);
  const limit = ent.limits.monthly_messages;
  const daysLeft = t.plan_expires_at ? Math.ceil((t.plan_expires_at - now) / DAY) : null;
  if (t.status !== "active") add("الاشتراك", "bad", "الحساب موقوف من لوحة المالك", "فعّله من «العملاء» إذا كان الإيقاف غير مقصود.");
  else if (!ent.active) add("الاشتراك", "bad", "الاشتراك منتهي — الردود التلقائية متوقفة", "جدّد له بكود تفعيل أو أضف أيام من «الباقة».");
  else if (daysLeft !== null && daysLeft <= 5) add("الاشتراك", "warn", `الاشتراك ينتهي بعد ${daysLeft} يوم`);
  else add("الاشتراك", "ok", `الاشتراك فعّال${daysLeft !== null ? ` — باقي ${daysLeft} يوم` : ""}`);
  if (limit && used >= limit) add("الاشتراك", "bad", `خلصت رسائل الدورة (${used} من ${limit}) — الردود متوقفة لين يتجدد العدّاد`, "رقّ باقته أو انتظر تجدد العدّاد (كل 30 يوم من بداية الاشتراك).");
  else if (limit && used / limit >= 0.8) add("الاشتراك", "warn", `استهلك ${Math.round((used / limit) * 100)}% من رسائل الشهر (${used} من ${limit})`);

  // ---- Instagram
  const accounts = await all<{ id: number; ig_user_id: string; username: string | null; status: string; is_demo: number; token_expires_at: number | null; token_refreshed_at: number | null; scopes: string; webhook_status: string; last_webhook_at: number | null; last_error: string | null; connected_at: number | null; api_version: string | null }>(
    db,
    "SELECT id, ig_user_id, username, status, is_demo, token_expires_at, token_refreshed_at, scopes, webhook_status, last_webhook_at, last_error, connected_at, api_version FROM instagram_accounts WHERE tenant_id = ? AND is_demo = 0 ORDER BY id",
    tenantId,
  );
  if (!accounts.length) add("إنستقرام", "bad", "ما ربط أي حساب إنستقرام", "يدخل «الربط» ويضغط «ربط إنستقرام».");
  for (const a of accounts) {
    const who = `@${a.username ?? a.ig_user_id}`;
    if (a.status === "disconnected") add("إنستقرام", "bad", `${who}: الربط مفصول`, "يعيد الربط من «الربط».");
    else if (a.status === "needs_reauth") add("إنستقرام", "bad", `${who}: يحتاج إعادة ربط (الصلاحية انتهت أو انسحبت)`, "يدخل «الربط» ويضغط «إعادة الربط».");
    else add("إنستقرام", "ok", `${who}: متصل`);
    if (a.status !== "disconnected") {
      if (a.token_expires_at && a.token_expires_at < now) add("إنستقرام", "bad", `${who}: صلاحية الدخول منتهية`, "إعادة ربط من «الربط».");
      else if (a.token_expires_at && a.token_expires_at - now < 7 * DAY) add("إنستقرام", "warn", `${who}: صلاحية الدخول تنتهي خلال ${Math.ceil((a.token_expires_at - now) / DAY)} يوم ولم تتجدد`);
      let scopes: string[] = [];
      try {
        scopes = JSON.parse(a.scopes);
      } catch {
        /* unknown */
      }
      const missing = INSTAGRAM_SCOPES.filter((s) => !scopes.includes(s));
      if (scopes.length && missing.length) add("إنستقرام", "bad", `${who}: صلاحيات ناقصة: ${missing.join("، ")}`, "يعيد الربط ويوافق على كل الصلاحيات.");
      if (a.webhook_status !== "subscribed") add("إنستقرام", "bad", `${who}: استقبال التعليقات من Meta غير مفعّل (${a.webhook_status})`, "إعادة الربط تفعّله تلقائيًا.");
      if (!a.last_webhook_at) add("إنستقرام", "warn", `${who}: ما وصل أي حدث من Meta لهذا الحساب أبدًا`, "يعلّق من حساب ثاني على منشوره للتجربة. إذا ما وصل شي، المشكلة في الربط أو إعدادات Meta.");
      else if (now - a.last_webhook_at > 3 * DAY) add("إنستقرام", "warn", `${who}: آخر حدث من Meta وصل قبل ${Math.floor((now - a.last_webhook_at) / DAY)} يوم`);
    }
    if (a.last_error) add("إنستقرام", "info", `${who}: آخر خطأ مسجّل: ${cleanError(a.last_error)}`);
  }
  const accIds = accounts.map((a) => a.id);
  const igIds = accounts.map((a) => a.ig_user_id);
  const inAcc = accIds.length ? `(${accIds.map(() => "?").join(",")})` : "(NULL)";
  const inIg = igIds.length ? `(${igIds.map(() => "?").join(",")})` : "(NULL)";

  // ---- campaigns
  const campaigns = await all<{ id: number; name: string; type: string; status: string; scope: string; match_all: number; account_id: number | null; schedule_start: number | null; schedule_end: number | null; stock_paused: number; stock_out_at: number | null; includes: number; media: number }>(
    db,
    `SELECT c.id, c.name, c.type, c.status, c.scope, c.match_all, c.account_id, c.schedule_start, c.schedule_end, c.stock_paused, c.stock_out_at,
            (SELECT COUNT(*) FROM campaign_keywords k WHERE k.campaign_id = c.id AND k.kind = 'include') AS includes,
            (SELECT COUNT(*) FROM campaign_media m WHERE m.campaign_id = c.id) AS media
       FROM campaigns c WHERE c.tenant_id = ? AND c.deleted_at IS NULL AND c.status IN ('active','paused') ORDER BY c.status, c.id DESC LIMIT 50`,
    tenantId,
  );
  const active = campaigns.filter((c) => c.status === "active");
  if (!active.length) add("الحملات", campaigns.length ? "warn" : "bad", campaigns.length ? "كل حملاته موقفة" : "ما عنده أي حملة شغّالة", "يفعّل حملة أو يسوي حملة جديدة.");
  else add("الحملات", "ok", `${active.length} حملة شغّالة`);
  for (const c of campaigns) {
    const nm = `«${c.name}» (#${c.id})`;
    if (c.stock_paused) add("الحملات", "warn", `${nm}: موقفة تلقائيًا لأن المنتج نفد`);
    if (c.status !== "active") continue;
    if (!c.account_id || !accIds.includes(c.account_id)) add("الحملات", "bad", `${nm}: غير مربوطة بحساب إنستقرام متصل`, "يعدّل الحملة ويختار الحساب.");
    if (c.type === "comment" && c.scope === "selected" && !c.media) add("الحملات", "bad", `${nm}: مخصصة لمنشورات محددة بس ما اختار أي منشور`, "يعدّل الحملة ويختار المنشور، أو يخليها على كل المنشورات.");
    if (!c.match_all && !c.includes && c.type !== "story_mention") add("الحملات", "bad", `${nm}: ما فيها كلمات تشغيل ولا «الرد على أي تعليق»`, "يضيف كلمة مثل «تم» أو يفعّل الرد على أي تعليق.");
    if (c.schedule_end && c.schedule_end < now) add("الحملات", "bad", `${nm}: انتهى وقتها المجدول`, "يمدد تاريخ النهاية.");
    else if (c.schedule_start && c.schedule_start > now) add("الحملات", "info", `${nm}: تبدأ لاحقًا (مجدولة)`);
    if (c.stock_out_at && !c.stock_paused) add("الحملات", "info", `${nm}: المنتج المرتبط نافد`);
  }

  // ---- recent events (7 days): what came in and why it was skipped
  const since = now - 7 * DAY;
  const events = await all<{ status: string; reason: string | null; n: number }>(
    db,
    `SELECT status, CASE WHEN status = 'ignored' THEN substr(COALESCE(reason, ''), 1, instr(COALESCE(reason, '') || ' ', ' ') - 1) ELSE NULL END AS reason, COUNT(*) AS n
       FROM webhook_events WHERE account_ig_id IN ${inIg} AND is_demo = 0 AND event_type != 'echo' AND received_at >= ? GROUP BY 1, 2 ORDER BY n DESC LIMIT 20`,
    ...igIds,
    since,
  );
  const totalEvents = events.reduce((s, e) => s + e.n, 0);
  if (accounts.length && !totalEvents) add("الأحداث", "warn", "ما وصل أي تعليق أو رسالة آخر 7 أيام");
  const failedEvents = events.filter((e) => e.status === "failed").reduce((s, e) => s + e.n, 0);
  if (failedEvents) add("الأحداث", "bad", `${failedEvents} حدث فشلت معالجته آخر 7 أيام`);

  // ---- failed sends (7 days)
  const jobs = await all<{ status: string; n: number }>(
    db,
    `SELECT status, COUNT(*) AS n FROM action_jobs WHERE account_id IN ${inAcc} AND is_demo = 0 AND updated_at >= ? GROUP BY status`,
    ...accIds,
    since,
  );
  const failures = await all<{ kind: string; purpose: string | null; status: string; last_error: string | null; attempts: number; updated_at: number; campaign_id: number | null }>(
    db,
    `SELECT kind, purpose, status, last_error, attempts, updated_at, campaign_id FROM action_jobs
      WHERE account_id IN ${inAcc} AND is_demo = 0 AND status IN ('failed','uncertain') AND updated_at >= ? ORDER BY updated_at DESC LIMIT 10`,
    ...accIds,
    since,
  );
  const failedN = jobs.filter((j) => j.status === "failed" || j.status === "uncertain").reduce((s, j) => s + j.n, 0);
  const okN = jobs.find((j) => j.status === "accepted")?.n ?? 0;
  if (failedN) add("الإرسال", failedN > okN ? "bad" : "warn", `${failedN} إرسال فشل أو غير مؤكد آخر 7 أيام (نجح ${okN})`);
  else if (okN) add("الإرسال", "ok", `${okN} إرسال ناجح آخر 7 أيام بدون أخطاء`);

  // ---- scheduled posts (14 days)
  const posts = await all<{ id: number; kind: string; status: string; last_error: string | null; publish_at: number }>(
    db,
    "SELECT id, kind, status, last_error, publish_at FROM scheduled_posts WHERE tenant_id = ? AND status IN ('failed','uncertain') AND updated_at >= ? ORDER BY updated_at DESC LIMIT 5",
    tenantId,
    now - 14 * DAY,
  );
  if (posts.length) add("الجدولة", "warn", `${posts.length} منشور مجدول فشل نشره آخر 14 يوم`);

  // ---- store
  const store = await first<{ platform: string; name: string | null; status: string; last_error: string | null; products_synced_at: number | null; token_expires_at: number | null; last_order: number | null; orders_7d: number }>(
    db,
    `SELECT s.platform, s.name, s.status, s.last_error, s.products_synced_at, s.token_expires_at,
            (SELECT MAX(o.ordered_at) FROM store_orders o WHERE o.store_id = s.id) AS last_order,
            (SELECT COUNT(*) FROM store_orders o WHERE o.store_id = s.id AND o.ordered_at >= ?) AS orders_7d
       FROM stores s WHERE s.tenant_id = ? AND s.status != 'disconnected' ORDER BY s.id DESC LIMIT 1`,
    since,
    tenantId,
  );
  if (store) {
    if (store.status === "needs_reauth") add("المتجر", "bad", `${store.platform}: الربط يحتاج إعادة`, "يعيد ربط المتجر من «تحليل المتجر».");
    else add("المتجر", "ok", `${store.platform} «${store.name ?? ""}» متصل — ${store.orders_7d} طلب آخر 7 أيام`);
    if (store.last_error) add("المتجر", "info", `آخر خطأ: ${cleanError(store.last_error)}`);
  }

  // ---- logins
  const sessions = await all<{ kind: string; device_label: string | null; last_seen_at: number }>(
    db,
    `SELECT s.kind, s.device_label, s.last_seen_at FROM sessions s JOIN admin_users u ON u.id = s.user_id
      WHERE u.tenant_id = ? AND s.revoked_at IS NULL AND s.expires_at > ? ORDER BY s.last_seen_at DESC LIMIT 5`,
    tenantId,
    now,
  );
  const lastSeen = sessions[0]?.last_seen_at ?? null;
  if (!lastSeen) add("الدخول", "warn", "ما فيه جلسة دخول فعّالة (ما دخل التطبيق مؤخرًا)");
  else if (now - lastSeen > 14 * DAY) add("الدخول", "warn", `آخر دخول قبل ${Math.floor((now - lastSeen) / DAY)} يوم`);

  const order = { bad: 0, warn: 1, info: 2, ok: 3 } as const;
  checks.sort((a, b) => order[a.level] - order[b.level]);
  const ts = (x: number | null | undefined) => (x ? new Date(x).toISOString() : null);
  return {
    report: "HSN AutoReply — customer diagnosis",
    generated_at: new Date(now).toISOString(),
    app_version: appVersion,
    customer: { id: t.id, name: t.name, status: t.status, plan: ent.plan?.name ?? t.plan_id, plan_active: ent.active, plan_expires_at: ts(t.plan_expires_at), created_at: ts(t.created_at) },
    summary: { bad: checks.filter((c) => c.level === "bad").length, warn: checks.filter((c) => c.level === "warn").length },
    checks,
    details: {
      messages_this_month: { used, limit },
      instagram: accounts.map((a) => ({
        id: a.id,
        username: a.username,
        status: a.status,
        token_expires_at: ts(a.token_expires_at),
        token_refreshed_at: ts(a.token_refreshed_at),
        scopes: (() => {
          try {
            return JSON.parse(a.scopes);
          } catch {
            return [];
          }
        })(),
        webhook_status: a.webhook_status,
        last_webhook_at: ts(a.last_webhook_at),
        connected_at: ts(a.connected_at),
        api_version: a.api_version,
        last_error: cleanError(a.last_error),
      })),
      campaigns: campaigns.map((c) => ({ id: c.id, name: c.name, type: c.type, status: c.status, scope: c.scope, match_all: !!c.match_all, include_keywords: c.includes, selected_posts: c.media, account_id: c.account_id, schedule_start: ts(c.schedule_start), schedule_end: ts(c.schedule_end), stock_paused: !!c.stock_paused })),
      events_7d: events,
      jobs_7d: jobs,
      recent_failures: failures.map((f) => ({ ...f, last_error: cleanError(f.last_error), updated_at: ts(f.updated_at) })),
      scheduled_post_failures: posts.map((p) => ({ ...p, last_error: cleanError(p.last_error), publish_at: ts(p.publish_at) })),
      store: store ? { ...store, last_error: cleanError(store.last_error), products_synced_at: ts(store.products_synced_at), token_expires_at: ts(store.token_expires_at), last_order: ts(store.last_order) } : null,
      sessions: sessions.map((s) => ({ kind: s.kind, device: s.device_label?.slice(0, 80) ?? null, last_seen_at: ts(s.last_seen_at) })),
    },
    _hours_since_last_event: accounts.length && accounts.some((a) => a.last_webhook_at) ? Math.floor((now - Math.max(...accounts.map((a) => a.last_webhook_at ?? 0))) / H) : null,
  };
}
