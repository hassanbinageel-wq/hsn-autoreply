import type { Env } from "../env";
import type { NotifyKind } from "../engine/context";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import { all, first, getSetting, setSetting } from "../lib/db";
import { sanitize } from "../meta/client";

/**
 * Owner notifications through a Telegram bot the owner creates (free, no extra account needed).
 * The bot token is entered in the app's settings, stored AES-GCM encrypted, and never returned to the client.
 */
export interface NotifySettings {
  enabled: boolean;
  chat_id: string | null;
  daily_report: boolean;
  report_hour: number; // 0-23, in `timezone`
  timezone: string;
  alert_reauth: boolean;
  alert_failures: boolean;
  alert_spike: boolean;
  spike_per_hour: number;
  notify_new_follower: boolean;
  notify_delivery: boolean;
}

export const DEFAULT_NOTIFY: NotifySettings = {
  enabled: false,
  chat_id: null,
  daily_report: true,
  report_hour: 21,
  timezone: "Asia/Aden",
  alert_reauth: true,
  alert_failures: true,
  alert_spike: true,
  spike_per_hour: 50,
  notify_new_follower: false,
  notify_delivery: false,
};

const TOKEN_KEY = "telegram_token";
const TOKEN_AAD = "telegram-bot-token";
const TELEGRAM_TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;

/** Minimum time between two alerts of the same kind, so a bad hour never floods the owner's phone. */
const THROTTLE_MS: Partial<Record<NotifyKind, number>> = {
  reauth: 6 * 3_600_000,
  failures: 3 * 3_600_000,
  spike: 6 * 3_600_000,
};

export function isTelegramToken(t: string): boolean {
  return TELEGRAM_TOKEN_RE.test(t);
}

export async function getNotifySettings(db: D1Database): Promise<NotifySettings> {
  return { ...DEFAULT_NOTIFY, ...(await getSetting<Partial<NotifySettings>>(db, "notify", {})) };
}

export async function hasBotToken(db: D1Database): Promise<boolean> {
  return !!(await getSetting<{ ciphertext?: string } | null>(db, TOKEN_KEY, null))?.ciphertext;
}

export async function saveBotToken(env: Env, token: string | null): Promise<void> {
  if (!token) {
    await env.DB.prepare("DELETE FROM app_settings WHERE key = ?").bind(TOKEN_KEY).run();
    return;
  }
  const enc = await encryptSecret(token, env.TOKEN_ENC_KEY, TOKEN_AAD);
  await setSetting(env.DB, TOKEN_KEY, enc);
}

async function botToken(env: Env): Promise<string | null> {
  const enc = await getSetting<{ ciphertext: string; iv: string } | null>(env.DB, TOKEN_KEY, null);
  if (!enc?.ciphertext) return null;
  try {
    return await decryptSecret(enc.ciphertext, enc.iv, env.TOKEN_ENC_KEY, TOKEN_AAD);
  } catch {
    return null;
  }
}

async function telegram(env: Env, method: string, body: Record<string, unknown>, token?: string | null): Promise<{ ok: boolean; result?: any; error?: string }> {
  const t = token ?? (await botToken(env));
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

export async function sendTelegram(env: Env, text: string, s?: NotifySettings): Promise<{ ok: boolean; error?: string }> {
  const cfg = s ?? (await getNotifySettings(env.DB));
  if (!cfg.chat_id) return { ok: false, error: "لم تُحدَّد المحادثة بعد" };
  return telegram(env, "sendMessage", { chat_id: cfg.chat_id, text: text.slice(0, 4000), disable_web_page_preview: true });
}

/** Finds the chat of the latest message sent to the bot (the owner sends /start once). */
export async function detectChat(env: Env, token?: string | null): Promise<{ ok: boolean; chat_id?: string; name?: string; error?: string }> {
  const r = await telegram(env, "getUpdates", { limit: 20, allowed_updates: ["message"] }, token);
  if (!r.ok) return { ok: false, error: r.error };
  const msgs = (r.result as any[]).map((u) => u.message).filter((m) => m?.chat?.type === "private");
  const last = msgs.at(-1);
  if (!last) return { ok: false, error: "لم تصل رسالة للبوت بعد — افتح البوت في تيليجرام واضغط Start ثم أعد المحاولة" };
  return { ok: true, chat_id: String(last.chat.id), name: [last.chat.first_name, last.chat.last_name].filter(Boolean).join(" ") || last.chat.username };
}

/** Sends an owner notification if that kind is enabled (and not throttled). Never throws. */
export async function notify(env: Env, kind: NotifyKind, text: string, onRequest?: () => void): Promise<void> {
  try {
    const s = await getNotifySettings(env.DB);
    if (!s.enabled || !s.chat_id) return;
    const on: Record<NotifyKind, boolean> = {
      new_follower: s.notify_new_follower,
      delivery: s.notify_delivery,
      reauth: s.alert_reauth,
      failures: s.alert_failures,
      spike: s.alert_spike,
      report: s.daily_report,
      test: true,
    };
    if (!on[kind]) return;
    const throttle = THROTTLE_MS[kind];
    if (throttle) {
      const key = `notify_last_${kind}`;
      const last = await getSetting<number>(env.DB, key, 0);
      if (Date.now() - last < throttle) return;
      await setSetting(env.DB, key, Date.now());
    }
    onRequest?.(); // counts against the same per-invocation subrequest budget as the Meta calls
    await sendTelegram(env, text, s);
  } catch (e) {
    console.error("notify failed", sanitize(String(e)));
  }
}

function localParts(ms: number, tz: string): { date: string; hour: number } {
  try {
    const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false });
    const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
  } catch {
    const d = new Date(ms);
    return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
  }
}

/** Numbers for the last 24 hours (production data only). */
export async function buildDailyReport(db: D1Database, now = Date.now()): Promise<string> {
  const since = now - 86_400_000;
  const perFlow = `
    SELECT f.campaign_id, f.participant_id, f.state, f.link_clicks,
           EXISTS (SELECT 1 FROM follow_checks fc WHERE fc.flow_id = f.id AND fc.result = 'not_following') AS saw_not,
           EXISTS (SELECT 1 FROM follow_checks fc WHERE fc.flow_id = f.id AND fc.result = 'following') AS saw_yes
      FROM conversation_flows f WHERE f.is_demo = 0 AND f.created_at >= ?`;
  const [t, comments, top, failed] = await Promise.all([
    first<any>(
      db,
      `SELECT COUNT(DISTINCT participant_id) AS people,
              COUNT(DISTINCT CASE WHEN saw_not AND saw_yes THEN participant_id END) AS new_followers,
              COUNT(DISTINCT CASE WHEN state = 'content_sent' THEN participant_id END) AS delivered,
              COUNT(DISTINCT CASE WHEN link_clicks > 0 THEN participant_id END) AS clicked
         FROM (${perFlow})`,
      since,
    ),
    first<{ n: number }>(db, "SELECT COUNT(*) AS n FROM webhook_events WHERE is_demo = 0 AND event_type = 'comment' AND received_at >= ?", since),
    all<any>(
      db,
      `SELECT c.name, COUNT(DISTINCT x.participant_id) AS people, COUNT(DISTINCT CASE WHEN x.state = 'content_sent' THEN x.participant_id END) AS delivered
         FROM (${perFlow}) x JOIN campaigns c ON c.id = x.campaign_id GROUP BY x.campaign_id ORDER BY people DESC LIMIT 3`,
      since,
    ),
    first<{ n: number }>(db, "SELECT COUNT(*) AS n FROM action_jobs WHERE is_demo = 0 AND status IN ('failed','uncertain') AND updated_at >= ?", since),
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

/** Called every minute by the cron: daily report at the chosen local hour, failure and spike alerts. */
export async function runNotifications(env: Env, now = Date.now()): Promise<void> {
  const s = await getNotifySettings(env.DB);
  if (!s.enabled || !s.chat_id) return;
  const local = localParts(now, await getSetting<string>(env.DB, "timezone", s.timezone));
  if (s.daily_report && local.hour === s.report_hour) {
    const last = await getSetting<string>(env.DB, "notify_last_report_date", "");
    if (last !== local.date) {
      await setSetting(env.DB, "notify_last_report_date", local.date);
      await sendTelegram(env, await buildDailyReport(env.DB, now), s);
    }
  }
  // Failure/spike checks every 10 minutes (not every cron minute) to stay far below the free D1 read quota.
  if (Math.floor(now / 60_000) % 10 !== 0) return;
  if (s.alert_failures) {
    const f = await first<{ n: number }>(env.DB, "SELECT COUNT(*) AS n FROM action_jobs WHERE is_demo = 0 AND status IN ('failed','uncertain') AND updated_at >= ?", now - 3_600_000);
    if ((f?.n ?? 0) >= 3) await notify(env, "failures", `⚠️ ${f!.n} رسائل فشلت أو نتيجتها غير مؤكدة خلال الساعة الأخيرة. افتح «السجل» في التطبيق للتفاصيل.`);
  }
  if (s.alert_spike) {
    const c = await first<{ n: number }>(env.DB, "SELECT COUNT(*) AS n FROM conversation_flows WHERE is_demo = 0 AND created_at >= ?", now - 3_600_000);
    if ((c?.n ?? 0) >= s.spike_per_hour) await notify(env, "spike", `🔥 تفاعل كبير: ${c!.n} شخص تفاعلوا مع حملاتك خلال الساعة الأخيرة.`);
  }
}
