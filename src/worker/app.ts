import { Hono, type Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import type { Env } from "./env";
import { missingSecrets } from "./env";
import { all, audit, first, getSetting, OWNER_TENANT, run, setSetting, settingKey, tenantSettingsFilter } from "./lib/db";
import { hashPassword, randomToken, sha256Hex, timingSafeEqual, verifyMetaSignature, verifyPassword } from "./lib/crypto";
import { parseWebhook } from "./meta/webhook-parse";
import { INSIGHTS_SCOPE, INSTAGRAM_SCOPES, WEBHOOK_FIELDS, sanitize } from "./meta/client";
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
import { refreshAccountProfiles,
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
  tenantCreateSchema,
  registerSchema,
  planUpdateSchema,
  paymentProviderSchema,
  paymentAccountSchema,
  exchangeRatesSchema,
  brandingSchema,
  featuredSchema,
  featureOrderSchema,
  campaignInputSchema,
  drawInputSchema,
  loginSchema,
  settingsSchema,
  setupSchema,
  simulateSchema,
  templateInputSchema,
} from "../shared/schemas";
import { claimsDelivery, claimsFollowRequired, publicReplyVariants } from "../shared/template";
import { cacheMediaStmt } from "./services/media";
import { INBOX_LABELS, markRead, recordMessage, refreshAvatars, type InboxLabel } from "./services/inbox";
import { broadcastNotice, buildDailyReport, detectChat, getNotifySettings, hasBotToken, isTelegramToken, notify, saveBotToken, sendTelegram } from "./services/notify";
import { MESSAGING_WINDOW_MS } from "./engine/context";
import { estimateUsage, platformUsage } from "./services/usage";
import { cloudflareUsage } from "./services/cfusage";
import { claimStore, completeSallaOAuth, handleSallaWebhook, sallaAuthorizeUrl, sallaConfigured, syncProducts, verifySallaWebhook } from "./services/salla";
import { bestTimes, postSales, weeklyReport } from "./services/growth";
import { storeAnalytics, storeCampaignDetail, storeProductCosts, storeProducts } from "./services/store";
import { domainInfo } from "./services/domain";
import { recoverMissedComments } from "./services/recover";
import { auditCampaignComments } from "./services/audit";
import { LIMITS, hasPublishScope, isImage, isVideo, optionalScopes, publishScopeMode, removeFiles, validatePost, verifyMediaUrl, wantsPublishScope, type PostKind } from "./services/publish";
import { captureInsights, insightsAccount, insightsScopeMode, insightsSummary, mediaInsightsSeries, wantsInsightsScope } from "./services/insights";
import { analyticsByCampaign, analyticsByPost, analyticsDevices, analyticsFollow, analyticsHeatmap, analyticsOverview, analyticsRetention, osFamily, tzOffsetMinutes, type AnalyticsFilter, type EventType, type HeatKind } from "./services/analytics";
import { deleteDraws, DrawFailure, EXCLUDE_LABELS, fetchBatch, loadDraw, pickNext, preview, replaceWinner, runDraw, settingsOf, winnersOf } from "./services/draws";
import { instagramShortcode } from "../shared/draw";
import { cardDesignInputSchema } from "../shared/card";
import { cardByToken, planFor, publicReplyToWinner, sendCard, storeCard } from "./services/cards";

/** Settings shown to the client / exported in backups: never the Telegram bot token or notification state. */
import { toCsv } from "../shared/csv";
import { DEFAULT_RATES, EVENT_LABELS, FEATURE_LABELS, formatPrice, MESSAGE_LINKS, orderFeatures, type ExchangeRates, type PlanLimits } from "../shared/plans";
const MESSAGE_LINK_PATHS = MESSAGE_LINKS.map((l) => l.to) as [string, ...string[]];
import { listPaymentMethods } from "./services/payments";
import { codeHash, deleteTenantData, drawsThisMonth, getEntitlement, listPlans, monthlyMessages, newCode, parseLimits, redeemCode, RedeemError } from "./services/plans";
import { campaignSnapshot, drawSnapshots, listUndo, recordUndo, stopCampaignWork, undoOperation, UndoError } from "./services/undo";
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

async function currentAccount(db: D1Database, tenantId: number): Promise<AccountRow & Record<string, any> | null> {
  return first(db, "SELECT * FROM instagram_accounts WHERE tenant_id = ? AND is_demo = 0 ORDER BY (status = 'active') DESC, updated_at DESC LIMIT 1", tenantId);
}

/** SQL condition: a row's account_id belongs to the tenant (engine tables are keyed by Instagram account). */
const TENANT_ACCOUNTS = "(SELECT id FROM instagram_accounts WHERE tenant_id = ?)";
/** Same for webhook events, which carry the Instagram account id. */
const TENANT_IG_IDS = "(SELECT ig_user_id FROM instagram_accounts WHERE tenant_id = ?)";

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

/** One tenant's settings without secrets (Telegram token / notification internals). */
async function publicSettings(db: D1Database, tenantId: number): Promise<Record<string, unknown>> {
  const f = tenantSettingsFilter(tenantId);
  const rows = await all<{ key: string; value: string }>(db, `SELECT key, value FROM app_settings WHERE ${f.where}`, ...f.params);
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    const k = f.strip(r.key);
    if (k.startsWith("telegram") || k.startsWith("notify")) continue;
    out[k] = JSON.parse(r.value);
  }
  return out;
}

/** Starter templates for a new customer (no follow-requirement texts: customers only get the optional invitation). */
async function seedStarterTemplates(db: D1Database, tenantId: number, now: number): Promise<void> {
  await db.batch(
    [
      ["public", "رد عام — شيّك الخاص", "شيّك الخاص 🙌"],
      ["final", "المحتوى النهائي", "تفضل 🎁 {{content_url}}"],
      ["mention", "شكر على المنشن", "تسلم على المنشن 🙌 هذه هديتنا لك: {{content_url}}"],
    ].map(([kind, name, body]) => db.prepare("INSERT INTO templates (tenant_id, kind, name, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(tenantId, kind, name, body, now, now)),
  );
}

/** The tenant of the logged-in user: every query below is scoped to it. */
const T = (c: C): number => c.get("session").tenant_id;

/** Where customers download the Android app: the owner's link, or the APK served on this domain. */
async function appDownloadUrl(c: C): Promise<string> {
  const custom = await getSetting<string>(c.env.DB, OWNER_TENANT, "app_download_url", "");
  return custom || `${new URL(c.req.url).origin}/app.apk`;
}

/** What a buyer needs to see: active plans (with structured prices), exchange rates, payment accounts and the contact link. */
async function publicCatalog(c: C) {
  const [plans, rates, payment_methods, contact, featured, order] = await Promise.all([
    listPlans(c.env.DB),
    getSetting<ExchangeRates>(c.env.DB, OWNER_TENANT, "exchange_rates", DEFAULT_RATES),
    listPaymentMethods(c.env.DB),
    getSetting<string>(c.env.DB, OWNER_TENANT, "sales_contact", ""),
    getSetting<{ plan_id: string | null; label: string } | null>(c.env.DB, OWNER_TENANT, "featured_plan", null),
    getSetting<string[] | null>(c.env.DB, OWNER_TENANT, "feature_order", null),
  ]);
  return {
    plans: plans
      .filter((p) => p.active)
      .map(({ id, name, price_label, price_amount, price_currency, price_period, description, limits }) => ({ id, name, price_label, price_amount, price_currency, price_period, description, limits })),
    rates: { ...DEFAULT_RATES, ...rates, USD: 1 },
    // A bank / office with no account yet would show buyers an empty box.
    payment_methods: payment_methods.filter((p) => p.accounts.length > 0),
    sales_contact: contact || null,
    // Which plan carries the highlight badge (default: the "pro" plan, "الأكثر طلبًا").
    featured: featured ?? { plan_id: "pro", label: "الأكثر طلبًا" },
    // The order the plan points are listed in (set by the owner by dragging).
    feature_order: orderFeatures(order),
  };
}

/** The caller's subscription (the owner always has everything). */
const ENT = (c: C) => getEntitlement(c.env.DB, T(c));
/** 403 with a clear message when the caller's plan does not include a feature. */
async function planBlock(c: C, feature: keyof PlanLimits): Promise<Response | null> {
  const e = await ENT(c);
  if (!e.active) return apiError(c, 403, "subscription_inactive", "اشتراكك غير فعّال — أدخل كود التفعيل من صفحة «اشتراكي»");
  if (!e.limits[feature]) return apiError(c, 403, "plan_feature", `باقتك لا تشمل: ${FEATURE_LABELS[feature] ?? feature} — رقِّ باقتك من صفحة «اشتراكي»`);
  return null;
}
/** Can one more campaign of this type be active? (excludeId: the campaign being activated). */
async function activationBlock(c: C, type: string, excludeId: number | null): Promise<Response | null> {
  const e = await ENT(c);
  if (!e.active) return apiError(c, 403, "subscription_inactive", "اشتراكك غير فعّال — أدخل كود التفعيل من صفحة «اشتراكي»");
  if (!e.limits.events.includes(type as any)) return apiError(c, 403, "plan_event", `باقتك لا تشمل حملات «${EVENT_LABELS[type] ?? type}»`);
  if (e.limits.active_campaigns !== null) {
    const n = await first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM campaigns WHERE tenant_id = ? AND status = 'active' AND deleted_at IS NULL AND id != ?", T(c), excludeId ?? 0);
    if ((n?.n ?? 0) >= e.limits.active_campaigns) return apiError(c, 403, "plan_campaigns", `وصلت للحد الأعلى من الحملات النشطة في باقتك (${e.limits.active_campaigns}) — أوقف حملة أو رقِّ باقتك`);
  }
  return null;
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
  // Public congratulation card image (unguessable token) — Meta fetches it when the card is sent.
  app.get("/c/:token", async (c) => {
    const token = c.req.param("token").replace(/\.(jpg|jpeg|png)$/, "");
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return c.text("not found", 404);
    const card = await cardByToken(c.env.DB, token);
    if (!card) return c.text("not found", 404);
    return new Response(card.data, { headers: { "Content-Type": card.mime, "Cache-Control": "public, max-age=31536000, immutable", "X-Robots-Tag": "noindex" } });
  });

  // Tracked content link: counts the tap, then redirects to the campaign's real link.
  // Link-preview crawlers (Instagram/Meta fetch the URL to render a card) are redirected but not counted.
  // Scheduled-publishing files, fetched by Meta through signed links that expire (the bucket itself is private).
  app.on(["GET", "HEAD"], "/m/:key", async (c) => {
    const key = c.req.param("key");
    if (!c.env.MEDIA || !/^[A-Za-z0-9._-]{8,120}$/.test(key) || !(await verifyMediaUrl(c.env, key, c.req.query("e"), c.req.query("s")))) return c.text("not found", 404);
    const obj = await c.env.MEDIA.get(key);
    if (!obj) return c.text("not found", 404);
    return new Response(c.req.method === "HEAD" ? null : obj.body, {
      headers: { "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream", "Content-Length": String(obj.size), "Cache-Control": "private, max-age=3600" },
    });
  });

  app.on(["GET", "HEAD"], "/l/:token", async (c) => {
    const token = c.req.param("token");
    const notFound = () => c.html('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font-family:system-ui;text-align:center;padding:3rem">الرابط غير صالح أو منتهي.</body>', 404);
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return notFound();
    const row = await first<{ id: number; link_url: string | null; account_id: number }>(c.env.DB, "SELECT id, link_url, account_id FROM conversation_flows WHERE link_token = ?", token);
    if (!row?.link_url || !/^https?:\/\//i.test(row.link_url)) return notFound();
    const ua = c.req.header("User-Agent") ?? "";
    const isBot = !ua || /facebookexternalhit|facebot|meta-external|bot\b|bot\/|crawler|spider|preview|slurp|whatsapp|telegram|curl|wget|python-requests|headless/i.test(ua);
    if (c.req.method === "GET" && !isBot) {
      const now = Date.now();
      await c.env.DB.batch([
        c.env.DB
          .prepare("UPDATE conversation_flows SET link_clicks = link_clicks + 1, link_first_click_at = COALESCE(link_first_click_at, ?), link_last_click_at = ? WHERE id = ?")
          .bind(now, now, row.id),
        c.env.DB.prepare("INSERT INTO link_clicks (flow_id, account_id, clicked_at, os) VALUES (?, ?, ?, ?)").bind(row.id, row.account_id, now, osFamily(ua)),
      ]);
    }
    return new Response(null, {
      status: 302,
      headers: { Location: row.link_url, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" },
    });
  });

  app.get("/privacy", (c) => html(c, privacyPage(c.env.PUBLIC_BASE_URL)));
  // The plans page lives in the app now (works for visitors without an account).
  app.get("/pricing", (c) => c.redirect("/#/plans", 302));
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


  // ---- Salla store connection (official OAuth "Custom mode") and webhooks
  app.get("/oauth/salla/callback", async (c) => {
    const state = c.req.query("state") ?? "";
    const code = c.req.query("code") ?? "";
    const now = Date.now();
    c.header("Content-Security-Policy", PAGE_CSP);
    c.header("Cache-Control", "no-store");
    const st = state
      ? await first<{ tenant_id: number; client: "web" | "app" }>(
          c.env.DB,
          "UPDATE store_oauth_states SET used_at = ? WHERE state_hash = ? AND used_at IS NULL AND expires_at > ? AND platform = 'salla' RETURNING tenant_id, client",
          now,
          await sha256Hex(state),
          now,
        )
      : null;
    if (!st) {
      // Installed from Salla's side (app store / partner portal): connect the store, then let the signed-in customer
      // claim it with a one-time token (the session cookie is SameSite=Strict, so it is not sent on this redirect).
      if (!code || c.req.query("error")) return c.html(oauthResultPage(false, "رابط ربط المتجر غير صالح أو منتهي. ابدأ الربط من صفحة الربط في HSN.", "web", c.env.APP_DEEP_LINK), 400);
      const r = await completeSallaOAuth(c.env, code, 0);
      if (!r.ok) return c.html(oauthResultPage(false, `تعذر ربط متجر سلة: ${sanitize(r.error ?? "")}`, "web", c.env.APP_DEEP_LINK), 502);
      c.executionCtx.waitUntil(syncProducts(c.env, r.storeId!).catch(() => undefined));
      if (r.tenantId) return c.html(oauthResultPage(true, `تم تحديث ربط متجر «${r.name ?? "سلة"}».`, "web", c.env.APP_DEEP_LINK));
      const claim = randomToken(24);
      await run(
        c.env.DB,
        "INSERT INTO store_oauth_states (state_hash, tenant_id, user_id, platform, client, created_at, expires_at) VALUES (?, 0, ?, 'salla_claim', 'web', ?, ?)",
        await sha256Hex(claim),
        r.storeId,
        now,
        now + 30 * 60_000,
      );
      return c.redirect(`/#/connection?claim=${claim}`, 302);
    }
    if (c.req.query("error") || !code) return c.html(oauthResultPage(false, "تم إلغاء ربط المتجر أو رفض الصلاحيات.", st.client, c.env.APP_DEEP_LINK), 400);
    const r = await completeSallaOAuth(c.env, code, st.tenant_id);
    if (!r.ok) {
      await audit(c.env.DB, st.tenant_id, "system", "store.connect_failed", undefined, { detail: sanitize(r.error ?? "") });
      return c.html(oauthResultPage(false, `تعذر ربط متجر سلة: ${sanitize(r.error ?? "")}`, st.client, c.env.APP_DEEP_LINK), 502);
    }
    c.executionCtx.waitUntil(syncProducts(c.env, r.storeId!).catch((e) => console.error("salla sync", sanitize(String(e)))));
    return c.html(oauthResultPage(true, `تم ربط متجر «${r.name ?? "سلة"}» بنجاح. المنتجات تنجلب الحين، والطلبات الجديدة توصل تلقائيًا.`, st.client, c.env.APP_DEEP_LINK));
  });
  app.post("/webhooks/salla", async (c) => {
    const raw = new Uint8Array(await c.req.arrayBuffer());
    if (raw.byteLength > 1_000_000) return c.json({ ok: false }, 413);
    if (!(await verifySallaWebhook(c.env, raw, c.req.header("X-Salla-Signature") ?? null, c.req.header("Authorization") ?? null))) return c.json({ ok: false }, 401);
    let body: any;
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return c.json({ ok: false }, 400);
    }
    const out = await handleSallaWebhook(c.env, body).catch((e) => (console.error("salla webhook", sanitize(String(e))), "error"));
    return c.json({ ok: out !== "error", result: out }, out === "error" ? 500 : 200);
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
    const acc = await first<{ id: number; tenant_id: number }>(c.env.DB, "SELECT id, tenant_id FROM instagram_accounts WHERE (ig_user_id = ? OR app_scoped_id = ?) AND is_demo = 0", uid, uid);
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
    await audit(c.env.DB, acc?.tenant_id ?? OWNER_TENANT, "meta", "data_deletion", code);
    return c.json({ url: `${c.env.PUBLIC_BASE_URL}/meta/deletion-status?code=${code}`, confirmation_code: code });
  });

  // ------------------------------------------------------------------ OAuth callback (system browser)
  app.get("/oauth/instagram/callback", async (c) => {
    const state = c.req.query("state") ?? "";
    const code = c.req.query("code") ?? "";
    const now = Date.now();
    // State must exist, be unexpired and unused — it is consumed atomically.
    const st = state
      ? await first<{ client: "web" | "app"; user_id: number }>(
          c.env.DB,
          "UPDATE oauth_states SET used_at = ? WHERE state_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING client, user_id",
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
    // The account is connected to the tenant of the user who started the flow.
    const owner = await first<{ tenant_id: number }>(c.env.DB, "SELECT tenant_id FROM admin_users WHERE id = ?", st.user_id);
    if (!owner) return c.html(oauthResultPage(false, "رابط الربط غير صالح أو منتهي. ابدأ الربط من جديد من التطبيق.", "web", c.env.APP_DEEP_LINK), 400);
    const r = await completeOAuth(c.env, code.replace(/#_$/, ""), owner.tenant_id);
    if (!r.ok) {
      const detail = sanitize(r.error ?? "unknown");
      console.error("oauth failed", detail);
      await audit(c.env.DB, owner.tenant_id, "system", "oauth.failed", undefined, { detail });
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

  // Public: the plans and how to buy, shown on the sign-up screen before an account exists.
  app.get("/api/public/plans", async (c) => c.json(await publicCatalog(c)));
  // Login-page look chosen by the owner: banner images (computer / phone, cacheable per version), texts and logo.
  app.get("/api/public/branding", async (c) => {
    const db = c.env.DB;
    const [d, m, texts, logo, appIcon, download] = await Promise.all([
      getSetting<number>(db, OWNER_TENANT, "login_banner_at", 0),
      getSetting<number>(db, OWNER_TENANT, "login_banner_mobile_at", 0),
      getSetting<unknown>(db, OWNER_TENANT, "login_texts", null),
      getSetting<string>(db, OWNER_TENANT, "login_logo", ""),
      getSetting<string>(db, OWNER_TENANT, "login_app_icon", ""),
      appDownloadUrl(c),
    ]);
    return c.json({
      login_banner: d ? `/api/public/login-banner?v=${d}` : null,
      login_banner_mobile: m ? `/api/public/login-banner?k=mobile&v=${m}` : null,
      texts,
      logo: logo || null,
      app_icon: appIcon || null,
      app_download_url: download,
    });
  });
  app.get("/api/public/login-banner", async (c) => {
    const key = c.req.query("k") === "mobile" ? "login_banner_mobile" : "login_banner";
    const data = await getSetting<string>(c.env.DB, OWNER_TENANT, key, "");
    const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(data);
    if (!m) return c.body(null, 404);
    const bytes = Uint8Array.from(atob(m[2]), (ch) => ch.charCodeAt(0));
    return c.body(bytes, 200, { "Content-Type": m[1], "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" });
  });

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
      // First-time setup only: the owner login is created when no login exists at all (customers are added by the owner).
      const r = await run(
        c.env.DB,
        "INSERT INTO admin_users (username, password_hash, tenant_id, created_at, updated_at) SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM admin_users)",
        p.data.username, hash, OWNER_TENANT, now, now,
      );
      if (!r.meta.changes) return apiError(c, 409, "already_setup", "تم الإعداد مسبقًا");
    } catch {
      return apiError(c, 409, "already_setup", "تم الإعداد مسبقًا");
    }
    await audit(c.env.DB, OWNER_TENANT, p.data.username, "admin.setup");
    return c.json({ ok: true, next: "احذف SETUP_TOKEN من أسرار Worker الآن (wrangler secret delete SETUP_TOKEN)" });
  });

  app.post("/api/auth/login", async (c) => {
    const ip = clientIp(c);
    if (!(await rateLimit(c.env.DB, `login:${ip}`, 10, 15 * 60_000))) return apiError(c, 429, "rate_limited", "محاولات كثيرة، انتظر 15 دقيقة");
    const p = await parseBody(c, loginSchema);
    if (!p.ok) return p.res;
    const user = await first<{ id: number; username: string; password_hash: string; failed_attempts: number; locked_until: number | null; tenant_id: number; tenant_status: string }>(
      c.env.DB,
      "SELECT u.*, t.status AS tenant_status FROM admin_users u JOIN tenants t ON t.id = u.tenant_id WHERE u.username = ?",
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
    if (user.tenant_status !== "active") return apiError(c, 403, "account_suspended", "هذا الحساب موقوف — تواصل مع إدارة الخدمة");
    const kind = p.data.client === "app" ? "device" : "web";
    const s = await createSession(c.env.DB, user.id, kind, p.data.device_label);
    await audit(c.env.DB, user.tenant_id, user.username, "auth.login", kind);
    if (kind === "web") {
      setCookie(c, SESSION_COOKIE, s.token, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: WEB_SESSION_TTL / 1000 });
      return c.json({ ok: true, username: user.username, csrf_token: s.csrf });
    }
    return c.json({ ok: true, username: user.username, token: s.token, expires_at: s.expiresAt });
  });

  // Self sign-up with an activation code (no code = no account, so the form cannot be used for spam).
  app.post("/api/auth/register", async (c) => {
    if (!(await rateLimit(c.env.DB, `register:${clientIp(c)}`, 5, 60 * 60_000))) return apiError(c, 429, "rate_limited", "محاولات كثيرة، حاول بعد ساعة");
    const p = await parseBody(c, registerSchema);
    if (!p.ok) return p.res;
    const now = Date.now();
    // Check the code first (without using it) so a typo never creates an empty account.
    const code = await first<{ id: number }>(c.env.DB, "SELECT id FROM activation_codes WHERE code_hash = ? AND used_at IS NULL AND revoked_at IS NULL", await codeHash(p.data.code));
    if (!code) return apiError(c, 422, "invalid_code", "كود التفعيل غير صحيح أو مستخدم");
    if (await first(c.env.DB, "SELECT 1 FROM admin_users WHERE username = ?", p.data.username)) return apiError(c, 409, "username_taken", "اسم المستخدم مستخدم — اختر غيره");
    const hash = await hashPassword(p.data.password, c.env.PASSWORD_PEPPER, Number(c.env.PBKDF2_ITERATIONS || 100_000));
    const t = await first<{ id: number }>(c.env.DB, "INSERT INTO tenants (name, created_at, updated_at) VALUES (?, ?, ?) RETURNING id", p.data.name, now, now);
    const tid = t!.id;
    try {
      await run(c.env.DB, "INSERT INTO admin_users (username, password_hash, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", p.data.username, hash, tid, now, now);
      await redeemCode(c.env.DB, tid, p.data.code, now);
    } catch (e) {
      await deleteTenantData(c.env.DB, tid);
      if (e instanceof RedeemError) return apiError(c, 422, e.code, e.message);
      return apiError(c, 409, "username_taken", "اسم المستخدم مستخدم — اختر غيره");
    }
    await seedStarterTemplates(c.env.DB, tid, now);
    await audit(c.env.DB, tid, p.data.username, "tenant.registered", String(tid));
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------------ Authenticated API
  const api = new Hono<AppEnv>();
  api.use("*", requireAuth);

  // Ownership guard: any route addressing a row by id only reaches rows of the caller's tenant (404 otherwise).
  const OWNED: Record<string, string> = {
    campaigns: "SELECT 1 FROM campaigns WHERE id = ? AND tenant_id = ?",
    draws: "SELECT 1 FROM draws WHERE id = ? AND tenant_id = ?",
    "card-designs": "SELECT 1 FROM card_designs WHERE id = ? AND tenant_id = ?",
    templates: "SELECT 1 FROM templates WHERE id = ? AND tenant_id = ?",
    "saved-replies": "SELECT 1 FROM saved_replies WHERE id = ? AND tenant_id = ?",
    undo: "SELECT 1 FROM undo_ops WHERE id = ? AND tenant_id = ?",
    inbox: `SELECT 1 FROM participants WHERE id = ? AND account_id IN ${TENANT_ACCOUNTS}`,
    flows: `SELECT 1 FROM conversation_flows WHERE id = ? AND account_id IN ${TENANT_ACCOUNTS}`,
    jobs: `SELECT 1 FROM action_jobs WHERE id = ? AND account_id IN ${TENANT_ACCOUNTS}`,
  };
  api.use("/:kind/:id/*", ownedGuard);
  api.use("/:kind/:id", ownedGuard);
  async function ownedGuard(c: C, next: () => Promise<void>) {
    const sql = OWNED[c.req.param("kind") ?? ""];
    const raw = c.req.param("id") ?? "";
    if (sql && /^\d+$/.test(raw)) {
      const ok = await first(c.env.DB, sql, Number(raw), T(c));
      if (!ok) return apiError(c, 404, "not_found", "غير موجود");
    }
    await next();
  }

  api.get("/auth/me", (c) => {
    const s = c.get("session");
    return c.json({ username: s.username, kind: s.kind, is_owner: s.is_owner, csrf_token: s.kind === "web" ? s.csrf_token : undefined });
  });

  api.post("/auth/logout", async (c) => {
    await run(c.env.DB, "UPDATE sessions SET revoked_at = ? WHERE id = ?", Date.now(), c.get("session").id);
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
    return c.json({ ok: true });
  });

  api.get("/auth/sessions", async (c) =>
    c.json(await all(c.env.DB, "SELECT substr(id,1,12) AS id, kind, device_label, created_at, last_seen_at, expires_at FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC", c.get("session").user_id, Date.now())),
  );

  api.post("/auth/sessions/revoke-others", async (c) => {
    await run(c.env.DB, "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL", Date.now(), c.get("session").user_id, c.get("session").id);
    return c.json({ ok: true });
  });

  // ---- Subscription of the logged-in customer
  api.get("/subscription", async (c) => {
    const e = await ENT(c);
    const [messages, activeCampaigns, draws] = await Promise.all([
      monthlyMessages(c.env.DB, T(c)),
      first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM campaigns WHERE tenant_id = ? AND status = 'active' AND deleted_at IS NULL", T(c)),
      drawsThisMonth(c.env.DB, T(c)),
    ]);
    return c.json({
      ...e,
      usage: { messages, active_campaigns: activeCampaigns?.n ?? 0, draws_this_month: draws },
      ...(await publicCatalog(c)),
      app_download_url: await appDownloadUrl(c),
    });
  });
  api.post("/subscription/redeem", async (c) => {
    if (!(await rateLimit(c.env.DB, `redeem:${T(c)}`, 10, 60 * 60_000))) return apiError(c, 429, "rate_limited", "محاولات كثيرة، حاول بعد ساعة");
    const p = await parseBody(c, z.object({ code: z.string().trim().min(4).max(40) }));
    if (!p.ok) return p.res;
    if (c.get("session").is_owner) return apiError(c, 409, "owner", "حساب المالك لا يحتاج اشتراكًا");
    try {
      const r = await redeemCode(c.env.DB, T(c), p.data.code);
      await audit(c.env.DB, T(c), c.get("session").username, "subscription.redeemed", r.plan_id, { expires_at: r.expires_at });
      return c.json({ ok: true, ...r });
    } catch (e) {
      if (e instanceof RedeemError) return apiError(c, 422, e.code, e.message);
      throw e;
    }
  });

  // ---- Owner panel (customers). Owner tenant only.
  const owner = new Hono<AppEnv>();
  owner.use("*", async (c, next) => {
    if (!c.get("session").is_owner) return apiError(c, 403, "owner_only", "هذه الصفحة لإدارة الخدمة فقط");
    await next();
  });
  // A notice to every active customer's bell (maintenance, an interruption, service back).
  owner.post("/broadcast", async (c) => {
    const p = await parseBody(c, z.object({ title: z.string().trim().min(3).max(200), body: z.string().trim().max(1000).optional(), link: z.enum(MESSAGE_LINK_PATHS).optional() }));
    if (!p.ok) return p.res;
    if (!(await rateLimit(c.env.DB, "owner_broadcast", 10, 3_600_000))) return apiError(c, 429, "rate_limited", "أرسلت إشعارات كثيرة — جرّب بعد شوي");
    const n = await broadcastNotice(c.env.DB, p.data.title, p.data.body ?? null, Date.now(), p.data.link ?? "/");
    await audit(c.env.DB, T(c), c.get("session").username, "owner.broadcast", String(n), { title: p.data.title });
    return c.json({ ok: true, sent: n });
  });
  // A private message to one customer: their bell, and their Telegram when they set it up.
  owner.post("/tenants/:id/message", async (c) => {
    const id = idParam(c);
    const p = await parseBody(c, z.object({ title: z.string().trim().min(3).max(200), body: z.string().trim().max(1000).optional(), link: z.enum(MESSAGE_LINK_PATHS).optional() }));
    if (!p.ok) return p.res;
    const t = id && (await first<{ id: number; is_owner: number }>(c.env.DB, "SELECT id, is_owner FROM tenants WHERE id = ?", id));
    if (!t || t.is_owner) return apiError(c, 404, "not_found", "العميل غير موجود");
    if (!(await rateLimit(c.env.DB, "owner_message", 60, 3_600_000))) return apiError(c, 429, "rate_limited", "أرسلت رسائل كثيرة — جرّب بعد شوي");
    const text = `✉️ ${p.data.title}${p.data.body ? `\n${p.data.body}` : ""}`;
    await notify(c.env, t.id, "message", text, undefined, { link: p.data.link ?? "/" });
    const s = await getNotifySettings(c.env.DB, t.id);
    await audit(c.env.DB, T(c), c.get("session").username, "owner.message", String(t.id), { title: p.data.title });
    return c.json({ ok: true, telegram: !!s.enabled && !!s.chat_id });
  });
  owner.get("/tenants", async (c) => {
    const since = Date.now() - 30 * 86_400_000;
    const rows = await all<any>(
      c.env.DB,
      `SELECT t.id, t.name, t.is_owner, t.status, t.notes, t.created_at, t.plan_id, t.plan_expires_at, t.plan_started_at,
              (SELECT p.name FROM plans p WHERE p.id = t.plan_id) AS plan_name,
              (SELECT u.messages FROM usage_counters u WHERE u.tenant_id = t.id AND u.month = ?) AS messages_month,
              (SELECT u.username FROM admin_users u WHERE u.tenant_id = t.id ORDER BY u.id LIMIT 1) AS username,
              (SELECT a.username FROM instagram_accounts a WHERE a.tenant_id = t.id AND a.is_demo = 0 ORDER BY (a.status = 'active') DESC, a.updated_at DESC LIMIT 1) AS ig_username,
              (SELECT a.status FROM instagram_accounts a WHERE a.tenant_id = t.id AND a.is_demo = 0 ORDER BY (a.status = 'active') DESC, a.updated_at DESC LIMIT 1) AS ig_status,
              (SELECT a.follow_gate_allowed FROM instagram_accounts a WHERE a.tenant_id = t.id AND a.is_demo = 0 ORDER BY (a.status = 'active') DESC, a.updated_at DESC LIMIT 1) AS follow_gate_allowed,
              (SELECT COUNT(*) FROM campaigns c WHERE c.tenant_id = t.id AND c.deleted_at IS NULL) AS campaigns,
              (SELECT COUNT(*) FROM campaigns c WHERE c.tenant_id = t.id AND c.deleted_at IS NULL AND c.status = 'active') AS active_campaigns,
              (SELECT COUNT(*) FROM conversation_flows f WHERE f.is_demo = 0 AND f.created_at > ? AND f.account_id IN (SELECT id FROM instagram_accounts WHERE tenant_id = t.id)) AS flows_30d,
              (SELECT MAX(s.last_seen_at) FROM sessions s JOIN admin_users u ON u.id = s.user_id WHERE u.tenant_id = t.id) AS last_seen_at
         FROM tenants t ORDER BY t.is_owner DESC, t.id DESC`,
      new Date().toISOString().slice(0, 7),
      since,
    );
    return c.json(rows);
  });
  owner.post("/tenants", async (c) => {
    const p = await parseBody(c, tenantCreateSchema);
    if (!p.ok) return p.res;
    if (await first(c.env.DB, "SELECT 1 FROM admin_users WHERE username = ?", p.data.username)) return apiError(c, 409, "username_taken", "اسم المستخدم مستخدم — اختر غيره");
    const now = Date.now();
    const hash = await hashPassword(p.data.password, c.env.PASSWORD_PEPPER, Number(c.env.PBKDF2_ITERATIONS || 100_000));
    const t = await first<{ id: number }>(c.env.DB, "INSERT INTO tenants (name, notes, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING id", p.data.name, p.data.notes ?? null, now, now);
    const tid = t!.id;
    try {
      await run(c.env.DB, "INSERT INTO admin_users (username, password_hash, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", p.data.username, hash, tid, now, now);
    } catch {
      await run(c.env.DB, "DELETE FROM tenants WHERE id = ?", tid);
      return apiError(c, 409, "username_taken", "اسم المستخدم مستخدم — اختر غيره");
    }
    await seedStarterTemplates(c.env.DB, tid, now);
    await audit(c.env.DB, T(c), c.get("session").username, "tenant.created", String(tid), { name: p.data.name, username: p.data.username });
    return c.json({ id: tid });
  });
  const tenantParam = async (c: C) => {
    const tid = Number(c.req.param("tid"));
    if (!Number.isInteger(tid) || tid < 1) return null;
    return first<{ id: number; is_owner: number; name: string }>(c.env.DB, "SELECT id, is_owner, name FROM tenants WHERE id = ?", tid);
  };
  owner.post("/tenants/:tid/status", async (c) => {
    const t = await tenantParam(c);
    if (!t) return apiError(c, 404, "not_found", "العميل غير موجود");
    if (t.is_owner) return apiError(c, 409, "owner", "لا يمكن إيقاف حساب المالك");
    const p = await parseBody(c, z.object({ status: z.enum(["active", "suspended"]) }));
    if (!p.ok) return p.res;
    const now = Date.now();
    await run(c.env.DB, "UPDATE tenants SET status = ?, updated_at = ? WHERE id = ?", p.data.status, now, t.id);
    if (p.data.status === "suspended") {
      // Logged-out immediately, and nothing more is sent for this customer.
      await run(c.env.DB, "UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM admin_users WHERE tenant_id = ?)", now, t.id);
      await cancelJobsWhere(c.env.DB, `kind != 'process_event' AND account_id IN ${TENANT_ACCOUNTS}`, now, t.id);
    }
    await audit(c.env.DB, T(c), c.get("session").username, `tenant.${p.data.status}`, String(t.id), { name: t.name });
    return c.json({ ok: true });
  });
  owner.post("/tenants/:tid/password", async (c) => {
    const t = await tenantParam(c);
    if (!t) return apiError(c, 404, "not_found", "العميل غير موجود");
    const p = await parseBody(c, z.object({ password: z.string().min(12, "كلمة المرور 12 حرفًا على الأقل").max(256) }));
    if (!p.ok) return p.res;
    const now = Date.now();
    const hash = await hashPassword(p.data.password, c.env.PASSWORD_PEPPER, Number(c.env.PBKDF2_ITERATIONS || 100_000));
    await run(c.env.DB, "UPDATE admin_users SET password_hash = ?, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE tenant_id = ?", hash, now, t.id);
    await run(c.env.DB, "UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM admin_users WHERE tenant_id = ?)", now, t.id);
    await audit(c.env.DB, T(c), c.get("session").username, "tenant.password_reset", String(t.id));
    return c.json({ ok: true });
  });
  // The follow REQUIREMENT stays an owner decision per account (Meta Spam policy — for the owner's own accounts).
  owner.post("/tenants/:tid/follow-gate", async (c) => {
    const t = await tenantParam(c);
    if (!t) return apiError(c, 404, "not_found", "العميل غير موجود");
    const p = await parseBody(c, z.object({ allowed: z.boolean() }));
    if (!p.ok) return p.res;
    await run(c.env.DB, "UPDATE instagram_accounts SET follow_gate_allowed = ?, updated_at = ? WHERE tenant_id = ? AND is_demo = 0", p.data.allowed ? 1 : 0, Date.now(), t.id);
    await audit(c.env.DB, T(c), c.get("session").username, p.data.allowed ? "follow_gate.allowed" : "follow_gate.disallowed", `tenant:${t.id}`);
    return c.json({ ok: true });
  });
  // Cloudflare free-plan usage (requests, database writes and size, R2 storage) for the owner.
  owner.get("/usage", async (c) => {
    const force = c.req.query("refresh") === "1" && (await rateLimit(c.env.DB, "cf_usage_refresh", 12, 3_600_000));
    const [cf, domain] = await Promise.all([cloudflareUsage(c.env, Date.now(), force), domainInfo(c.env, Date.now(), force)]);
    return c.json({ ...(await platformUsage(c.env.DB, !!c.env.MEDIA, Date.now(), cf)), cf_connected: !!c.env.CF_ANALYTICS_TOKEN && !!c.env.CF_ACCOUNT_ID, domain });
  });
  // Plan of one customer, set by hand (e.g. a payment received outside the codes).
  owner.post("/tenants/:tid/plan", async (c) => {
    const t = await tenantParam(c);
    if (!t) return apiError(c, 404, "not_found", "العميل غير موجود");
    if (t.is_owner) return apiError(c, 409, "owner", "حساب المالك لا يحتاج اشتراكًا");
    // days > 0 adds (after the current expiry if still running), days < 0 removes; expires_at sets an exact date;
    // neither keeps the current expiry (e.g. a plan change only).
    const p = await parseBody(c, z.object({ plan_id: z.string().max(20).nullable(), days: z.number().int().min(-3650).max(3650).optional(), expires_at: z.number().int().nullable().optional() }));
    if (!p.ok) return p.res;
    if (p.data.plan_id && !(await first(c.env.DB, "SELECT 1 FROM plans WHERE id = ?", p.data.plan_id))) return apiError(c, 422, "validation", "باقة غير موجودة");
    const now = Date.now();
    const cur = await first<{ plan_expires_at: number | null; plan_started_at: number | null }>(c.env.DB, "SELECT plan_expires_at, plan_started_at FROM tenants WHERE id = ?", t.id);
    const running = !!cur?.plan_expires_at && cur.plan_expires_at > now;
    let expires: number | null = cur?.plan_expires_at ?? null;
    if (p.data.expires_at !== undefined) expires = p.data.expires_at;
    else if (p.data.days !== undefined && p.data.days > 0) expires = (running ? cur!.plan_expires_at! : now) + p.data.days * 86_400_000;
    else if (p.data.days !== undefined && p.data.days < 0) expires = running ? Math.max(now, cur!.plan_expires_at! + p.data.days * 86_400_000) : expires;
    // A new period starts when the subscription was not running; extending keeps the original start.
    const started = expires && expires > now ? (running ? (cur!.plan_started_at ?? now) : now) : (cur?.plan_started_at ?? null);
    await run(c.env.DB, "UPDATE tenants SET plan_id = ?, plan_expires_at = ?, plan_started_at = ?, expiry_notice_at = NULL, updated_at = ? WHERE id = ?", p.data.plan_id, expires, started, now, t.id);
    await audit(c.env.DB, T(c), c.get("session").username, "tenant.plan_set", String(t.id), { plan: p.data.plan_id, expires_at: expires });
    return c.json({ ok: true, plan_id: p.data.plan_id, expires_at: expires });
  });
  // Deletes a customer and all of its data (irreversible; the customer's exact name must be typed).
  owner.delete("/tenants/:tid", async (c) => {
    const t = await tenantParam(c);
    if (!t) return apiError(c, 404, "not_found", "العميل غير موجود");
    if (t.is_owner) return apiError(c, 409, "owner", "لا يمكن حذف حساب المالك");
    const p = await parseBody(c, z.object({ confirm: z.string() }));
    if (!p.ok) return p.res;
    if (p.data.confirm.trim() !== t.name.trim()) return apiError(c, 422, "confirm", "اكتب اسم العميل كما هو للتأكيد");
    // Stop Instagram webhooks for the customer's account(s) first, then remove everything.
    const accounts = await all<{ id: number }>(c.env.DB, "SELECT id FROM instagram_accounts WHERE tenant_id = ? AND is_demo = 0", t.id);
    for (const a of accounts) await disconnectAccount(c.env, a.id, { purge: true, actor: c.get("session").username }).catch(() => undefined);
    await deleteTenantData(c.env.DB, t.id);
    await audit(c.env.DB, T(c), c.get("session").username, "tenant.deleted", String(t.id), { name: t.name });
    return c.json({ ok: true });
  });

  owner.get("/plans", async (c) => c.json(await listPlans(c.env.DB)));
  owner.put("/plans/:pid", async (c) => {
    const pid = c.req.param("pid");
    if (!(await first(c.env.DB, "SELECT 1 FROM plans WHERE id = ?", pid))) return apiError(c, 404, "not_found", "الباقة غير موجودة");
    const p = await parseBody(c, planUpdateSchema);
    if (!p.ok) return p.res;
    const currency = p.data.price_currency ?? "SAR";
    const period = p.data.price_period ?? "month";
    const amount = p.data.price_amount ?? null;
    // A structured price wins; otherwise the free-text label (or nothing → "تواصل معنا").
    const label = amount !== null ? formatPrice(amount, currency, period) : (p.data.price_label ?? null);
    await run(
      c.env.DB,
      "UPDATE plans SET name = ?, price_label = ?, price_amount = ?, price_currency = ?, price_period = ?, description = ?, limits = ?, active = ?, updated_at = ? WHERE id = ?",
      p.data.name, label, amount, currency, period, p.data.description ?? null, JSON.stringify(p.data.limits), p.data.active ? 1 : 0, Date.now(), pid,
    );
    await audit(c.env.DB, T(c), c.get("session").username, "plan.updated", pid);
    return c.json({ ok: true });
  });

  owner.get("/codes", async (c) =>
    c.json(
      await all(
        c.env.DB,
        `SELECT a.id, a.hint, a.plan_id, p.name AS plan_name, a.days, a.note, a.created_at, a.used_at, a.revoked_at, a.used_by_tenant,
                COALESCE(t.name, a.used_by_name) AS used_by, a.used_by_username, (t.id IS NOT NULL) AS customer_exists,
                t.plan_expires_at AS customer_expires_at
           FROM activation_codes a LEFT JOIN plans p ON p.id = a.plan_id LEFT JOIN tenants t ON t.id = a.used_by_tenant
          ORDER BY a.id DESC LIMIT 300`,
      ),
    ),
  );
  owner.post("/codes", async (c) => {
    const p = await parseBody(c, z.object({ plan_id: z.string().max(20), days: z.number().int().min(1).max(3650), count: z.number().int().min(1).max(50).default(1), note: z.string().trim().max(200).optional() }));
    if (!p.ok) return p.res;
    if (!(await first(c.env.DB, "SELECT 1 FROM plans WHERE id = ?", p.data.plan_id))) return apiError(c, 422, "validation", "باقة غير موجودة");
    const now = Date.now();
    const codes: string[] = [];
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < p.data.count; i++) {
      const code = newCode();
      codes.push(code);
      stmts.push(
        c.env.DB.prepare("INSERT INTO activation_codes (code_hash, hint, plan_id, days, note, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(await codeHash(code), code.slice(-4), p.data.plan_id, p.data.days, p.data.note ?? null, now),
      );
    }
    await c.env.DB.batch(stmts);
    await audit(c.env.DB, T(c), c.get("session").username, "codes.created", p.data.plan_id, { count: p.data.count, days: p.data.days });
    // The codes themselves are returned once and never stored.
    return c.json({ codes });
  });
  owner.post("/codes/:cid/revoke", async (c) => {
    const cid = Number(c.req.param("cid"));
    const r = await run(c.env.DB, "UPDATE activation_codes SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL", Date.now(), cid);
    if (!r.meta.changes) return apiError(c, 409, "not_revocable", "الكود مستخدم أو ملغى مسبقًا");
    await audit(c.env.DB, T(c), c.get("session").username, "codes.revoked", String(cid));
    return c.json({ ok: true });
  });
  // Removes a code from the list (any state). A used code's subscription stays as it is.
  owner.delete("/codes/:cid", async (c) => {
    const cid = Number(c.req.param("cid"));
    const r = await run(c.env.DB, "DELETE FROM activation_codes WHERE id = ?", cid);
    if (!r.meta.changes) return apiError(c, 404, "not_found", "الكود غير موجود");
    await audit(c.env.DB, T(c), c.get("session").username, "codes.deleted", String(cid));
    return c.json({ ok: true });
  });

  // The login page banner images (data: URLs resized in the browser; null = back to the default design).
  owner.put("/login-banner", async (c) => {
    const p = await parseBody(c, z.object({
      variant: z.enum(["desktop", "mobile"]).default("desktop"),
      image: z.string().max(1_400_000, "الصورة كبيرة — اختر صورة أصغر").regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, "صيغة الصورة غير مدعومة").nullable(),
    }));
    if (!p.ok) return p.res;
    const key = p.data.variant === "mobile" ? "login_banner_mobile" : "login_banner";
    await setSetting(c.env.DB, OWNER_TENANT, key, p.data.image ?? "");
    await setSetting(c.env.DB, OWNER_TENANT, `${key}_at`, p.data.image ? Date.now() : 0);
    return c.json({ ok: true });
  });
  // Banner texts and logo (null texts = the default texts).
  owner.put("/branding", async (c) => {
    const p = await parseBody(c, brandingSchema);
    if (!p.ok) return p.res;
    await setSetting(c.env.DB, OWNER_TENANT, "login_texts", p.data.texts);
    await setSetting(c.env.DB, OWNER_TENANT, "login_logo", p.data.logo ?? "");
    if (p.data.app_icon !== undefined) await setSetting(c.env.DB, OWNER_TENANT, "login_app_icon", p.data.app_icon ?? "");
    return c.json({ ok: true });
  });
  // The highlighted plan and its badge text (plan_id null = no badge).
  owner.put("/featured-plan", async (c) => {
    const p = await parseBody(c, featuredSchema);
    if (!p.ok) return p.res;
    if (p.data.plan_id && !(await first(c.env.DB, "SELECT 1 FROM plans WHERE id = ?", p.data.plan_id))) return apiError(c, 422, "validation", "باقة غير موجودة");
    await setSetting(c.env.DB, OWNER_TENANT, "featured_plan", p.data);
    return c.json({ ok: true });
  });

  // The order of the plan points everywhere they are listed.
  owner.put("/feature-order", async (c) => {
    const p = await parseBody(c, featureOrderSchema);
    if (!p.ok) return p.res;
    await setSetting(c.env.DB, OWNER_TENANT, "feature_order", orderFeatures(p.data.order));
    return c.json({ ok: true });
  });

  // ---- Payment methods (banks / exchange offices and their accounts), shown to buyers
  owner.get("/payment-methods", async (c) => c.json(await listPaymentMethods(c.env.DB)));
  owner.post("/payment-providers", async (c) => {
    const p = await parseBody(c, paymentProviderSchema);
    if (!p.ok) return p.res;
    const max = await first<{ m: number | null }>(c.env.DB, "SELECT MAX(sort) AS m FROM payment_providers");
    const row = await first<{ id: number }>(c.env.DB, "INSERT INTO payment_providers (name, kind, logo, sort, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id", p.data.name, p.data.kind, p.data.logo ?? null, (max?.m ?? 0) + 1, Date.now());
    return c.json({ ok: true, id: row!.id });
  });
  owner.put("/payment-providers/:pid", async (c) => {
    const p = await parseBody(c, paymentProviderSchema);
    if (!p.ok) return p.res;
    const r = await run(c.env.DB, "UPDATE payment_providers SET name = ?, kind = ?, logo = ? WHERE id = ?", p.data.name, p.data.kind, p.data.logo ?? null, Number(c.req.param("pid")));
    if (!r.meta.changes) return apiError(c, 404, "not_found", "غير موجود");
    return c.json({ ok: true });
  });
  owner.post("/payment-providers/:pid/move", async (c) => {
    const p = await parseBody(c, z.object({ dir: z.enum(["up", "down"]) }));
    if (!p.ok) return p.res;
    const rows = await all<{ id: number }>(c.env.DB, "SELECT id FROM payment_providers ORDER BY sort, id");
    const i = rows.findIndex((r) => r.id === Number(c.req.param("pid")));
    const j = p.data.dir === "up" ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= rows.length) return c.json({ ok: true });
    [rows[i], rows[j]] = [rows[j], rows[i]];
    await c.env.DB.batch(rows.map((r, k) => c.env.DB.prepare("UPDATE payment_providers SET sort = ? WHERE id = ?").bind(k + 1, r.id)));
    return c.json({ ok: true });
  });
  owner.delete("/payment-providers/:pid", async (c) => {
    const pid = Number(c.req.param("pid"));
    await c.env.DB.batch([c.env.DB.prepare("DELETE FROM payment_accounts WHERE provider_id = ?").bind(pid), c.env.DB.prepare("DELETE FROM payment_providers WHERE id = ?").bind(pid)]);
    return c.json({ ok: true });
  });
  owner.post("/payment-providers/:pid/accounts", async (c) => {
    const pid = Number(c.req.param("pid"));
    if (!(await first(c.env.DB, "SELECT 1 FROM payment_providers WHERE id = ?", pid))) return apiError(c, 404, "not_found", "غير موجود");
    const p = await parseBody(c, paymentAccountSchema);
    if (!p.ok) return p.res;
    const max = await first<{ m: number | null }>(c.env.DB, "SELECT MAX(sort) AS m FROM payment_accounts WHERE provider_id = ?", pid);
    const row = await first<{ id: number }>(c.env.DB, "INSERT INTO payment_accounts (provider_id, holder, number, currency, note, sort) VALUES (?, ?, ?, ?, ?, ?) RETURNING id", pid, p.data.holder, p.data.number, p.data.currency ?? null, p.data.note ?? null, (max?.m ?? 0) + 1);
    return c.json({ ok: true, id: row!.id });
  });
  owner.put("/payment-accounts/:aid", async (c) => {
    const p = await parseBody(c, paymentAccountSchema);
    if (!p.ok) return p.res;
    const r = await run(c.env.DB, "UPDATE payment_accounts SET holder = ?, number = ?, currency = ?, note = ? WHERE id = ?", p.data.holder, p.data.number, p.data.currency ?? null, p.data.note ?? null, Number(c.req.param("aid")));
    if (!r.meta.changes) return apiError(c, 404, "not_found", "غير موجود");
    return c.json({ ok: true });
  });
  owner.delete("/payment-accounts/:aid", async (c) => {
    await run(c.env.DB, "DELETE FROM payment_accounts WHERE id = ?", Number(c.req.param("aid")));
    return c.json({ ok: true });
  });

  owner.get("/settings", async (c) =>
    c.json({
      sales_contact: await getSetting<string>(c.env.DB, OWNER_TENANT, "sales_contact", ""),
      app_download_url: await getSetting<string>(c.env.DB, OWNER_TENANT, "app_download_url", ""),
      exchange_rates: { ...DEFAULT_RATES, ...(await getSetting<ExchangeRates>(c.env.DB, OWNER_TENANT, "exchange_rates", DEFAULT_RATES)), USD: 1 },
    }),
  );
  owner.put("/settings", async (c) => {
    const httpsOrEmpty = z.string().trim().max(300).refine((v) => v === "" || /^https:\/\//.test(v), "الرابط يجب أن يبدأ بـ https://");
    const p = await parseBody(c, z.object({ sales_contact: httpsOrEmpty.optional(), app_download_url: httpsOrEmpty.optional(), exchange_rates: exchangeRatesSchema.optional() }));
    if (!p.ok) return p.res;
    if (p.data.exchange_rates) await setSetting(c.env.DB, OWNER_TENANT, "exchange_rates", { USD: 1, ...p.data.exchange_rates });
    if (p.data.sales_contact !== undefined) await setSetting(c.env.DB, OWNER_TENANT, "sales_contact", p.data.sales_contact);
    if (p.data.app_download_url !== undefined) await setSetting(c.env.DB, OWNER_TENANT, "app_download_url", p.data.app_download_url);
    return c.json({ ok: true });
  });

  api.route("/owner", owner);

  // ---- Dashboard
  api.get("/dashboard", async (c) => {
    const db = c.env.DB;
    const since = Date.now() - Number(c.req.query("days") ?? 30) * 86_400_000;
    const t = T(c);
    const [account, campaigns, events, jobs, flows, follows, automation] = await Promise.all([
      currentAccount(db, t),
      first(db, "SELECT SUM(status='active') AS active, SUM(status='paused') AS paused, SUM(status='draft') AS draft FROM campaigns WHERE tenant_id = ? AND deleted_at IS NULL", t),
      all(db, `SELECT event_type, status, COUNT(*) AS n FROM webhook_events WHERE account_ig_id IN ${TENANT_IG_IDS} AND is_demo = 0 AND received_at > ? GROUP BY event_type, status`, t, since),
      all(db, `SELECT kind, purpose, status, COUNT(*) AS n FROM action_jobs WHERE account_id IN ${TENANT_ACCOUNTS} AND is_demo = 0 AND created_at > ? AND kind != 'process_event' GROUP BY kind, purpose, status`, t, since),
      all(db, `SELECT state, COUNT(*) AS n FROM conversation_flows WHERE account_id IN ${TENANT_ACCOUNTS} AND is_demo = 0 AND created_at > ? GROUP BY state`, t, since),
      // New followers: people Meta first reported as not following who were following at a later check in the period.
      first(
        db,
        `SELECT COUNT(DISTINCT fc.participant_id) AS verified,
                COUNT(DISTINCT CASE WHEN EXISTS (
                  SELECT 1 FROM follow_checks f0 WHERE f0.participant_id = fc.participant_id AND f0.is_demo = 0
                     AND f0.result = 'not_following' AND f0.checked_at < fc.checked_at) THEN fc.participant_id END) AS new_followers
           FROM follow_checks fc JOIN participants p ON p.id = fc.participant_id
          WHERE p.account_id IN ${TENANT_ACCOUNTS} AND fc.is_demo = 0 AND fc.result = 'following' AND fc.checked_at > ?`,
        t,
        since,
      ),
      getSetting(db, t, "automation_enabled", true),
    ]);
    // Daily series (UTC days) for the activity chart, best campaigns and the latest activity.
    const [sComments, sDelivered, top, recent] = await Promise.all([
      all<{ d: number; n: number }>(db, `SELECT CAST(received_at / 86400000 AS INTEGER) AS d, COUNT(*) AS n FROM webhook_events WHERE account_ig_id IN ${TENANT_IG_IDS} AND is_demo = 0 AND event_type IN ('comment','story_reply','story_mention') AND received_at > ? GROUP BY d`, t, since),
      all<{ d: number; n: number }>(db, `SELECT CAST(updated_at / 86400000 AS INTEGER) AS d, COUNT(*) AS n FROM action_jobs WHERE account_id IN ${TENANT_ACCOUNTS} AND is_demo = 0 AND kind = 'send_message' AND purpose = 'content' AND status = 'accepted' AND created_at > ? GROUP BY d`, t, since),
      all(
        db,
        `SELECT c.id, c.name, c.type, c.status, COUNT(f.id) AS triggers, SUM(f.state = 'content_sent') AS delivered
           FROM campaigns c JOIN conversation_flows f ON f.campaign_id = c.id AND f.is_demo = 0 AND f.created_at > ?
          WHERE c.tenant_id = ? AND c.deleted_at IS NULL GROUP BY c.id ORDER BY triggers DESC LIMIT 4`,
        since,
        t,
      ),
      all(
        db,
        `SELECT f.id, f.state, f.updated_at, p.username, p.profile_pic_url, c.name AS campaign
           FROM conversation_flows f JOIN participants p ON p.id = f.participant_id JOIN campaigns c ON c.id = f.campaign_id
          WHERE c.tenant_id = ? AND f.is_demo = 0 ORDER BY f.updated_at DESC LIMIT 6`,
        t,
      ),
    ]);
    return c.json({ account: publicAccount(account), campaigns, events, jobs, flows, follows, automation_enabled: automation, series: { comments: sComments, delivered: sDelivered }, top_campaigns: top, recent });
  });

  api.post("/automation", async (c) => {
    const p = await parseBody(c, z.object({ enabled: z.boolean() }));
    if (!p.ok) return p.res;
    await setSetting(c.env.DB, T(c), "automation_enabled", p.data.enabled);
    if (!p.data.enabled) await cancelJobsWhere(c.env.DB, `is_demo = 0 AND kind != 'process_event' AND account_id IN ${TENANT_ACCOUNTS}`, Date.now(), T(c));
    await audit(c.env.DB, T(c), c.get("session").username, p.data.enabled ? "automation.enabled" : "automation.disabled");
    return c.json({ ok: true, enabled: p.data.enabled });
  });

  // ---- Instagram account connection
  // The stored profile picture link expired (the app saw a broken image): read the profile again.
  api.post("/account/refresh-profile", async (c) => {
    if (!(await rateLimit(c.env.DB, `profile:${c.get("session").username}`, 6, 3_600_000))) return c.json({ ok: false });
    await refreshAccountProfiles(c.env, T(c));
    return c.json({ ok: true, account: publicAccount(await currentAccount(c.env.DB, T(c))) });
  });
  // Owner-only switch: allow the follow REQUIREMENT on this account (everyone else gets the optional invitation).
  api.post("/account/follow-gate", async (c) => {
    if (!c.get("session").is_owner) return apiError(c, 403, "owner_only", "هذا الإعداد متاح لإدارة الخدمة فقط");
    const p = await parseBody(c, z.object({ allowed: z.boolean() }));
    if (!p.ok) return p.res;
    const a = await currentAccount(c.env.DB, T(c));
    if (!a) return apiError(c, 404, "not_found", "لا يوجد حساب متصل");
    await run(c.env.DB, "UPDATE instagram_accounts SET follow_gate_allowed = ?, updated_at = ? WHERE id = ?", p.data.allowed ? 1 : 0, Date.now(), a.id);
    await audit(c.env.DB, T(c), c.get("session").username, p.data.allowed ? "follow_gate.allowed" : "follow_gate.disallowed", String(a.id));
    return c.json({ ok: true });
  });
  api.get("/account", async (c) => {
    const a = await currentAccount(c.env.DB, T(c));
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
    const extra = await optionalScopes(c.env.DB, T(c));
    return c.json({ url: metaClient(c.env).authorizeUrl(redirectUri(c.env), state, extra) });
  });

  api.post("/account/resubscribe", async (c) => {
    const a = await currentAccount(c.env.DB, T(c));
    if (!a || a.status === "disconnected") return apiError(c, 404, "no_account", "لا يوجد حساب متصل");
    const r = await subscribeWebhooks(c.env, a.id);
    return r.ok ? c.json({ ok: true }) : apiError(c, 502 as any, "meta_error", r.error ?? "فشل الاشتراك");
  });

  api.post("/account/refresh-token", async (c) => {
    const a = await currentAccount(c.env.DB, T(c));
    if (!a || a.status === "disconnected") return apiError(c, 404, "no_account", "لا يوجد حساب متصل");
    const r = await refreshToken(c.env, a);
    return r.ok ? c.json({ ok: true }) : apiError(c, 502 as any, "meta_error", r.error ?? "فشل التجديد");
  });

  api.get("/account/diagnostics", async (c) => {
    const a = await currentAccount(c.env.DB, T(c));
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
    const a = await currentAccount(c.env.DB, T(c));
    if (!a) return apiError(c, 404, "no_account", "لا يوجد حساب");
    await disconnectAccount(c.env, a.id, { purge: p.data.purge, actor: c.get("session").username });
    return c.json({ ok: true });
  });

  // ---- Media & stories
  api.get("/media", async (c) => {
    const a = await currentAccount(c.env.DB, T(c));
    if (!a) return c.json({ items: [] });
    const kind = c.req.query("kind") === "story" ? "story" : "media";
    const items = await all(c.env.DB, "SELECT * FROM media_cache WHERE account_id = ? AND kind = ? ORDER BY posted_at DESC LIMIT 1000", a.id, kind);
    return c.json({ items, now: Date.now() });
  });

  api.post("/media/refresh", async (c) => {
    const p = await parseBody(c, z.object({ kind: z.enum(["media", "story"]), after: z.string().max(500).optional(), all: z.boolean().default(true) }));
    if (!p.ok) return p.res;
    const a = await currentAccount(c.env.DB, T(c));
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
    const where = ["c.tenant_id = ?", "deleted_at IS NULL"];
    const params: unknown[] = [T(c)];
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
    const row = id && (await first(c.env.DB, "SELECT * FROM campaigns WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL", id, T(c)));
    if (!row) return apiError(c, 404, "not_found", "الحملة غير موجودة");
    const [keywords, media] = await Promise.all([
      all(c.env.DB, "SELECT keyword, kind, match_type FROM campaign_keywords WHERE campaign_id = ? ORDER BY id", id),
      all<{ media_id: string }>(c.env.DB, "SELECT media_id FROM campaign_media WHERE campaign_id = ?", id),
    ]);
    // The scheduled post this campaign waits for (until it is published and gets its id).
    const scheduled_post = await first(
      c.env.DB,
      "SELECT id, kind, publish_at, status FROM scheduled_posts WHERE campaign_id = ? AND tenant_id = ? AND status NOT IN ('published','cancelled') ORDER BY publish_at LIMIT 1",
      id,
      T(c),
    );
    return c.json({ ...row, keywords, media_ids: media.map((m) => m.media_id), scheduled_post });
  });

  // Per-post performance of one campaign: comments, people reached, follow conversions, deliveries.
  api.get("/campaigns/:id/stats", async (c) => {
    const blocked = await planBlock(c, "campaign_stats");
    if (blocked) return blocked;
    const id = idParam(c);
    const campaign = id && (await first<{ id: number; type: string; require_follow: number }>(c.env.DB, "SELECT id, type, require_follow FROM campaigns WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL", id, T(c)));
    if (!campaign) return apiError(c, 404, "not_found", "الحملة غير موجودة");
    const days = Number(c.req.query("days") ?? 0);
    const since = days > 0 ? Date.now() - Math.min(days, 3650) * 86_400_000 : 0;
    const db = c.env.DB;
    // One row per flow with the facts we aggregate on (first follow result, did we reach them, did they convert).
    const perFlow = `
      SELECT f.id, f.participant_id, COALESCE(f.source_media_id, '') AS media_id, f.state, f.public_reply_status, f.created_at, f.link_clicks,
             (SELECT fc.result FROM follow_checks fc WHERE fc.flow_id = f.id AND fc.result IN ('following','not_following') ORDER BY fc.id LIMIT 1) AS first_follow,
             EXISTS (SELECT 1 FROM follow_checks fc WHERE fc.flow_id = f.id AND fc.result <> 'needs_interaction') AS checked,
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
      COUNT(DISTINCT CASE WHEN checked THEN participant_id END) AS interacted,
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
          WHERE account_ig_id IN ${TENANT_IG_IDS} AND event_type = 'comment' AND is_demo = 0 AND received_at >= ? AND media_id IS NOT NULL
            AND (media_id IN (SELECT media_id FROM campaign_media WHERE campaign_id = ?) OR campaign_id = ?)
          GROUP BY media_id`,
        id, T(c), since, id, id,
      ),
    ]);
    const mediaIds = new Set<string>([...rows.map((r) => r.media_id), ...comments.map((r) => r.media_id)].filter(Boolean));
    for (const m of await all<{ media_id: string }>(db, "SELECT media_id FROM campaign_media WHERE campaign_id = ?", id)) mediaIds.add(m.media_id);
    const meta = mediaIds.size
      ? await all<any>(db, `SELECT media_id, caption, permalink, thumbnail_url, media_product_type, posted_at FROM media_cache WHERE account_id IN ${TENANT_ACCOUNTS} AND media_id IN (${[...mediaIds].map(() => "?").join(",")})`, T(c), ...mediaIds)
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
  // Comment check: every comment Instagram has on the campaign's posts vs what we recorded and answered.
  // import=true also queues the ones we never received (still inside Meta's 7-day private-reply window).
  api.post("/campaigns/:id/audit", async (c) => {
    const blocked = await planBlock(c, "campaign_stats");
    if (blocked) return blocked;
    const id = idParam(c);
    if (!id) return apiError(c, 404, "not_found", "الحملة غير موجودة");
    const body = await c.req.json().catch(() => ({}));
    const importMissing = (body as any)?.import === true;
    if (importMissing) {
      const b = await planBlock(c, "recover");
      if (b) return b;
    }
    if (!(await rateLimit(c.env.DB, `audit:${T(c)}`, 20, 3_600_000))) return apiError(c, 429, "rate_limited", "انتظر قليلًا قبل فحص التعليقات مرة أخرى");
    let used = 0;
    const ctx = engineContext(c.env, () => used++);
    const mediaId = typeof (body as any)?.media_id === "string" && (body as any).media_id.length <= 64 ? (body as any).media_id : undefined;
    const r = await auditCampaignComments(ctx, T(c), id, { importMissing, mediaId });
    if (!r) return apiError(c, 404, "not_found", "الحملة غير موجودة");
    if (r.imported > 0) {
      await audit(c.env.DB, T(c), c.get("session").username, "comments.recovered", String(id), { imported: r.imported, via: "campaign_audit" });
      c.executionCtx.waitUntil(
        runQueue(ctx, { maxJobs: 20, includeDemo: false, deadlineMs: 25_000, budget: { used: () => used, limit: 44 } }).catch((e) => console.error("audit queue", sanitize(String(e)))),
      );
    }
    return c.json(r);
  });

  // ---- Analytics (from what the system recorded; Instagram's own metrics need the insights permission)
  const analyticsFilter = async (c: C): Promise<AnalyticsFilter | null> => {
    const now = Date.now();
    const from = Number(c.req.query("from"));
    const to = Number(c.req.query("to"));
    if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= from || to - from > 400 * 86_400_000) return null;
    const type = c.req.query("type");
    const tz = await getSetting<string>(c.env.DB, T(c), "timezone", "Asia/Aden");
    return {
      from,
      to: Math.min(to, now + 60_000),
      campaignId: Number(c.req.query("campaign_id")) || undefined,
      mediaId: (c.req.query("media_id") || "").slice(0, 64) || undefined,
      type: type === "comment" || type === "story_reply" || type === "story_mention" ? (type as EventType) : undefined,
      tzOffsetMin: tzOffsetMinutes(tz || "Asia/Aden"),
    };
  };
  api.get("/analytics", async (c) => {
    const blocked = await planBlock(c, "campaign_stats");
    if (blocked) return blocked;
    const f = await analyticsFilter(c);
    if (!f) return apiError(c, 422, "validation", "فترة غير صحيحة");
    const heat = (["comments", "messages", "clicks"] as const).includes(c.req.query("heat") as HeatKind) ? (c.req.query("heat") as HeatKind) : "comments";
    const db = c.env.DB;
    const [overview, campaigns, posts, heatmap, devices, follow, retention, recheck_enabled, recheck_days, instagram] = await Promise.all([
      analyticsOverview(db, T(c), f),
      analyticsByCampaign(db, T(c), f),
      analyticsByPost(db, T(c), f),
      analyticsHeatmap(db, T(c), f, heat),
      analyticsDevices(db, T(c), f),
      analyticsFollow(db, T(c), f),
      analyticsRetention(db, T(c), f),
      getSetting(db, T(c), "follow_recheck_enabled", false),
      getSetting(db, T(c), "follow_recheck_days", 7),
      insightsSummary(db, T(c), f),
    ]);
    return c.json({
      generated_at: Date.now(),
      filter: { from: f.from, to: f.to, campaign_id: f.campaignId ?? null, media_id: f.mediaId ?? null, type: f.type ?? null, tz_offset_min: f.tzOffsetMin },
      overview,
      campaigns,
      posts,
      heatmap,
      devices,
      follow,
      retention,
      recheck: { enabled: !!recheck_enabled, days: Number(recheck_days) || 7 },
      instagram: { ...instagram, scope_mode: c.get("session").is_owner ? await insightsScopeMode(db) : undefined },
    });
  });
  // Every stored reading of one post (lifetime values over time).
  api.get("/analytics/media/:mid/insights", async (c) => {
    const blocked = await planBlock(c, "campaign_stats");
    if (blocked) return blocked;
    return c.json({ items: await mediaInsightsSeries(c.env.DB, T(c), c.req.param("mid").slice(0, 64)) });
  });
  // Manual refresh of Instagram metrics (a few times an hour; the hourly job does the rest).
  api.post("/analytics/insights/refresh", async (c) => {
    const blocked = await planBlock(c, "campaign_stats");
    if (blocked) return blocked;
    const account = await insightsAccount(c.env.DB, T(c));
    if (!account) return apiError(c, 409, "no_permission", "صلاحية الإحصاءات غير مفعّلة على الحساب المربوط");
    if (!(await rateLimit(c.env.DB, `insights:${T(c)}`, 4, 3_600_000))) return apiError(c, 429, "rate_limited", "حدّثت كثير — جرّب بعد شوي (4 مرات بالساعة)");
    const token = await getAccessToken(c.env, c.env.DB, account);
    if (!token) return apiError(c, 409, "no_token", "أعد ربط الحساب");
    const summary = await captureInsights(c.env.DB, metaClient(c.env), account, token, T(c), { left: 14 });
    return c.json({ ok: !summary.stopped || summary.stopped === "budget", summary });
  });
  // Owner: who is asked for the insights permission when connecting (it must be added to the Meta app first).
  api.put("/analytics/insights-scope", async (c) => {
    if (!c.get("session").is_owner) return apiError(c, 403, "owner_only", "هذا الإعداد متاح لإدارة الخدمة فقط");
    const p = await parseBody(c, z.object({ mode: z.enum(["off", "owner", "all"]) }));
    if (!p.ok) return p.res;
    await setSetting(c.env.DB, OWNER_TENANT, "insights_scope", p.data.mode);
    await audit(c.env.DB, T(c), c.get("session").username, "insights_scope.updated", undefined, p.data);
    return c.json({ ok: true });
  });
  api.put("/analytics/recheck", async (c) => {
    const p = await parseBody(c, z.object({ enabled: z.boolean(), days: z.number().int().min(1).max(90) }));
    if (!p.ok) return p.res;
    await setSetting(c.env.DB, T(c), "follow_recheck_enabled", p.data.enabled);
    await setSetting(c.env.DB, T(c), "follow_recheck_days", p.data.days);
    await audit(c.env.DB, T(c), c.get("session").username, "follow_recheck.updated", undefined, p.data);
    return c.json({ ok: true });
  });


  // ---- Scheduled publishing (official Content Publishing API; files in the private R2 bucket until published)
  const POST_EDITABLE = ["draft", "scheduled", "failed", "cancelled"];
  const schedAccount = async (c: C) =>
    first<{ id: number; scopes: string | null; status: string }>(c.env.DB, "SELECT id, scopes, status FROM instagram_accounts WHERE tenant_id = ? AND is_demo = 0 ORDER BY (status = 'active') DESC, id LIMIT 1", T(c));
  const ownPost = async (c: C) => {
    const id = idParam(c);
    return id ? first<any>(c.env.DB, "SELECT * FROM scheduled_posts WHERE id = ? AND tenant_id = ?", id, T(c)) : null;
  };
  const postBody = z.object({
    kind: z.enum(["IMAGE", "CAROUSEL", "REELS", "STORY"]),
    caption: z.string().max(LIMITS.captionChars).optional().nullable(),
    publish_at: z.number().int().positive(),
    share_to_feed: z.boolean().optional(),
    campaign_id: z.number().int().positive().optional().nullable(),
  });
  const checkCampaign = async (c: C, id: number | null | undefined) =>
    !id || !!(await first(c.env.DB, "SELECT id FROM campaigns WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL", id, T(c)));

  api.get("/schedule/meta", async (c) => {
    const a = await schedAccount(c);
    const e = await ENT(c);
    return c.json({
      plan: !!e.active && !!e.limits.scheduling,
      connected: !!a && a.status === "active",
      granted: !!a && hasPublishScope(a.scopes),
      requested: await wantsPublishScope(c.env.DB, T(c)),
      storage: !!c.env.MEDIA,
      limits: LIMITS,
      tz_offset_min: tzOffsetMinutes((await getSetting<string>(c.env.DB, T(c), "timezone", "Asia/Aden")) || "Asia/Aden"),
      scope_mode: c.get("session").is_owner ? await publishScopeMode(c.env.DB) : undefined,
    });
  });
  api.put("/schedule/scope", async (c) => {
    if (!c.get("session").is_owner) return apiError(c, 403, "owner_only", "هذا الإعداد متاح لإدارة الخدمة فقط");
    const p = await parseBody(c, z.object({ mode: z.enum(["off", "owner", "all"]) }));
    if (!p.ok) return p.res;
    await setSetting(c.env.DB, OWNER_TENANT, "publish_scope", p.data.mode);
    await audit(c.env.DB, T(c), c.get("session").username, "publish_scope.updated", undefined, p.data);
    return c.json({ ok: true });
  });
  api.get("/schedule", async (c) => {
    const blocked = await planBlock(c, "scheduling");
    if (blocked) return blocked;
    const from = Number(c.req.query("from")) || Date.now() - 31 * 86_400_000;
    const to = Number(c.req.query("to")) || Date.now() + 62 * 86_400_000;
    const items = await all<any>(
      c.env.DB,
      `SELECT p.id, p.kind, p.caption, p.publish_at, p.status, p.campaign_id, p.media_id, p.permalink, p.last_error, p.published_at, p.share_to_feed,
              (SELECT c2.name FROM campaigns c2 WHERE c2.id = p.campaign_id) AS campaign_name,
              (SELECT m.id FROM scheduled_media m WHERE m.post_id = p.id AND m.role = 'item' AND m.deleted_at IS NULL ORDER BY m.position LIMIT 1) AS thumb_id,
              (SELECT m.mime FROM scheduled_media m WHERE m.post_id = p.id AND m.role = 'item' ORDER BY m.position LIMIT 1) AS thumb_mime,
              (SELECT COUNT(*) FROM scheduled_media m WHERE m.post_id = p.id AND m.role = 'item') AS files,
              (SELECT mc.thumbnail_url FROM media_cache mc WHERE mc.media_id = p.media_id AND mc.account_id = p.account_id) AS published_thumb
         FROM scheduled_posts p WHERE p.tenant_id = ? AND p.publish_at >= ? AND p.publish_at < ? ORDER BY p.publish_at LIMIT 500`,
      T(c),
      from,
      to,
    );
    return c.json({ items });
  });
  api.get("/schedule/:id", async (c) => {
    const blocked = await planBlock(c, "scheduling");
    if (blocked) return blocked;
    const post = await ownPost(c);
    if (!post) return apiError(c, 404, "not_found", "المنشور غير موجود");
    post.campaign_name = post.campaign_id ? (await first<{ name: string }>(c.env.DB, "SELECT name FROM campaigns WHERE id = ? AND tenant_id = ?", post.campaign_id, T(c)))?.name ?? null : null;
    const [media, log] = await Promise.all([
      all(c.env.DB, "SELECT id, position, role, mime, size, width, height, deleted_at FROM scheduled_media WHERE post_id = ? ORDER BY role DESC, position", post.id),
      all(c.env.DB, "SELECT at, step, ok, detail FROM publish_log WHERE post_id = ? ORDER BY at, id LIMIT 200", post.id),
    ]);
    return c.json({ post, media, log });
  });
  api.post("/schedule", async (c) => {
    const blocked = await planBlock(c, "scheduling");
    if (blocked) return blocked;
    const p = await parseBody(c, postBody);
    if (!p.ok) return p.res;
    const a = await schedAccount(c);
    if (!a || a.status !== "active") return apiError(c, 409, "no_account", "اربط حساب إنستقرام أولًا");
    if (!hasPublishScope(a.scopes)) return apiError(c, 409, "no_permission", "صلاحية النشر غير مفعّلة على الحساب — أعد الربط ووافق عليها");
    if (!c.env.MEDIA) return apiError(c, 503, "no_storage", "مساحة حفظ الملفات غير مفعّلة على الخادم");
    if (!(await checkCampaign(c, p.data.campaign_id))) return apiError(c, 404, "campaign", "الحملة غير موجودة");
    if ((await first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM scheduled_posts WHERE tenant_id = ? AND status IN ('draft','scheduled','publishing','uncertain')", T(c)))!.n >= 100)
      return apiError(c, 409, "too_many", "عندك 100 منشور مجدول أو مسودة — احذف بعضها أولًا");
    const now = Date.now();
    const r = await first<{ id: number }>(
      c.env.DB,
      `INSERT INTO scheduled_posts (tenant_id, account_id, kind, caption, publish_at, status, share_to_feed, campaign_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?) RETURNING id`,
      T(c), a.id, p.data.kind, p.data.caption?.trim() || null, p.data.publish_at, p.data.share_to_feed === false ? 0 : 1, p.data.campaign_id ?? null, now, now,
    );
    return c.json({ id: r!.id });
  });
  api.patch("/schedule/:id", async (c) => {
    const blocked = await planBlock(c, "scheduling");
    if (blocked) return blocked;
    const post = await ownPost(c);
    if (!post) return apiError(c, 404, "not_found", "المنشور غير موجود");
    if (!POST_EDITABLE.includes(post.status)) return apiError(c, 409, "locked", "المنشور قيد النشر أو منشور — ما يتعدّل");
    const p = await parseBody(c, postBody.partial());
    if (!p.ok) return p.res;
    if (!(await checkCampaign(c, p.data.campaign_id))) return apiError(c, 404, "campaign", "الحملة غير موجودة");
    const d = p.data;
    await run(
      c.env.DB,
      `UPDATE scheduled_posts SET kind = COALESCE(?, kind), caption = CASE WHEN ? THEN ? ELSE caption END, publish_at = COALESCE(?, publish_at),
         share_to_feed = COALESCE(?, share_to_feed), campaign_id = CASE WHEN ? THEN ? ELSE campaign_id END,
         status = 'draft', updated_at = ? WHERE id = ?`,
      d.kind ?? null, d.caption !== undefined ? 1 : 0, d.caption?.trim() || null, d.publish_at ?? null,
      d.share_to_feed === undefined ? null : d.share_to_feed ? 1 : 0, d.campaign_id !== undefined ? 1 : 0, d.campaign_id ?? null, Date.now(), post.id,
    );
    return c.json({ ok: true });
  });
  // Raw file upload (body = the file). Images must already be JPEG (the app converts them before uploading).
  api.put("/schedule/:id/media", async (c) => {
    const blocked = await planBlock(c, "scheduling");
    if (blocked) return blocked;
    if (!c.env.MEDIA) return apiError(c, 503, "no_storage", "مساحة حفظ الملفات غير مفعّلة على الخادم");
    const post = await ownPost(c);
    if (!post) return apiError(c, 404, "not_found", "المنشور غير موجود");
    if (!POST_EDITABLE.includes(post.status)) return apiError(c, 409, "locked", "المنشور قيد النشر أو منشور — ما يتعدّل");
    const mime = (c.req.header("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
    const size = Number(c.req.header("Content-Length") ?? 0);
    if (!isImage(mime) && !isVideo(mime)) return apiError(c, 422, "type", "نوع ملف غير مدعوم: الصور JPEG والفيديو MP4");
    if (!size || size > (isVideo(mime) ? LIMITS.singleUploadBytes : LIMITS.imageBytes)) return apiError(c, 422, "size", isVideo(mime) ? "الفيديو كبير — يُرفع على أجزاء" : "الصورة أكبر من 8 ميجا");
    const role = c.req.query("role") === "cover" ? "cover" : "item";
    const count = (await first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM scheduled_media WHERE post_id = ? AND deleted_at IS NULL", post.id))!.n;
    if (count >= LIMITS.carouselMax + 1) return apiError(c, 409, "too_many", "وصلت للحد الأعلى من الملفات");
    if (!(await rateLimit(c.env.DB, `upload:${T(c)}`, 120, 3_600_000))) return apiError(c, 429, "rate_limited", "رفعت ملفات كثيرة — جرّب بعد شوي");
    const key = `t${T(c)}-p${post.id}-${randomToken(12)}.${isVideo(mime) ? (mime === "video/quicktime" ? "mov" : "mp4") : "jpg"}`;
    const body = c.req.raw.body;
    if (!body) return apiError(c, 400, "empty", "الملف فاضي");
    await c.env.MEDIA.put(key, body, { httpMetadata: { contentType: mime } });
    const pos = Number(c.req.query("position"));
    const r = await first<{ id: number }>(
      c.env.DB,
      "INSERT INTO scheduled_media (post_id, position, role, r2_key, mime, size, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
      post.id, Number.isFinite(pos) ? pos : count, role, key, mime, size, Number(c.req.query("w")) || null, Number(c.req.query("h")) || null, Date.now(),
    );
    await run(c.env.DB, "UPDATE scheduled_posts SET status = 'draft', updated_at = ? WHERE id = ? AND status != 'draft'", Date.now(), post.id);
    return c.json({ id: r!.id });
  });

  // Large videos (over the 100 MB request limit) go up in parts: start → parts (≤ 95 MB each) → complete.
  const partKeyOk = (c: C, postId: number, key: string) => new RegExp(`^t${T(c)}-p${postId}-[A-Za-z0-9_-]{8,40}\\.(mp4|mov)$`).test(key);
  api.post("/schedule/:id/media/multipart", async (c) => {
    const blocked = await planBlock(c, "scheduling");
    if (blocked) return blocked;
    if (!c.env.MEDIA) return apiError(c, 503, "no_storage", "مساحة حفظ الملفات غير مفعّلة على الخادم");
    const post = await ownPost(c);
    if (!post) return apiError(c, 404, "not_found", "المنشور غير موجود");
    if (!POST_EDITABLE.includes(post.status)) return apiError(c, 409, "locked", "المنشور قيد النشر أو منشور — ما يتعدّل");
    const p = await parseBody(c, z.object({ mime: z.enum(["video/mp4", "video/quicktime"]), size: z.number().int().positive() }));
    if (!p.ok) return p.res;
    const max = post.kind === "REELS" ? LIMITS.reelBytes : LIMITS.videoBytes;
    if (p.data.size > max) return apiError(c, 422, "size", post.kind === "REELS" ? "فيديو الريل أكبر من 300 ميجا (حد Meta)" : "الفيديو أكبر من 100 ميجا (حد Meta)");
    if (!(await rateLimit(c.env.DB, `upload:${T(c)}`, 120, 3_600_000))) return apiError(c, 429, "rate_limited", "رفعت ملفات كثيرة — جرّب بعد شوي");
    const key = `t${T(c)}-p${post.id}-${randomToken(12)}.${p.data.mime === "video/quicktime" ? "mov" : "mp4"}`;
    const up = await c.env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: p.data.mime } });
    return c.json({ key, upload_id: up.uploadId, part_bytes: LIMITS.partBytes });
  });
  api.put("/schedule/:id/media/multipart/part", async (c) => {
    if (!c.env.MEDIA) return apiError(c, 503, "no_storage", "مساحة حفظ الملفات غير مفعّلة على الخادم");
    const post = await ownPost(c);
    const key = c.req.query("key") ?? "";
    const n = Number(c.req.query("n"));
    const size = Number(c.req.header("Content-Length") ?? 0);
    if (!post || !partKeyOk(c, post.id, key) || !(n >= 1 && n <= 100)) return apiError(c, 404, "not_found", "الرفع غير موجود");
    if (!size || size > LIMITS.singleUploadBytes || !c.req.raw.body) return apiError(c, 422, "size", "جزء غير صالح");
    const part = await c.env.MEDIA.resumeMultipartUpload(key, c.req.query("upload_id") ?? "").uploadPart(n, c.req.raw.body);
    return c.json({ n: part.partNumber, etag: part.etag });
  });
  api.post("/schedule/:id/media/multipart/complete", async (c) => {
    if (!c.env.MEDIA) return apiError(c, 503, "no_storage", "مساحة حفظ الملفات غير مفعّلة على الخادم");
    const post = await ownPost(c);
    const p = await parseBody(c, z.object({
      key: z.string().max(120), upload_id: z.string().min(1).max(2000), parts: z.array(z.object({ n: z.number().int().min(1).max(100), etag: z.string().min(1).max(200) })).min(1).max(100),
      position: z.number().int().min(0).max(20).optional(), w: z.number().int().optional(), h: z.number().int().optional(),
    }));
    if (!p.ok) return p.res;
    if (!post || !partKeyOk(c, post.id, p.data.key)) return apiError(c, 404, "not_found", "الرفع غير موجود");
    if (!POST_EDITABLE.includes(post.status)) return apiError(c, 409, "locked", "المنشور قيد النشر أو منشور — ما يتعدّل");
    const up = c.env.MEDIA.resumeMultipartUpload(p.data.key, p.data.upload_id);
    const obj = await up.complete(p.data.parts.map((x) => ({ partNumber: x.n, etag: x.etag })));
    const max = post.kind === "REELS" ? LIMITS.reelBytes : LIMITS.videoBytes;
    if (obj.size > max) {
      await c.env.MEDIA.delete(p.data.key);
      return apiError(c, 422, "size", "الفيديو أكبر من حد Meta");
    }
    const count = (await first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM scheduled_media WHERE post_id = ? AND deleted_at IS NULL", post.id))!.n;
    const r = await first<{ id: number }>(
      c.env.DB,
      "INSERT INTO scheduled_media (post_id, position, role, r2_key, mime, size, width, height, created_at) VALUES (?, ?, 'item', ?, ?, ?, ?, ?, ?) RETURNING id",
      post.id, p.data.position ?? count, p.data.key, obj.httpMetadata?.contentType ?? "video/mp4", obj.size, p.data.w ?? null, p.data.h ?? null, Date.now(),
    );
    await run(c.env.DB, "UPDATE scheduled_posts SET status = 'draft', updated_at = ? WHERE id = ? AND status != 'draft'", Date.now(), post.id);
    return c.json({ id: r!.id });
  });
  // Preview of an uploaded file for its owner (the bucket is private).
  api.get("/schedule/media/:mid", async (c) => {
    const mid = Number(c.req.param("mid"));
    const m = mid ? await first<{ r2_key: string }>(c.env.DB, "SELECT m.r2_key FROM scheduled_media m JOIN scheduled_posts p ON p.id = m.post_id WHERE m.id = ? AND p.tenant_id = ? AND m.deleted_at IS NULL", mid, T(c)) : null;
    const obj = m && c.env.MEDIA ? await c.env.MEDIA.get(m.r2_key) : null;
    if (!obj) return c.text("not found", 404);
    return new Response(obj.body, { headers: { "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream", "Cache-Control": "private, max-age=600" } });
  });
  api.delete("/schedule/:id/media/:mid", async (c) => {
    const post = await ownPost(c);
    if (!post) return apiError(c, 404, "not_found", "المنشور غير موجود");
    if (!POST_EDITABLE.includes(post.status)) return apiError(c, 409, "locked", "المنشور قيد النشر أو منشور — ما يتعدّل");
    const m = await first<{ id: number; r2_key: string }>(c.env.DB, "SELECT id, r2_key FROM scheduled_media WHERE id = ? AND post_id = ?", Number(c.req.param("mid")), post.id);
    if (!m) return apiError(c, 404, "not_found", "الملف غير موجود");
    await c.env.MEDIA?.delete(m.r2_key).catch(() => undefined);
    await run(c.env.DB, "DELETE FROM scheduled_media WHERE id = ?", m.id);
    await run(c.env.DB, "UPDATE scheduled_posts SET status = 'draft', updated_at = ? WHERE id = ?", Date.now(), post.id);
    return c.json({ ok: true });
  });
  // Draft → scheduled, after the same checks Meta applies (type, count, JPEG, sizes, caption).
  api.post("/schedule/:id/submit", async (c) => {
    const blocked = await planBlock(c, "scheduling");
    if (blocked) return blocked;
    const post = await ownPost(c);
    if (!post) return apiError(c, 404, "not_found", "المنشور غير موجود");
    if (!POST_EDITABLE.includes(post.status)) return apiError(c, 409, "locked", "المنشور قيد النشر أو منشور");
    const a = await schedAccount(c);
    if (!a || a.status !== "active" || !hasPublishScope(a.scopes)) return apiError(c, 409, "no_permission", "صلاحية النشر غير مفعّلة على الحساب — أعد الربط ووافق عليها");
    const media = await all<any>(c.env.DB, "SELECT role, mime, size FROM scheduled_media WHERE post_id = ? AND deleted_at IS NULL", post.id);
    const err = validatePost({ kind: post.kind as PostKind, caption: post.caption, publish_at: post.publish_at }, media);
    if (err) return apiError(c, 422, "validation", err);
    await run(
      c.env.DB,
      `UPDATE scheduled_posts SET status = 'scheduled', account_id = ?, container_id = NULL, children = NULL, publish_requested_at = NULL, attempts = 0,
         next_attempt_at = NULL, last_error = NULL, updated_at = ? WHERE id = ?`,
      a.id, Date.now(), post.id,
    );
    await audit(c.env.DB, T(c), c.get("session").username, "schedule.scheduled", String(post.id), { kind: post.kind, publish_at: post.publish_at });
    return c.json({ ok: true });
  });
  api.post("/schedule/:id/cancel", async (c) => {
    const post = await ownPost(c);
    if (!post) return apiError(c, 404, "not_found", "المنشور غير موجود");
    if (post.publish_requested_at || ["published", "uncertain"].includes(post.status)) return apiError(c, 409, "locked", "طلب النشر انرسل لـ Meta — ما نقدر نلغيه");
    await run(c.env.DB, "UPDATE scheduled_posts SET status = 'cancelled', next_attempt_at = NULL, updated_at = ? WHERE id = ?", Date.now(), post.id);
    await audit(c.env.DB, T(c), c.get("session").username, "schedule.cancelled", String(post.id));
    return c.json({ ok: true });
  });
  api.delete("/schedule/:id", async (c) => {
    const post = await ownPost(c);
    if (!post) return apiError(c, 404, "not_found", "المنشور غير موجود");
    if (["publishing", "uncertain"].includes(post.status)) return apiError(c, 409, "locked", "المنشور قيد النشر — انتظر لين يخلص");
    await removeFiles({ db: c.env.DB, now: () => Date.now(), deleteObject: c.env.MEDIA ? (k) => c.env.MEDIA!.delete(k) : undefined }, post.id);
    await run(c.env.DB, "DELETE FROM scheduled_posts WHERE id = ?", post.id);
    await audit(c.env.DB, T(c), c.get("session").username, "schedule.deleted", String(post.id));
    return c.json({ ok: true });
  });


  // ---- Online store (Salla): connect, products, store analytics
  const publicStore = (s: any) => s && { id: s.id, platform: s.platform, name: s.name, domain: s.domain, avatar_url: s.avatar_url, status: s.status, last_error: s.last_error, products_synced_at: s.products_synced_at, connected_at: s.connected_at };
  api.get("/stores", async (c) => {
    const rows = await all(c.env.DB, "SELECT * FROM stores WHERE tenant_id = ? AND status != 'disconnected' ORDER BY id DESC", T(c));
    const e = await ENT(c);
    return c.json({ stores: rows.map(publicStore), salla_configured: sallaConfigured(c.env), plan: !!e.active && !!e.limits.store });
  });
  api.post("/stores/salla/connect", async (c) => {
    const blocked = await planBlock(c, "store");
    if (blocked) return blocked;
    if (!sallaConfigured(c.env)) return apiError(c, 503, "not_configured", "ربط سلة غير مفعّل على الخادم بعد");
    const p = await parseBody(c, z.object({ client: z.enum(["web", "app"]).default("web") }));
    if (!p.ok) return p.res;
    const state = randomToken(32);
    const now = Date.now();
    await run(c.env.DB, "DELETE FROM store_oauth_states WHERE expires_at < ?", now);
    await run(
      c.env.DB,
      "INSERT INTO store_oauth_states (state_hash, tenant_id, user_id, platform, client, created_at, expires_at) VALUES (?, ?, ?, 'salla', ?, ?, ?)",
      await sha256Hex(state),
      T(c),
      c.get("session").user_id,
      p.data.client,
      now,
      now + 15 * 60_000,
    );
    return c.json({ url: sallaAuthorizeUrl(c.env, state) });
  });
  // Finish a store installed from Salla's side: the one-time token from the callback ties it to this customer.
  api.post("/stores/claim", async (c) => {
    const blocked = await planBlock(c, "store");
    if (blocked) return blocked;
    const p = await parseBody(c, z.object({ token: z.string().min(16).max(80) }));
    if (!p.ok) return p.res;
    const now = Date.now();
    const st = await first<{ user_id: number }>(
      c.env.DB,
      "UPDATE store_oauth_states SET used_at = ? WHERE state_hash = ? AND platform = 'salla_claim' AND used_at IS NULL AND expires_at > ? RETURNING user_id",
      now,
      await sha256Hex(p.data.token),
      now,
    );
    if (!st || !(await claimStore(c.env, st.user_id, T(c), now))) return apiError(c, 404, "not_found", "رابط إكمال الربط غير صالح أو منتهي — ابدأ الربط من جديد");
    return c.json({ ok: true });
  });
  api.post("/stores/:id/sync", async (c) => {
    const id = idParam(c);
    const s = id && (await first<{ id: number }>(c.env.DB, "SELECT id FROM stores WHERE id = ? AND tenant_id = ? AND status = 'active'", id, T(c)));
    if (!s) return apiError(c, 404, "not_found", "المتجر غير موجود");
    if (!(await rateLimit(c.env.DB, `store_sync:${T(c)}`, 6, 3_600_000))) return apiError(c, 429, "rate_limited", "حدّثت كثير — جرّب بعد شوي");
    return c.json({ ok: true, products: await syncProducts(c.env, s.id) });
  });
  api.delete("/stores/:id", async (c) => {
    const id = idParam(c);
    const s = id && (await first<{ id: number; merchant_id: string }>(c.env.DB, "SELECT id, merchant_id FROM stores WHERE id = ? AND tenant_id = ?", id, T(c)));
    if (!s) return apiError(c, 404, "not_found", "المتجر غير موجود");
    await run(c.env.DB, "UPDATE stores SET status = 'disconnected', token_ciphertext = NULL, token_iv = NULL, refresh_ciphertext = NULL, refresh_iv = NULL, updated_at = ? WHERE id = ?", Date.now(), s.id);
    await audit(c.env.DB, T(c), c.get("session").username, "store.disconnected", s.merchant_id);
    return c.json({ ok: true });
  });
  api.get("/store/products", async (c) => c.json({ items: await storeProducts(c.env.DB, T(c)) }));
  // ---- Growth: posts by sales, best time to post, weekly report
  api.get("/growth/posts", async (c) => {
    const blocked = await planBlock(c, "campaign_stats");
    if (blocked) return blocked;
    const f = await analyticsFilter(c);
    if (!f) return apiError(c, 422, "validation", "فترة غير صحيحة");
    return c.json({ generated_at: Date.now(), ...(await postSales(c.env.DB, T(c), f, { storeOnly: c.req.query("store_only") === "1" })) });
  });
  api.get("/growth/best-times", async (c) => {
    const tz = await getSetting<string>(c.env.DB, T(c), "timezone", "Asia/Aden");
    return c.json(await bestTimes(c.env.DB, T(c), tzOffsetMinutes(tz || "Asia/Aden")));
  });
  api.get("/growth/weekly", async (c) => {
    const blocked = await planBlock(c, "campaign_stats");
    if (blocked) return blocked;
    const tz = await getSetting<string>(c.env.DB, T(c), "timezone", "Asia/Aden");
    return c.json({ generated_at: Date.now(), timezone: tz, ...(await weeklyReport(c.env.DB, T(c), tzOffsetMinutes(tz || "Asia/Aden"))) });
  });
  api.get("/store/campaigns/:id", async (c) => {
    const blocked = await planBlock(c, "store");
    if (blocked) return blocked;
    const id = idParam(c);
    const f = await analyticsFilter(c);
    if (!id || !f) return apiError(c, 422, "validation", "طلب غير صحيح");
    const d = await storeCampaignDetail(c.env.DB, T(c), id, f);
    if (!d) return apiError(c, 404, "not_found", "الحملة غير موجودة");
    return c.json({ generated_at: Date.now(), filter: { from: f.from, to: f.to, tz_offset_min: f.tzOffsetMin }, ...d });
  });
  // Product costs for profit: per product (entered here wins over Salla's cost price) and a default % of the price.
  api.get("/store/costs", async (c) => {
    const s = await first<{ default_cost_pct: number | null }>(c.env.DB, "SELECT default_cost_pct FROM stores WHERE tenant_id = ? AND status != 'disconnected' ORDER BY id DESC LIMIT 1", T(c));
    return c.json({ default_pct: s?.default_cost_pct ?? null, items: await storeProductCosts(c.env.DB, T(c)) });
  });
  api.put("/store/costs", async (c) => {
    const blocked = await planBlock(c, "store");
    if (blocked) return blocked;
    const p = await parseBody(
      c,
      z.object({
        default_pct: z.number().min(0).max(100).nullable().optional(),
        items: z.array(z.object({ product_id: z.string().min(1).max(64), cost: z.number().min(0).max(10_000_000).nullable() })).max(1000).optional(),
      }),
    );
    if (!p.ok) return p.res;
    const s = await first<{ id: number }>(c.env.DB, "SELECT id FROM stores WHERE tenant_id = ? AND status != 'disconnected' ORDER BY id DESC LIMIT 1", T(c));
    if (!s) return apiError(c, 404, "not_found", "ما فيه متجر مربوط");
    const now = Date.now();
    const stmts: D1PreparedStatement[] = [];
    if (p.data.default_pct !== undefined) stmts.push(c.env.DB.prepare("UPDATE stores SET default_cost_pct = ?, updated_at = ? WHERE id = ?").bind(p.data.default_pct, now, s.id));
    for (const i of p.data.items ?? []) stmts.push(c.env.DB.prepare("UPDATE store_products SET cost_manual = ? WHERE store_id = ? AND product_id = ?").bind(i.cost, s.id, i.product_id));
    if (stmts.length) await c.env.DB.batch(stmts);
    await audit(c.env.DB, T(c), c.get("session").username, "store.costs", String(s.id), { items: p.data.items?.length ?? 0, default_pct: p.data.default_pct });
    return c.json({ ok: true });
  });
  api.get("/store/analytics", async (c) => {
    const blocked = await planBlock(c, "store");
    if (blocked) return blocked;
    const f = await analyticsFilter(c);
    if (!f) return apiError(c, 422, "validation", "فترة غير صحيحة");
    return c.json({ generated_at: Date.now(), filter: { from: f.from, to: f.to, tz_offset_min: f.tzOffsetMin }, ...(await storeAnalytics(c.env.DB, T(c), f)) });
  });

  api.get("/campaigns/:id/people", async (c) => {
    const blocked = await planBlock(c, "campaign_stats");
    if (blocked) return blocked;
    const id = idParam(c);
    const campaign = id && (await first(c.env.DB, "SELECT id FROM campaigns WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL", id, T(c)));
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
              (SELECT fc.result FROM follow_checks fc WHERE fc.flow_id = f.id AND fc.result IN ('following','not_following') ORDER BY fc.id LIMIT 1) AS first_follow,
             EXISTS (SELECT 1 FROM follow_checks fc WHERE fc.flow_id = f.id AND fc.result <> 'needs_interaction') AS checked,
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
      p.interacted ||= !!r.checked;
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
    // Plan: features the plan does not include are saved switched off (with a note).
    const ent = await ENT(c);
    if (d.public_reply_enabled && !ent.limits.public_reply) {
      d.public_reply_enabled = false;
      warnings.push("الرد العام غير متاح في باقتك — حُفظت الحملة بدونه.");
    }
    if (d.track_clicks && !ent.limits.link_tracking) d.track_clicks = false;
    if (d.require_follow && !(await followGateAllowed(c.env.DB, T(c)))) {
      warnings.push("شرط المتابعة غير مسموح لهذا الحساب — حُفظت الحملة بدونه. يمكنك إضافة دعوة اختيارية للمتابعة.");
    }
    if (d.require_follow && d.public_reply_enabled && publicReplyVariants(d.public_reply_text).some((v) => claimsDelivery(v))) {
      warnings.push("بعض صيغ الرد العام تدّعي الإرسال قبل التسليم الفعلي؛ لن تُستخدم قبل التسليم (تُستخدم الصيغ الأخرى أو صيغ محايدة تلقائيًا).");
    }
    if (d.follow_invite && d.follow_invite_text && claimsFollowRequired(d.follow_invite_text)) {
      warnings.push("نص الدعوة يوحي أن المتابعة شرط للحصول على المحتوى — سياسة Meta تمنع ذلك. اجعلها دعوة اختيارية (المحتوى يُرسل للجميع).");
    }
    const cols = {
      name: d.name, type: d.type, priority: d.priority, scope: d.scope, match_all: d.match_all ? 1 : 0, unify_alef: d.unify_alef ? 1 : 0,
      // The follow requirement only on accounts the owner allowed (Meta Spam policy); others get the optional invitation.
      include_replies: d.include_replies ? 1 : 0, require_follow: d.require_follow && (await followGateAllowed(c.env.DB, T(c))) ? 1 : 0, follow_invite: d.follow_invite ? 1 : 0, follow_invite_text: d.follow_invite_text ?? null,
      opening_text: d.opening_text ?? null,
      follow_request_text: d.follow_request_text ?? null, follow_reminder_text: d.follow_reminder_text ?? null, verify_error_text: d.verify_error_text ?? null,
      final_text: d.final_text, final_url: d.final_url || null, public_reply_enabled: d.public_reply_enabled ? 1 : 0, public_reply_text: d.public_reply_text ?? null,
      public_reply_on_dm_fail: d.public_reply_on_dm_fail, public_reply_fallback_text: d.public_reply_fallback_text ?? null,
      schedule_start: d.schedule_start ?? null, schedule_end: d.schedule_end ?? null, timezone: d.timezone,
      per_user_cooldown_hours: d.per_user_cooldown_hours, max_deliveries_per_user: d.max_deliveries_per_user,
      max_verify_attempts: d.max_verify_attempts, verify_cooldown_seconds: d.verify_cooldown_seconds, process_old_events: d.process_old_events ? 1 : 0,
      track_clicks: d.track_clicks ? 1 : 0, follow_reminder_minutes: d.follow_reminder_minutes,
      auto_new_media: d.auto_new_media && d.type === "comment" ? 1 : 0, auto_new_reels_only: d.auto_new_reels_only ? 1 : 0,
      store_coupon: d.store_coupon ? d.store_coupon.toUpperCase() : null,
      stock_action: d.stock_action ?? "notify",
      utm: d.utm === false ? 0 : 1,
      out_of_stock_text: d.out_of_stock_text || null,
      // "New posts from now on": the starting point is kept once set (or taken from the request), else it is now.
      auto_new_since: d.auto_new_media && d.type === "comment"
        ? d.auto_new_since ?? (id !== null ? (await first<{ v: number | null }>(c.env.DB, "SELECT auto_new_since AS v FROM campaigns WHERE id = ? AND tenant_id = ?", id, T(c)))?.v : null) ?? now
        : null,
    };
    // A campaign for a scheduled post: the post must be the customer's and not live yet; the post's id is attached
    // when it is published (see services/publish.ts).
    const forPost = d.for_scheduled_post
      ? await first<{ id: number }>(c.env.DB, "SELECT id FROM scheduled_posts WHERE id = ? AND tenant_id = ? AND status IN ('draft','scheduled','failed','cancelled') AND kind != 'STORY'", d.for_scheduled_post, T(c))
      : null;
    if (d.for_scheduled_post && !forPost) return apiError(c, 404, "post", "المنشور المجدول غير موجود أو انتشر");
    if (forPost) {
      cols.type = "comment";
      cols.scope = "selected";
    }
    const keys = Object.keys(cols);
    const before = id !== null ? await campaignSnapshot(c.env.DB, id) : null;
    let campaignId: number;
    if (id === null) {
      const r = await first<{ id: number }>(
        c.env.DB,
        `INSERT INTO campaigns (${keys.join(",")}, tenant_id, status, created_at, updated_at) VALUES (${keys.map(() => "?").join(",")}, ?, 'draft', ?, ?) RETURNING id`,
        ...Object.values(cols),
        T(c),
        now,
        now,
      );
      campaignId = r!.id;
    } else {
      const exists = await first<{ id: number; final_url: string | null }>(c.env.DB, "SELECT id, final_url FROM campaigns WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL", id, T(c));
      if (!exists) return apiError(c, 404, "not_found", "الحملة غير موجودة");
      const prevUrl = exists.final_url;
      await run(c.env.DB, `UPDATE campaigns SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ? AND tenant_id = ?`, ...Object.values(cols), now, id, T(c));
      // Another product (or none): the old product's stock state no longer applies.
      await run(c.env.DB, "UPDATE campaigns SET stock_out_at = NULL, stock_paused = 0 WHERE id = ? AND tenant_id = ? AND stock_out_at IS NOT NULL AND COALESCE(final_url, '') != ?", id, T(c), prevUrl ?? "");
      campaignId = id;
    }
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM campaign_keywords WHERE campaign_id = ?").bind(campaignId),
      c.env.DB.prepare("DELETE FROM campaign_media WHERE campaign_id = ?").bind(campaignId),
      ...d.keywords.map((k) => c.env.DB.prepare("INSERT INTO campaign_keywords (campaign_id, keyword, kind, match_type) VALUES (?, ?, ?, ?)").bind(campaignId, k.keyword, k.kind, k.match_type)),
      ...[...new Set(d.media_ids)].map((m) => c.env.DB.prepare("INSERT INTO campaign_media (campaign_id, media_id) VALUES (?, ?)").bind(campaignId, m)),
    ]);
    if (forPost) await run(c.env.DB, "UPDATE scheduled_posts SET campaign_id = ?, updated_at = ? WHERE id = ? AND tenant_id = ?", campaignId, now, forPost.id, T(c));
    await audit(c.env.DB, T(c), c.get("session").username, id ? "campaign.updated" : "campaign.created", String(campaignId));
    if (before) await recordUndo(c.env.DB, T(c), c.get("session").username, "campaign.update", `campaign:${campaignId}`, `تعديل الحملة «${before.row.name}»`, before);
    else await recordUndo(c.env.DB, T(c), c.get("session").username, "campaign.create", `campaign:${campaignId}`, `إنشاء الحملة «${d.name}»`, { id: campaignId });
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
    const src = id && (await first<Record<string, unknown>>(c.env.DB, "SELECT * FROM campaigns WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL", id, T(c)));
    if (!src) return apiError(c, 404, "not_found", "الحملة غير موجودة");
    const now = Date.now();
    if (p.data.activate) {
      const blocked = await activationBlock(c, String(src.type), null);
      if (blocked) return blocked;
    }
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
    await audit(c.env.DB, T(c), c.get("session").username, "campaign.duplicated", String(r!.id), { from: id, activate: p.data.activate });
    await recordUndo(c.env.DB, T(c), c.get("session").username, "campaign.duplicate", `campaign:${r!.id}`, `نسخ الحملة «${name}»`, { id: r!.id });
    return c.json({ id: r!.id, status });
  });

  api.post("/campaigns/:id/status", async (c) => {
    const id = idParam(c);
    const p = await parseBody(c, z.object({ status: z.enum(["active", "paused", "archived", "draft"]) }));
    if (!p.ok) return p.res;
    const row = id && (await first<{ status: string; activated_at: number | null; name: string; type: string }>(c.env.DB, "SELECT status, activated_at, name, type FROM campaigns WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL", id, T(c)));
    if (!row) return apiError(c, 404, "not_found", "الحملة غير موجودة");
    if (p.data.status === "active" && row.status !== "active") {
      const blocked = await activationBlock(c, row.type, id!);
      if (blocked) return blocked;
    }
    const now = Date.now();
    // activated_at is reset on every (re)activation so events that arrived while paused are not replayed.
    await run(
      c.env.DB,
      "UPDATE campaigns SET status = ?, activated_at = CASE WHEN ? = 'active' AND status != 'active' THEN ? ELSE activated_at END, updated_at = ? WHERE id = ? AND tenant_id = ?",
      p.data.status,
      p.data.status,
      now,
      now,
      id,
      T(c),
    );
    let cancelled = 0;
    if (p.data.status !== "active") cancelled = await stopCampaignWork(c.env.DB, id!, now, "campaign_" + p.data.status);
    await audit(c.env.DB, T(c), c.get("session").username, `campaign.${p.data.status}`, String(id), { cancelled });
    if (row.status !== p.data.status) {
      const word = { active: "تفعيل", paused: "إيقاف", archived: "أرشفة", draft: "إرجاع لمسودة" }[p.data.status];
      await recordUndo(c.env.DB, T(c), c.get("session").username, "campaign.status", `campaign:${id}`, `${word} الحملة «${row.name}»`, { id, status: row.status });
    }
    return c.json({ ok: true, cancelled_jobs: cancelled });
  });

  api.delete("/campaigns/:id", async (c) => {
    const id = idParam(c);
    if (!id) return apiError(c, 404, "not_found", "غير موجود");
    const prev = await first<{ name: string; status: string }>(c.env.DB, "SELECT name, status FROM campaigns WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL", id, T(c));
    if (!prev) return apiError(c, 404, "not_found", "الحملة غير موجودة");
    const now = Date.now();
    await run(c.env.DB, "UPDATE campaigns SET deleted_at = ?, status = 'archived', updated_at = ? WHERE id = ? AND tenant_id = ?", now, now, id, T(c));
    const cancelled = await stopCampaignWork(c.env.DB, id, now, "campaign_deleted");
    await audit(c.env.DB, T(c), c.get("session").username, "campaign.deleted", String(id));
    await recordUndo(c.env.DB, T(c), c.get("session").username, "campaign.delete", `campaign:${id}`, `حذف الحملة «${prev.name}»`, { id, status: prev.status });
    return c.json({ ok: true, cancelled_jobs: cancelled });
  });

  // ---- Templates
  api.get("/templates", async (c) => c.json(await all(c.env.DB, "SELECT * FROM templates WHERE tenant_id = ? ORDER BY kind, id", T(c))));
  api.post("/templates", async (c) => {
    const p = await parseBody(c, templateInputSchema);
    if (!p.ok) return p.res;
    const now = Date.now();
    const r = await first<{ id: number }>(c.env.DB, "INSERT INTO templates (tenant_id, kind, name, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id", T(c), p.data.kind, p.data.name, p.data.body, now, now);
    await recordUndo(c.env.DB, T(c), c.get("session").username, "template.create", `template:${r!.id}`, `إضافة القالب «${p.data.name}»`, { id: r!.id });
    return c.json(r);
  });
  api.put("/templates/:id", async (c) => {
    const p = await parseBody(c, templateInputSchema);
    if (!p.ok) return p.res;
    const prev = await first<Record<string, unknown>>(c.env.DB, "SELECT * FROM templates WHERE id = ? AND tenant_id = ?", idParam(c), T(c));
    if (!prev) return apiError(c, 404, "not_found", "القالب غير موجود");
    await run(c.env.DB, "UPDATE templates SET kind = ?, name = ?, body = ?, updated_at = ? WHERE id = ? AND tenant_id = ?", p.data.kind, p.data.name, p.data.body, Date.now(), idParam(c), T(c));
    await recordUndo(c.env.DB, T(c), c.get("session").username, "template.update", `template:${prev.id}`, `تعديل القالب «${prev.name}»`, { row: prev });
    return c.json({ ok: true });
  });
  api.delete("/templates/:id", async (c) => {
    const prev = await first<Record<string, unknown>>(c.env.DB, "SELECT * FROM templates WHERE id = ? AND tenant_id = ?", idParam(c), T(c));
    if (!prev) return c.json({ ok: true });
    await run(c.env.DB, "DELETE FROM templates WHERE id = ? AND tenant_id = ?", prev.id, T(c));
    await recordUndo(c.env.DB, T(c), c.get("session").username, "template.delete", `template:${prev.id}`, `حذف القالب «${prev.name}»`, { row: prev });
    return c.json({ ok: true });
  });

  // ---- Simulation (demo mode: never sends anything to Instagram)
  api.post("/simulate", async (c) => {
    const blocked = await planBlock(c, "simulator");
    if (blocked) return blocked;
    const p = await parseBody(c, simulateSchema);
    if (!p.ok) return p.res;
    return c.json(await simulate(c.env, T(c), p.data));
  });

  // ---- Logs
  api.get("/logs/events", async (c) => {
    const { where, params } = logFilters(c, "received_at", ["status", "event_type"], "", `account_ig_id IN ${TENANT_IG_IDS}`);
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
    const { where, params } = logFilters(c, "created_at", ["status", "kind"], "", `account_id IN ${TENANT_ACCOUNTS}`);
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
    const { where, params } = logFilters(c, "f.created_at", ["state"], "f.", `f.account_id IN ${TENANT_ACCOUNTS}`);
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
    const flow = id && (await first<any>(c.env.DB, `SELECT f.*, p.username, p.igsid FROM conversation_flows f JOIN participants p ON p.id = f.participant_id WHERE f.id = ? AND f.account_id IN ${TENANT_ACCOUNTS}`, id, T(c)));
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
    const job = id && (await first<any>(c.env.DB, `SELECT * FROM action_jobs WHERE id = ? AND status = 'uncertain' AND account_id IN ${TENANT_ACCOUNTS}`, id, T(c)));
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
    await audit(c.env.DB, T(c), c.get("session").username, "job.resolve", String(id), p.data);
    return c.json({ ok: true });
  });

  api.get("/logs/export", async (c) => {
    const blocked = await planBlock(c, "csv_export");
    if (blocked) return blocked;
    const type = c.req.query("type") ?? "events";
    let headers: string[];
    let rows: any[];
    if (type === "jobs") {
      headers = ["id", "kind", "purpose", "flow_id", "campaign_id", "status", "attempts", "last_error", "is_demo", "created_at"];
      rows = await all(c.env.DB, `SELECT ${headers.join(",")} FROM action_jobs WHERE account_id IN ${TENANT_ACCOUNTS} ORDER BY id DESC LIMIT 5000`, T(c));
    } else if (type === "flows") {
      headers = ["id", "campaign_id", "username", "state", "state_reason", "private_reply_status", "public_reply_status", "content_status", "verify_attempts", "last_follow_result", "is_demo", "created_at"];
      rows = await all(c.env.DB, `SELECT f.id, f.campaign_id, p.username, f.state, f.state_reason, f.private_reply_status, f.public_reply_status, f.content_status, f.verify_attempts, f.last_follow_result, f.is_demo, f.created_at FROM conversation_flows f JOIN participants p ON p.id = f.participant_id WHERE f.account_id IN ${TENANT_ACCOUNTS} ORDER BY f.id DESC LIMIT 5000`, T(c));
    } else {
      headers = ["id", "event_type", "sender_username", "text", "status", "reason", "campaign_id", "is_demo", "received_at"];
      rows = await all(c.env.DB, `SELECT ${headers.join(",")} FROM webhook_events WHERE account_ig_id IN ${TENANT_IG_IDS} ORDER BY id DESC LIMIT 5000`, T(c));
    }
    for (const r of rows) for (const k of Object.keys(r)) if (k.endsWith("_at") && typeof r[k] === "number") r[k] = new Date(r[k]).toISOString();
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="hsn-${type}-${new Date().toISOString().slice(0, 10)}.csv"`);
    return c.body(toCsv(headers, rows));
  });

  api.get("/undo", async (c) => {
    const blocked = await planBlock(c, "undo");
    if (blocked) return blocked;
    return c.json(await listUndo(c.env.DB, T(c)));
  });
  api.post("/undo/:id", async (c) => {
    const blocked = await planBlock(c, "undo");
    if (blocked) return blocked;
    const id = idParam(c);
    if (!id) return apiError(c, 404, "not_found", "غير موجود");
    try {
      const r = await undoOperation(c.env.DB, T(c), id, c.get("session").username);
      await audit(c.env.DB, T(c), c.get("session").username, "undo", String(id), { label: r.label });
      return c.json({ ok: true, ...r });
    } catch (e) {
      if (e instanceof UndoError) return apiError(c, 409, e.code, e.message);
      throw e;
    }
  });
  api.get("/audit", async (c) => c.json(await all(c.env.DB, "SELECT * FROM audit_logs WHERE tenant_id = ? ORDER BY id DESC LIMIT 200", T(c))));

  // ---- Daily usage (estimate) and recovery of missed comments
  api.get("/usage", async (c) => {
    // The platform-wide Cloudflare estimate concerns the owner only.
    const [usage, recover_last, auto_recover] = await Promise.all([
      c.get("session").is_owner ? estimateUsage(c.env.DB) : Promise.resolve(null),
      getSetting<Record<string, unknown> | null>(c.env.DB, T(c), "recover_last", null),
      getSetting(c.env.DB, T(c), "auto_recover_comments", true),
    ]);
    return c.json({ usage, recover_last, auto_recover });
  });
  api.post("/recover", async (c) => {
    const blocked = await planBlock(c, "recover");
    if (blocked) return blocked;
    if (!(await rateLimit(c.env.DB, `recover:${c.get("session").username}`, 6, 3_600_000))) return apiError(c, 429, "rate_limited", "انتظر قليلًا قبل تشغيل الاسترجاع مرة أخرى");
    let used = 0;
    const ctx = engineContext(c.env, () => used++);
    const r = await recoverMissedComments(ctx, T(c), { maxMedia: 15 });
    await setSetting(c.env.DB, T(c), "recover_last", { at: Date.now(), ...r, auto: false });
    await audit(c.env.DB, T(c), c.get("session").username, "comments.recovered", undefined, r);
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
         LEFT JOIN media_cache m ON m.media_id = e.media_id AND m.account_id IN (SELECT id FROM instagram_accounts WHERE ig_user_id = e.account_ig_id)
        WHERE e.account_ig_id IN ${TENANT_IG_IDS} AND e.recovered = 1 AND e.is_demo = 0 AND e.received_at > ?
        ORDER BY e.id DESC LIMIT 200`,
      T(c),
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
    const acc = await currentAccount(c.env.DB, T(c));
    if (!acc || acc.status !== "active") throw new DrawFailure(409, "no_account", "اربط حساب إنستقرام أولًا");
    if (d.source_type === "story") {
      const id = d.media_id;
      if (!id) throw new DrawFailure(422, "validation", "اختر الستوري");
      const cached = await first<any>(c.env.DB, "SELECT media_id, caption, permalink, thumbnail_url FROM media_cache WHERE account_id = ? AND media_id = ? AND kind = 'story'", acc.id, id);
      const seen = await first(c.env.DB, "SELECT 1 AS ok FROM webhook_events WHERE event_type = 'story_reply' AND is_demo = 0 AND media_id = ? AND account_ig_id = ? LIMIT 1", id, acc.ig_user_id);
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
         FROM draws d LEFT JOIN campaigns c ON c.id = d.campaign_id WHERE d.tenant_id = ? ORDER BY d.id DESC LIMIT 300`,
      T(c),
    );
    return c.json(rows);
  });
  api.post("/draws/:id/next", async (c) => {
    const id = idParam(c);
    const p = await parseBody(c, z.object({ request_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) }));
    if (!p.ok) return p.res;
    try {
      const r = await pickNext(c.env.DB, id!, p.data.request_id);
      if (!r.replay) await audit(c.env.DB, T(c), c.get("session").username, "draw.pick", String(id), { position: r.position });
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
    const camp = cid && (await first(c.env.DB, "SELECT id FROM campaigns WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL", cid, T(c)));
    if (!camp) return apiError(c, 404, "not_found", "الحملة غير موجودة");
    const p = await parseBody(c, drawInputSchema);
    if (!p.ok) return p.res;
    const d = p.data;
    const ent = await ENT(c);
    if (!ent.active) return apiError(c, 403, "subscription_inactive", "اشتراكك غير فعّال — أدخل كود التفعيل من صفحة «اشتراكي»");
    if (ent.limits.draws_per_month !== null && (await drawsThisMonth(c.env.DB, T(c))) >= ent.limits.draws_per_month) {
      return apiError(c, 403, "plan_draws", ent.limits.draws_per_month === 0 ? "باقتك لا تشمل: السحوبات — رقِّ باقتك من صفحة «اشتراكي»" : `وصلت لحد السحوبات الشهري في باقتك (${ent.limits.draws_per_month})`);
    }
    try {
      const m = await resolveDrawMedia(c, d);
      const now = Date.now();
      const r = await first<{ id: number }>(
        c.env.DB,
        `INSERT INTO draws (tenant_id, campaign_id, name, source_type, media_id, media_permalink, media_caption, media_thumb, media_comments_count, winners_count,
           starts_at, ends_at, timezone, include_replies, keyword, exclude_own, excluded_accounts, entry_mode, allow_repeat_winner, exclude_previous_winners, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        T(c), cid, d.name, d.source_type, m.media_id, m.permalink, m.caption, m.thumb, m.comments_count, d.winners_count,
        d.starts_at ?? null, d.ends_at ?? null, d.timezone ?? null, d.source_type === "story" ? 0 : +d.include_replies, d.keyword?.trim() || null, +d.exclude_own,
        JSON.stringify(d.excluded_accounts), d.entry_mode, d.entry_mode === "per_comment" ? +d.allow_repeat_winner : 0, +d.exclude_previous_winners, now, now,
      );
      await audit(c.env.DB, T(c), c.get("session").username, "draw.created", String(r!.id), { campaign: cid });
      await recordUndo(c.env.DB, T(c), c.get("session").username, "draw.create", `draw:${r!.id}`, `إنشاء السحب «${d.name}»`, { id: r!.id });
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
    const prevDraw = await first<Record<string, unknown>>(c.env.DB, "SELECT * FROM draws WHERE id = ?", id);
    await run(
      c.env.DB,
      `UPDATE draws SET name = ?, winners_count = ?, starts_at = ?, ends_at = ?, timezone = ?, include_replies = ?, keyword = ?, exclude_own = ?,
         excluded_accounts = ?, entry_mode = ?, allow_repeat_winner = ?, exclude_previous_winners = ?, updated_at = ? WHERE id = ? AND status = 'draft'`,
      x.name, x.winners_count, x.starts_at ?? null, x.ends_at ?? null, x.timezone ?? null, d.source_type === "story" ? 0 : +x.include_replies, x.keyword?.trim() || null,
      +x.exclude_own, JSON.stringify(x.excluded_accounts), x.entry_mode, x.entry_mode === "per_comment" ? +x.allow_repeat_winner : 0, +x.exclude_previous_winners, Date.now(), id,
    );
    if (prevDraw) {
      // Only the settings are restored on undo, never the fetched-comments progress.
      const { fetch_state: _fs, fetch_status: _fst, fetched_count: _fc, fetch_updated_at: _fu, fetch_error: _fe, ...row } = prevDraw;
      await recordUndo(c.env.DB, T(c), c.get("session").username, "draw.update", `draw:${id}`, `تعديل السحب «${prevDraw.name}»`, { row });
    }
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
      if (!r.replay) await audit(c.env.DB, T(c), c.get("session").username, "draw.run", String(id));
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
      await audit(c.env.DB, T(c), c.get("session").username, "draw.winner_replaced", String(id), { winner: wid, reason: p.data.reason });
      return c.json({ ok: true, ...r, winners: await winnersOf(c.env.DB, id!) });
    } catch (e) {
      return drawError(c, e);
    }
  });
  api.delete("/draws/:id", async (c) => {
    const id = idParam(c);
    const d = id && (await loadDraw(c.env.DB, id));
    if (!d) return apiError(c, 404, "not_found", "السحب غير موجود");
    const snap = await drawSnapshots(c.env.DB, [d.id]);
    await deleteDraws(c.env.DB, [d.id]);
    await recordUndo(c.env.DB, T(c), c.get("session").username, "draw.delete", `draw:${d.id}`, `حذف السحب «${d.name}»`, { draws: snap });
    await audit(c.env.DB, T(c), c.get("session").username, "draw.deleted", String(d.id), { name: d.name, status: d.status });
    return c.json({ ok: true });
  });
  // Clears the whole draws log (explicit confirmation word required).
  api.post("/draws/clear", async (c) => {
    const p = await parseBody(c, z.object({ confirm: z.literal("مسح") }));
    if (!p.ok) return p.res;
    const ids = (await all<{ id: number }>(c.env.DB, "SELECT id FROM draws WHERE tenant_id = ?", T(c))).map((r) => r.id);
    const snap = await drawSnapshots(c.env.DB, ids);
    await deleteDraws(c.env.DB, ids);
    if (ids.length) await recordUndo(c.env.DB, T(c), c.get("session").username, "draw.clear", "draws:all", `مسح سجل السحوبات (${ids.length})`, { draws: snap });
    await audit(c.env.DB, T(c), c.get("session").username, "draw.cleared", undefined, { count: ids.length });
    return c.json({ ok: true, deleted: ids.length });
  });

  // ---- Congratulation cards (designs, generated images, sending to winners)
  api.get("/card-designs", async (c) => c.json(await all(c.env.DB, "SELECT id, name, design, updated_at FROM card_designs WHERE tenant_id = ? ORDER BY id DESC", T(c))));
  const designBody = z.object({ name: z.string().trim().min(1, "اكتب اسم التصميم").max(80), design: cardDesignInputSchema });
  api.post("/card-designs", async (c) => {
    const blocked = await planBlock(c, "cards");
    if (blocked) return blocked;
    const p = await parseBody(c, designBody);
    if (!p.ok) return p.res;
    const now = Date.now();
    const r = await first<{ id: number }>(c.env.DB, "INSERT INTO card_designs (tenant_id, name, design, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id", T(c), p.data.name, JSON.stringify(p.data.design), now, now);
    await recordUndo(c.env.DB, T(c), c.get("session").username, "design.create", `design:${r!.id}`, `إضافة تصميم التهنئة «${p.data.name}»`, { id: r!.id });
    return c.json({ id: r!.id });
  });
  api.put("/card-designs/:id", async (c) => {
    const id = idParam(c);
    const p = await parseBody(c, designBody);
    if (!p.ok) return p.res;
    const prev = await first<Record<string, unknown>>(c.env.DB, "SELECT * FROM card_designs WHERE id = ?", id);
    if (!prev) return apiError(c, 404, "not_found", "التصميم غير موجود");
    await run(c.env.DB, "UPDATE card_designs SET name = ?, design = ?, updated_at = ? WHERE id = ?", p.data.name, JSON.stringify(p.data.design), Date.now(), id);
    await recordUndo(c.env.DB, T(c), c.get("session").username, "design.update", `design:${id}`, `تعديل تصميم التهنئة «${prev.name}»`, { row: prev });
    return c.json({ ok: true });
  });
  api.delete("/card-designs/:id", async (c) => {
    const id = idParam(c);
    const prev = await first<Record<string, unknown>>(c.env.DB, "SELECT * FROM card_designs WHERE id = ?", id);
    if (!prev) return c.json({ ok: true });
    const drawIds = (await all<{ id: number }>(c.env.DB, "SELECT id FROM draws WHERE card_design_id = ? AND tenant_id = ?", id, T(c))).map((r) => r.id);
    await run(c.env.DB, "UPDATE draws SET card_design_id = NULL WHERE card_design_id = ? AND tenant_id = ?", id, T(c));
    await run(c.env.DB, "DELETE FROM card_designs WHERE id = ?", id);
    await recordUndo(c.env.DB, T(c), c.get("session").username, "design.delete", `design:${id}`, `حذف تصميم التهنئة «${prev.name}»`, { row: prev, draw_ids: drawIds });
    return c.json({ ok: true });
  });
  api.put("/draws/:id/card-design", async (c) => {
    const id = idParam(c);
    const p = await parseBody(c, z.object({ card_design_id: z.number().int().positive().nullable() }));
    if (!p.ok) return p.res;
    // The design must be one of the tenant's own designs.
    if (p.data.card_design_id && !(await first(c.env.DB, "SELECT 1 FROM card_designs WHERE id = ? AND tenant_id = ?", p.data.card_design_id, T(c)))) {
      return apiError(c, 404, "not_found", "التصميم غير موجود");
    }
    await run(c.env.DB, "UPDATE draws SET card_design_id = ?, updated_at = ? WHERE id = ? AND tenant_id = ?", p.data.card_design_id, Date.now(), id, T(c));
    return c.json({ ok: true });
  });
  api.get("/draws/:id/winners/:wid/plan", async (c) => {
    try {
      return c.json(await planFor(c.env.DB, idParam(c)!, Number(c.req.param("wid"))));
    } catch (e) {
      return drawError(c, e);
    }
  });
  api.post("/draws/:id/winners/:wid/card", async (c) => {
    const blocked = await planBlock(c, "cards");
    if (blocked) return blocked;
    const p = await parseBody(c, z.object({ image: z.string().max(2_100_000) }));
    if (!p.ok) return p.res;
    try {
      const token = await storeCard(c.env.DB, idParam(c)!, Number(c.req.param("wid")), p.data.image);
      return c.json({ token, url: `${c.env.PUBLIC_BASE_URL.replace(/\/+$/, "")}/c/${token}` });
    } catch (e) {
      return drawError(c, e);
    }
  });
  api.post("/draws/:id/winners/:wid/send", async (c) => {
    const blocked = await planBlock(c, "cards");
    if (blocked) return blocked;
    const id = idParam(c)!;
    const wid = Number(c.req.param("wid"));
    try {
      const r = await sendCard(engineContext(c.env), c.env.PUBLIC_BASE_URL, id, wid);
      await audit(c.env.DB, T(c), c.get("session").username, "draw.card_sent", String(id), { winner: wid, channel: r.channel });
      return c.json({ ok: true, ...r, winners: await winnersOf(c.env.DB, id) });
    } catch (e) {
      return drawError(c, e);
    }
  });

  api.post("/draws/:id/winners/:wid/public-reply", async (c) => {
    const p = await parseBody(c, z.object({ text: z.string().trim().min(1, "اكتب نص الرد").max(1000) }));
    if (!p.ok) return p.res;
    const id = idParam(c)!;
    const wid = Number(c.req.param("wid"));
    try {
      await publicReplyToWinner(engineContext(c.env), id, wid, p.data.text);
      await audit(c.env.DB, T(c), c.get("session").username, "draw.public_reply", String(id), { winner: wid });
      return c.json({ ok: true, winners: await winnersOf(c.env.DB, id) });
    } catch (e) {
      return drawError(c, e);
    }
  });

  // ---- Notifications (Telegram)
  api.get("/notifications", async (c) => {
    const [settings, has_token] = await Promise.all([getNotifySettings(c.env.DB, T(c)), hasBotToken(c.env.DB, T(c))]);
    return c.json({ settings, has_token });
  });
  api.put("/notifications", async (c) => {
    const blocked = await planBlock(c, "telegram");
    if (blocked) return blocked;
    const p = await parseBody(
      c,
      z.object({
        bot_token: z.string().trim().max(100).optional(), // "" removes it
        enabled: z.boolean().optional(),
        chat_id: z.string().regex(/^-?\d{1,20}$/).nullable().optional(),
        daily_report: z.boolean().optional(),
        weekly_report: z.boolean().optional(),
        report_hour: z.number().int().min(0).max(23).optional(),
        timezone: z.string().max(64).optional(),
        alert_reauth: z.boolean().optional(),
        alert_failures: z.boolean().optional(),
        alert_spike: z.boolean().optional(),
        alert_usage: z.boolean().optional(),
        alert_stock: z.boolean().optional(),
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
      await saveBotToken(c.env, T(c), bot_token || null);
      if (!bot_token) rest.chat_id = null;
    }
    const cur = await getNotifySettings(c.env.DB, T(c));
    const next = { ...cur, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) };
    await setSetting(c.env.DB, T(c), "notify", next);
    await audit(c.env.DB, T(c), c.get("session").username, "notifications.updated", undefined, { ...rest, bot_token: bot_token === undefined ? undefined : bot_token ? "set" : "removed" });
    return c.json({ settings: next, has_token: await hasBotToken(c.env.DB, T(c)) });
  });
  api.post("/notifications/detect", async (c) => {
    const blocked = await planBlock(c, "telegram");
    if (blocked) return blocked;
    const r = await detectChat(c.env, T(c));
    if (!r.ok) return apiError(c, 422, "telegram", r.error ?? "تعذر العثور على المحادثة");
    const next = { ...(await getNotifySettings(c.env.DB, T(c))), chat_id: r.chat_id!, enabled: true };
    await setSetting(c.env.DB, T(c), "notify", next);
    return c.json({ settings: next, name: r.name ?? null });
  });
  api.post("/notifications/test", async (c) => {
    const blocked = await planBlock(c, "telegram");
    if (blocked) return blocked;
    const p = await parseBody(c, z.object({ kind: z.enum(["test", "report"]).default("test") }));
    if (!p.ok) return p.res;
    const text = p.data.kind === "report" ? await buildDailyReport(c.env.DB, T(c)) : "✅ تم ربط إشعارات HSN AutoReply بنجاح. ستصلك التنبيهات والتقرير اليومي هنا.";
    const r = await sendTelegram(c.env, T(c), text);
    if (!r.ok) return apiError(c, 422, "telegram", r.error ?? "تعذر الإرسال");
    return c.json({ ok: true });
  });

  // ---- Inbox: conversations started or answered by the automation, and manual replies (24h window only)
  api.get("/inbox", async (c) => {
    const q = (c.req.query("q") ?? "").trim().replace(/^@/, "").slice(0, 60);
    const label = c.req.query("label") ?? "";
    const params: unknown[] = [T(c)];
    let where = `p.account_id IN ${TENANT_ACCOUNTS} AND p.is_demo = 0 AND p.last_message_at IS NOT NULL`;
    if (q) {
      where += " AND p.username LIKE ? ESCAPE '\\'";
      params.push(`%${q.replace(/[%_\\]/g, (m) => "\\" + m)}%`);
    }
    if ((INBOX_LABELS as string[]).includes(label)) {
      where += " AND p.inbox_label = ?";
      params.push(label);
    } else if (label === "none") where += " AND p.inbox_label IS NULL";
    const rows = await all<any>(
      c.env.DB,
      `SELECT p.id, p.username, p.profile_pic_url, p.last_message_at, p.last_user_message_at, p.inbox_read_at, p.last_follow_status, p.inbox_label, p.inbox_label_source,
              (SELECT m.text FROM messages m WHERE m.participant_id = p.id ORDER BY m.id DESC LIMIT 1) AS last_text,
              (SELECT m.direction FROM messages m WHERE m.participant_id = p.id ORDER BY m.id DESC LIMIT 1) AS last_direction,
              (SELECT COUNT(*) FROM messages m WHERE m.participant_id = p.id AND m.direction = 'in' AND m.created_at > COALESCE(p.inbox_read_at, 0)) AS unread
         FROM participants p WHERE ${where} ORDER BY p.last_message_at DESC LIMIT 150`,
      ...params,
    );
    const now = Date.now();
    return c.json(rows.map((r) => ({ ...r, window_open: !!r.last_user_message_at && now - r.last_user_message_at < MESSAGING_WINDOW_MS })));
  });
  // Fills missing / expired profile pictures (bounded batch; the client calls it when the inbox opens).
  api.post("/inbox/avatars", async (c) => {
    if (!(await rateLimit(c.env.DB, `avatars:${c.get("session").username}`, 30, 3_600_000))) return c.json({ checked: 0, updated: 0 });
    return c.json(await refreshAvatars(engineContext(c.env), T(c)));
  });
  api.get("/inbox/:id", async (c) => {
    const id = idParam(c);
    const p = id && (await first<any>(c.env.DB, "SELECT id, username, profile_pic_url, last_user_message_at, last_follow_status, is_demo, inbox_label, inbox_label_source FROM participants WHERE id = ? AND is_demo = 0", id));
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
  // Label of a conversation, set by the merchant (kept over automatic suggestions); null clears it.
  api.put("/inbox/:id/label", async (c) => {
    const id = idParam(c);
    const body = await parseBody(c, z.object({ label: z.enum(INBOX_LABELS as [InboxLabel, ...InboxLabel[]]).nullable() }));
    if (!body.ok) return body.res;
    await run(c.env.DB, "UPDATE participants SET inbox_label = ?, inbox_label_source = ? WHERE id = ?", body.data.label, body.data.label ? "manual" : null, id);
    return c.json({ ok: true });
  });
  // Counts per label, for the inbox filter.
  api.get("/inbox-labels", async (c) => {
    const rows = await all<{ label: string | null; n: number }>(
      c.env.DB,
      `SELECT inbox_label AS label, COUNT(*) AS n FROM participants WHERE account_id IN ${TENANT_ACCOUNTS} AND is_demo = 0 AND last_message_at IS NOT NULL GROUP BY inbox_label`,
      T(c),
    );
    return c.json(rows);
  });

  // ---- Important notifications (the bell)
  api.get("/app-notifications", async (c) => {
    const [items, unread] = await Promise.all([
      all(c.env.DB, "SELECT id, kind, title, body, link, read_at, created_at FROM app_notifications WHERE tenant_id = ? ORDER BY id DESC LIMIT 50", T(c)),
      first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM app_notifications WHERE tenant_id = ? AND read_at IS NULL", T(c)),
    ]);
    return c.json({ items, unread: unread?.n ?? 0 });
  });
  // Unread count, and the newest unread one (the app plays a sound for owner messages and support replies).
  api.get("/app-notifications/unread", async (c) => {
    const [n, latest] = await Promise.all([
      first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM app_notifications WHERE tenant_id = ? AND read_at IS NULL", T(c)),
      first<{ id: number; kind: string; title: string }>(c.env.DB, "SELECT id, kind, title FROM app_notifications WHERE tenant_id = ? AND read_at IS NULL ORDER BY id DESC LIMIT 1", T(c)),
    ]);
    return c.json({ unread: n?.n ?? 0, latest: latest ?? null });
  });
  api.post("/app-notifications/read", async (c) => {
    await run(c.env.DB, "UPDATE app_notifications SET read_at = ? WHERE tenant_id = ? AND read_at IS NULL", Date.now(), T(c));
    return c.json({ ok: true });
  });

  // ---- Saved replies (quick replies in the inbox)
  const replySchema = z.object({ title: z.string().trim().min(1).max(60), body: z.string().trim().min(1).max(1000) });
  api.get("/saved-replies", async (c) => c.json(await all(c.env.DB, "SELECT id, title, body, uses FROM saved_replies WHERE tenant_id = ? ORDER BY uses DESC, id DESC LIMIT 100", T(c))));
  api.post("/saved-replies", async (c) => {
    const p = await parseBody(c, replySchema);
    if (!p.ok) return p.res;
    const n = await first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM saved_replies WHERE tenant_id = ?", T(c));
    if ((n?.n ?? 0) >= 100) return apiError(c, 409, "limit", "الحد 100 رد محفوظ");
    const now = Date.now();
    const r = await first<{ id: number }>(c.env.DB, "INSERT INTO saved_replies (tenant_id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id", T(c), p.data.title, p.data.body, now, now);
    return c.json({ ok: true, id: r?.id });
  });
  api.put("/saved-replies/:id", async (c) => {
    const p = await parseBody(c, replySchema);
    if (!p.ok) return p.res;
    await run(c.env.DB, "UPDATE saved_replies SET title = ?, body = ?, updated_at = ? WHERE id = ? AND tenant_id = ?", p.data.title, p.data.body, Date.now(), idParam(c), T(c));
    return c.json({ ok: true });
  });
  api.post("/saved-replies/:id/use", async (c) => {
    await run(c.env.DB, "UPDATE saved_replies SET uses = uses + 1 WHERE id = ? AND tenant_id = ?", idParam(c), T(c));
    return c.json({ ok: true });
  });
  api.delete("/saved-replies/:id", async (c) => {
    await run(c.env.DB, "DELETE FROM saved_replies WHERE id = ? AND tenant_id = ?", idParam(c), T(c));
    return c.json({ ok: true });
  });
  api.post("/inbox/:id/send", async (c) => {
    const blocked = await planBlock(c, "inbox_manual");
    if (blocked) return blocked;
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
    await audit(c.env.DB, T(c), c.get("session").username, "inbox.sent", String(p.id));
    return c.json({ ok: true });
  });

  // ---- Settings
  api.get("/settings", async (c) => {
    const out = await publicSettings(c.env.DB, T(c));
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
    const prev: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(p.data)) {
      if (v === undefined) continue;
      const old = await first<{ value: string }>(c.env.DB, "SELECT value FROM app_settings WHERE key = ?", settingKey(T(c), k));
      prev[k] = old ? JSON.parse(old.value) : null;
    }
    for (const [k, v] of Object.entries(p.data)) if (v !== undefined) await setSetting(c.env.DB, T(c), k, v);
    await audit(c.env.DB, T(c), c.get("session").username, "settings.updated", undefined, p.data);
    if (Object.keys(prev).some((k) => JSON.stringify(prev[k]) !== JSON.stringify((p.data as Record<string, unknown>)[k]))) {
      await recordUndo(c.env.DB, T(c), c.get("session").username, "settings.update", "settings", "تعديل الإعدادات", { prev });
    }
    return c.json({ ok: true });
  });

  // Backup of configuration only — never tokens, secrets, sessions or personal data.
  api.get("/settings/backup", async (c) => {
    const t = T(c);
    const [settingsObj, campaigns, keywords, media, templates] = await Promise.all([
      publicSettings(c.env.DB, t),
      all(c.env.DB, "SELECT * FROM campaigns WHERE tenant_id = ? AND deleted_at IS NULL", t),
      all(c.env.DB, "SELECT campaign_id, keyword, kind, match_type FROM campaign_keywords WHERE campaign_id IN (SELECT id FROM campaigns WHERE tenant_id = ?)", t),
      all(c.env.DB, "SELECT campaign_id, media_id FROM campaign_media WHERE campaign_id IN (SELECT id FROM campaigns WHERE tenant_id = ?)", t),
      all(c.env.DB, "SELECT kind, name, body FROM templates WHERE tenant_id = ?", t),
    ]);
    const settings = Object.entries(settingsObj).map(([key, value]) => ({ key, value: JSON.stringify(value) }));
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
    for (const s of p.data.settings) if (allowedSettings.includes(s.key)) await run(c.env.DB, "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", settingKey(T(c), s.key), s.value, now);
    let restored = 0;
    for (const raw of p.data.campaigns) {
      const oldId = Number(raw.id);
      const kw = p.data.keywords.filter((k) => k.campaign_id === oldId).map((k) => ({ keyword: k.keyword, kind: k.kind, match_type: k.match_type }));
      const md = p.data.media.filter((m) => m.campaign_id === oldId).map((m) => m.media_id);
      const bool = (v: unknown) => v === 1 || v === true;
      const parsed = campaignInputSchema.safeParse({
        ...raw, keywords: kw, media_ids: md, match_all: bool(raw.match_all), unify_alef: bool(raw.unify_alef), include_replies: bool(raw.include_replies),
        require_follow: bool(raw.require_follow), follow_invite: bool(raw.follow_invite), public_reply_enabled: bool(raw.public_reply_enabled), process_old_events: bool(raw.process_old_events),
      });
      if (!parsed.success) continue;
      const d = parsed.data;
      const r = await first<{ id: number }>(
        c.env.DB,
        `INSERT INTO campaigns (tenant_id, name, type, status, priority, scope, match_all, unify_alef, include_replies, require_follow, follow_invite, follow_invite_text, opening_text, follow_request_text,
           follow_reminder_text, verify_error_text, final_text, final_url, public_reply_enabled, public_reply_text, public_reply_on_dm_fail, public_reply_fallback_text,
           schedule_start, schedule_end, timezone, per_user_cooldown_hours, max_deliveries_per_user, max_verify_attempts, verify_cooldown_seconds, process_old_events, created_at, updated_at)
         VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        T(c), d.name, d.type, d.priority, d.scope, +d.match_all, +d.unify_alef, +d.include_replies, +(d.require_follow && (await followGateAllowed(c.env.DB, T(c)))), +d.follow_invite, d.follow_invite_text ?? null, d.opening_text ?? null, d.follow_request_text ?? null,
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
    for (const t of p.data.templates) await run(c.env.DB, "INSERT INTO templates (tenant_id, kind, name, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", T(c), t.kind, t.name, t.body, now, now);
    await audit(c.env.DB, T(c), c.get("session").username, "settings.restored", undefined, { campaigns: restored });
    return c.json({ ok: true, campaigns: restored, note: "الحملات المستعادة في وضع مسودة — راجعها ثم فعّلها." });
  });

  api.post("/data/delete", async (c) => {
    const p = await parseBody(c, z.object({ scope: z.enum(["logs", "demo", "all_personal"]), confirm: z.literal("DELETE") }));
    if (!p.ok) return p.res;
    const db = c.env.DB;
    const t = T(c);
    // Every statement is limited to the caller's tenant (its Instagram accounts and its own logs).
    const ACC = TENANT_ACCOUNTS;
    const PART = `(SELECT id FROM participants WHERE account_id IN ${ACC})`;
    if (p.data.scope === "demo") {
      await db.batch([
        db.prepare("DELETE FROM action_jobs WHERE is_demo = 1 AND account_id IN (SELECT id FROM instagram_accounts WHERE tenant_id = ? AND is_demo = 1)").bind(t),
        db.prepare("DELETE FROM webhook_events WHERE is_demo = 1 AND account_ig_id IN (SELECT ig_user_id FROM instagram_accounts WHERE tenant_id = ? AND is_demo = 1)").bind(t),
        db.prepare("DELETE FROM instagram_accounts WHERE is_demo = 1 AND tenant_id = ?").bind(t),
      ]);
    } else if (p.data.scope === "logs") {
      await db.batch([
        db.prepare(`DELETE FROM action_attempts WHERE job_id IN (SELECT id FROM action_jobs WHERE account_id IN ${ACC})`).bind(t),
        db.prepare(`UPDATE webhook_events SET text = NULL, sender_username = NULL, payload = '{}' WHERE account_ig_id IN ${TENANT_IG_IDS}`).bind(t),
        db.prepare("DELETE FROM audit_logs WHERE tenant_id = ?").bind(t),
      ]);
    } else {
      await db.batch([
        db.prepare(`DELETE FROM action_attempts WHERE job_id IN (SELECT id FROM action_jobs WHERE account_id IN ${ACC})`).bind(t),
        db.prepare(`DELETE FROM follow_checks WHERE participant_id IN ${PART}`).bind(t),
        db.prepare(`DELETE FROM conversation_flows WHERE account_id IN ${ACC}`).bind(t),
        db.prepare(`DELETE FROM messages WHERE participant_id IN ${PART}`).bind(t),
        db.prepare(`DELETE FROM participants WHERE account_id IN ${ACC}`).bind(t),
        db.prepare(`UPDATE action_jobs SET payload = '{}', result = NULL WHERE status NOT IN ('pending','processing','retry_scheduled') AND account_id IN ${ACC}`).bind(t),
        db.prepare(`UPDATE webhook_events SET text = NULL, sender_username = NULL, sender_id = NULL, payload = '{}' WHERE account_ig_id IN ${TENANT_IG_IDS}`).bind(t),
      ]);
    }
    await audit(db, t, c.get("session").username, "data.deleted", p.data.scope);
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

/** The follow requirement is allowed only when the owner enabled it on a connected (non-demo) account. */
async function followGateAllowed(db: D1Database, tenantId: number): Promise<boolean> {
  const r = await first<{ n: number }>(db, "SELECT COUNT(*) AS n FROM instagram_accounts WHERE tenant_id = ? AND is_demo = 0 AND follow_gate_allowed = 1 AND status != 'disconnected'", tenantId);
  return (r?.n ?? 0) > 0;
}

/** Log filters; `scope` is the tenant condition (always applied first). */
function logFilters(c: C, timeCol: string, eq: string[], prefix: string, scope: string) {
  const where: string[] = [scope];
  const params: unknown[] = [T(c)];
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
  return { where: `WHERE ${where.join(" AND ")}`, params };
}
