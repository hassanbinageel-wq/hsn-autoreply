import type { Env } from "../env";
import type { NotifyKind } from "../engine/context";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import { all, first, getSetting, OWNER_TENANT, setSetting, settingKey } from "../lib/db";
import { sanitize } from "../meta/client";
import { estimateUsage, platformUsage } from "./usage";
import { cloudflareUsage } from "./cfusage";
import { domainInfo } from "./domain";
import { drawsThisMonth, getEntitlement, monthlyMessages } from "./plans";
import { weeklyReport, weeklyText } from "./growth";
import { tzOffsetMinutes } from "./analytics";
import { serviceDomain } from "./domain";
import { fillMessage } from "../../shared/messageTemplates";

/**
 * Owner notifications through a Telegram bot the owner creates (free, no extra account needed).
 * The bot token is entered in the app's settings, stored AES-GCM encrypted, and never returned to the client.
 */
export interface NotifySettings {
  enabled: boolean;
  chat_id: string | null;
  daily_report: boolean;
  weekly_report: boolean;
  report_hour: number; // 0-23, in `timezone`
  timezone: string;
  alert_reauth: boolean;
  alert_failures: boolean;
  alert_spike: boolean;
  spike_per_hour: number;
  alert_usage: boolean;
  alert_stock: boolean;
  notify_new_follower: boolean;
  notify_delivery: boolean;
}

export const DEFAULT_NOTIFY: NotifySettings = {
  enabled: false,
  chat_id: null,
  daily_report: true,
  weekly_report: true,
  report_hour: 21,
  timezone: "Asia/Aden",
  alert_reauth: true,
  alert_failures: true,
  alert_spike: true,
  spike_per_hour: 50,
  alert_usage: true,
  alert_stock: true,
  notify_new_follower: false,
  notify_delivery: false,
};

const TOKEN_KEY = "telegram_token";
/** The encrypted token is bound to its tenant (the owner keeps the original binding). */
const tokenAad = (tenantId: number) => (tenantId === OWNER_TENANT ? "telegram-bot-token" : `telegram-bot-token:t${tenantId}`);
const TELEGRAM_TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;

/** Minimum time between two alerts of the same kind, so a bad hour never floods the owner's phone. */
const THROTTLE_MS: Partial<Record<NotifyKind, number>> = {
  reauth: 6 * 3_600_000,
  failures: 3 * 3_600_000,
  spike: 6 * 3_600_000,
  usage: 12 * 3_600_000,
  domain: 24 * 3_600_000,
};

export function isTelegramToken(t: string): boolean {
  return TELEGRAM_TOKEN_RE.test(t);
}

export async function getNotifySettings(db: D1Database, tenantId: number): Promise<NotifySettings> {
  return { ...DEFAULT_NOTIFY, ...(await getSetting<Partial<NotifySettings>>(db, tenantId, "notify", {})) };
}

export async function hasBotToken(db: D1Database, tenantId: number): Promise<boolean> {
  return !!(await getSetting<{ ciphertext?: string } | null>(db, tenantId, TOKEN_KEY, null))?.ciphertext;
}

export async function saveBotToken(env: Env, tenantId: number, token: string | null): Promise<void> {
  if (!token) {
    await env.DB.prepare("DELETE FROM app_settings WHERE key = ?").bind(settingKey(tenantId, TOKEN_KEY)).run();
    return;
  }
  const enc = await encryptSecret(token, env.TOKEN_ENC_KEY, tokenAad(tenantId));
  await setSetting(env.DB, tenantId, TOKEN_KEY, enc);
}

async function botToken(env: Env, tenantId: number): Promise<string | null> {
  const enc = await getSetting<{ ciphertext: string; iv: string } | null>(env.DB, tenantId, TOKEN_KEY, null);
  if (!enc?.ciphertext) return null;
  try {
    return await decryptSecret(enc.ciphertext, enc.iv, env.TOKEN_ENC_KEY, tokenAad(tenantId));
  } catch {
    return null;
  }
}

async function telegram(env: Env, tenantId: number, method: string, body: Record<string, unknown>, token?: string | null): Promise<{ ok: boolean; result?: any; error?: string }> {
  const t = token ?? (await botToken(env, tenantId));
  if (!t) return { ok: false, error: "لم يُضبط توكن البوت" };
  try {
    const r = await fetch(`https://api.telegram.org/bot${t}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const j = (await r.json().catch(() => ({}))) as any;
    if (!r.ok || !j.ok) return { ok: false, error: sanitize(String(j.description ?? `HTTP ${r.status}`)).replaceAll(t, "***") };
    return { ok: true, result: j.result };
  } catch (e) {
    return { ok: false, error: sanitize(String((e as Error)?.message ?? e)).replaceAll(t, "***") };
  }
}

export async function sendTelegram(env: Env, tenantId: number, text: string, s?: NotifySettings): Promise<{ ok: boolean; error?: string }> {
  const cfg = s ?? (await getNotifySettings(env.DB, tenantId));
  if (!cfg.chat_id) return { ok: false, error: "لم تُحدَّد المحادثة بعد" };
  return telegram(env, tenantId, "sendMessage", { chat_id: cfg.chat_id, text: text.slice(0, 4000), disable_web_page_preview: true });
}

/** Finds the chat of the latest message sent to the bot (the owner sends /start once). */
export async function detectChat(env: Env, tenantId: number, token?: string | null): Promise<{ ok: boolean; chat_id?: string; name?: string; error?: string }> {
  const r = await telegram(env, tenantId, "getUpdates", { limit: 20, allowed_updates: ["message"] }, token);
  if (!r.ok) return { ok: false, error: r.error };
  const msgs = (r.result as any[]).map((u) => u.message).filter((m) => m?.chat?.type === "private");
  const last = msgs.at(-1);
  if (!last) return { ok: false, error: "لم تصل رسالة للبوت بعد — افتح البوت في تيليجرام واضغط Start ثم أعد المحاولة" };
  return { ok: true, chat_id: String(last.chat.id), name: [last.chat.first_name, last.chat.last_name].filter(Boolean).join(" ") || last.chat.username };
}

/** Kinds that also go to the in-app bell, and where a tap leads. Frequent ones (followers, deliveries) stay out. */
const IN_APP: Partial<Record<NotifyKind, string>> = {
  stock: "/store",
  story: "/schedule",
  reauth: "/connection",
  failures: "/logs",
  spike: "/analytics",
  expiry: "/subscription",
  usage: "/usage",
  domain: "/usage",
  plan: "/subscription",
  service: "/",
  message: "/",
  support: "/owner?tab=support",
  support_reply: "/support",
  referral: "/subscription",
  system: "/owner?tab=health",
};

/** Saves an important notification for the in-app bell (first line = title, the rest = body). */
export async function addAppNotification(db: D1Database, tenantId: number, kind: NotifyKind, text: string, now = Date.now(), linkOverride?: string): Promise<void> {
  const link = linkOverride ?? IN_APP[kind];
  if (link === undefined) return;
  const [title, ...rest] = text.split("\n");
  await db
    .prepare("INSERT INTO app_notifications (tenant_id, kind, title, body, link, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(tenantId, kind, title.slice(0, 200), rest.join("\n").trim().slice(0, 1000) || null, link, now + NOTIFICATION_KEEP_DAYS * 86_400_000, now)
    .run();
}

/**
 * An owner/customer notification: the in-app bell (important kinds) and Telegram (when set up and that kind is on).
 * Throttled per kind so a bad hour never floods either. Never throws.
 */
export async function notify(env: Env, tenantId: number, kind: NotifyKind, text: string, onRequest?: () => void, opts: { link?: string } = {}): Promise<void> {
  try {
    const throttle = THROTTLE_MS[kind];
    if (throttle) {
      const key = `notify_last_${kind}`;
      const last = await getSetting<number>(env.DB, tenantId, key, 0);
      if (Date.now() - last < throttle) return;
      await setSetting(env.DB, tenantId, key, Date.now());
    }
    await addAppNotification(env.DB, tenantId, kind, text, Date.now(), opts.link).catch((e) => console.error("app notification failed", sanitize(String(e))));
    const s = await getNotifySettings(env.DB, tenantId);
    if (!s.enabled || !s.chat_id) return;
    const on: Record<NotifyKind, boolean> = {
      new_follower: s.notify_new_follower,
      delivery: s.notify_delivery,
      reauth: s.alert_reauth,
      failures: s.alert_failures,
      spike: s.alert_spike,
      usage: s.alert_usage,
      report: s.daily_report,
      test: true,
      expiry: true,
      domain: true,
      stock: s.alert_stock !== false,
      story: s.alert_stock !== false,
      plan: true,
      service: true,
      message: true,
      support: true,
      support_reply: true,
      referral: true,
      system: true,
    };
    if (!on[kind]) return;
    onRequest?.(); // counts against the same per-invocation subrequest budget as the Meta calls
    await sendTelegram(env, tenantId, text, s);
  } catch (e) {
    console.error("notify failed", sanitize(String(e)));
  }
}

function localParts(ms: number, tz: string): { date: string; hour: number; weekday: number } {
  try {
    const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false, weekday: "short" });
    const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
    return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, weekday };
  } catch {
    const d = new Date(ms);
    return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours(), weekday: d.getUTCDay() };
  }
}

/** Numbers for the last 24 hours (production data only). */
export async function buildDailyReport(db: D1Database, tenantId: number, now = Date.now()): Promise<string> {
  const since = now - 86_400_000;
  const ACC = "(SELECT id FROM instagram_accounts WHERE tenant_id = ?)";
  const perFlow = `
    SELECT f.campaign_id, f.participant_id, f.state, f.link_clicks,
           EXISTS (SELECT 1 FROM follow_checks fc WHERE fc.flow_id = f.id AND fc.result = 'not_following') AS saw_not,
           EXISTS (SELECT 1 FROM follow_checks fc WHERE fc.flow_id = f.id AND fc.result = 'following') AS saw_yes
      FROM conversation_flows f WHERE f.account_id IN ${ACC} AND f.is_demo = 0 AND f.created_at >= ?`;
  const [t, comments, top, failed] = await Promise.all([
    first<any>(
      db,
      `SELECT COUNT(DISTINCT participant_id) AS people,
              COUNT(DISTINCT CASE WHEN saw_not AND saw_yes THEN participant_id END) AS new_followers,
              COUNT(DISTINCT CASE WHEN state = 'content_sent' THEN participant_id END) AS delivered,
              COUNT(DISTINCT CASE WHEN link_clicks > 0 THEN participant_id END) AS clicked
         FROM (${perFlow})`,
      tenantId,
      since,
    ),
    first<{ n: number }>(
      db,
      "SELECT COUNT(*) AS n FROM webhook_events WHERE account_ig_id IN (SELECT ig_user_id FROM instagram_accounts WHERE tenant_id = ?) AND is_demo = 0 AND event_type = 'comment' AND received_at >= ?",
      tenantId,
      since,
    ),
    all<any>(
      db,
      `SELECT c.name, COUNT(DISTINCT x.participant_id) AS people, COUNT(DISTINCT CASE WHEN x.state = 'content_sent' THEN x.participant_id END) AS delivered
         FROM (${perFlow}) x JOIN campaigns c ON c.id = x.campaign_id GROUP BY x.campaign_id ORDER BY people DESC LIMIT 3`,
      tenantId,
      since,
    ),
    first<{ n: number }>(db, `SELECT COUNT(*) AS n FROM action_jobs WHERE account_id IN ${ACC} AND is_demo = 0 AND status IN ('failed','uncertain') AND updated_at >= ?`, tenantId, since),
  ]);
  const lines = [
    "📊 تقرير HSN AutoReply — آخر 24 ساعة",
    "",
    `💬 تعليقات مستلمة: ${comments?.n ?? 0}`,
    `👥 أشخاص تفاعلوا: ${t?.people ?? 0}`,
    `➕ متابعون جدد: ${t?.new_followers ?? 0}`,
    `✅ استلموا المحتوى: ${t?.delivered ?? 0}`,
    `🔗 ضغطوا الرابط: ${t?.clicked ?? 0}`,
  ];
  if (top.length) {
    lines.push("", "🏆 أنشط الحملات:");
    for (const r of top) lines.push(`• ${r.name}: ${r.people} شخص · ${r.delivered} استلموا`);
  }
  if ((failed?.n ?? 0) > 0) lines.push("", `⚠️ مهام فشلت أو غير مؤكدة: ${failed!.n} (راجع السجل)`);
  return lines.join("\n");
}

/**
 * Every 10 minutes: each customer's own plan usage — monthly messages and draws — at 80% and when used up.
 * Told once per threshold per month (in the app, and on Telegram when set up). The owner has no limits.
 */
export async function runPlanAlerts(env: Env, now = Date.now()): Promise<number> {
  if (Math.floor(now / 60_000) % 10 !== 3) return 0;
  const month = new Date(now).toISOString().slice(0, 7);
  const tenants = await all<{ id: number }>(env.DB, "SELECT id FROM tenants WHERE status = 'active' AND is_owner = 0 ORDER BY id");
  let sent = 0;
  for (const t of tenants) {
    const ent = await getEntitlement(env.DB, t.id, now);
    if (!ent.active) continue;
    const checks: Array<{ key: string; used: number; limit: number | null; what: string; full: string }> = [
      { key: "messages", used: await monthlyMessages(env.DB, t.id, now), limit: ent.limits.monthly_messages, what: "رسائل باقتك هذا الشهر", full: "الردود التلقائية متوقفة لين يبدأ الشهر الجديد أو ترقّي باقتك من «اشتراكي»." },
      { key: "draws", used: ent.limits.draws_per_month ? await drawsThisMonth(env.DB, t.id, now) : 0, limit: ent.limits.draws_per_month || null, what: "سحوبات باقتك هذا الشهر", full: "ما تقدر تسوي سحب جديد لين يبدأ الشهر الجديد أو ترقّي باقتك من «اشتراكي»." },
    ];
    for (const c of checks) {
      if (!c.limit) continue;
      const pct = c.used / c.limit;
      const level = pct >= 1 ? 100 : pct >= 0.8 ? 80 : 0;
      if (!level) continue;
      const key = `plan_alert_${c.key}_${month}`;
      if ((await getSetting<number>(env.DB, t.id, key, 0)) >= level) continue;
      await setSetting(env.DB, t.id, key, level);
      const n = (x: number) => x.toLocaleString("en-US");
      await notify(
        env,
        t.id,
        "plan",
        level === 100
          ? `⛔ خلصت ${c.what} (${n(c.used)} من ${n(c.limit)})\n${c.full}`
          : `📨 استخدمت ${Math.round(pct * 100)}% من ${c.what} (${n(c.used)} من ${n(c.limit)})\nإذا تتوقع تفاعل أكثر، رقّ باقتك من «اشتراكي» قبل لا يخلص.`,
      );
      sent++;
    }
  }
  return sent;
}

/** How long bell notifications stay: system ones 30 days; owner messages as the owner chose. */
export const NOTIFICATION_KEEP_DAYS = 30;
export const OWNER_MESSAGE_DAYS = [3, 7, 30, 90] as const;

/**
 * A message from the owner — to one customer (tenantId) or every active customer (null, a notice). Kept as a
 * history entry so it can be reminded or deleted later; on the customer's bell until it expires.
 */
export async function sendOwnerMessage(env: Env, o: { tenantId: number | null; title: string; body: string | null; link: string; days: number }, now = Date.now()): Promise<{ id: number; sent: number }> {
  const kind = o.tenantId === null ? "service" : "message";
  const m = await first<{ id: number }>(
    env.DB,
    "INSERT INTO owner_messages (tenant_id, kind, title, body, link, keep_days, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
    o.tenantId,
    kind,
    o.title.slice(0, 200),
    o.body?.slice(0, 1000) || null,
    o.link,
    o.days,
    now,
  );
  const sent = await deliverOwnerMessage(env, m!.id, null, now);
  return { id: m!.id, sent };
}

/**
 * Puts an owner message (again) on the bell of its customer(s), unread — a reminder rings and flashes again.
 * Placeholders ({الاسم}…) are filled per customer, and each recipient gets a permanent receipt row.
 */
async function deliverOwnerMessage(env: Env, id: number, prefix: string | null, now: number): Promise<number> {
  const m = await first<{ id: number; tenant_id: number | null; kind: string; title: string; body: string | null; link: string | null; keep_days: number }>(env.DB, "SELECT * FROM owner_messages WHERE id = ?", id);
  if (!m) return 0;
  const expires = now + m.keep_days * 86_400_000;
  const kind = m.tenant_id === null ? "service" : "message";
  const recipients = await all<{ id: number; name: string; plan_expires_at: number | null; plan_name: string | null }>(
    env.DB,
    `SELECT t.id, t.name, t.plan_expires_at, p.name AS plan_name FROM tenants t LEFT JOIN plans p ON p.id = t.plan_id
      WHERE t.is_owner = 0 AND ${m.tenant_id === null ? "t.status = 'active'" : "t.id = ?"} ORDER BY t.id`,
    ...(m.tenant_id === null ? [] : [m.tenant_id]),
  );
  if (!recipients.length) return 0;
  const stmts: D1PreparedStatement[] = [];
  for (const r of recipients) {
    const v = { name: r.name, plan: r.plan_name, expiresAt: r.plan_expires_at };
    const title = `${prefix ?? ""}${kind === "message" ? "✉️ " : ""}${fillMessage(m.title, v, now)}`.slice(0, 220);
    const body = m.body ? fillMessage(m.body, v, now).slice(0, 1200) : null;
    stmts.push(
      env.DB.prepare("INSERT INTO app_notifications (tenant_id, kind, title, body, link, expires_at, owner_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(r.id, kind, title, body, m.link ?? "/", expires, m.id, now),
      env.DB
        .prepare("INSERT INTO owner_message_receipts (owner_message_id, tenant_id, delivered_at, last_delivered_at) VALUES (?, ?, ?, ?) ON CONFLICT(owner_message_id, tenant_id) DO UPDATE SET last_delivered_at = excluded.last_delivered_at, deleted_at = NULL")
        .bind(m.id, r.id, now, now),
    );
    // A private message also goes to the customer's Telegram when they set it up.
    if (m.tenant_id !== null) {
      const s = await getNotifySettings(env.DB, r.id);
      if (s.enabled && s.chat_id) await sendTelegram(env, r.id, `${title}${body ? `\n${body}` : ""}`, s).catch(() => undefined);
    }
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return recipients.length;
}

/** A reminder: the earlier copies leave the bell and one fresh, unread copy arrives (ring + flash). The receipts stay. */
export async function remindOwnerMessage(env: Env, id: number, now = Date.now()): Promise<number> {
  await env.DB.prepare("DELETE FROM app_notifications WHERE owner_message_id = ?").bind(id).run();
  const n = await deliverOwnerMessage(env, id, "🔔 تذكير: ", now);
  if (n) await env.DB.prepare("UPDATE owner_messages SET reminders = reminders + 1, reminded_at = ? WHERE id = ?").bind(now, id).run();
  return n;
}

/** Deletes an owner message from the history, its receipts, and every customer's bell. */
export async function deleteOwnerMessage(db: D1Database, id: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM app_notifications WHERE owner_message_id = ?").bind(id),
    db.prepare("DELETE FROM owner_message_receipts WHERE owner_message_id = ?").bind(id),
    db.prepare("DELETE FROM owner_messages WHERE id = ?").bind(id),
  ]);
}

/**
 * The customer acted on bell notifications (read / opened / removed): the owner-message receipts remember it for
 * good. `where` selects the customer's notifications (it is ANDed with the tenant).
 */
export function receiptUpdate(db: D1Database, tenantId: number, field: "read_at" | "clicked_at" | "deleted_at", where: string, args: unknown[], now: number): D1PreparedStatement {
  const set = field === "clicked_at" ? "clicked_at = COALESCE(clicked_at, ?1), read_at = COALESCE(read_at, ?1)" : field === "read_at" ? "read_at = COALESCE(read_at, ?1)" : "deleted_at = ?1";
  return db
    .prepare(`UPDATE owner_message_receipts SET ${set} WHERE tenant_id = ?2 AND owner_message_id IN (SELECT owner_message_id FROM app_notifications WHERE tenant_id = ?2 AND owner_message_id IS NOT NULL AND ${where})`)
    .bind(now, tenantId, ...args);
}

/** The owner's notice to every active customer — kept for tests and older callers. */
export async function broadcastNotice(db: D1Database, title: string, body: string | null, now = Date.now(), link = "/"): Promise<number> {
  const r = await db
    .prepare("INSERT INTO app_notifications (tenant_id, kind, title, body, link, expires_at, created_at) SELECT id, 'service', ?, ?, ?, ?, ? FROM tenants WHERE status = 'active' AND is_owner = 0")
    .bind(title.slice(0, 200), body?.slice(0, 1000) || null, link, now + NOTIFICATION_KEEP_DAYS * 86_400_000, now)
    .run();
  return r.meta.changes ?? 0;
}

/** Called every minute by the cron: notifications of every active customer. */
export async function runNotifications(env: Env, now = Date.now()): Promise<void> {
  const tenants = await all<{ id: number }>(env.DB, "SELECT id FROM tenants WHERE status = 'active' ORDER BY id");
  for (const t of tenants) {
    if (!(await getEntitlement(env.DB, t.id, now)).limits.telegram) continue; // not in the customer's plan
    await runTenantNotifications(env, t.id, now);
  }
}

/**
 * Daily: reminds customers whose subscription ends within 3 days (Telegram when they set it up; the app always
 * shows a banner). At most one reminder per customer per day.
 */
export async function remindExpiringSubscriptions(env: Env, now = Date.now()): Promise<number> {
  const rows = await all<{ id: number; plan_expires_at: number }>(
    env.DB,
    `SELECT id, plan_expires_at FROM tenants WHERE is_owner = 0 AND status = 'active' AND plan_expires_at > ? AND plan_expires_at <= ?
       AND (expiry_notice_at IS NULL OR expiry_notice_at < ?)`,
    now,
    now + 3 * 86_400_000,
    now - 20 * 3_600_000,
  );
  for (const r of rows) {
    const days = Math.max(1, Math.ceil((r.plan_expires_at - now) / 86_400_000));
    await env.DB.prepare("UPDATE tenants SET expiry_notice_at = ? WHERE id = ?").bind(now, r.id).run();
    await notify(env, r.id, "expiry", `⏳ اشتراكك في HSN AutoReply ينتهي خلال ${days} ${days === 1 ? "يوم" : "أيام"}. جدّده بكود تفعيل جديد من صفحة «اشتراكي» حتى لا تتوقف الردود.`);
  }
  return rows.length;
}

/** Daily report at the chosen local hour, failure and spike alerts (usage alerts: owner only). */
async function runTenantNotifications(env: Env, tenantId: number, now: number): Promise<void> {
  const s = await getNotifySettings(env.DB, tenantId);
  if (!s.enabled || !s.chat_id) return;
  const ACC = "(SELECT id FROM instagram_accounts WHERE tenant_id = ?)";
  const local = localParts(now, await getSetting<string>(env.DB, tenantId, "timezone", s.timezone));
  if (s.daily_report && local.hour === s.report_hour) {
    const last = await getSetting<string>(env.DB, tenantId, "notify_last_report_date", "");
    if (last !== local.date) {
      await setSetting(env.DB, tenantId, "notify_last_report_date", local.date);
      await sendTelegram(env, tenantId, await buildDailyReport(env.DB, tenantId, now), s);
    }
  }
  // Weekly report: Saturday (the end of the Saudi week) at the same local hour as the daily report.
  if (s.weekly_report && local.hour === s.report_hour && local.weekday === 6) {
    const last = await getSetting<string>(env.DB, tenantId, "notify_last_weekly_date", "");
    if (last !== local.date) {
      await setSetting(env.DB, tenantId, "notify_last_weekly_date", local.date);
      const tz = await getSetting<string>(env.DB, tenantId, "timezone", s.timezone);
      const domain = serviceDomain(env);
      const r = await weeklyReport(env.DB, tenantId, tzOffsetMinutes(tz || "Asia/Aden", now), now);
      await sendTelegram(env, tenantId, weeklyText(r, domain ? `https://${domain}/#/report` : undefined), s);
    }
  }
  // Failure/spike checks every 10 minutes (not every cron minute) to stay far below the free D1 read quota.
  if (Math.floor(now / 60_000) % 10 !== 0) return;
  if (s.alert_failures) {
    const f = await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM action_jobs WHERE account_id IN ${ACC} AND is_demo = 0 AND status IN ('failed','uncertain') AND updated_at >= ?`, tenantId, now - 3_600_000);
    if ((f?.n ?? 0) >= 3) await notify(env, tenantId, "failures", `⚠️ ${f!.n} رسائل فشلت أو نتيجتها غير مؤكدة خلال الساعة الأخيرة. افتح «السجل» في التطبيق للتفاصيل.`);
  }
  if (s.alert_usage && tenantId === OWNER_TENANT) {
    // Storage (database, R2) once an hour: an early warning at 70%.
    if (Math.floor(now / 60_000) % 60 === 0) {
      const p = await platformUsage(env.DB, !!env.MEDIA, now, await cloudflareUsage(env, now).catch(() => null));
      const full = p.meters.filter((x) => x.pct >= (["requests", "writes", "reads"].includes(x.key) ? 80 : 70));
      if (full.length) await notify(env, tenantId, "usage", `⚠️ اقتربت من حد Cloudflare المجاني: ${full.map((x) => `${x.label} ${x.pct}%`).join("، ")}. التفاصيل في «الاستهلاك» بلوحة الإدارة.`);
      // The service domain: warn from 30 days before it expires.
      const d = await domainInfo(env, now).catch(() => null);
      const left = d?.expires_at ? Math.floor((d.expires_at - now) / 86_400_000) : null;
      if (left !== null && left <= 30) await notify(env, tenantId, "domain", `⏰ الدومين ${d!.name} ينتهي بعد ${left} يوم — جدّده${d!.registrar ? ` من ${d!.registrar}` : ""}، لأن انتهاءه يوقف الموقع والردود.`);
    }
    const u = await estimateUsage(env.DB, now);
    const worst = u.writes.pct >= u.requests.pct ? { name: "عمليات الكتابة في قاعدة البيانات", ...u.writes } : { name: "الطلبات", ...u.requests };
    if (worst.pct >= 80) {
      await notify(
        env,
        tenantId,
        "usage",
        `⚠️ اقتربت من الحد المجاني اليومي في Cloudflare: ${worst.name} ≈ ${worst.pct}% (تقديري). عند بلوغ 100% تتوقف الردود حتى 03:00 بتوقيت السعودية ثم تكمل تلقائيًا، ويسترجع النظام التعليقات الفائتة.`,
      );
    }
  }
  if (s.alert_spike) {
    const c = await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM conversation_flows WHERE account_id IN ${ACC} AND is_demo = 0 AND created_at >= ?`, tenantId, now - 3_600_000);
    if ((c?.n ?? 0) >= s.spike_per_hour) await notify(env, tenantId, "spike", `🔥 تفاعل كبير: ${c!.n} شخص تفاعلوا مع حملاتك خلال الساعة الأخيرة.`);
  }
}
