import { Hono, type Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import type { Env } from "./env";
import { missingSecrets } from "./env";
import { all, audit, first, getSetting, run, setSetting } from "./lib/db";
import { hashPassword, randomToken, sha256Hex, timingSafeEqual, verifyMetaSignature, verifyPassword } from "./lib/crypto";
import { parseWebhook } from "./meta/webhook-parse";
import { INSTAGRAM_SCOPES, WEBHOOK_FIELDS, sanitize } from "./meta/client";
import type { MediaItem } from "./meta/types";
import {
  allowedAppOrigins,
  clientIp,
  createSession,
  rateLimit,
  requireAuth,
  SESSION_COOKIE,
  WEB_SESSION_TTL,
  type AppEnv,
} from "./services/auth";
import {
  completeOAuth,
  DEFAULT_API_VERSION,
  disconnectAccount,
  engineContext,
  getAccessToken,
  metaClient,
  redirectUri,
  refreshToken,
  subscribeWebhooks,
} from "./services/account";
import { storeEvents } from "./services/webhook";
import { simulate } from "./services/simulate";
import { runQueue } from "./engine/executor";
import { cancelJobsWhere } from "./engine/jobs";
import type { AccountRow } from "./engine/context";
import {
  campaignInputSchema,
  drawInputSchema,
  loginSchema,
  settingsSchema,
  setupSchema,
  simulateSchema,
  templateInputSchema,
} from "../shared/schemas";
import { claimsDelivery, publicReplyVariants } from "../shared/template";
import { cacheMediaStmt } from "./services/media";
import { markRead, recordMessage } from "./services/inbox";
import { buildDailyReport, detectChat, getNotifySettings, hasBotToken, isTelegramToken, saveBotToken, sendTelegram } from "./services/notify";
import { MESSAGING_WINDOW_MS } from "./engine/context";
import { estimateUsage } from "./services/usage";
import { recoverMissedComments } from "./services/recover";
import { DrawFailure, EXCLUDE_LABELS, fetchBatch, loadDraw, pickNext, preview, replaceWinner, runDraw, settingsOf, winnersOf } from "./services/draws";
import { instagramShortcode } from "../shared/draw";

/** Settings shown to the client / exported in backups: never the Telegram bot token or notification state. */
const PUBLIC_SETTINGS_SQL = "key NOT LIKE 'telegram%' AND key NOT LIKE 'notify%'";
import { toCsv } from "../shared/csv";
import { dataDeletionPage, deletionStatusPage, oauthResultPage, PAGE_CSP, parseSignedRequest, privacyPage, termsPage } from "./pages";

type C = Context<AppEnv>;

function apiError(c: C, status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503, code: string, message: string, details?: unknown) {
  return c.json({ error: { code, message, details } }, status);
}

async function parseBody<T extends z.ZodTypeAny>(c: C, schema: T): Promise<{ ok: true; data: z.infer<T> } | { ok: false; res: Response }> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, res: apiError(c, 400, "invalid_json", "صيغة الطلب غير صحيحة") };
  }
  const r = schema.safeParse(body);
  if (!r.success) {
    return {
      ok: false,
      res: apiError(c, 422, "validation", "بيانات غير صالحة", r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }))),
    };
  }
  return { ok: true, data: r.data };
}

const idParam = (c: C) => {
  const n = Number(c.req.param("id"));
  return Number.isInteger(n) && n > 0 ? n : null;
};

async function currentAccount(db: D1Database): Promise<AccountRow & Record<string, any> | null> {
  return first(db, "SELECT * FROM instagram_accounts WHERE is_demo = 0 ORDER BY (status = 'active') DESC, updated_at DESC LIMIT 1");
}

function publicAccount(a: any) {
  if (!a) return null;
  const { token_ciphertext, token_iv, token_key_version, ...rest } = a;
  return {
    ...rest,
    has_token: !!token_ciphertext,
    scopes: JSON.parse(a.scopes || "[]"),
    webhook_fields: JSON.parse(a.webhook_fields || "[]"),
  };
}

export function createApp() {
  const app = new Hono<AppEnv>();

  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: undefined, // SPA CSP is set in public/_headers and index.html meta
      crossOriginResourcePolicy: false,
      referrerPolicy: "strict-origin-when-cross-origin",
      xFrameOptions: "DENY",
    }),
  );

  // CORS only for the Android app origins (bearer-token auth, no cookies).
  app.use("/api/*", async (c, next) => {
    const allowed = allowedAppOrigins(c.env);
    return cors({
      origin: (origin) => (allowed.includes(origin) ? origin : null),
      allowHeaders: ["Authorization", "Content-Type"],
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      credentials: false,
      maxAge: 600,
    })(c, next);
  });

  app.onError((err, c) => {
    console.error("unhandled", sanitize(String(err?.stack ?? err)));
    return c.json({ error: { code: "internal", message: "حدث خطأ داخلي" } }, 500);
  });

  app.get("/healthz", (c) => c.json({ ok: true, version: c.env.APP_VERSION }));

  // ------------------------------------------------------------------ Public legal pages
  const html = (c: C, body: string) => {
    c.header("Content-Security-Policy", PAGE_CSP);
    return c.html(body);
  };
  // Tracked content link: counts the tap, then redirects to the campaign's real link.
  // Link-preview crawlers (Instagram/Meta fetch the URL to render a card) are redirected but not counted.
  app.on(["GET", "HEAD"], "/l/:token", async (c) => {
    const token = c.req.param("token");
    const notFound = () => c.html('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font-family:system-ui;text-align:center;padding:3rem">الرابط غير صالح أو منتهي.</body>', 404);
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return notFound();
    const row = await first<{ id: number; link_url: string | null }>(c.env.DB, "SELECT id, link_url FROM conversation_flows WHERE link_token = ?", token);
    if (!row?.link_url || !/^https?:\/\//i.test(row.link_url)) return notFound();
    const ua = c.req.header("User-Agent") ?? "";
    const isBot = !ua || /facebookexternalhit|facebot|meta-external|bot\b|bot\/|crawler|spider|preview|slurp|whatsapp|telegram|curl|wget|python-requests|headless/i.test(ua);
    if (c.req.method === "GET" && !isBot) {
      const now = Date.now();
      await run(
        c.env.DB,
        "UPDATE conversation_flows SET link_clicks = link_clicks + 1, link_first_click_at = COALESCE(link_first_click_at, ?), link_last_click_at = ? WHERE id = ?",
        now,
        now,
        row.id,
      );
    }
    return new Response(null, {
      status: 302,
      headers: { Location: row.link_url, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" },
    });
  });

  app.get("/privacy", (c) => html(c, privacyPage(c.env.PUBLIC_BASE_URL)));
  app.get("/terms", (c) => html(c, termsPage()));
  app.get("/data-deletion", (c) => html(c, dataDeletionPage()));
  app.get("/meta/deletion-status", (c) => html(c, deletionStatusPage(c.req.query("code") ?? "")));

  // ------------------------------------------------------------------ Webhooks
  app.get("/webhooks/instagram", (c) => {
    const mode = c.req.query("hub.mode");
    const token = c.req.query("hub.verify_token") ?? "";
    const challenge = c.req.query("hub.challenge") ?? "";
    if (mode === "subscribe" && c.env.META_WEBHOOK_VERIFY_TOKEN && timingSafeEqual(token, c.env.META_WEBHOOK_VERIFY_TOKEN)) {
      return c.text(challenge, 200);
    }
    return c.text("forbidden", 403);
  });

  app.post("/webhooks/instagram", async (c) => {
    const raw = new Uint8Array(await c.req.arrayBuffer());
    if (raw.byteLength > 1_000_000) return c.text("payload too large", 413);
    const ok = await verifyMetaSignature(raw, c.req.header("X-Hub-Signature-256") ?? null, c.env.INSTAGRAM_APP_SECRET);
    if (!ok) return c.text("invalid signature", 401);
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return c.text("bad json", 400);
    }
    const events = await parseWebhook(body);
    try {
      await storeEvents(c.env.DB, events);
    } catch (err) {
      console.error("webhook store failed", sanitize(String(err)));
      return c.text("storage error", 500); // Meta will retry
    }
    // Opportunistic immediate processing; the cron trigger is the durable guarantee.
    let used = 0;
    const ctx = engineContext(c.env, () => used++);
    c.executionCtx.waitUntil(
      runQueue(ctx, { maxJobs: 8, includeDemo: false, deadlineMs: 25_000, waitForSoonMs: 20_000, budget: { used: () => used, limit: 40 } }).catch((e) =>
        console.error("inline queue", sanitize(String(e))),
      ),
    );
    return c.text("EVENT_RECEIVED", 200);
  });

  // Meta "Deauthorize callback" and "Data deletion request" (signed_request, verified with the app secret).
  app.post("/meta/deauthorize", async (c) => {
    const form = await c.req.parseBody();
    const data = await parseSignedRequest(String(form["signed_request"] ?? ""), c.env.INSTAGRAM_APP_SECRET);
    if (!data?.user_id) return c.text("invalid", 400);
    const acc = await first<{ id: number }>(c.env.DB, "SELECT id FROM instagram_accounts WHERE (ig_user_id = ? OR app_scoped_id = ?) AND is_demo = 0", String(data.user_id), String(data.user_id));
    if (acc) await disconnectAccount(c.env, acc.id, { purge: false, actor: "meta:deauthorize", skipRemote: true });
    return c.json({ success: true });
  });

  app.post("/meta/data-deletion", async (c) => {
    const form = await c.req.parseBody();
    const data = await parseSignedRequest(String(form["signed_request"] ?? ""), c.env.INSTAGRAM_APP_SECRET);
    if (!data?.user_id) return c.text("invalid", 400);
    const uid = String(data.user_id);
    const acc = await first<{ id: number }>(c.env.DB, "SELECT id FROM instagram_accounts WHERE (ig_user_id = ? OR app_scoped_id = ?) AND is_demo = 0", uid, uid);
    if (acc) {
      await disconnectAccount(c.env, acc.id, { purge: true, actor: "meta:data-deletion", skipRemote: true });
    } else {
      // A regular Instagram user who interacted with the account: remove their participant data.
      await c.env.DB.batch([
        c.env.DB.prepare("DELETE FROM messages WHERE participant_id IN (SELECT id FROM participants WHERE igsid = ?)").bind(uid),
        c.env.DB.prepare("DELETE FROM participants WHERE igsid = ?").bind(uid),
        c.env.DB.prepare("UPDATE webhook_events SET text = NULL, sender_username = NULL, payload = '{}' WHERE sender_id = ?").bind(uid),
      ]);
    }
    const code = randomToken(9);
    await audit(c.env.DB, "meta", "data_deletion", code);
    return c.json({ url: `${c.env.PUBLIC_BASE_URL}/meta/deletion-status?code=${code}`, confirmation_code: code });
  });

  // ------------------------------------------------------------------ OAuth callback (system browser)
  app.get("/oauth/instagram/callback", async (c) => {
    const state = c.req.query("state") ?? "";
    const code = c.req.query("code") ?? "";
    const now = Date.now();
    // State must exist, be unexpired and unused — it is consumed atomically.
    const st = state
      ? await first<{ client: "web" | "app" }>(
          c.env.DB,
          "UPDATE oauth_states SET used_at = ? WHERE state_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING client",
          now,
          await sha256Hex(state),
          now,
        )
      : null;
    c.header("Content-Security-Policy", PAGE_CSP);
    c.header("Cache-Control", "no-store");
    if (!st) return c.html(oauthResultPage(false, "رابط الربط غير صالح أو منتهي. ابدأ الربط من جديد من التطبيق.", "web", c.env.APP_DEEP_LINK), 400);
    if (c.req.query("error") || !code) {
      return c.html(oauthResultPage(false, "تم إلغاء الربط أو رفض الأذونات.", st.client, c.env.APP_DEEP_LINK), 400);
    }
    const r = await completeOAuth(c.env, code.replace(/#_$/, ""));
    if (!r.ok) {
      const detail = sanitize(r.error ?? "unknown");
      console.error("oauth failed", detail);
      await audit(c.env.DB, "system", "oauth.failed", undefined, { detail });
      const hint = detail.startsWith("code_exchange")
        ? "غالبًا INSTAGRAM_APP_SECRET غير صحيح (يجب أن يكون «Instagram app secret» من صفحة إعداد API باستخدام تسجيل دخول Instagram، وليس المفتاح السري في «الإعدادات › أساسي»)، أو INSTAGRAM_APP_ID غير مطابق."
        : "تحقق من إعدادات التطبيق في Meta ثم أعد المحاولة.";
      return c.html(oauthResultPage(false, `تعذر إكمال الربط مع Meta. ${hint} — التفاصيل: ${detail}`, st.client, c.env.APP_DEEP_LINK), 502);
    }
    return c.html(oauthResultPage(true, "تم ربط حساب إنستقرام بنجاح. ارجع للتطبيق لمراجعة الأذونات وحالة Webhooks.", st.client, c.env.APP_DEEP_LINK));
  });

  // ------------------------------------------------------------------ Public API
  app.get("/api/app/version", (c) =>
    c.json({
      version: c.env.APP_VERSION,
      releases_url: c.env.RELEASES_URL || null,
      apk_url: c.env.APK_DOWNLOAD_URL || null,
      api_version: c.env.META_API_VERSION || DEFAULT_API_VERSION,
      api_version_verified_at: c.env.META_API_VERIFIED_AT || null,
    }),
  );

  app.get("/api/auth/status", async (c) => {
    const admin = await first(c.env.DB, "SELECT id FROM admin_users LIMIT 1");
    return c.json({ needs_setup: !admin, setup_enabled: !admin && !!c.env.SETUP_TOKEN, missing_secrets: missingSecrets(c.env) });
  });

  app.post("/api/auth/setup", async (c) => {
    if (!(await rateLimit(c.env.DB, `setup:${clientIp(c)}`, 5, 15 * 60_000))) return apiError(c, 429, "rate_limited", "محاولات كثيرة، حاول لاحقًا");
    const p = await parseBody(c, setupSchema);
    if (!p.ok) return p.res;
    if (!c.env.SETUP_TOKEN || !c.env.PASSWORD_PEPPER) return apiError(c, 403, "setup_disabled", "الإعداد الأولي غير مفعّل على الخادم");
    if (!timingSafeEqual(p.data.setup_token, c.env.SETUP_TOKEN)) return apiError(c, 403, "bad_setup_token", "رمز الإعداد غير صحيح");
    const hash = await hashPassword(p.data.password, c.env.PASSWORD_PEPPER, Number(c.env.PBKDF2_ITERATIONS || 100_000));
    const now = Date.now();
    try {
      // The singleton unique index guarantees only one admin can ever be created.
      await run(c.env.DB, "INSERT INTO admin_users (username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)", p.data.username, hash, now, now);
    } catch {
      return apiError(c, 409, "already_setup", "تم الإعداد مسبقًا");
    }
    await audit(c.env.DB, p.data.username, "admin.setup");
    return c.json({ ok: true, next: "احذف SETUP_TOKEN من أسرار Worker الآن (wrangler secret delete SETUP_TOKEN)" });
  });

  app.post("/api/auth/login", async (c) => {
    const ip = clientIp(c);
    if (!(await rateLimit(c.env.DB, `login:${ip}`, 10, 15 * 60_000))) return apiError(c, 429, "rate_limited", "محاولات كثيرة، انتظر 15 دقيقة");
    const p = await parseBody(c, loginSchema);
    if (!p.ok) return p.res;
    const user = await first<{ id: number; username: string; password_hash: string; failed_attempts: number; locked_until: number | null }>(
      c.env.DB,
      "SELECT * FROM admin_users WHERE username = ?",
      p.data.username,
    );
    const now = Date.now();
    if (user?.locked_until && user.locked_until > now) return apiError(c, 429, "locked", "الحساب مقفل مؤقتًا بسبب محاولات فاشلة");
    const valid = user ? await verifyPassword(p.data.password, user.password_hash, c.env.PASSWORD_PEPPER) : false;
    if (!user || !valid) {
      if (user) {
        const fails = user.failed_attempts + 1;
        await run(c.env.DB, "UPDATE admin_users SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?", fails, fails >= 5 ? now + 15 * 60_000 : null, now, user.id);
      }
      return apiError(c, 401, "invalid_credentials", "بيانات الدخول غير صحيحة");
    }
    await run(c.env.DB, "UPDATE admin_users SET failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?", now, user.id);
    const kind = p.data.client === "app" ? "device" : "web";
    const s = await createSession(c.env.DB, user.id, kind, p.data.device_label);
    await audit(c.env.DB, user.username, "auth.login", kind);
    if (kind === "web") {
      setCookie(c, SESSION_COOKIE, s.token, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: WEB_SESSION_TTL / 1000 });
      return c.json({ ok: true, username: user.username, csrf_token: s.csrf });
    }
    return c.json({ ok: true, username: user.username, token: s.token, expires_at: s.expiresAt });
  });

  // ------------------------------------------------------------------ Authenticated API
  const api = new Hono<AppEnv>();
  api.use("*", requireAuth);

  api.get("/auth/me", (c) => {
    const s = c.get("session");
    return c.json({ username: s.username, kind: s.kind, csrf_token: s.kind === "web" ? s.csrf_token : undefined });
  });

  api.post("/auth/logout", async (c) => {
    await run(c.env.DB, "UPDATE sessions SET revoked_at = ? WHERE id = ?", Date.now(), c.get("session").id);
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
    return c.json({ ok: true });
  });

  api.get("/auth/sessions", async (c) =>
    c.json(await all(c.env.DB, "SELECT substr(id,1,12) AS id, kind, device_label, created_at, last_seen_at, expires_at FROM sessions WHERE revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC", Date.now())),
  );

  api.post("/auth/sessions/revoke-others", async (c) => {
    await run(c.env.DB, "UPDATE sessions SET revoked_at = ? WHERE id != ? AND revoked_at IS NULL", Date.now(), c.get("session").id);
    return c.json({ ok: true });
  });

  // ---- Dashboard
  api.get("/dashboard", async (c) => {
    const db = c.env.DB;
    const since = Date.now() - Number(c.req.query("days") ?? 30) * 86_400_000;
    const [account, campaigns, events, jobs, flows, follows, automation] = await Promise.all([
      currentAccount(db),
      first(db, "SELECT SUM(status='active') AS active, SUM(status='paused') AS paused, SUM(status='draft') AS draft FROM campaigns WHERE deleted_at IS NULL"),
      all(db, "SELECT event_type, status, COUNT(*) AS n FROM webhook_events WHERE is_demo = 0 AND received_at > ? GROUP BY event_type, status", since),
      all(db, "SELECT kind, purpose, status, COUNT(*) AS n FROM action_jobs WHERE is_demo = 0 AND created_at > ? AND kind != 'process_event' GROUP BY kind, purpose, status", since),
      all(db, "SELECT state, COUNT(*) AS n FROM conversation_flows WHERE is_demo = 0 AND created_at > ? GROUP BY state", since),
      first(db, "SELECT COUNT(DISTINCT participant_id) AS verified FROM follow_checks WHERE is_demo = 0 AND result = 'following' AND checked_at > ?", since),
      getSetting(db, "automation_enabled", true),
    ]);
    return c.json({ account: publicAccount(account), campaigns, events, jobs, flows, follows, automation_enabled: automation });
  });

  api.post("/automation", async (c) => {
    const p = await parseBody(c, z.object({ enabled: z.boolean() }));
    if (!p.ok) return p.res;
    await setSetting(c.env.DB, "automation_enabled", p.data.enabled);
    if (!p.data.enabled) await cancelJobsWhere(c.env.DB, "is_demo = 0 AND kind != 'process_event'", Date.now());
    await audit(c.env.DB, c.get("session").username, p.data.enabled ? "automation.enabled" : "automation.disabled");
    return c.json({ ok: true, enabled: p.data.enabled });
  });

  // ---- Instagram account connection
  api.get("/account", async (c) => {
    const a = await currentAccount(c.env.DB);
    return c.json({
      account: publicAccount(a),
      required_scopes: INSTAGRAM_SCOPES,
      webhook_fields: WEBHOOK_FIELDS,
      api_version: c.env.META_API_VERSION || DEFAULT_API_VERSION,
      api_version_verified_at: c.env.META_API_VERIFIED_AT || null,
      redirect_uri: redirectUri(c.env),
      webhook_url: `${c.env.PUBLIC_BASE_URL}/webhooks/instagram`,
      configured: !!c.env.INSTAGRAM_APP_ID && !!c.env.INSTAGRAM_APP_SECRET,
    });
  });

  api.post("/account/connect", async (c) => {
    const p = await parseBody(c, z.object({ client: z.enum(["web", "app"]).default("web") }));
    if (!p.ok) return p.res;
    if (!c.env.INSTAGRAM_APP_ID || !c.env.INSTAGRAM_APP_SECRET) return apiError(c, 503, "not_configured", "لم يتم إعداد INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET على الخادم");
    const state = randomToken(32);
    const now = Date.now();
    await run(c.env.DB, "DELETE FROM oauth_states WHERE expires_at < ?", now);
    await run(
      c.env.DB,
      "INSERT INTO oauth_states (state_hash, user_id, client, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      await sha256Hex(state),
      c.get("session").user_id,
      p.data.client,
      now,
      now + 10 * 60_000,
    );
    return c.json({ url: metaClient(c.env).authorizeUrl(redirectUri(c.env), state) });
  });

  api.post("/account/resubscribe", async (c) => {
    const a = await currentAccount(c.env.DB);
    if (!a || a.status === "disconnected") return apiError(c, 404, "no_account", "لا يوجد حساب متصل");
    const r = await subscribeWebhooks(c.env, a.id);
    return r.ok ? c.json({ ok: true }) : apiError(c, 502 as any, "meta_error", r.error ?? "فشل الاشتراك");
  });

  api.post("/account/refresh-token", async (c) => {
    const a = await currentAccount(c.env.DB);
    if (!a || a.status === "disconnected") return apiError(c, 404, "no_account", "لا يوجد حساب متصل");
    const r = await refreshToken(c.env, a);
    return r.ok ? c.json({ ok: true }) : apiError(c, 502 as any, "meta_error", r.error ?? "فشل التجديد");
  });

  api.get("/account/diagnostics", async (c) => {
    const a = await currentAccount(c.env.DB);
    const checks: Array<{ name: string; ok: boolean | null; detail?: string }> = [];
    const miss = missingSecrets(c.env);
    checks.push({ name: "أسرار الخادم", ok: miss.length === 0, detail: miss.length ? `ناقص: ${miss.join(", ")}` : undefined });
    checks.push({ name: "INSTAGRAM_APP_ID", ok: !!c.env.INSTAGRAM_APP_ID });
    checks.push({ name: "PUBLIC_BASE_URL (HTTPS)", ok: c.env.PUBLIC_BASE_URL?.startsWith("https://") ?? false, detail: c.env.PUBLIC_BASE_URL });
    if (!a || a.status === "disconnected") {
      checks.push({ name: "حساب متصل", ok: false });
      return c.json({ checks });
    }
    checks.push({ name: "حالة التفويض", ok: a.status === "active", detail: a.status });
    const token = await getAccessToken(c.env, c.env.DB, a);
    checks.push({ name: "فك تشفير التوكن", ok: !!token });
    if (token) {
      const meta = metaClient(c.env);
      const me = await meta.getMe(token);
      checks.push({ name: "استدعاء /me", ok: me.ok, detail: me.ok ? `@${me.data.username}` : me.error.message });
      const subs = await meta.getSubscriptions(token);
      const fields = subs.ok ? (subs.data.data?.[0]?.subscribed_fields ?? []) : [];
      checks.push({ name: "اشتراك Webhooks", ok: subs.ok && WEBHOOK_FIELDS.every((f) => fields.includes(f)), detail: subs.ok ? fields.join(", ") || "لا حقول" : subs.error.message });
    }
    checks.push({ name: "آخر حدث Webhook", ok: a.last_webhook_at ? true : null, detail: a.last_webhook_at ? new Date(a.last_webhook_at).toISOString() : "لم يصل أي حدث بعد" });
    checks.push({ name: "التحقق من المتابعة", ok: a.follow_check_support === "supported" ? true : a.follow_check_support === "unsupported" ? false : null, detail: a.follow_check_note ?? a.follow_check_support });
    return c.json({ checks });
  });

  api.post("/account/disconnect", async (c) => {
    const p = await parseBody(c, z.object({ purge: z.boolean().default(false) }));
    if (!p.ok) return p.res;
    const a = await currentAccount(c.env.DB);
    if (!a) return apiError(c, 404, "no_account", "لا يوجد حساب");
    await disconnectAccount(c.env, a.id, { purge: p.data.purge, actor: c.get("session").username });
    return c.json({ ok: true });
  });

  // ---- Media & stories
  api.get("/media", async (c) => {
    const a = await currentAccount(c.env.DB);
    if (!a) return c.json({ items: [] });
    const kind = c.req.query("kind") === "story" ? "story" : "media";
    const items = await all(c.env.DB, "SELECT * FROM media_cache WHERE account_id = ? AND kind = ? ORDER BY posted_at DESC LIMIT 1000", a.id, kind);
    return c.json({ items, now: Date.now() });
  });

  api.post("/media/refresh", async (c) => {
    const p = await parseBody(c, z.object({ kind: z.enum(["media", "story"]), after: z.string().max(500).optional(), all: z.boolean().default(true) }));
    if (!p.ok) return p.res;
    const a = await currentAccount(c.env.DB);
    if (!a || a.status !== "active") return apiError(c, 409, "no_account", "اربط الحساب أولًا");
    const token = await getAccessToken(c.env, c.env.DB, a);
    if (!token) return apiError(c, 409, "no_token", "التفويض غير متاح — أعد الربط");
    const meta = metaClient(c.env);
    // Follow pagination to fetch every post/reel (bounded: max 12 pages × 50 = 600 items per refresh,
    // well inside the Workers Free limit of 50 external requests per invocation).
    const items: MediaItem[] = [];
    let after = p.data.after;
    let next: string | null = null;
    for (let page = 0; page < (p.data.kind === "story" ? 1 : 12); page++) {
      const r = p.data.kind === "story" ? await meta.listStories(token) : await meta.listMedia(token, after);
      if (!r.ok) {
        if (r.error.kind === "auth") await engineContext(c.env).onAuthError?.(a, r.error.message);
        if (!items.length) return apiError(c, 502 as any, "meta_error", r.error.message);
        break;
      }
      items.push(...r.data.data);
      next = r.data.paging?.next ? r.data.paging?.cursors?.after ?? null : null;
      if (!next || !p.data.all) break;
      after = next;
    }
    const now = Date.now();
    const stmts = items.map((m) => cacheMediaStmt(c.env.DB, a.id, m, p.data.kind, now));
    if (stmts.length) await c.env.DB.batch(stmts);
    return c.json({ count: stmts.length, next });
  });

  // ---- Campaigns
  api.get("/campaigns", async (c) => {
    const q = (c.req.query("q") ?? "").slice(0, 100);
    const status = c.req.query("status");
    const type = c.req.query("type");
    const where = ["deleted_at IS NULL"];
    const params: unknown[] = [];
    if (q) {
      where.push("name LIKE ? ESCAPE '\\'");
      params.push(`%${q.replace(/[%_\\]/g, (m) => "\\" + m)}%`);
    }
    if (status && ["draft", "active", "paused", "archived"].includes(status)) {
      where.push("status = ?");
      params.push(status);
    }
    if (type && ["comment", "story_reply", "story_mention"].includes(type)) {
      where.push("type = ?");
      params.push(type);
    }
    const rows = await all(
      c.env.DB,
      `SELECT c.*, (SELECT COUNT(*) FROM conversation_flows f WHERE f.campaign_id = c.id AND f.is_demo = 0) AS flows_count,
              (SELECT COUNT(DISTINCT f.participant_id) FROM conversation_flows f WHERE f.campaign_id = c.id AND f.is_demo = 0) AS people_count,
              (SELECT COUNT(DISTINCT f.participant_id) FROM conversation_flows f WHERE f.campaign_id = c.id AND f.is_demo = 0 AND f.state = 'content_sent') AS delivered_count,
              (SELECT m.thumbnail_url FROM campaign_media cm JOIN media_cache m ON m.media_id = cm.media_id WHERE cm.campaign_id = c.id AND m.thumbnail_url IS NOT NULL LIMIT 1) AS cover_url,
              (SELECT COUNT(*) FROM campaign_media cm WHERE cm.campaign_id = c.id) AS media_count
         FROM campaigns c WHERE ${where.join(" AND ")} ORDER BY priority DESC, id DESC`,
      ...params,
    );
    return c.json(rows);
  });

  api.get("/campaigns/:id", async (c) => {
    const id = idParam(c);
    const row = id && (await first(c.env.DB, "SELECT * FROM campaigns WHERE id = ? AND deleted_at IS NULL", id));
    if (!row) return apiError(c, 404, "not_found", "الحملة غير موجودة");
    const [keywords, media] = await Promise.all([
      all(c.env.DB, "SELECT keyword, kind, match_type FROM campaign_keywords WHERE campaign_id = ? ORDER BY id", id),
      all<{ media_id: string }>(c.env.DB, "SELECT media_id FROM campaign_media WHERE campaign_id = ?", id),
    ]);
    return c.json({ ...row, keywords, media_ids: media.map((m) => m.media_id) });
  });

  // Per-post performance of one campaign: comments, people reached, follow conversions, deliveries.
  api.get("/campaigns/:id/stats", async (c) => {
    const id = idParam(c);
    const campaign = id && (await first<{ id: number; type: string; require_follow: number }>(c.env.DB, "SELECT id, type, require_follow FROM campaigns WHERE id = ? AND deleted_at IS NULL", id));
    if (!campaign) return apiError(c, 404, "not_found", "الحملة غير موجودة");
    const days = Number(c.req.query("days") ?? 0);
    const since = days > 0 ? Date.now() - Math.min(days, 3650) * 86_400_000 : 0;
    const db = c.env.DB;
    // One row per flow with the facts we aggregate on (first follow result, did we reach them, did they convert).
    const perFlow = `
      SELECT f.id, f.participant_id, COALESCE(f.source_media_id, '') AS media_id, f.state, f.public_reply_status, f.created_at, f.link_clicks,
             (SELECT fc.result FROM follow_checks fc WHERE fc.flow_id = f.id ORDER BY fc.id LIMIT 1) AS first_follow,
             EXISTS (SELECT 1 FROM follow_checks fc WHERE fc.flow_id = f.id AND fc.result = 'not_following') AS saw_not_following,
             EXISTS (SELECT 1 FROM follow_checks fc WHERE fc.flow_id = f.id AND fc.result = 'following') AS saw_following,
             (f.private_reply_status = 'accepted' OR EXISTS (
                SELECT 1 FROM action_jobs j WHERE j.flow_id = f.id AND j.kind = 'send_message' AND j.status = 'accepted')) AS reached
        FROM conversation_flows f
       WHERE f.campaign_id = ? AND f.is_demo = 0 AND f.created_at >= ?`;
    const agg = `
      COUNT(*) AS triggers,
      COUNT(DISTINCT participant_id) AS people,
      COUNT(DISTINCT CASE WHEN reached THEN participant_id END) AS reached,
      COUNT(DISTINCT CASE WHEN first_follow IS NOT NULL THEN participant_id END) AS interacted,
      COUNT(DISTINCT CASE WHEN first_follow = 'following' THEN participant_id END) AS already_following,
      COUNT(DISTINCT CASE WHEN saw_not_following AND saw_following THEN participant_id END) AS new_followers,
      COUNT(DISTINCT CASE WHEN saw_not_following AND NOT saw_following THEN participant_id END) AS not_followed,
      COUNT(DISTINCT CASE WHEN state = 'content_sent' THEN participant_id END) AS delivered,
      SUM(state IN ('awaiting_user_interaction','awaiting_follow','checking_follow','ready_to_deliver','delivering','trigger_received')) AS waiting,
      SUM(state IN ('expired','failed','cancelled','verification_unavailable')) AS dropped,
      SUM(public_reply_status = 'accepted') AS public_replies,
      COUNT(DISTINCT CASE WHEN link_clicks > 0 THEN participant_id END) AS clicked,
      COALESCE(SUM(link_clicks), 0) AS clicks_total,
      MAX(created_at) AS last_at`;
    const [rows, totals, comments] = await Promise.all([
      all<any>(db, `SELECT media_id, ${agg} FROM (${perFlow}) GROUP BY media_id`, id, since),
      first<any>(db, `SELECT ${agg} FROM (${perFlow})`, id, since),
      all<{ media_id: string; total: number; matched: number }>(
        db,
        `SELECT media_id, COUNT(*) AS total, SUM(campaign_id = ?) AS matched FROM webhook_events
          WHERE event_type = 'comment' AND is_demo = 0 AND received_at >= ? AND media_id IS NOT NULL
            AND (media_id IN (SELECT media_id FROM campaign_media WHERE campaign_id = ?) OR campaign_id = ?)
          GROUP BY media_id`,
        id, since, id, id,
      ),
    ]);
    const mediaIds = new Set<string>([...rows.map((r) => r.media_id), ...comments.map((r) => r.media_id)].filter(Boolean));
    for (const m of await all<{ media_id: string }>(db, "SELECT media_id FROM campaign_media WHERE campaign_id = ?", id)) mediaIds.add(m.media_id);
    const meta = mediaIds.size
      ? await all<any>(db, `SELECT media_id, caption, permalink, thumbnail_url, media_product_type, posted_at FROM media_cache WHERE media_id IN (${[...mediaIds].map(() => "?").join(",")})`, ...mediaIds)
      : [];
    const byId = new Map(meta.map((m) => [m.media_id, m]));
    const empty = { triggers: 0, people: 0, reached: 0, interacted: 0, already_following: 0, new_followers: 0, not_followed: 0, delivered: 0, clicked: 0, clicks_total: 0, waiting: 0, dropped: 0, public_replies: 0, last_at: null };
    const commentsBy = new Map(comments.map((r) => [r.media_id, r]));
    const media = [...new Set<string>([...mediaIds, ...rows.map((r) => r.media_id)])].map((mid) => ({
      ...empty,
      ...(rows.find((r) => r.media_id === mid) ?? {}),
      media_id: mid || null,
      comments_total: commentsBy.get(mid)?.total ?? 0,
      comments_matched: commentsBy.get(mid)?.matched ?? 0,
      media: byId.get(mid) ?? null,
    }));
    media.sort((a, b) => b.people - a.people || b.comments_total - a.comments_total);
    return c.json({
      campaign,
      since,
      totals: { ...empty, ...(totals ?? {}), comments_total: comments.reduce((n, r) => n + r.total, 0), comments_matched: comments.reduce((n, r) => n + (r.matched ?? 0), 0) },
      media,
    });
  });

  // Who interacted with a campaign: one row per person (latest interaction), with the same flags as the stats.
  api.get("/campaigns/:id/people", async (c) => {
    const id = idParam(c);
    const campaign = id && (await first(c.env.DB, "SELECT id FROM campaigns WHERE id = ? AND deleted_at IS NULL", id));
    if (!campaign) return apiError(c, 404, "not_found", "الحملة غير موجودة");
    const days = Number(c.req.query("days") ?? 0);
    const since = days > 0 ? Date.now() - Math.min(days, 3650) * 86_400_000 : 0;
    const media = c.req.query("media_id");
    const params: unknown[] = [id, since];
    let mediaSql = "";
    if (media !== undefined) {
      mediaSql = "AND COALESCE(f.source_media_id, '') = ?";
      params.push(media.slice(0, 64));
    }
    const rows = await all<any>(
      c.env.DB,
      `SELECT f.id, f.participant_id, p.username, f.trigger_type, COALESCE(f.source_media_id, '') AS media_id, f.state, f.state_reason,
              f.created_at, f.updated_at, f.content_delivered_at, e.text AS trigger_text, p.last_follow_status, f.link_clicks, f.link_first_click_at,
              (SELECT fc.result FROM follow_checks fc WHERE fc.flow_id = f.id ORDER BY fc.id LIMIT 1) AS first_follow,
              EXISTS (SELECT 1 FROM follow_checks fc WHERE fc.flow_id = f.id AND fc.result = 'not_following') AS saw_not_following,
              EXISTS (SELECT 1 FROM follow_checks fc WHERE fc.flow_id = f.id AND fc.result = 'following') AS saw_following,
              (f.private_reply_status = 'accepted' OR EXISTS (
                 SELECT 1 FROM action_jobs j WHERE j.flow_id = f.id AND j.kind = 'send_message' AND j.status = 'accepted')) AS reached
         FROM conversation_flows f
         JOIN participants p ON p.id = f.participant_id
         LEFT JOIN webhook_events e ON e.id = f.trigger_event_id
        WHERE f.campaign_id = ? AND f.is_demo = 0 AND f.created_at >= ? ${mediaSql}
        ORDER BY f.id DESC LIMIT 3000`,
      ...params,
    );
    const WAITING = ["trigger_received", "awaiting_user_interaction", "checking_follow", "awaiting_follow", "ready_to_deliver", "delivering"];
    const people = new Map<number, any>();
    for (const r of rows) {
      let p = people.get(r.participant_id);
      if (!p) {
        // Rows are newest first: the first one seen is the person's latest interaction.
        p = {
          participant_id: r.participant_id, username: r.username, state: r.state, state_reason: r.state_reason,
          last_at: r.updated_at, first_at: r.created_at, follow_status: r.last_follow_status, interactions: [],
          reached: false, interacted: false, already_following: false, new_follower: false, not_followed: false,
          delivered: false, waiting: WAITING.includes(r.state), delivered_at: null, clicks: 0, clicked_at: null,
        };
        people.set(r.participant_id, p);
      }
      p.first_at = Math.min(p.first_at, r.created_at);
      p.reached ||= !!r.reached;
      p.interacted ||= r.first_follow != null;
      p.already_following ||= r.first_follow === "following";
      p.new_follower ||= !!(r.saw_not_following && r.saw_following);
      p.delivered ||= r.state === "content_sent";
      p.clicks += r.link_clicks ?? 0;
      if (r.link_first_click_at) p.clicked_at = p.clicked_at ? Math.min(p.clicked_at, r.link_first_click_at) : r.link_first_click_at;
      if (r.content_delivered_at) p.delivered_at = Math.max(p.delivered_at ?? 0, r.content_delivered_at);
      p.not_followed ||= !!(r.saw_not_following && !r.saw_following);
      if (p.interactions.length < 10) p.interactions.push({ type: r.trigger_type, text: r.trigger_text, media_id: r.media_id || null, at: r.created_at, state: r.state });
    }
    for (const p of people.values()) if (p.new_follower || p.delivered) p.not_followed = false;
    return c.json({ people: [...people.values()], truncated: rows.length >= 3000 });
  });

  async function saveCampaign(c: C, id: number | null) {
    const p = await parseBody(c, campaignInputSchema);
    if (!p.ok) return p.res;
    const d = p.data;
    const now = Date.now();
    const warnings: string[] = [];
    if (d.require_follow && d.public_reply_enabled && publicReplyVariants(d.public_reply_text).some((v) => claimsDelivery(v))) {
      warnings.push("بعض صيغ الرد العام تدّعي الإرسال قبل التسليم الفعلي؛ لن تُستخدم قبل التسليم (تُستخدم الصيغ الأخرى أو صيغ محايدة تلقائيًا).");
    }
    const cols = {
      name: d.name, type: d.type, priority: d.priority, scope: d.scope, match_all: d.match_all ? 1 : 0, unify_alef: d.unify_alef ? 1 : 0,
      include_replies: d.include_replies ? 1 : 0, require_follow: d.require_follow ? 1 : 0, opening_text: d.opening_text ?? null,
      follow_request_text: d.follow_request_text ?? null, follow_reminder_text: d.follow_reminder_text ?? null, verify_error_text: d.verify_error_text ?? null,
      final_text: d.final_text, final_url: d.final_url || null, public_reply_enabled: d.public_reply_enabled ? 1 : 0, public_reply_text: d.public_reply_text ?? null,
      public_reply_on_dm_fail: d.public_reply_on_dm_fail, public_reply_fallback_text: d.public_reply_fallback_text ?? null,
      schedule_start: d.schedule_start ?? null, schedule_end: d.schedule_end ?? null, timezone: d.timezone,
      per_user_cooldown_hours: d.per_user_cooldown_hours, max_deliveries_per_user: d.max_deliveries_per_user,
      max_verify_attempts: d.max_verify_attempts, verify_cooldown_seconds: d.verify_cooldown_seconds, process_old_events: d.process_old_events ? 1 : 0,
      track_clicks: d.track_clicks ? 1 : 0, follow_reminder_minutes: d.follow_reminder_minutes,
      auto_new_media: d.auto_new_media && d.type === "comment" ? 1 : 0, auto_new_reels_only: d.auto_new_reels_only ? 1 : 0,
      // "New posts from now on": the starting point is kept once set (or taken from the request), else it is now.
      auto_new_since: d.auto_new_media && d.type === "comment"
        ? d.auto_new_since ?? (id !== null ? (await first<{ v: number | null }>(c.env.DB, "SELECT auto_new_since AS v FROM campaigns WHERE id = ?", id))?.v : null) ?? now
        : null,
    };
    const keys = Object.keys(cols);
    let campaignId: number;
    if (id === null) {
      const r = await first<{ id: number }>(
        c.env.DB,
        `INSERT INTO campaigns (${keys.join(",")}, status, created_at, updated_at) VALUES (${keys.map(() => "?").join(",")}, 'draft', ?, ?) RETURNING id`,
        ...Object.values(cols),
        now,
        now,
      );
      campaignId = r!.id;
    } else {
      const exists = await first(c.env.DB, "SELECT id FROM campaigns WHERE id = ? AND deleted_at IS NULL", id);
      if (!exists) return apiError(c, 404, "not_found", "الحملة غير موجودة");
      await run(c.env.DB, `UPDATE campaigns SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, ...Object.values(cols), now, id);
      campaignId = id;
    }
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM campaign_keywords WHERE campaign_id = ?").bind(campaignId),
      c.env.DB.prepare("DELETE FROM campaign_media WHERE campaign_id = ?").bind(campaignId),
      ...d.keywords.map((k) => c.env.DB.prepare("INSERT INTO campaign_keywords (campaign_id, keyword, kind, match_type) VALUES (?, ?, ?, ?)").bind(campaignId, k.keyword, k.kind, k.match_type)),
      ...[...new Set(d.media_ids)].map((m) => c.env.DB.prepare("INSERT INTO campaign_media (campaign_id, media_id) VALUES (?, ?)").bind(campaignId, m)),
    ]);
    await audit(c.env.DB, c.get("session").username, id ? "campaign.updated" : "campaign.created", String(campaignId));
    return c.json({ id: campaignId, warnings });
  }

  api.post("/campaigns", (c) => saveCampaign(c, null));
  api.put("/campaigns/:id", (c) => {
    const id = idParam(c);
    return id ? saveCampaign(c, id) : apiError(c, 404, "not_found", "غير موجود");
  });

  // Duplicate a campaign. Optional: attach it to other posts/reels ("copy to a new reel") and activate it right away.
  api.post("/campaigns/:id/duplicate", async (c) => {
    const id = idParam(c);
    const p = await parseBody(
      c,
      z.object({
        media_ids: z.array(z.string().regex(/^[0-9A-Za-z_]{1,64}$/)).min(1).max(50).optional(),
        name: z.string().trim().min(1).max(120).optional(),
        activate: z.boolean().default(false),
      }),
    );
    if (!p.ok) return p.res;
    const src = id && (await first<Record<string, unknown>>(c.env.DB, "SELECT * FROM campaigns WHERE id = ? AND deleted_at IS NULL", id));
    if (!src) return apiError(c, 404, "not_found", "الحملة غير موجودة");
    const now = Date.now();
    const { id: _id, status: _s, activated_at: _a, created_at: _c, updated_at: _u, deleted_at: _d, name, ...rest } = src;
    if (p.data.media_ids) {
      rest.scope = "selected";
      rest.auto_new_media = 0;
      rest.auto_new_since = null;
    }
    const keys = Object.keys(rest);
    const status = p.data.activate ? "active" : "draft";
    const r = await first<{ id: number }>(
      c.env.DB,
      `INSERT INTO campaigns (name, ${keys.join(",")}, status, activated_at, created_at, updated_at) VALUES (?, ${keys.map(() => "?").join(",")}, ?, ?, ?, ?) RETURNING id`,
      p.data.name ?? `${name} (نسخة)`,
      ...Object.values(rest),
      status,
      p.data.activate ? now : null,
      now,
      now,
    );
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO campaign_keywords (campaign_id, keyword, kind, match_type) SELECT ?, keyword, kind, match_type FROM campaign_keywords WHERE campaign_id = ?").bind(r!.id, id),
      ...(p.data.media_ids
        ? [...new Set(p.data.media_ids)].map((m) => c.env.DB.prepare("INSERT OR IGNORE INTO campaign_media (campaign_id, media_id) VALUES (?, ?)").bind(r!.id, m))
        : [c.env.DB.prepare("INSERT INTO campaign_media (campaign_id, media_id) SELECT ?, media_id FROM campaign_media WHERE campaign_id = ?").bind(r!.id, id)]),
    ]);
    await audit(c.env.DB, c.get("session").username, "campaign.duplicated", String(r!.id), { from: id, activate: p.data.activate });
    return c.json({ id: r!.id, status });
  });

  api.post("/campaigns/:id/status", async (c) => {
    const id = idParam(c);
    const p = await parseBody(c, z.object({ status: z.enum(["active", "paused", "archived", "draft"]) }));
    if (!p.ok) return p.res;
    const row = id && (await first<{ status: string; activated_at: number | null }>(c.env.DB, "SELECT status, activated_at FROM campaigns WHERE id = ? AND deleted_at IS NULL", id));
    if (!row) return apiError(c, 404, "not_found", "الحملة غير موجودة");
    const now = Date.now();
    // activated_at is reset on every (re)activation so events that arrived while paused are not replayed.
    await run(
      c.env.DB,
      "UPDATE campaigns SET status = ?, activated_at = CASE WHEN ? = 'active' AND status != 'active' THEN ? ELSE activated_at END, updated_at = ? WHERE id = ?",
      p.data.status,
      p.data.status,
      now,
      now,
      id,
    );
    let cancelled = 0;
    if (p.data.status !== "active") cancelled = await stopCampaignWork(c.env.DB, id!, now, "campaign_" + p.data.status);
    await audit(c.env.DB, c.get("session").username, `campaign.${p.data.status}`, String(id), { cancelled });
    return c.json({ ok: true, cancelled_jobs: cancelled });
  });

  api.delete("/campaigns/:id", async (c) => {
    const id = idParam(c);
    if (!id) return apiError(c, 404, "not_found", "غير موجود");
    const now = Date.now();
    await run(c.env.DB, "UPDATE campaigns SET deleted_at = ?, status = 'archived', updated_at = ? WHERE id = ?", now, now, id);
    const cancelled = await stopCampaignWork(c.env.DB, id, now, "campaign_deleted");
    await audit(c.env.DB, c.get("session").username, "campaign.deleted", String(id));
    return c.json({ ok: true, cancelled_jobs: cancelled });
  });

  // ---- Templates
  api.get("/templates", async (c) => c.json(await all(c.env.DB, "SELECT * FROM templates ORDER BY kind, id")));
  api.post("/templates", async (c) => {
    const p = await parseBody(c, templateInputSchema);
    if (!p.ok) return p.res;
    const now = Date.now();
    const r = await first(c.env.DB, "INSERT INTO templates (kind, name, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id", p.data.kind, p.data.name, p.data.body, now, now);
    return c.json(r);
  });
  api.put("/templates/:id", async (c) => {
    const p = await parseBody(c, templateInputSchema);
    if (!p.ok) return p.res;
    await run(c.env.DB, "UPDATE templates SET kind = ?, name = ?, body = ?, updated_at = ? WHERE id = ?", p.data.kind, p.data.name, p.data.body, Date.now(), idParam(c));
    return c.json({ ok: true });
  });
  api.delete("/templates/:id", async (c) => {
    await run(c.env.DB, "DELETE FROM templates WHERE id = ?", idParam(c));
    return c.json({ ok: true });
  });

  // ---- Simulation (demo mode: never sends anything to Instagram)
  api.post("/simulate", async (c) => {
    const p = await parseBody(c, simulateSchema);
    if (!p.ok) return p.res;
    return c.json(await simulate(c.env, p.data));
  });

  // ---- Logs
  api.get("/logs/events", async (c) => {
    const { where, params } = logFilters(c, "received_at", ["status", "event_type"]);
    return c.json(
      await all(
        c.env.DB,
        `SELECT id, event_type, sender_id, sender_username, media_id, substr(text,1,300) AS text, status, reason, campaign_id, flow_id, event_time, received_at, is_demo
           FROM webhook_events ${where} ORDER BY id DESC LIMIT 200`,
        ...params,
      ),
    );
  });
  api.get("/logs/jobs", async (c) => {
    const { where, params } = logFilters(c, "created_at", ["status", "kind"]);
    return c.json(
      await all(
        c.env.DB,
        `SELECT id, kind, purpose, flow_id, campaign_id, status, attempts, max_attempts, run_at, last_error, result, is_demo, created_at, updated_at
           FROM action_jobs ${where} ORDER BY id DESC LIMIT 200`,
        ...params,
      ),
    );
  });
  api.get("/logs/flows", async (c) => {
    const { where, params } = logFilters(c, "f.created_at", ["state"], "f.");
    return c.json(
      await all(
        c.env.DB,
        `SELECT f.*, p.username, p.igsid, c.name AS campaign_name,
                (SELECT MAX(checked_at) FROM follow_checks fc WHERE fc.flow_id = f.id) AS last_check_at
           FROM conversation_flows f JOIN participants p ON p.id = f.participant_id LEFT JOIN campaigns c ON c.id = f.campaign_id
           ${where} ORDER BY f.id DESC LIMIT 200`,
        ...params,
      ).then((rows) => rows.map(({ start_token, verify_token, ...r }: any) => r)),
    );
  });
  api.get("/flows/:id", async (c) => {
    const id = idParam(c);
    const flow = id && (await first<any>(c.env.DB, "SELECT f.*, p.username, p.igsid FROM conversation_flows f JOIN participants p ON p.id = f.participant_id WHERE f.id = ?", id));
    if (!flow) return apiError(c, 404, "not_found", "غير موجود");
    const { start_token, verify_token, ...safe } = flow;
    const [jobs, checks, attempts] = await Promise.all([
      all(c.env.DB, "SELECT * FROM action_jobs WHERE flow_id = ? ORDER BY id", id),
      all(c.env.DB, "SELECT * FROM follow_checks WHERE flow_id = ? ORDER BY id", id),
      all(c.env.DB, "SELECT a.* FROM action_attempts a JOIN action_jobs j ON j.id = a.job_id WHERE j.flow_id = ? ORDER BY a.id", id),
    ]);
    return c.json({ flow: safe, jobs, checks, attempts });
  });

  // Manual resolution of uncertain sends (never automatically resent).
  api.post("/jobs/:id/resolve", async (c) => {
    const id = idParam(c);
    const p = await parseBody(c, z.object({ action: z.enum(["mark_accepted", "mark_failed", "retry"]) }));
    if (!p.ok) return p.res;
    const job = id && (await first<any>(c.env.DB, "SELECT * FROM action_jobs WHERE id = ? AND status = 'uncertain'", id));
    if (!job) return apiError(c, 404, "not_found", "لا توجد مهمة غير مؤكدة بهذا الرقم");
    const now = Date.now();
    if (p.data.action === "retry") {
      await run(c.env.DB, "UPDATE action_jobs SET status = 'retry_scheduled', run_at = ?, external_call_started_at = NULL, updated_at = ? WHERE id = ?", now, now, id);
    } else {
      const st = p.data.action === "mark_accepted" ? "accepted" : "failed";
      await run(c.env.DB, "UPDATE action_jobs SET status = ?, last_error = ?, updated_at = ? WHERE id = ?", st, `resolved manually: ${st}`, now, id);
      if (job.flow_id && job.purpose === "content") {
        await run(
          c.env.DB,
          "UPDATE conversation_flows SET state = ?, content_status = ?, content_delivered_at = CASE WHEN ? = 'accepted' THEN ? ELSE content_delivered_at END, state_reason = 'resolved_manually', updated_at = ? WHERE id = ? AND state = 'delivering'",
          st === "accepted" ? "content_sent" : "failed",
          st,
          st,
          now,
          now,
          job.flow_id,
        );
      }
    }
    await audit(c.env.DB, c.get("session").username, "job.resolve", String(id), p.data);
    return c.json({ ok: true });
  });

  api.get("/logs/export", async (c) => {
    const type = c.req.query("type") ?? "events";
    let headers: string[];
    let rows: any[];
    if (type === "jobs") {
      headers = ["id", "kind", "purpose", "flow_id", "campaign_id", "status", "attempts", "last_error", "is_demo", "created_at"];
      rows = await all(c.env.DB, `SELECT ${headers.join(",")} FROM action_jobs ORDER BY id DESC LIMIT 5000`);
    } else if (type === "flows") {
      headers = ["id", "campaign_id", "username", "state", "state_reason", "private_reply_status", "public_reply_status", "content_status", "verify_attempts", "last_follow_result", "is_demo", "created_at"];
      rows = await all(c.env.DB, "SELECT f.id, f.campaign_id, p.username, f.state, f.state_reason, f.private_reply_status, f.public_reply_status, f.content_status, f.verify_attempts, f.last_follow_result, f.is_demo, f.created_at FROM conversation_flows f JOIN participants p ON p.id = f.participant_id ORDER BY f.id DESC LIMIT 5000");
    } else {
      headers = ["id", "event_type", "sender_username", "text", "status", "reason", "campaign_id", "is_demo", "received_at"];
      rows = await all(c.env.DB, `SELECT ${headers.join(",")} FROM webhook_events ORDER BY id DESC LIMIT 5000`);
    }
    for (const r of rows) for (const k of Object.keys(r)) if (k.endsWith("_at") && typeof r[k] === "number") r[k] = new Date(r[k]).toISOString();
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="hsn-${type}-${new Date().toISOString().slice(0, 10)}.csv"`);
    return c.body(toCsv(headers, rows));
  });

  api.get("/audit", async (c) => c.json(await all(c.env.DB, "SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200")));

  // ---- Daily usage (estimate) and recovery of missed comments
  api.get("/usage", async (c) => {
    const [usage, recover_last, auto_recover] = await Promise.all([
      estimateUsage(c.env.DB),
      getSetting<Record<string, unknown> | null>(c.env.DB, "recover_last", null),
      getSetting(c.env.DB, "auto_recover_comments", true),
    ]);
    return c.json({ usage, recover_last, auto_recover });
  });
  api.post("/recover", async (c) => {
    if (!(await rateLimit(c.env.DB, `recover:${c.get("session").username}`, 6, 3_600_000))) return apiError(c, 429, "rate_limited", "انتظر قليلًا قبل تشغيل الاسترجاع مرة أخرى");
    let used = 0;
    const ctx = engineContext(c.env, () => used++);
    const r = await recoverMissedComments(ctx, { maxMedia: 15 });
    await setSetting(c.env.DB, "recover_last", { at: Date.now(), ...r, auto: false });
    await audit(c.env.DB, c.get("session").username, "comments.recovered", undefined, r);
    if (r.recovered > 0) {
      c.executionCtx.waitUntil(
        runQueue(ctx, { maxJobs: 20, includeDemo: false, deadlineMs: 25_000, budget: { used: () => used, limit: 44 } }).catch((e) => console.error("recover queue", sanitize(String(e)))),
      );
    }
    return c.json(r);
  });

  // Comments picked up by the recovery: who commented, on which post, what happened and what was sent.
  api.get("/recover/items", async (c) => {
    const days = Math.min(Math.max(Number(c.req.query("days") ?? 7), 1), 30);
    const since = Date.now() - days * 86_400_000;
    const items = await all<any>(
      c.env.DB,
      `SELECT e.id, e.sender_username, e.text, e.media_id, e.status, e.reason, e.received_at, e.event_time, e.flow_id,
              c.name AS campaign_name, f.state, f.participant_id, f.public_reply_status, f.link_clicks,
              m.thumbnail_url, m.caption, m.permalink
         FROM webhook_events e
         LEFT JOIN campaigns c ON c.id = e.campaign_id
         LEFT JOIN conversation_flows f ON f.id = e.flow_id
         LEFT JOIN media_cache m ON m.media_id = e.media_id
        WHERE e.recovered = 1 AND e.is_demo = 0 AND e.received_at > ?
        ORDER BY e.id DESC LIMIT 200`,
      since,
    );
    const pids = [...new Set(items.map((i) => i.participant_id).filter(Boolean))] as number[];
    const msgs = pids.length
      ? await all<any>(
          c.env.DB,
          `SELECT participant_id, text, kind, created_at FROM messages
            WHERE direction = 'out' AND source = 'bot' AND created_at > ? AND participant_id IN (${pids.map(() => "?").join(",")})
            ORDER BY id`,
          since,
          ...pids,
        )
      : [];
    for (const i of items) {
      i.sent = msgs.filter((m) => m.participant_id === i.participant_id && m.created_at >= i.received_at).slice(0, 6).map(({ text, kind, created_at }) => ({ text, kind, created_at }));
      delete i.participant_id;
    }
    return c.json({ items });
  });

  // ---- Random Comment Picker (draws)
  const drawError = (c: C, e: unknown) => {
    if (e instanceof DrawFailure) return c.json({ error: e.code, message: e.message, ...e.extra }, e.status as any);
    throw e;
  };
  async function resolveDrawMedia(c: C, d: { source_type: "media" | "story"; media_id?: string; url?: string }) {
    const acc = await currentAccount(c.env.DB);
    if (!acc || acc.status !== "active") throw new DrawFailure(409, "no_account", "اربط حساب إنستقرام أولًا");
    if (d.source_type === "story") {
      const id = d.media_id;
      if (!id) throw new DrawFailure(422, "validation", "اختر الستوري");
      const cached = await first<any>(c.env.DB, "SELECT media_id, caption, permalink, thumbnail_url FROM media_cache WHERE account_id = ? AND media_id = ? AND kind = 'story'", acc.id, id);
      const seen = await first(c.env.DB, "SELECT 1 AS ok FROM webhook_events WHERE event_type = 'story_reply' AND is_demo = 0 AND media_id = ? LIMIT 1", id);
      if (!cached && !seen) throw new DrawFailure(404, "unknown_story", "الستوري غير معروفة للنظام — اجلب الستوري الحالية أولًا");
      return { media_id: id, permalink: cached?.permalink ?? null, caption: cached?.caption ?? null, thumb: cached?.thumbnail_url ?? null, comments_count: null };
    }
    let mediaId = d.media_id;
    if (!mediaId && d.url) {
      const code = instagramShortcode(d.url);
      if (!code) throw new DrawFailure(422, "bad_url", "الرابط ليس رابط منشور أو ريل من إنستقرام");
      const hit = await first<{ media_id: string }>(c.env.DB, "SELECT media_id FROM media_cache WHERE account_id = ? AND kind = 'media' AND permalink LIKE ?", acc.id, `%/${code}/%`);
      if (!hit) throw new DrawFailure(404, "not_own_media", "لم يُعثر على هذا المنشور في حسابك المربوط. السحب متاح لمنشورات حسابك فقط — حدّث قائمة المنشورات ثم أعد المحاولة.");
      mediaId = hit.media_id;
    }
    // Confirm with Meta that the media is reachable with the current authorization.
    const token = await getAccessToken(c.env, c.env.DB, acc);
    if (!token) throw new DrawFailure(409, "no_token", "التفويض غير متاح — أعد الربط");
    const r = await metaClient(c.env).getMedia(token, mediaId!);
    if (!r.ok) throw new DrawFailure(422, "media_unreachable", `تعذر الوصول إلى المنشور عبر Meta: ${r.error.message}`);
    const m = r.data;
    const preview = m.media_type === "VIDEO" ? m.thumbnail_url ?? null : m.thumbnail_url ?? m.media_url ?? null;
    return { media_id: m.id, permalink: m.permalink ?? null, caption: m.caption?.slice(0, 500) ?? null, thumb: preview, comments_count: m.comments_count ?? null };
  }

  // All draws (the standalone «السحوبات» section), newest first.
  api.get("/draws", async (c) => {
    const rows = await all<any>(
      c.env.DB,
      `SELECT d.id, d.name, d.campaign_id, c.name AS campaign_name, d.source_type, d.media_thumb, d.media_caption, d.winners_count, d.status, d.fetch_status,
              d.fetched_count, d.drawn_at, d.created_at,
              (SELECT COUNT(*) FROM draw_winners w WHERE w.draw_id = d.id AND w.status = 'active') AS active_winners
         FROM draws d LEFT JOIN campaigns c ON c.id = d.campaign_id ORDER BY d.id DESC LIMIT 300`,
    );
    return c.json(rows);
  });
  api.post("/draws/:id/next", async (c) => {
    const id = idParam(c);
    const p = await parseBody(c, z.object({ request_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) }));
    if (!p.ok) return p.res;
    try {
      const r = await pickNext(c.env.DB, id!, p.data.request_id);
      if (!r.replay) await audit(c.env.DB, c.get("session").username, "draw.pick", String(id), { position: r.position });
      return c.json({ ok: true, ...r, winners: await winnersOf(c.env.DB, id!) });
    } catch (e) {
      return drawError(c, e);
    }
  });
  api.get("/campaigns/:id/draws", async (c) => {
    const id = idParam(c);
    const rows = await all<any>(
      c.env.DB,
      `SELECT d.id, d.name, d.source_type, d.media_thumb, d.media_caption, d.winners_count, d.status, d.fetch_status, d.fetched_count, d.drawn_at, d.created_at,
              (SELECT COUNT(*) FROM draw_winners w WHERE w.draw_id = d.id AND w.status = 'active') AS active_winners
         FROM draws d WHERE d.campaign_id = ? ORDER BY d.id DESC LIMIT 200`,
      id,
    );
    return c.json(rows);
  });
  api.post("/campaigns/:id/draws", async (c) => {
    const cid = idParam(c);
    const camp = cid && (await first(c.env.DB, "SELECT id FROM campaigns WHERE id = ? AND deleted_at IS NULL", cid));
    if (!camp) return apiError(c, 404, "not_found", "الحملة غير موجودة");
    const p = await parseBody(c, drawInputSchema);
    if (!p.ok) return p.res;
    const d = p.data;
    try {
      const m = await resolveDrawMedia(c, d);
      const now = Date.now();
      const r = await first<{ id: number }>(
        c.env.DB,
        `INSERT INTO draws (campaign_id, name, source_type, media_id, media_permalink, media_caption, media_thumb, media_comments_count, winners_count,
           starts_at, ends_at, timezone, include_replies, keyword, exclude_own, excluded_accounts, entry_mode, allow_repeat_winner, exclude_previous_winners, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        cid, d.name, d.source_type, m.media_id, m.permalink, m.caption, m.thumb, m.comments_count, d.winners_count,
        d.starts_at ?? null, d.ends_at ?? null, d.timezone ?? null, d.source_type === "story" ? 0 : +d.include_replies, d.keyword?.trim() || null, +d.exclude_own,
        JSON.stringify(d.excluded_accounts), d.entry_mode, d.entry_mode === "per_comment" ? +d.allow_repeat_winner : 0, +d.exclude_previous_winners, now, now,
      );
      await audit(c.env.DB, c.get("session").username, "draw.created", String(r!.id), { campaign: cid });
      return c.json({ id: r!.id });
    } catch (e) {
      return drawError(c, e);
    }
  });
  api.get("/draws/:id", async (c) => {
    const id = idParam(c);
    const d = id && (await loadDraw(c.env.DB, id));
    if (!d) return apiError(c, 404, "not_found", "السحب غير موجود");
    const [pv, winners, campaign] = await Promise.all([
      preview(c.env.DB, d),
      winnersOf(c.env.DB, d.id),
      first<{ id: number; name: string }>(c.env.DB, "SELECT id, name FROM campaigns WHERE id = ?", d.campaign_id),
    ]);
    const { fetch_state: _fs, ...draw } = d;
    return c.json({ draw: { ...draw, excluded_accounts: settingsOf(d).excluded_accounts }, campaign, preview: pv, winners, labels: EXCLUDE_LABELS });
  });
  api.put("/draws/:id", async (c) => {
    const id = idParam(c);
    const d = id && (await loadDraw(c.env.DB, id));
    if (!d) return apiError(c, 404, "not_found", "السحب غير موجود");
    if (d.status !== "draft") return apiError(c, 409, "locked", "تم تنفيذ السحب — الإعدادات مجمّدة");
    const p = await parseBody(c, drawInputSchema);
    if (!p.ok) return p.res;
    const x = p.data;
    await run(
      c.env.DB,
      `UPDATE draws SET name = ?, winners_count = ?, starts_at = ?, ends_at = ?, timezone = ?, include_replies = ?, keyword = ?, exclude_own = ?,
         excluded_accounts = ?, entry_mode = ?, allow_repeat_winner = ?, exclude_previous_winners = ?, updated_at = ? WHERE id = ? AND status = 'draft'`,
      x.name, x.winners_count, x.starts_at ?? null, x.ends_at ?? null, x.timezone ?? null, d.source_type === "story" ? 0 : +x.include_replies, x.keyword?.trim() || null,
      +x.exclude_own, JSON.stringify(x.excluded_accounts), x.entry_mode, x.entry_mode === "per_comment" ? +x.allow_repeat_winner : 0, +x.exclude_previous_winners, Date.now(), id,
    );
    return c.json({ ok: true });
  });
  api.post("/draws/:id/fetch", async (c) => {
    const id = idParam(c);
    const p = await parseBody(c, z.object({ restart: z.boolean().default(false) }));
    if (!p.ok) return p.res;
    try {
      const d = await fetchBatch(engineContext(c.env), id!, { restart: p.data.restart });
      return c.json({ fetch_status: d.fetch_status, fetched_count: d.fetched_count, fetch_error: d.fetch_error, fetch_updated_at: d.fetch_updated_at });
    } catch (e) {
      return drawError(c, e);
    }
  });
  api.post("/draws/:id/run", async (c) => {
    const id = idParam(c);
    const p = await parseBody(c, z.object({ request_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) }));
    if (!p.ok) return p.res;
    try {
      const r = await runDraw(c.env.DB, id!, p.data.request_id);
      if (!r.replay) await audit(c.env.DB, c.get("session").username, "draw.run", String(id));
      return c.json({ ok: true, replay: r.replay, winners: await winnersOf(c.env.DB, id!) });
    } catch (e) {
      return drawError(c, e);
    }
  });
  api.post("/draws/:id/winners/:wid/replace", async (c) => {
    const id = idParam(c);
    const wid = Number(c.req.param("wid"));
    const p = await parseBody(c, z.object({ reason: z.string().trim().min(2, "اكتب سبب الاستبدال").max(300) }));
    if (!p.ok) return p.res;
    try {
      const r = await replaceWinner(c.env.DB, id!, wid, p.data.reason);
      await audit(c.env.DB, c.get("session").username, "draw.winner_replaced", String(id), { winner: wid, reason: p.data.reason });
      return c.json({ ok: true, ...r, winners: await winnersOf(c.env.DB, id!) });
    } catch (e) {
      return drawError(c, e);
    }
  });
  api.delete("/draws/:id", async (c) => {
    const id = idParam(c);
    const d = id && (await loadDraw(c.env.DB, id));
    if (!d) return apiError(c, 404, "not_found", "السحب غير موجود");
    if (d.status !== "draft") return apiError(c, 409, "locked", "السحوبات المنفّذة تبقى في السجل ولا تُحذف");
    await run(c.env.DB, "DELETE FROM draws WHERE id = ? AND status = 'draft'", id);
    return c.json({ ok: true });
  });

  // ---- Notifications (Telegram)
  api.get("/notifications", async (c) => {
    const [settings, has_token] = await Promise.all([getNotifySettings(c.env.DB), hasBotToken(c.env.DB)]);
    return c.json({ settings, has_token });
  });
  api.put("/notifications", async (c) => {
    const p = await parseBody(
      c,
      z.object({
        bot_token: z.string().trim().max(100).optional(), // "" removes it
        enabled: z.boolean().optional(),
        chat_id: z.string().regex(/^-?\d{1,20}$/).nullable().optional(),
        daily_report: z.boolean().optional(),
        report_hour: z.number().int().min(0).max(23).optional(),
        timezone: z.string().max(64).optional(),
        alert_reauth: z.boolean().optional(),
        alert_failures: z.boolean().optional(),
        alert_spike: z.boolean().optional(),
        alert_usage: z.boolean().optional(),
        spike_per_hour: z.number().int().min(5).max(10_000).optional(),
        notify_new_follower: z.boolean().optional(),
        notify_delivery: z.boolean().optional(),
      }),
    );
    if (!p.ok) return p.res;
    const { bot_token, ...rest } = p.data;
    if (rest.timezone) {
      try {
        new Intl.DateTimeFormat("en", { timeZone: rest.timezone });
      } catch {
        return apiError(c, 422, "validation", "منطقة زمنية غير صحيحة");
      }
    }
    if (bot_token !== undefined) {
      if (bot_token && !isTelegramToken(bot_token)) return apiError(c, 422, "validation", "توكن البوت غير صحيح — انسخه كما أعطاك إياه BotFather");
      await saveBotToken(c.env, bot_token || null);
      if (!bot_token) rest.chat_id = null;
    }
    const cur = await getNotifySettings(c.env.DB);
    const next = { ...cur, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) };
    await setSetting(c.env.DB, "notify", next);
    await audit(c.env.DB, c.get("session").username, "notifications.updated", undefined, { ...rest, bot_token: bot_token === undefined ? undefined : bot_token ? "set" : "removed" });
    return c.json({ settings: next, has_token: await hasBotToken(c.env.DB) });
  });
  api.post("/notifications/detect", async (c) => {
    const r = await detectChat(c.env);
    if (!r.ok) return apiError(c, 422, "telegram", r.error ?? "تعذر العثور على المحادثة");
    const next = { ...(await getNotifySettings(c.env.DB)), chat_id: r.chat_id!, enabled: true };
    await setSetting(c.env.DB, "notify", next);
    return c.json({ settings: next, name: r.name ?? null });
  });
  api.post("/notifications/test", async (c) => {
    const p = await parseBody(c, z.object({ kind: z.enum(["test", "report"]).default("test") }));
    if (!p.ok) return p.res;
    const text = p.data.kind === "report" ? await buildDailyReport(c.env.DB) : "✅ تم ربط إشعارات HSN AutoReply بنجاح. ستصلك التنبيهات والتقرير اليومي هنا.";
    const r = await sendTelegram(c.env, text);
    if (!r.ok) return apiError(c, 422, "telegram", r.error ?? "تعذر الإرسال");
    return c.json({ ok: true });
  });

  // ---- Inbox: conversations started or answered by the automation, and manual replies (24h window only)
  api.get("/inbox", async (c) => {
    const q = (c.req.query("q") ?? "").trim().replace(/^@/, "").slice(0, 60);
    const params: unknown[] = [];
    let where = "p.is_demo = 0 AND p.last_message_at IS NOT NULL";
    if (q) {
      where += " AND p.username LIKE ? ESCAPE '\\'";
      params.push(`%${q.replace(/[%_\\]/g, (m) => "\\" + m)}%`);
    }
    const rows = await all<any>(
      c.env.DB,
      `SELECT p.id, p.username, p.last_message_at, p.last_user_message_at, p.inbox_read_at, p.last_follow_status,
              (SELECT m.text FROM messages m WHERE m.participant_id = p.id ORDER BY m.id DESC LIMIT 1) AS last_text,
              (SELECT m.direction FROM messages m WHERE m.participant_id = p.id ORDER BY m.id DESC LIMIT 1) AS last_direction,
              (SELECT COUNT(*) FROM messages m WHERE m.participant_id = p.id AND m.direction = 'in' AND m.created_at > COALESCE(p.inbox_read_at, 0)) AS unread
         FROM participants p WHERE ${where} ORDER BY p.last_message_at DESC LIMIT 150`,
      ...params,
    );
    const now = Date.now();
    return c.json(rows.map((r) => ({ ...r, window_open: !!r.last_user_message_at && now - r.last_user_message_at < MESSAGING_WINDOW_MS })));
  });
  api.get("/inbox/:id", async (c) => {
    const id = idParam(c);
    const p = id && (await first<any>(c.env.DB, "SELECT id, username, last_user_message_at, last_follow_status, is_demo FROM participants WHERE id = ? AND is_demo = 0", id));
    if (!p) return apiError(c, 404, "not_found", "المحادثة غير موجودة");
    const [messages, flows] = await Promise.all([
      all<any>(c.env.DB, "SELECT id, direction, source, kind, text, created_at FROM messages WHERE participant_id = ? ORDER BY id DESC LIMIT 200", id),
      all<any>(
        c.env.DB,
        `SELECT f.id, f.state, f.created_at, f.link_clicks, c.name AS campaign_name FROM conversation_flows f JOIN campaigns c ON c.id = f.campaign_id
          WHERE f.participant_id = ? AND f.is_demo = 0 ORDER BY f.id DESC LIMIT 10`,
        id,
      ),
    ]);
    const now = Date.now();
    await markRead(c.env.DB, id!, now);
    const expires = p.last_user_message_at ? p.last_user_message_at + MESSAGING_WINDOW_MS : null;
    return c.json({ participant: p, messages: messages.reverse(), flows, window_open: !!expires && expires > now, window_expires_at: expires });
  });
  api.post("/inbox/:id/send", async (c) => {
    const id = idParam(c);
    const body = await parseBody(c, z.object({ text: z.string().trim().min(1).max(1000) }));
    if (!body.ok) return body.res;
    const p = id && (await first<any>(c.env.DB, "SELECT * FROM participants WHERE id = ? AND is_demo = 0", id));
    if (!p) return apiError(c, 404, "not_found", "المحادثة غير موجودة");
    const now = Date.now();
    if (!p.last_user_message_at || now - p.last_user_message_at >= MESSAGING_WINDOW_MS) {
      return apiError(c, 409, "window_closed", "مرّت 24 ساعة على آخر رسالة من الشخص — إنستقرام لا يسمح بالرد حتى يراسلك مرة أخرى");
    }
    const a = await first<AccountRow>(c.env.DB, "SELECT * FROM instagram_accounts WHERE id = ?", p.account_id);
    if (!a || a.status !== "active") return apiError(c, 409, "no_account", "الحساب غير مربوط");
    const token = await getAccessToken(c.env, c.env.DB, a);
    if (!token) return apiError(c, 409, "no_token", "التفويض غير متاح — أعد الربط");
    const r = await metaClient(c.env).sendMessage(token, a.ig_user_id, p.igsid, { text: body.data.text });
    if (!r.ok) {
      if (r.error.kind === "auth") await engineContext(c.env).onAuthError?.(a, r.error.message);
      const msg = r.error.kind === "window_closed" ? "انتهت نافذة المراسلة (24 ساعة)" : r.error.kind === "uncertain" ? "انقطع الاتصال — قد تكون الرسالة وصلت، تحقق قبل إعادة الإرسال" : r.error.message;
      return apiError(c, 502 as any, "meta_error", msg);
    }
    await recordMessage(c.env.DB, { accountId: a.id, participantId: p.id, direction: "out", source: "manual", kind: "message", text: body.data.text, mid: r.data.message_id ?? null, at: now });
    await markRead(c.env.DB, p.id, now);
    await audit(c.env.DB, c.get("session").username, "inbox.sent", String(p.id));
    return c.json({ ok: true });
  });

  // ---- Settings
  api.get("/settings", async (c) => {
    const rows = await all<{ key: string; value: string }>(c.env.DB, `SELECT key, value FROM app_settings WHERE ${PUBLIC_SETTINGS_SQL}`);
    const out: Record<string, unknown> = {};
    for (const r of rows) out[r.key] = JSON.parse(r.value);
    return c.json({ settings: out, app_version: c.env.APP_VERSION, releases_url: c.env.RELEASES_URL || null, apk_url: c.env.APK_DOWNLOAD_URL || null });
  });
  api.put("/settings", async (c) => {
    const p = await parseBody(c, settingsSchema);
    if (!p.ok) return p.res;
    if (p.data.timezone) {
      try {
        new Intl.DateTimeFormat("en", { timeZone: p.data.timezone });
      } catch {
        return apiError(c, 422, "validation", "منطقة زمنية غير صحيحة");
      }
    }
    for (const [k, v] of Object.entries(p.data)) if (v !== undefined) await setSetting(c.env.DB, k, v);
    await audit(c.env.DB, c.get("session").username, "settings.updated", undefined, p.data);
    return c.json({ ok: true });
  });

  // Backup of configuration only — never tokens, secrets, sessions or personal data.
  api.get("/settings/backup", async (c) => {
    const [settings, campaigns, keywords, media, templates] = await Promise.all([
      all(c.env.DB, `SELECT key, value FROM app_settings WHERE ${PUBLIC_SETTINGS_SQL}`),
      all(c.env.DB, "SELECT * FROM campaigns WHERE deleted_at IS NULL"),
      all(c.env.DB, "SELECT campaign_id, keyword, kind, match_type FROM campaign_keywords"),
      all(c.env.DB, "SELECT campaign_id, media_id FROM campaign_media"),
      all(c.env.DB, "SELECT kind, name, body FROM templates"),
    ]);
    c.header("Content-Disposition", `attachment; filename="hsn-autoreply-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    return c.json({ format: "hsn-autoreply-backup", version: 1, exported_at: new Date().toISOString(), settings, campaigns, keywords, media, templates });
  });

  api.post("/settings/restore", async (c) => {
    const p = await parseBody(
      c,
      z.object({
        format: z.literal("hsn-autoreply-backup"),
        version: z.literal(1),
        settings: z.array(z.object({ key: z.string().max(64), value: z.string().max(2000) })).max(100),
        campaigns: z.array(z.record(z.string(), z.unknown())).max(500),
        keywords: z.array(z.object({ campaign_id: z.number(), keyword: z.string().max(100), kind: z.enum(["include", "exclude"]), match_type: z.enum(["exact", "word", "contains"]) })).max(5000),
        media: z.array(z.object({ campaign_id: z.number(), media_id: z.string().max(64) })).max(5000),
        templates: z.array(templateInputSchema).max(500),
      }),
    );
    if (!p.ok) return p.res;
    const now = Date.now();
    const allowedSettings = ["timezone", "retention_days", "dedup_retention_days", "any_reply_counts_as_start", "global_user_hourly_limit"];
    for (const s of p.data.settings) if (allowedSettings.includes(s.key)) await run(c.env.DB, "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", s.key, s.value, now);
    let restored = 0;
    for (const raw of p.data.campaigns) {
      const oldId = Number(raw.id);
      const kw = p.data.keywords.filter((k) => k.campaign_id === oldId).map((k) => ({ keyword: k.keyword, kind: k.kind, match_type: k.match_type }));
      const md = p.data.media.filter((m) => m.campaign_id === oldId).map((m) => m.media_id);
      const bool = (v: unknown) => v === 1 || v === true;
      const parsed = campaignInputSchema.safeParse({
        ...raw, keywords: kw, media_ids: md, match_all: bool(raw.match_all), unify_alef: bool(raw.unify_alef), include_replies: bool(raw.include_replies),
        require_follow: bool(raw.require_follow), public_reply_enabled: bool(raw.public_reply_enabled), process_old_events: bool(raw.process_old_events),
      });
      if (!parsed.success) continue;
      const d = parsed.data;
      const r = await first<{ id: number }>(
        c.env.DB,
        `INSERT INTO campaigns (name, type, status, priority, scope, match_all, unify_alef, include_replies, require_follow, opening_text, follow_request_text,
           follow_reminder_text, verify_error_text, final_text, final_url, public_reply_enabled, public_reply_text, public_reply_on_dm_fail, public_reply_fallback_text,
           schedule_start, schedule_end, timezone, per_user_cooldown_hours, max_deliveries_per_user, max_verify_attempts, verify_cooldown_seconds, process_old_events, created_at, updated_at)
         VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        d.name, d.type, d.priority, d.scope, +d.match_all, +d.unify_alef, +d.include_replies, +d.require_follow, d.opening_text ?? null, d.follow_request_text ?? null,
        d.follow_reminder_text ?? null, d.verify_error_text ?? null, d.final_text, d.final_url || null, +d.public_reply_enabled, d.public_reply_text ?? null, d.public_reply_on_dm_fail,
        d.public_reply_fallback_text ?? null, d.schedule_start ?? null, d.schedule_end ?? null, d.timezone, d.per_user_cooldown_hours, d.max_deliveries_per_user,
        d.max_verify_attempts, d.verify_cooldown_seconds, +d.process_old_events, now, now,
      );
      const children = [
        ...d.keywords.map((k) => c.env.DB.prepare("INSERT INTO campaign_keywords (campaign_id, keyword, kind, match_type) VALUES (?, ?, ?, ?)").bind(r!.id, k.keyword, k.kind, k.match_type)),
        ...d.media_ids.map((m) => c.env.DB.prepare("INSERT OR IGNORE INTO campaign_media (campaign_id, media_id) VALUES (?, ?)").bind(r!.id, m)),
      ];
      if (children.length) await c.env.DB.batch(children);
      restored++;
    }
    for (const t of p.data.templates) await run(c.env.DB, "INSERT INTO templates (kind, name, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", t.kind, t.name, t.body, now, now);
    await audit(c.env.DB, c.get("session").username, "settings.restored", undefined, { campaigns: restored });
    return c.json({ ok: true, campaigns: restored, note: "الحملات المستعادة في وضع مسودة — راجعها ثم فعّلها." });
  });

  api.post("/data/delete", async (c) => {
    const p = await parseBody(c, z.object({ scope: z.enum(["logs", "demo", "all_personal"]), confirm: z.literal("DELETE") }));
    if (!p.ok) return p.res;
    const db = c.env.DB;
    if (p.data.scope === "demo") {
      await db.batch([
        db.prepare("DELETE FROM action_jobs WHERE is_demo = 1"),
        db.prepare("DELETE FROM webhook_events WHERE is_demo = 1"),
        db.prepare("DELETE FROM instagram_accounts WHERE is_demo = 1"),
      ]);
    } else if (p.data.scope === "logs") {
      await db.batch([
        db.prepare("DELETE FROM action_attempts"),
        db.prepare("UPDATE webhook_events SET text = NULL, sender_username = NULL, payload = '{}'"),
        db.prepare("DELETE FROM audit_logs"),
      ]);
    } else {
      await db.batch([
        db.prepare("DELETE FROM action_attempts"),
        db.prepare("DELETE FROM follow_checks"),
        db.prepare("DELETE FROM conversation_flows"),
        db.prepare("DELETE FROM messages"),
        db.prepare("DELETE FROM participants"),
        db.prepare("UPDATE action_jobs SET payload = '{}', result = NULL WHERE status NOT IN ('pending','processing','retry_scheduled')"),
        db.prepare("UPDATE webhook_events SET text = NULL, sender_username = NULL, sender_id = NULL, payload = '{}'"),
      ]);
    }
    await audit(db, c.get("session").username, "data.deleted", p.data.scope);
    return c.json({ ok: true });
  });

  app.route("/api", api);
  app.all("/api/*", (c) => apiError(c, 404, "not_found", "المسار غير موجود"));

  // ------------------------------------------------------------------ SPA / static assets
  app.all("*", async (c) => {
    if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
    return c.text("not found", 404);
  });

  return app;
}

async function stopCampaignWork(db: D1Database, campaignId: number, now: number, reason: string): Promise<number> {
  const cancelled = await cancelJobsWhere(db, "campaign_id = ? AND is_demo = 0", now, campaignId);
  await run(
    db,
    `UPDATE conversation_flows SET state = 'cancelled', state_reason = ?, updated_at = ?
     WHERE campaign_id = ? AND is_demo = 0 AND state NOT IN ('content_sent','verification_unavailable','expired','failed','cancelled')`,
    reason,
    now,
    campaignId,
  );
  return cancelled;
}

function logFilters(c: C, timeCol: string, eq: string[], prefix = "") {
  const where: string[] = [];
  const params: unknown[] = [];
  for (const k of eq) {
    const v = c.req.query(k);
    if (v && /^[a-z_]{1,40}$/.test(v)) {
      where.push(`${prefix}${k} = ?`);
      params.push(v);
    }
  }
  const demo = c.req.query("demo");
  if (demo === "0" || demo === "1") {
    where.push(`${prefix}is_demo = ?`);
    params.push(Number(demo));
  }
  const campaign = Number(c.req.query("campaign_id"));
  if (Number.isInteger(campaign) && campaign > 0) {
    where.push(`${prefix}campaign_id = ?`);
    params.push(campaign);
  }
  const days = Number(c.req.query("days"));
  if (Number.isFinite(days) && days > 0) {
    where.push(`${timeCol} > ?`);
    params.push(Date.now() - days * 86_400_000);
  }
  return { where: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}
