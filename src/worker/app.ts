import { Hono, type Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import type { Env } from "./env";
import { missingSecrets } from "./env";
import { all, audit, first, getSetting, OWNER_TENANT, run, setSetting, settingKey, tenantSettingsFilter } from "./lib/db";
import { decryptSecret, encryptSecret, fromB64, hashPassword, randomToken, sha256Hex, timingSafeEqual, verifyMetaSignature, verifyPassword } from "./lib/crypto";
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
  dmMenuSchema,
  featuredSchema,
  featureOrderSchema,
  campaignInputSchema,
  drawInputSchema,
  loginSchema,
  settingsSchema,
  setupSchema,
  simulateSchema,
  templateInputSchema,
  username,
} from "../shared/schemas";
import { claimsDelivery, claimsFollowRequired, publicReplyVariants } from "../shared/template";
import { cacheMediaStmt } from "./services/media";
import { INBOX_LABELS, markRead, recordMessage, refreshAvatars, type InboxLabel } from "./services/inbox";
import { buildDailyReport, deleteOwnerMessage, detectChat, getNotifySettings, hasBotToken, isTelegramToken, notify, receiptUpdate, remindOwnerMessage, saveBotToken, sendOwnerMessage, sendTelegram } from "./services/notify";
import { MESSAGING_WINDOW_MS } from "./engine/context";
import { estimateUsage, platformUsage } from "./services/usage";
import { cloudflareUsage } from "./services/cfusage";
import { claimStore, completeSallaOAuth, handleSallaWebhook, sallaAuthorizeUrl, sallaConfigured, syncProducts, verifySallaWebhook } from "./services/salla";
import { bestTimes, postSales, weeklyReport } from "./services/growth";
import { applyReferral, customerHealth, findCoupon, normCode, publicCoupon, referralDays, referralStats } from "./services/customers";
import { storeAnalytics, storeCampaignDetail, storeProductCosts, storeProducts } from "./services/store";
import { domainInfo } from "./services/domain";
import { recoverMissedComments } from "./services/recover";
import { auditCampaignComments } from "./services/audit";
import { LIMITS, hasPublishScope, isImage, isVideo, optionalScopes, publishScopeMode, removeFiles, validatePost, verifyMediaUrl, wantsPublishScope, withSchedulingNotice, type PostKind } from "./services/publish";
import { captureInsights, insightsAccount, insightsScopeMode, insightsSummary, mediaInsightsSeries, wantsInsightsScope } from "./services/insights";
import { analyticsByCampaign, analyticsByPost, analyticsDevices, analyticsFollow, analyticsHeatmap, analyticsOverview, analyticsRetention, osFamily, tzOffsetMinutes, type AnalyticsFilter, type EventType, type HeatKind } from "./services/analytics";
import { deleteDraws, DrawFailure, EXCLUDE_LABELS, fetchBatch, loadDraw, pickNext, preview, replaceWinner, runDraw, settingsOf, winnersOf } from "./services/draws";
import { instagramShortcode } from "../shared/draw";
import { cardDesignInputSchema } from "../shared/card";
import { cardByToken, planFor, publicReplyToWinner, sendCard, storeCard } from "./services/cards";

/** Settings shown to the client / exported in backups: never the Telegram bot token or notification state. */
import { toCsv } from "../shared/csv";
import { DEFAULT_RATES, EVENT_LABELS, FEATURE_LABELS, formatPrice, MESSAGE_LINKS, orderFeatures, type ExchangeRates, type PlanLimits } from "../shared/plans";
import { diagnoseTenant } from "./services/diagnose";
import { parsePerms } from "./services/staff";
import { permsFor } from "../shared/staff";

const MAX_STAFF = 10;
import { confirmEmailCode, confirmPasswordChange, requestPasswordReset, resetPassword, sendEmailCode, startPasswordChange } from "./services/recovery";
import { emailEnabled, lastEmailError } from "./services/email";
import { newRecoveryCodes, newTotpSecret, normRecovery, otpauthUri, verifyTotp } from "./lib/totp";
import { DEFAULT_MESSAGE_TEMPLATES, type MessageTemplates } from "../shared/messageTemplates";
const MESSAGE_LINK_PATHS = MESSAGE_LINKS.map((l) => l.to) as [string, ...string[]];
import { listPaymentMethods } from "./services/payments";
import { parseFaqText } from "../shared/support";
import { emptyMenu, extrasProblem, keywordsProblem, menuParts, menuProblem, type DmMenu, type MenuNode } from "../shared/menu";
import { syncMenuProfile } from "./services/menuProfile";
import { ATTACH, attachKey, attachLimit, CATEGORIES, DEFAULT_RESPONSE_TIME, cardFontKey, deleteTenantCardFonts, deleteTenantSupportFiles, notifyState, ownMessage, setState, stateAfterCustomer, STATES, supportCenter, ticketNo, type Incident } from "./services/support";
import { CYCLE_MS, usageCycle, codeHash, deleteTenantData, drawsThisMonth, getEntitlement, listPlans, monthlyMessages, newCode, parseLimits, redeemCode, RedeemError } from "./services/plans";
import { cardEnabled, cardPriceHalalas, createInvoice, isTestKey, payablePlan, PayError, startCardPayment, syncInvoice } from "./services/moyasar";
import { planChangeBlock, quoteUpgrade } from "./services/upgrades";
import { campaignSnapshot, drawSnapshots, listUndo, recordUndo, stopCampaignWork, undoOperation, UndoError } from "./services/undo";
import { dataDeletionPage, deletionStatusPage, oauthResultPage, PAGE_CSP, pageLang, parseSignedRequest, privacyPage, refundPage, termsPage } from "./pages";

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

/** FAQ text compared without case, diacritics, punctuation or extra spaces (to skip duplicates on import). */
const normFaq = (v: string) => v.toLowerCase().replace(/[\u064B-\u0652\u0640]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/[؟?!.,،:«»"'()\s]+/g, " ").trim();

const idParam = (c: C) => {
  const n = Number(c.req.param("id"));
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * Second login step: a current authenticator code (never the same step twice) or an unused recovery code
 * (consumed). Returns which one matched, or null.
 */
async function checkSecondFactor(
  env: Env,
  u: { id: number; totp_ciphertext: string | null; totp_iv: string | null; totp_last_step: number | null; totp_recovery: string | null },
  code: string,
  now: number,
): Promise<"totp" | "recovery" | null> {
  if (/^\s*\d{3}\s?\d{3}\s*$/.test(code)) {
    if (!u.totp_ciphertext || !u.totp_iv) return null;
    const secret = await decryptSecret(u.totp_ciphertext, u.totp_iv, env.TOKEN_ENC_KEY, `totp:${u.id}`);
    const step = await verifyTotp(secret, code, now, u.totp_last_step);
    if (step === null) return null;
    const r = await env.DB.prepare("UPDATE admin_users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)").bind(step, u.id, step).run();
    return r.meta.changes ? "totp" : null;
  }
  const hashes: string[] = u.totp_recovery ? JSON.parse(u.totp_recovery) : [];
  const h = await sha256Hex(normRecovery(code));
  if (!hashes.includes(h)) return null;
  const left = JSON.stringify(hashes.filter((x) => x !== h));
  const r = await env.DB.prepare("UPDATE admin_users SET totp_recovery = ? WHERE id = ? AND totp_recovery = ?").bind(left, u.id, u.totp_recovery).run();
  return r.meta.changes ? "recovery" : null;
}

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

const DEFAULT_PRICE_NOTE = "شامل الضريبة المضافة 15%";
/** The activation-code box on «اشتراكي» (owner-editable; card payment is the main way, a code is the other one). */
type CodeBox = { enabled: boolean; title: string; text: string; button_label: string; button_url: string };
const DEFAULT_CODE_BOX: CodeBox = {
  enabled: true,
  title: "عندك كود تفعيل؟",
  text: "طريقة ثانية للاشتراك: إذا وصلك كود تفعيل (يبدأ بـ HSN-) اكتبه هنا وتتفعّل باقتك فورًا. وإذا اشتراكك فعّال تنضاف المدة بعد تاريخ انتهائه.",
  button_label: "تواصل معنا",
  button_url: "",
};
const codeBoxOf = async (db: D1Database) => ({ ...DEFAULT_CODE_BOX, ...(await getSetting<Partial<CodeBox> | null>(db, OWNER_TENANT, "code_box", null)) });

/** The stored rates, limited to the offered currencies (old settings may hold others). */
const knownRates = (r: ExchangeRates): ExchangeRates => ({ USD: 1, SAR: Number(r?.SAR) > 0 ? Number(r.SAR) : DEFAULT_RATES.SAR });

/** What a buyer needs to see: active plans (with structured prices), exchange rates, payment accounts and the contact link. */
async function publicCatalog(c: C) {
  const [plans, rates, payment_methods, contact, featured, order, cardLabel, priceNote, codeBox] = await Promise.all([
    listPlans(c.env.DB),
    getSetting<ExchangeRates>(c.env.DB, OWNER_TENANT, "exchange_rates", DEFAULT_RATES),
    listPaymentMethods(c.env.DB),
    getSetting<string>(c.env.DB, OWNER_TENANT, "sales_contact", ""),
    getSetting<{ plan_id: string | null; label: string } | null>(c.env.DB, OWNER_TENANT, "featured_plan", null),
    getSetting<string[] | null>(c.env.DB, OWNER_TENANT, "feature_order", null),
    getSetting<string>(c.env.DB, OWNER_TENANT, "card_button_label", ""),
    getSetting<string | null>(c.env.DB, OWNER_TENANT, "price_note", null),
    codeBoxOf(c.env.DB),
  ]);
  return {
    plans: plans
      .filter((p) => p.active)
      .map(({ id, name, price_label, price_amount, price_before, price_currency, price_period, card_price_halalas, description, limits }) => ({
        id, name, price_label, price_amount, price_currency, price_period, description, limits,
        // The old price, only when it is above the current one.
        price_before: price_amount !== null && price_before && price_before > price_amount ? price_before : null,
        // Fixed SAR price for card payment (Moyasar), only when card payments are on and the period has a length.
        card_price: cardEnabled(c.env) ? (cardPriceHalalas({ card_price_halalas, price_amount, price_currency, price_period }) ?? 0) / 100 || null : null,
      })),
    card_payments: cardEnabled(c.env),
    // Text of the card pay button (owner-set), no currency or price in it.
    card_button_label: cardLabel || "اشترك الآن",
    // Small note next to every price (owner-set; empty hides it).
    price_note: priceNote ?? DEFAULT_PRICE_NOTE,
    rates: knownRates(rates),
    // A bank / wallet with no account yet would show buyers an empty box.
    payment_methods: payment_methods.filter((p) => p.accounts.length > 0),
    sales_contact: contact || null,
    // The activation-code box; its button goes to the owner's link, else the sales contact (no link = no button).
    code_box: { ...codeBox, button_url: codeBox.button_url || contact || "" },
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

  app.get("/privacy", (c) => html(c, privacyPage(c.env.PUBLIC_BASE_URL, pageLang(c.req.query("lang")))));
  // The plans page lives in the app now (works for visitors without an account).
  app.get("/pricing", (c) => c.redirect("/#/plans", 302));
  app.get("/terms", (c) => html(c, termsPage(pageLang(c.req.query("lang")))));
  app.get("/refund", (c) => html(c, refundPage(pageLang(c.req.query("lang")))));
  app.get("/data-deletion", (c) => html(c, dataDeletionPage(pageLang(c.req.query("lang")))));
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
      if (!code || c.req.query("error")) return c.html(oauthResultPage(false, "رابط ربط المتجر غير صالح أو منتهي. ابدأ الربط من صفحة الربط في شيّك.", "web", c.env.APP_DEEP_LINK), 400);
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

  // Moyasar calls this when an invoice is paid. The body is only a hint: the invoice is fetched again with the
  // secret key before anything is activated (syncInvoice), so a forged call cannot activate a plan.
  app.post("/webhooks/moyasar", async (c) => {
    if (!cardEnabled(c.env)) return c.json({ ok: false }, 404);
    const raw = await c.req.text();
    if (raw.length > 100_000) return c.json({ ok: false }, 413);
    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ ok: false }, 400);
    }
    const id = String(body?.invoice_id ?? body?.data?.invoice_id ?? body?.id ?? body?.data?.id ?? "");
    if (!/^[\w-]{8,64}$/.test(id)) return c.json({ ok: false }, 400);
    if (!(await rateLimit(c.env.DB, "moyasar_webhook", 300, 3_600_000))) return c.json({ ok: false }, 429);
    const out = await syncInvoice(c.env, id).catch((e) => (console.error("moyasar webhook", sanitize(String(e))), "error"));
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
  // Help widget: FAQ (with video links), expected response time and the incident banner.
  app.get("/api/public/support", async (c) => c.json(await supportCenter(c.env.DB)));
  // Subscription discount codes: check a code (plans page), and count it when the receipt is sent.
  app.get("/api/public/coupon", async (c) => {
    if (!(await rateLimit(c.env.DB, `coupon_check:${clientIp(c)}`, 30, 3_600_000))) return apiError(c, 429, "rate_limited", "محاولات كثيرة، حاول بعد شوي");
    const cp = await findCoupon(c.env.DB, c.req.query("code") ?? "");
    if (!cp) return apiError(c, 404, "invalid_coupon", "كود الخصم غير صحيح أو منتهي");
    return c.json(publicCoupon(cp));
  });
  app.post("/api/public/coupon/use", async (c) => {
    const p = await parseBody(c, z.object({ code: z.string().max(40) }));
    if (!p.ok) return p.res;
    if (!(await rateLimit(c.env.DB, `coupon_use:${clientIp(c)}`, 10, 3_600_000))) return c.json({ ok: true });
    const cp = await findCoupon(c.env.DB, p.data.code);
    if (cp) await run(c.env.DB, "UPDATE sub_coupons SET uses = uses + 1 WHERE id = ?", cp.id);
    return c.json({ ok: true });
  });
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
    const user = await first<{ id: number; username: string; password_hash: string; failed_attempts: number; locked_until: number | null; tenant_id: number; tenant_status: string; totp_enabled_at: number | null; totp_ciphertext: string | null; totp_iv: string | null; totp_last_step: number | null; totp_recovery: string | null; disabled_at: number | null }>(
      c.env.DB,
      // The store name logs in without caring about upper/lower case (exact match preferred).
      "SELECT u.*, t.status AS tenant_status FROM admin_users u JOIN tenants t ON t.id = u.tenant_id WHERE u.username = ? COLLATE NOCASE ORDER BY (u.username = ?) DESC LIMIT 1",
      p.data.username,
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
    // Two-step login: after the right password, the authenticator code (or a one-time recovery code).
    if (user.totp_enabled_at) {
      if (!p.data.totp) return apiError(c, 401, "totp_required", "اكتب رمز التحقق من تطبيق المصادقة");
      const ok = await checkSecondFactor(c.env, user, p.data.totp, now);
      if (!ok) {
        const fails = user.failed_attempts + 1;
        await run(c.env.DB, "UPDATE admin_users SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?", fails, fails >= 5 ? now + 15 * 60_000 : null, now, user.id);
        return apiError(c, 401, "invalid_totp", "رمز التحقق غير صحيح أو انتهى وقته — اكتب الرمز الحالي من التطبيق");
      }
      if (ok === "recovery") await audit(c.env.DB, user.tenant_id, user.username, "auth.recovery_code_used");
    }
    await run(c.env.DB, "UPDATE admin_users SET failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?", now, user.id);
    if (user.disabled_at) return apiError(c, 403, "staff_disabled", "هذا الحساب موقوف من صاحب الحساب");
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

  // ---- Forgot password: a one-time link to the confirmed email. Same answer whether or not the account exists.
  app.post("/api/auth/forgot", async (c) => {
    if (!(await rateLimit(c.env.DB, `forgot:${clientIp(c)}`, 5, 60 * 60_000))) return apiError(c, 429, "rate_limited", "محاولات كثيرة، حاول بعد ساعة");
    const p = await parseBody(c, z.object({ login: z.string().trim().min(2).max(254) }));
    if (!p.ok) return p.res;
    if (!emailEnabled(c.env)) return apiError(c, 503, "email_off", "استرجاع كلمة المرور بالإيميل غير مفعّل بعد — تواصل مع إدارة الخدمة");
    // The link opens on the service's own domain when it has one (PUBLIC_BASE_URL stays as Meta's/Salla's callback base).
    const r = await requestPasswordReset(c.env, p.data.login, c.env.SERVICE_DOMAIN ? `https://${c.env.SERVICE_DOMAIN}` : c.env.PUBLIC_BASE_URL);
    if (r === "sent") await audit(c.env.DB, OWNER_TENANT, "system", "auth.reset_requested").catch(() => undefined);
    return c.json({ ok: true, message: "إذا كان الحساب مسجّل بإيميل مؤكَّد، وصلك رابط خلال دقائق. شيّك على البريد غير المرغوب (Spam) كمان." });
  });
  app.post("/api/auth/reset", async (c) => {
    if (!(await rateLimit(c.env.DB, `reset:${clientIp(c)}`, 10, 60 * 60_000))) return apiError(c, 429, "rate_limited", "محاولات كثيرة، حاول بعد ساعة");
    const p = await parseBody(c, z.object({ token: z.string().min(20).max(200), password: z.string().min(12, "كلمة المرور 12 حرفًا على الأقل").max(256) }));
    if (!p.ok) return p.res;
    const r = await resetPassword(c.env, p.data.token, p.data.password);
    if (!r.ok) return apiError(c, 422, "invalid_link", "الرابط غير صالح أو انتهى وقته أو استُخدم — اطلب رابط جديد");
    await audit(c.env.DB, r.tenant_id, r.username, "auth.password_reset");
    return c.json({ ok: true, username: r.username });
  });

  // Self sign-up with an activation code, or (when card payment is on) with a plan to pay for right after:
  // that account starts without a plan and is activated by the card payment.
  app.post("/api/auth/register", async (c) => {
    if (!(await rateLimit(c.env.DB, `register:${clientIp(c)}`, 5, 60 * 60_000))) return apiError(c, 429, "rate_limited", "محاولات كثيرة، حاول بعد ساعة");
    const p = await parseBody(c, registerSchema);
    if (!p.ok) return p.res;
    const now = Date.now();
    const withCode = !!p.data.code;
    if (withCode) {
      // Check the code first (without using it) so a typo never creates an empty account.
      const code = await first<{ id: number }>(c.env.DB, "SELECT id FROM activation_codes WHERE code_hash = ? AND used_at IS NULL AND revoked_at IS NULL", await codeHash(p.data.code!));
      if (!code) return apiError(c, 422, "invalid_code", "كود التفعيل غير صحيح أو مستخدم");
    } else if (!p.data.plan_id || !(await payablePlan(c.env, p.data.plan_id))) {
      return apiError(c, 422, "code_required", "أدخل كود التفعيل، أو اختر باقة من صفحة الباقات وادفع بالبطاقة");
    }
    if (await first(c.env.DB, "SELECT 1 FROM admin_users WHERE username = ? COLLATE NOCASE", p.data.username)) return apiError(c, 409, "username_taken", "اسم الحساب هذا مسجّل من قبل — اختر غيره");
    const hash = await hashPassword(p.data.password, c.env.PASSWORD_PEPPER, Number(c.env.PBKDF2_ITERATIONS || 100_000));
    const t = await first<{ id: number }>(c.env.DB, "INSERT INTO tenants (name, created_at, updated_at) VALUES (?, ?, ?) RETURNING id", p.data.name, now, now);
    const tid = t!.id;
    try {
      await run(c.env.DB, "INSERT INTO admin_users (username, password_hash, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", p.data.username, hash, tid, now, now);
      if (withCode) await redeemCode(c.env.DB, tid, p.data.code!, now);
    } catch (e) {
      await deleteTenantData(c.env.DB, tid);
      if (e instanceof RedeemError) return apiError(c, 422, e.code, e.message);
      return apiError(c, 409, "username_taken", "اسم المستخدم مستخدم — اختر غيره");
    }
    await seedStarterTemplates(c.env.DB, tid, now);
    await audit(c.env.DB, tid, p.data.username, "tenant.registered", String(tid), withCode ? undefined : { pay_plan: p.data.plan_id });
    // The email (for password recovery) gets a confirmation code; it works for recovery once confirmed.
    if (p.data.email) {
      const u = await first<{ id: number }>(c.env.DB, "SELECT id FROM admin_users WHERE tenant_id = ? ORDER BY id LIMIT 1", tid);
      if (u) {
        await run(c.env.DB, "UPDATE admin_users SET email = ? WHERE id = ?", p.data.email.toLowerCase(), u.id);
        await sendEmailCode(c.env, u.id, p.data.email, now).catch(() => undefined);
      }
    }
    // Signed up through a customer's referral link: both get bonus days.
    const referrer = await applyReferral(c.env.DB, tid, p.data.ref, now).catch(() => null);
    if (referrer) {
      const days = await referralDays(c.env.DB);
      if (days > 0) {
        await notify(c.env, referrer, "referral", `🎁 عميل جديد اشترك من رابط دعوتك!\nأضفنا ${days} أيام مجانية لاشتراكك. شكرًا لأنك نشرت الخدمة 💜`);
        await notify(c.env, tid, "referral", `🎁 هدية ترحيب: ${days} أيام إضافية على اشتراكك لأنك جيت من دعوة عميل.`);
      }
    }
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------------ Authenticated API
  const api = new Hono<AppEnv>();
  api.use("*", requireAuth);

  // ---- Two-step login (every account): set up with an authenticator app, confirm with a code, turn off.
  api.get("/auth/totp", async (c) => {
    const u = await first<{ totp_enabled_at: number | null; totp_recovery: string | null }>(c.env.DB, "SELECT totp_enabled_at, totp_recovery FROM admin_users WHERE id = ?", c.get("session").user_id);
    return c.json({ available: true, enabled: !!u?.totp_enabled_at, enabled_at: u?.totp_enabled_at ?? null, recovery_left: u?.totp_recovery ? (JSON.parse(u.totp_recovery) as string[]).length : 0 });
  });
  api.post("/auth/totp/setup", async (c) => {
    const s = c.get("session");
    const u = await first<{ totp_enabled_at: number | null }>(c.env.DB, "SELECT totp_enabled_at FROM admin_users WHERE id = ?", s.user_id);
    if (u?.totp_enabled_at) return apiError(c, 409, "already_enabled", "التحقق بخطوتين مفعّل — أوقفه أولًا إذا تبغى تربط جهاز جديد");
    const secret = newTotpSecret();
    const e = await encryptSecret(secret, c.env.TOKEN_ENC_KEY, `totp:${s.user_id}`);
    await run(c.env.DB, "UPDATE admin_users SET totp_ciphertext = ?, totp_iv = ?, totp_enabled_at = NULL, totp_last_step = NULL, totp_recovery = NULL, updated_at = ? WHERE id = ?", e.ciphertext, e.iv, Date.now(), s.user_id);
    return c.json({ secret, uri: otpauthUri(secret, s.username) });
  });
  api.post("/auth/totp/enable", async (c) => {
    const s = c.get("session");
    if (!(await rateLimit(c.env.DB, `totp_enable:${s.user_id}`, 10, 15 * 60_000))) return apiError(c, 429, "rate_limited", "محاولات كثيرة، انتظر 15 دقيقة");
    const p = await parseBody(c, z.object({ code: z.string().trim().min(6).max(10) }));
    if (!p.ok) return p.res;
    const u = await first<{ totp_ciphertext: string | null; totp_iv: string | null; totp_enabled_at: number | null }>(c.env.DB, "SELECT totp_ciphertext, totp_iv, totp_enabled_at FROM admin_users WHERE id = ?", s.user_id);
    if (!u?.totp_ciphertext || !u.totp_iv) return apiError(c, 409, "not_setup", "ابدأ الإعداد أولًا");
    if (u.totp_enabled_at) return apiError(c, 409, "already_enabled", "مفعّل مسبقًا");
    const secret = await decryptSecret(u.totp_ciphertext, u.totp_iv, c.env.TOKEN_ENC_KEY, `totp:${s.user_id}`);
    const now = Date.now();
    const step = await verifyTotp(secret, p.data.code, now);
    if (step === null) return apiError(c, 422, "invalid_totp", "الرمز غير صحيح — تأكد إن وقت الجوال مضبوط واكتب الرمز الحالي");
    const codes = newRecoveryCodes();
    const hashes = await Promise.all(codes.map((x) => sha256Hex(normRecovery(x))));
    await run(c.env.DB, "UPDATE admin_users SET totp_enabled_at = ?, totp_last_step = ?, totp_recovery = ?, updated_at = ? WHERE id = ?", now, step, JSON.stringify(hashes), now, s.user_id);
    await audit(c.env.DB, s.tenant_id, s.username, "auth.totp_enabled");
    return c.json({ ok: true, recovery_codes: codes });
  });
  api.post("/auth/totp/disable", async (c) => {
    const s = c.get("session");
    if (!(await rateLimit(c.env.DB, `totp_disable:${s.user_id}`, 10, 15 * 60_000))) return apiError(c, 429, "rate_limited", "محاولات كثيرة، انتظر 15 دقيقة");
    const p = await parseBody(c, z.object({ password: z.string().min(1).max(256), code: z.string().trim().min(6).max(20) }));
    if (!p.ok) return p.res;
    const u = await first<any>(c.env.DB, "SELECT * FROM admin_users WHERE id = ?", s.user_id);
    if (!u?.totp_enabled_at) return c.json({ ok: true });
    const now = Date.now();
    if (!(await verifyPassword(p.data.password, u.password_hash, c.env.PASSWORD_PEPPER)) || !(await checkSecondFactor(c.env, u, p.data.code, now)))
      return apiError(c, 422, "invalid_credentials", "كلمة المرور أو رمز التحقق غير صحيح");
    await run(c.env.DB, "UPDATE admin_users SET totp_ciphertext = NULL, totp_iv = NULL, totp_enabled_at = NULL, totp_last_step = NULL, totp_recovery = NULL, updated_at = ? WHERE id = ?", now, s.user_id);
    await audit(c.env.DB, s.tenant_id, s.username, "auth.totp_disabled");
    return c.json({ ok: true });
  });


  // Ownership guard: any route addressing a row by id only reaches rows of the caller's tenant (404 otherwise).
  const OWNED: Record<string, string> = {
    campaigns: "SELECT 1 FROM campaigns WHERE id = ? AND tenant_id = ?",
    draws: "SELECT 1 FROM draws WHERE id = ? AND tenant_id = ?",
    "card-designs": "SELECT 1 FROM card_designs WHERE id = ? AND tenant_id = ?",
    templates: "SELECT 1 FROM templates WHERE id = ? AND tenant_id = ?",
    "saved-replies": "SELECT 1 FROM saved_replies WHERE id = ? AND tenant_id = ?",
    support: "SELECT 1 FROM support_threads WHERE id = ? AND tenant_id = ?",
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
    return c.json({ username: s.username, kind: s.kind, is_owner: s.is_owner, role: s.role, perms: s.perms, display_name: s.display_name, csrf_token: s.kind === "web" ? s.csrf_token : undefined });
  });

  api.post("/auth/logout", async (c) => {
    await run(c.env.DB, "UPDATE sessions SET revoked_at = ? WHERE id = ?", Date.now(), c.get("session").id);
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
    return c.json({ ok: true });
  });

  api.get("/auth/sessions", async (c) =>
    c.json(await all(c.env.DB, "SELECT substr(id,1,12) AS id, kind, device_label, created_at, last_seen_at, expires_at FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC", c.get("session").user_id, Date.now())),
  );

  // ---- Staff: the account holder adds logins limited to chosen sections (enforced in requireAuth).
  const holderOnly = (c: C) => (c.get("session").role !== "owner" ? apiError(c, 403, "holder_only", "إدارة الموظفين لصاحب الحساب فقط") : null);
  const staffSchema = z.object({
    display_name: z.string().trim().min(2, "اكتب اسم الموظف").max(60),
    perms: z.array(z.string().max(30)).max(20),
  });
  /** How many staff the account may have: its plan's limit (the owner's account: the service maximum). */
  const staffLimit = async (c: C) => {
    if (c.get("session").is_owner) return MAX_STAFF;
    const ent = await getEntitlement(c.env.DB, T(c));
    if (!ent.active) return 0;
    const l = ent.limits.staff ?? 0;
    return l === null ? MAX_STAFF : Math.min(l, MAX_STAFF);
  };
  const cleanPerms = (c: C, perms: string[]) => {
    const allowed = new Set(permsFor(c.get("session").is_owner).map((p) => p.key as string));
    return [...new Set(perms)].filter((p) => allowed.has(p));
  };
  api.get("/staff", async (c) => {
    const bad = holderOnly(c);
    if (bad) return bad;
    const rows = await all<any>(
      c.env.DB,
      `SELECT u.id, u.username, u.display_name, u.perms, u.disabled_at, u.created_at, u.totp_enabled_at IS NOT NULL AS totp,
              (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen
         FROM admin_users u WHERE u.tenant_id = ? AND u.role = 'staff' ORDER BY u.id`,
      T(c),
    );
    return c.json({ staff: rows.map((r) => ({ ...r, perms: parsePerms(r.perms) })), available: permsFor(c.get("session").is_owner), max: await staffLimit(c) });
  });
  api.post("/staff", async (c) => {
    const bad = holderOnly(c);
    if (bad) return bad;
    const p = await parseBody(c, staffSchema.extend({ username: username(), password: z.string().min(12, "كلمة المرور 12 حرفًا على الأقل").max(256) }));
    if (!p.ok) return p.res;
    const n = await first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM admin_users WHERE tenant_id = ? AND role = 'staff'", T(c));
    const limit = await staffLimit(c);
    if (limit === 0) return apiError(c, 403, "plan_feature", "إضافة الموظفين غير متاحة في باقتك — رقّ باقتك من «اشتراكي»");
    if ((n?.n ?? 0) >= limit) return apiError(c, 403, "plan_feature", `باقتك تسمح بـ ${limit} ${limit === 1 ? "موظف" : "موظفين"} — رقّ باقتك من «اشتراكي» لإضافة المزيد`);
    if (await first(c.env.DB, "SELECT 1 FROM admin_users WHERE username = ? COLLATE NOCASE", p.data.username)) return apiError(c, 409, "username_taken", "اسم الدخول هذا مستخدم — اختر غيره");
    const perms = cleanPerms(c, p.data.perms);
    if (!perms.length) return apiError(c, 422, "no_perms", "اختر قسم واحد على الأقل");
    const now = Date.now();
    const hash = await hashPassword(p.data.password, c.env.PASSWORD_PEPPER, Number(c.env.PBKDF2_ITERATIONS || 100_000));
    await run(
      c.env.DB,
      "INSERT INTO admin_users (username, password_hash, tenant_id, role, perms, display_name, created_by, created_at, updated_at) VALUES (?, ?, ?, 'staff', ?, ?, ?, ?, ?)",
      p.data.username, hash, T(c), JSON.stringify(perms), p.data.display_name, c.get("session").user_id, now, now,
    );
    await audit(c.env.DB, T(c), c.get("session").username, "staff.created", p.data.username, { perms });
    return c.json({ ok: true });
  });
  const staffRow = (c: C) => first<{ id: number; username: string }>(c.env.DB, "SELECT id, username FROM admin_users WHERE id = ? AND tenant_id = ? AND role = 'staff'", idParam(c), T(c));
  api.put("/staff/:id", async (c) => {
    const bad = holderOnly(c);
    if (bad) return bad;
    const u = await staffRow(c);
    if (!u) return apiError(c, 404, "not_found", "الموظف غير موجود");
    const p = await parseBody(c, staffSchema.partial().extend({ disabled: z.boolean().optional() }));
    if (!p.ok) return p.res;
    const now = Date.now();
    if (p.data.perms) {
      const perms = cleanPerms(c, p.data.perms);
      if (!perms.length) return apiError(c, 422, "no_perms", "اختر قسم واحد على الأقل");
      await run(c.env.DB, "UPDATE admin_users SET perms = ?, updated_at = ? WHERE id = ?", JSON.stringify(perms), now, u.id);
    }
    if (p.data.display_name) await run(c.env.DB, "UPDATE admin_users SET display_name = ?, updated_at = ? WHERE id = ?", p.data.display_name, now, u.id);
    if (p.data.disabled !== undefined) {
      await run(c.env.DB, "UPDATE admin_users SET disabled_at = ?, updated_at = ? WHERE id = ?", p.data.disabled ? now : null, now, u.id);
      if (p.data.disabled) await run(c.env.DB, "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", now, u.id);
    }
    await audit(c.env.DB, T(c), c.get("session").username, "staff.updated", u.username, p.data);
    return c.json({ ok: true });
  });
  api.post("/staff/:id/password", async (c) => {
    const bad = holderOnly(c);
    if (bad) return bad;
    const u = await staffRow(c);
    if (!u) return apiError(c, 404, "not_found", "الموظف غير موجود");
    const p = await parseBody(c, z.object({ password: z.string().min(12, "كلمة المرور 12 حرفًا على الأقل").max(256) }));
    if (!p.ok) return p.res;
    const now = Date.now();
    const hash = await hashPassword(p.data.password, c.env.PASSWORD_PEPPER, Number(c.env.PBKDF2_ITERATIONS || 100_000));
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE admin_users SET password_hash = ?, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?").bind(hash, now, u.id),
      c.env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").bind(now, u.id),
    ]);
    await audit(c.env.DB, T(c), c.get("session").username, "staff.password", u.username);
    return c.json({ ok: true });
  });
  api.delete("/staff/:id", async (c) => {
    const bad = holderOnly(c);
    if (bad) return bad;
    const u = await staffRow(c);
    if (!u) return apiError(c, 404, "not_found", "الموظف غير موجود");
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(u.id),
      c.env.DB.prepare("DELETE FROM oauth_states WHERE user_id = ?").bind(u.id),
      c.env.DB.prepare("DELETE FROM password_resets WHERE user_id = ?").bind(u.id),
      c.env.DB.prepare("DELETE FROM email_codes WHERE user_id = ?").bind(u.id),
      c.env.DB.prepare("DELETE FROM admin_users WHERE id = ?").bind(u.id),
    ]);
    await audit(c.env.DB, T(c), c.get("session").username, "staff.deleted", u.username);
    return c.json({ ok: true });
  });

  // ---- Account email (password recovery): set → confirm with the emailed code
  api.get("/account/email", async (c) => {
    const u = await first<{ email: string | null; email_verified_at: number | null }>(c.env.DB, "SELECT email, email_verified_at FROM admin_users WHERE id = ?", c.get("session").user_id);
    return c.json({ email: u?.email ?? null, verified: !!u?.email_verified_at, enabled: emailEnabled(c.env) });
  });
  api.post("/account/email", async (c) => {
    const s = c.get("session");
    if (!(await rateLimit(c.env.DB, `email_code:${s.user_id}`, 5, 60 * 60_000))) return apiError(c, 429, "rate_limited", "طلبات كثيرة — حاول بعد ساعة");
    const p = await parseBody(c, z.object({ email: z.string().trim().max(254).email("اكتب إيميل صحيح") }));
    if (!p.ok) return p.res;
    const r = await sendEmailCode(c.env, s.user_id, p.data.email);
    if (!r.ok) {
      if (r.error === "email_not_configured") return apiError(c, 503, "email_off", "إرسال الإيميلات غير مفعّل بعد — تواصل مع إدارة الخدمة");
      if (r.error === "email_taken") return apiError(c, 409, "email_taken", "هذا الإيميل مستخدم في حساب ثاني");
      return apiError(c, 503, "email_failed", "ما قدرنا نرسل الإيميل الحين — حاول بعد شوي");
    }
    return c.json({ ok: true });
  });
  api.post("/account/email/verify", async (c) => {
    const s = c.get("session");
    if (!(await rateLimit(c.env.DB, `email_verify:${s.user_id}`, 10, 60 * 60_000))) return apiError(c, 429, "rate_limited", "محاولات كثيرة — حاول بعد ساعة");
    const p = await parseBody(c, z.object({ code: z.string().trim().min(6).max(10) }));
    if (!p.ok) return p.res;
    const r = await confirmEmailCode(c.env.DB, s.user_id, p.data.code);
    if (r === "invalid") return apiError(c, 422, "invalid_code", "الرمز غير صحيح");
    if (r === "expired") return apiError(c, 422, "expired", "الرمز انتهى — اطلب رمز جديد");
    if (r === "taken") return apiError(c, 409, "email_taken", "هذا الإيميل مستخدم في حساب ثاني");
    await audit(c.env.DB, s.tenant_id, s.username, "account.email_confirmed");
    return c.json({ ok: true });
  });
  // ---- Change password (Settings ← الأمان): current password → code to the confirmed email → applied.
  api.post("/account/password", async (c) => {
    const s = c.get("session");
    if (!(await rateLimit(c.env.DB, `pw_change:${s.user_id}`, 5, 60 * 60_000))) return apiError(c, 429, "rate_limited", "محاولات كثيرة — حاول بعد ساعة");
    const p = await parseBody(c, z.object({ current: z.string().min(1).max(256), password: z.string().min(12, "كلمة المرور الجديدة 12 حرفًا على الأقل").max(256) }));
    if (!p.ok) return p.res;
    const r = await startPasswordChange(c.env, s.user_id, p.data.current, p.data.password);
    if (r === "wrong_current") return apiError(c, 422, "wrong_current", "كلمة المرور الحالية غير صحيحة");
    if (r === "same") return apiError(c, 422, "same_password", "كلمة المرور الجديدة نفس الحالية");
    if (r === "no_email") return apiError(c, 409, "need_email", "أضف إيميلك وأكّده أول (من «إيميل استرجاع الحساب») — التغيير يحتاج تأكيد عليه");
    if (r === "email_off") return apiError(c, 503, "email_off", "إرسال الإيميلات غير مفعّل — تواصل مع إدارة الخدمة");
    if (r === "send_failed") return apiError(c, 503, "email_failed", "ما قدرنا نرسل الإيميل الحين — حاول بعد شوي");
    return c.json({ ok: true });
  });
  api.post("/account/password/confirm", async (c) => {
    const s = c.get("session");
    if (!(await rateLimit(c.env.DB, `pw_confirm:${s.user_id}`, 10, 60 * 60_000))) return apiError(c, 429, "rate_limited", "محاولات كثيرة — حاول بعد ساعة");
    const p = await parseBody(c, z.object({ code: z.string().trim().min(6).max(10) }));
    if (!p.ok) return p.res;
    const r = await confirmPasswordChange(c.env, s.user_id, s.id, p.data.code);
    if (r === "invalid") return apiError(c, 422, "invalid_code", "الرمز غير صحيح");
    if (r === "expired") return apiError(c, 422, "expired", "الرمز انتهى — ابدأ التغيير من جديد");
    await audit(c.env.DB, s.tenant_id, s.username, "account.password_changed");
    return c.json({ ok: true });
  });
  api.post("/auth/sessions/revoke-others", async (c) => {
    await run(c.env.DB, "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL", Date.now(), c.get("session").user_id, c.get("session").id);
    return c.json({ ok: true });
  });

  // ---- Subscription of the logged-in customer
  api.get("/subscription", async (c) => {
    const e = await ENT(c);
    const [messages, activeCampaigns, draws, cycle] = await Promise.all([
      monthlyMessages(c.env.DB, T(c)),
      first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM campaigns WHERE tenant_id = ? AND status = 'active' AND deleted_at IS NULL", T(c)),
      drawsThisMonth(c.env.DB, T(c)),
      usageCycle(c.env.DB, T(c)),
    ]);
    return c.json({
      ...e,
      // Monthly limits renew every 30 days of the subscription (resets_at null = with the next renewal).
      usage: { messages, active_campaigns: activeCampaigns?.n ?? 0, draws_this_month: draws, cycle_start: cycle.start, resets_at: cycle.resets_at },
      ...(await publicCatalog(c)),
      app_download_url: await appDownloadUrl(c),
    });
  });
  api.post("/subscription/redeem", async (c) => {
    if (!(await rateLimit(c.env.DB, `redeem:${T(c)}`, 10, 60 * 60_000))) return apiError(c, 429, "rate_limited", "محاولات كثيرة، حاول بعد ساعة");
    const p = await parseBody(c, z.object({ code: z.string().trim().min(4).max(40) }));
    if (!p.ok) return p.res;
    if (c.get("session").is_owner) return apiError(c, 409, "owner", "حساب المالك لا يحتاج اشتراكًا");
    // A discount code typed in the activation box: say where it goes.
    if (!/^HSN-/i.test(p.data.code.trim())) {
      const cp = await findCoupon(c.env.DB, p.data.code);
      if (cp) return apiError(c, 422, "is_coupon", `«${cp.code}» كود خصم ${cp.percent}% وليس كود تفعيل — استخدمه فوق في «الباقات وطرق الدفع» ← «عندك كود خصم؟» عشان يطلع لك السعر بعد الخصم.`);
    }
    try {
      const r = await withSchedulingNotice(c.env, T(c), () => redeemCode(c.env.DB, T(c), p.data.code));
      await audit(c.env.DB, T(c), c.get("session").username, "subscription.redeemed", r.plan_id, { expires_at: r.expires_at });
      return c.json({ ok: true, ...r });
    } catch (e) {
      if (e instanceof RedeemError) return apiError(c, 422, e.code, e.message);
      throw e;
    }
  });

  // Card payment (Moyasar): the account holder opens a payment page for one period of a plan.
  api.post("/subscription/pay", async (c) => {
    if (c.get("session").is_owner) return apiError(c, 409, "owner", "حساب المالك لا يحتاج اشتراكًا");
    if (c.get("session").role !== "owner") return apiError(c, 403, "holder_only", "الدفع لصاحب الحساب فقط");
    const p = await parseBody(c, z.object({ plan_id: z.string().max(20) }));
    if (!p.ok) return p.res;
    const block = await planChangeBlock(c.env, T(c), p.data.plan_id);
    if (block) return apiError(c, 409, block.code, block.message);
    if (!(await rateLimit(c.env.DB, `card_pay:${T(c)}`, 10, 3_600_000))) return apiError(c, 429, "rate_limited", "محاولات كثيرة، حاول بعد ساعة");
    try {
      // Back to the domain the API was called on (the web app's own domain, where its session cookie lives).
      const r = await startCardPayment(c.env, T(c), p.data.plan_id, c.get("session").username, new URL(c.req.url).origin);
      await audit(c.env.DB, T(c), c.get("session").username, "subscription.card_started", p.data.plan_id, { payment: r.id });
      return c.json({ ok: true, ...r });
    } catch (e) {
      if (e instanceof PayError) return apiError(c, e.status as any, e.code, e.message);
      throw e;
    }
  });
  // After returning from the payment page: re-checks that payment with Moyasar (own payments only).
  api.get("/subscription/pay/:id", async (c) => {
    const pay = await first<{ id: number; invoice_id: string | null; status: string; plan_id: string; amount: number; days: number; upgrade_id: number | null }>(
      c.env.DB,
      "SELECT id, invoice_id, status, plan_id, amount, days, upgrade_id FROM card_payments WHERE id = ? AND tenant_id = ?",
      Number(c.req.param("id")) || 0, T(c),
    );
    if (!pay) return apiError(c, 404, "not_found", "الدفعة غير موجودة");
    let status = pay.status;
    if (status === "initiated" && pay.invoice_id && cardEnabled(c.env) && (await rateLimit(c.env.DB, `card_check:${T(c)}`, 60, 3_600_000)))
      status = await syncInvoice(c.env, pay.invoice_id).catch(() => status);
    return c.json({ id: pay.id, status, plan_id: pay.plan_id, amount: pay.amount / 100, days: pay.days, upgrade: !!pay.upgrade_id });
  });

  // ---- Plan upgrade (automatic): the account holder pays the difference and the plan changes with the same expiry.
  api.use("/subscription/upgrade*", async (c, next) => {
    if (c.get("session").is_owner) return apiError(c, 409, "owner", "حساب المالك لا يحتاج اشتراكًا");
    if (c.req.method !== "GET" && c.get("session").role !== "owner") return apiError(c, 403, "holder_only", "الترقية لصاحب الحساب فقط");
    await next();
  });
  api.get("/subscription/upgrade", async (c) => {
    const u = await first<any>(
      c.env.DB,
      `SELECT u.id, u.from_plan, u.to_plan, f.name AS from_name, p.name AS to_name, u.status, u.amount, u.note, u.updated_at
         FROM plan_upgrades u LEFT JOIN plans f ON f.id = u.from_plan LEFT JOIN plans p ON p.id = u.to_plan
        WHERE u.tenant_id = ? AND u.status IN ('paid', 'done') AND u.updated_at > ? ORDER BY u.id DESC LIMIT 1`,
      T(c), Date.now() - 7 * 86_400_000,
    );
    return c.json({ upgrade: u ? { ...u, amount: u.amount === null ? null : u.amount / 100 } : null });
  });
  // What an upgrade costs now (fully automatic: the higher plan for the days left, less what is left of the current one).
  api.get("/subscription/upgrade/quote", async (c) => {
    try {
      const q = await quoteUpgrade(c.env, T(c), c.req.query("plan_id") ?? "");
      return c.json({ amount: q.amount / 100, days_left: q.days_left, used_messages: q.used_messages, messages_limit: q.messages_limit, new_value: q.new_value / 100, credit: q.credit / 100 });
    } catch (e) {
      if (e instanceof PayError) return apiError(c, e.status as any, e.code, e.message);
      throw e;
    }
  });
  // Starts an upgrade: the amount is computed now and the payment page opens; the plan changes once it is paid.
  api.post("/subscription/upgrade", async (c) => {
    const p = await parseBody(c, z.object({ plan_id: z.string().max(20) }));
    if (!p.ok) return p.res;
    if (!(await rateLimit(c.env.DB, `card_pay:${T(c)}`, 10, 3_600_000))) return apiError(c, 429, "rate_limited", "محاولات كثيرة، حاول بعد ساعة");
    const now = Date.now();
    try {
      const q = await quoteUpgrade(c.env, T(c), p.data.plan_id, now);
      await run(c.env.DB, "UPDATE plan_upgrades SET status = 'canceled', updated_at = ? WHERE tenant_id = ? AND status IN ('pending', 'approved')", now, T(c));
      const row = await run(
        c.env.DB,
        `INSERT INTO plan_upgrades (tenant_id, from_plan, to_plan, status, suggested, amount, used_messages, days_left, decided_by, decided_at, created_at, updated_at)
         VALUES (?, ?, ?, 'approved', ?, ?, ?, ?, 'auto', ?, ?, ?)`,
        T(c), q.from_plan, q.to_plan, q.amount, q.amount, q.used_messages, q.days_left, now, now, now,
      );
      const id = Number(row.meta.last_row_id);
      const to = await first<{ name: string }>(c.env.DB, "SELECT name FROM plans WHERE id = ?", q.to_plan);
      const r = await createInvoice(c.env, { tenantId: T(c), planId: q.to_plan, days: 0, amount: q.amount, description: `شيّك — ترقية إلى ${to?.name ?? q.to_plan}`, actor: c.get("session").username, siteOrigin: new URL(c.req.url).origin, upgradeId: id });
      await audit(c.env.DB, T(c), c.get("session").username, "subscription.upgrade_started", q.to_plan, { upgrade: id, from: q.from_plan, amount: q.amount, used: q.used_messages, payment: r.id });
      return c.json({ ok: true, upgrade_id: id, amount: q.amount / 100, ...r });
    } catch (e) {
      if (e instanceof PayError) return apiError(c, e.status as any, e.code, e.message);
      throw e;
    }
  });
  api.delete("/subscription/upgrade/:id", async (c) => {
    const r = await run(c.env.DB, "UPDATE plan_upgrades SET status = 'canceled', updated_at = ? WHERE id = ? AND tenant_id = ? AND status IN ('pending', 'approved')", Date.now(), Number(c.req.param("id")) || 0, T(c));
    if (!r.meta.changes) return apiError(c, 404, "not_found", "الطلب غير موجود");
    return c.json({ ok: true });
  });

  // ---- Owner panel (customers). Owner tenant only.
  const owner = new Hono<AppEnv>();
  owner.use("*", async (c, next) => {
    if (!c.get("session").is_owner) return apiError(c, 403, "owner_only", "هذه الصفحة لإدارة الخدمة فقط");
    await next();
  });
  // A notice to every active customer's bell (maintenance, an interruption, service back).
  owner.post("/broadcast", async (c) => {
    const p = await parseBody(c, z.object({ title: z.string().trim().min(3).max(200), body: z.string().trim().max(1000).optional(), link: z.enum(MESSAGE_LINK_PATHS).optional(), days: z.number().int().min(1).max(365).optional() }));
    if (!p.ok) return p.res;
    if (!(await rateLimit(c.env.DB, "owner_broadcast", 10, 3_600_000))) return apiError(c, 429, "rate_limited", "أرسلت إشعارات كثيرة — جرّب بعد شوي");
    const r = await sendOwnerMessage(c.env, { tenantId: null, title: p.data.title, body: p.data.body ?? null, link: p.data.link ?? "/", days: p.data.days ?? 7 });
    await audit(c.env.DB, T(c), c.get("session").username, "owner.broadcast", String(r.sent), { title: p.data.title });
    return c.json({ ok: true, sent: r.sent });
  });
  // Sent messages: remind (rings and flashes again) or delete (also from the customers' bell).
  owner.get("/messages", async (c) =>
    c.json(
      await all(
        c.env.DB,
        `SELECT m.id, m.tenant_id, n.name AS tenant_name, m.kind, m.title, m.body, m.link, m.keep_days, m.reminders, m.reminded_at, m.created_at,
                (SELECT GROUP_CONCAT(u.username, '، ') FROM admin_users u WHERE u.tenant_id = m.tenant_id AND u.role = 'owner') AS tenant_usernames,
                (SELECT COUNT(*) FROM owner_message_receipts r WHERE r.owner_message_id = m.id) AS copies,
                (SELECT COUNT(*) FROM owner_message_receipts r WHERE r.owner_message_id = m.id AND r.read_at IS NOT NULL) AS read,
                (SELECT COUNT(*) FROM owner_message_receipts r WHERE r.owner_message_id = m.id AND r.clicked_at IS NOT NULL) AS clicked,
                (SELECT COUNT(*) FROM owner_message_receipts r WHERE r.owner_message_id = m.id AND r.deleted_at IS NOT NULL) AS deleted,
                (SELECT MIN(r.read_at) FROM owner_message_receipts r WHERE r.owner_message_id = m.id) AS read_at,
                (SELECT MIN(r.clicked_at) FROM owner_message_receipts r WHERE r.owner_message_id = m.id) AS clicked_at,
                (SELECT MAX(r.deleted_at) FROM owner_message_receipts r WHERE r.owner_message_id = m.id) AS deleted_at
           FROM owner_messages m LEFT JOIN tenants n ON n.id = m.tenant_id ORDER BY m.id DESC LIMIT 50`,
      ),
    ),
  );
  // One sent message: who got it, who read it, who opened its link.
  owner.get("/messages/:id", async (c) =>
    c.json(
      await all(
        c.env.DB,
        `SELECT a.tenant_id, n.name AS tenant_name, (SELECT GROUP_CONCAT(u.username, '، ') FROM admin_users u WHERE u.tenant_id = a.tenant_id AND u.role = 'owner') AS tenant_usernames,
                a.delivered_at, a.last_delivered_at, a.read_at, a.clicked_at, a.deleted_at,
                EXISTS (SELECT 1 FROM app_notifications x WHERE x.owner_message_id = a.owner_message_id AND x.tenant_id = a.tenant_id) AS on_bell
           FROM owner_message_receipts a JOIN tenants n ON n.id = a.tenant_id WHERE a.owner_message_id = ? ORDER BY (a.clicked_at IS NULL), (a.read_at IS NULL), n.name LIMIT 1000`,
        idParam(c),
      ),
    ),
  );
  // Deletes every sent message (and their copies on the customers' bell).
  owner.delete("/messages", async (c) => {
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM app_notifications WHERE owner_message_id IS NOT NULL"),
      c.env.DB.prepare("DELETE FROM owner_message_receipts"),
      c.env.DB.prepare("DELETE FROM owner_messages"),
    ]);
    await audit(c.env.DB, T(c), c.get("session").username, "owner.messages_cleared", "all");
    return c.json({ ok: true });
  });
  owner.post("/messages/:id/remind", async (c) => {
    if (!(await rateLimit(c.env.DB, "owner_remind", 30, 3_600_000))) return apiError(c, 429, "rate_limited", "تذكيرات كثيرة — جرّب بعد شوي");
    const n = await remindOwnerMessage(c.env, idParam(c)!);
    if (!n) return apiError(c, 404, "not_found", "الرسالة غير موجودة أو ما فيه عملاء نشطين");
    return c.json({ ok: true, sent: n });
  });
  owner.delete("/messages/:id", async (c) => {
    await deleteOwnerMessage(c.env.DB, idParam(c)!);
    return c.json({ ok: true });
  });
  // Ready-made messages (notices / private), editable by the owner. Without a saved list: the defaults.
  owner.get("/message-templates", async (c) => c.json({ templates: await getSetting<MessageTemplates>(c.env.DB, OWNER_TENANT, "message_templates", DEFAULT_MESSAGE_TEMPLATES), defaults: DEFAULT_MESSAGE_TEMPLATES }));
  owner.put("/message-templates", async (c) => {
    const tpl = z.object({ label: z.string().trim().min(1).max(40), title: z.string().trim().min(3).max(200), body: z.string().trim().max(1000), link: z.enum(MESSAGE_LINK_PATHS), days: z.number().int().min(1).max(365) });
    const p = await parseBody(c, z.object({ notice: z.array(tpl).max(40), private: z.array(tpl).max(40) }));
    if (!p.ok) return p.res;
    await setSetting(c.env.DB, OWNER_TENANT, "message_templates", p.data);
    return c.json({ ok: true });
  });
  // A customer lost both the phone and the recovery codes: the owner turns their two-step login off.
  owner.post("/tenants/:id/totp-reset", async (c) => {
    const id = idParam(c);
    const t = id && (await first<{ is_owner: number }>(c.env.DB, "SELECT is_owner FROM tenants WHERE id = ?", id));
    if (!t || t.is_owner) return apiError(c, 404, "not_found", "العميل غير موجود");
    await run(c.env.DB, "UPDATE admin_users SET totp_ciphertext = NULL, totp_iv = NULL, totp_enabled_at = NULL, totp_last_step = NULL, totp_recovery = NULL, updated_at = ? WHERE tenant_id = ?", Date.now(), id);
    await audit(c.env.DB, T(c), c.get("session").username, "owner.totp_reset", String(id));
    return c.json({ ok: true });
  });
  // Diagnosis of one customer (no tokens, message texts or follower names): checks + details to download.
  owner.get("/tenants/:id/diagnose", async (c) => {
    const id = idParam(c);
    const t = id && (await first<{ is_owner: number }>(c.env.DB, "SELECT is_owner FROM tenants WHERE id = ?", id));
    if (!t || t.is_owner) return apiError(c, 404, "not_found", "العميل غير موجود");
    return c.json(await diagnoseTenant(c.env.DB, id!, c.env.APP_VERSION));
  });
  // Customer health: who may be about to leave, and why.
  owner.get("/health", async (c) => c.json({ customers: await customerHealth(c.env.DB) }));

  // Subscription coupons and referral reward.
  owner.get("/coupons", async (c) =>
    c.json({ coupons: await all(c.env.DB, "SELECT * FROM sub_coupons ORDER BY id DESC LIMIT 200"), referral_days: await referralDays(c.env.DB) }),
  );
  owner.post("/coupons", async (c) => {
    const p = await parseBody(
      c,
      z.object({
        code: z.string().trim().min(3).max(30),
        percent: z.number().int().min(1).max(100),
        plan_ids: z.array(z.string().max(40)).max(20).nullable().optional(),
        expires_at: z.number().int().positive().nullable().optional(),
        max_uses: z.number().int().min(1).max(1_000_000).nullable().optional(),
        note: z.string().trim().max(120).nullable().optional(),
      }),
    );
    if (!p.ok) return p.res;
    const code = normCode(p.data.code);
    if (code.length < 3) return apiError(c, 422, "validation", "الكود: 3 حروف إنجليزية أو أرقام على الأقل");
    if (await first(c.env.DB, "SELECT 1 FROM sub_coupons WHERE code = ?", code)) return apiError(c, 409, "exists", "الكود موجود — اختر كود ثاني");
    await run(
      c.env.DB,
      "INSERT INTO sub_coupons (code, percent, plan_ids, expires_at, max_uses, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      code,
      p.data.percent,
      p.data.plan_ids?.length ? JSON.stringify(p.data.plan_ids) : null,
      p.data.expires_at ?? null,
      p.data.max_uses ?? null,
      p.data.note ?? null,
      Date.now(),
    );
    await audit(c.env.DB, T(c), c.get("session").username, "owner.coupon_created", code, { percent: p.data.percent });
    return c.json({ ok: true, code });
  });
  owner.put("/coupons/:id", async (c) => {
    const p = await parseBody(c, z.object({ active: z.boolean() }));
    if (!p.ok) return p.res;
    await run(c.env.DB, "UPDATE sub_coupons SET active = ? WHERE id = ?", p.data.active ? 1 : 0, idParam(c));
    return c.json({ ok: true });
  });
  owner.delete("/coupons/:id", async (c) => {
    await run(c.env.DB, "DELETE FROM sub_coupons WHERE id = ?", idParam(c));
    return c.json({ ok: true });
  });
  owner.put("/referral", async (c) => {
    const p = await parseBody(c, z.object({ days: z.number().int().min(0).max(90) }));
    if (!p.ok) return p.res;
    await setSetting(c.env.DB, OWNER_TENANT, "referral_days", p.data.days);
    return c.json({ ok: true });
  });

  // ---- Support center (owner): every customer's tickets, FAQ, canned replies, response time and incident banner.
  const WHO = `(SELECT GROUP_CONCAT(u.username, '، ') FROM admin_users u WHERE u.tenant_id = t.tenant_id AND u.role = 'owner') AS tenant_usernames,
                (SELECT a.username FROM instagram_accounts a WHERE a.tenant_id = t.tenant_id ORDER BY a.id DESC LIMIT 1) AS ig_username,
                (SELECT st.name FROM stores st WHERE st.tenant_id = t.tenant_id AND st.status != 'disconnected' ORDER BY st.id DESC LIMIT 1) AS store_name`;
  const MSG_COLS = "id, sender, body, created_at, att_mime, att_size, (att_key IS NOT NULL AND att_deleted_at IS NULL) AS has_att, (att_deleted_at IS NOT NULL) AS att_removed";
  owner.get("/support", async (c) =>
    c.json(
      await all(
        c.env.DB,
        `SELECT t.id, t.tenant_id, n.name AS tenant_name, t.subject, t.category, t.state, t.priority, t.status, t.last_from, t.created_at, t.updated_at, ${WHO},
                (t.last_from = 'customer' AND COALESCE(t.owner_read_at, 0) < t.updated_at) AS unread,
                (SELECT body FROM support_messages m WHERE m.thread_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_body
           FROM support_threads t JOIN tenants n ON n.id = t.tenant_id
          ORDER BY (t.state = 'resolved'), CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.updated_at DESC LIMIT 300`,
      ),
    ),
  );
  // FAQ shown in the help widget (with optional YouTube / Instagram video links).
  const videoUrl = z
    .string()
    .trim()
    .max(300)
    .refine((v) => v === "" || /^https:\/\/((www\.|m\.)?youtube\.com|youtu\.be|(www\.)?instagram\.com)\//i.test(v), "رابط الفيديو لازم يكون من يوتيوب أو إنستقرام ويبدأ بـ https://");
  const faqSchema = z.object({ question: z.string().trim().min(3).max(200), answer: z.string().trim().min(1).max(3000), video_url: videoUrl.optional(), section_id: z.number().int().positive().nullable().optional(), sort: z.number().int().min(0).max(10_000).optional(), active: z.boolean().optional() });
  const sectionOk = async (c: C, id: number | null | undefined) => !id || !!(await first(c.env.DB, "SELECT 1 FROM support_faq_sections WHERE id = ?", id));
  owner.get("/support-faq", async (c) =>
    c.json({
      sections: await all(c.env.DB, "SELECT id, title, sort FROM support_faq_sections ORDER BY sort, id LIMIT 50"),
      items: await all(c.env.DB, "SELECT id, question, answer, video_url, section_id, sort, active FROM support_faq ORDER BY sort, id LIMIT 300"),
    }),
  );
  owner.post("/support-faq", async (c) => {
    const p = await parseBody(c, faqSchema);
    if (!p.ok) return p.res;
    if (!(await sectionOk(c, p.data.section_id))) return apiError(c, 422, "validation", "القسم غير موجود");
    const now = Date.now();
    const sort = p.data.sort ?? ((await first<{ n: number | null }>(c.env.DB, "SELECT MAX(sort) AS n FROM support_faq"))?.n ?? 0) + 1;
    const r = await first<{ id: number }>(c.env.DB, "INSERT INTO support_faq (question, answer, video_url, section_id, sort, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id", p.data.question, p.data.answer, p.data.video_url || null, p.data.section_id ?? null, sort, p.data.active === false ? 0 : 1, now, now);
    return c.json({ id: r!.id });
  });
  owner.put("/support-faq/:id", async (c) => {
    const p = await parseBody(c, faqSchema);
    if (!p.ok) return p.res;
    if (!(await sectionOk(c, p.data.section_id))) return apiError(c, 422, "validation", "القسم غير موجود");
    const r = await run(
      c.env.DB,
      "UPDATE support_faq SET question = ?, answer = ?, video_url = ?, section_id = CASE WHEN ? THEN ? ELSE section_id END, sort = COALESCE(?, sort), active = ?, updated_at = ? WHERE id = ?",
      p.data.question, p.data.answer, p.data.video_url || null, p.data.section_id !== undefined ? 1 : 0, p.data.section_id ?? null, p.data.sort ?? null, p.data.active === false ? 0 : 1, Date.now(), idParam(c),
    );
    if (!r.meta.changes) return apiError(c, 404, "not_found", "السؤال غير موجود");
    return c.json({ ok: true });
  });
  // Moves a question to a section (null = no section) and/or a new place in the order.
  owner.post("/support-faq/:id/move", async (c) => {
    const p = await parseBody(c, z.object({ section_id: z.number().int().positive().nullable().optional(), sort: z.number().int().min(0).max(10_000).optional() }));
    if (!p.ok) return p.res;
    if (!(await sectionOk(c, p.data.section_id))) return apiError(c, 422, "validation", "القسم غير موجود");
    await run(c.env.DB, "UPDATE support_faq SET section_id = CASE WHEN ? THEN ? ELSE section_id END, sort = COALESCE(?, sort), updated_at = ? WHERE id = ?", p.data.section_id !== undefined ? 1 : 0, p.data.section_id ?? null, p.data.sort ?? null, Date.now(), idParam(c));
    return c.json({ ok: true });
  });
  // Sections of the FAQ.
  const sectionSchema = z.object({ title: z.string().trim().min(1).max(80) });
  owner.post("/support-faq-sections", async (c) => {
    const p = await parseBody(c, sectionSchema);
    if (!p.ok) return p.res;
    if (((await first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM support_faq_sections"))?.n ?? 0) >= 50) return apiError(c, 409, "too_many", "الحد 50 قسم");
    const sort = ((await first<{ n: number | null }>(c.env.DB, "SELECT MAX(sort) AS n FROM support_faq_sections"))?.n ?? 0) + 1;
    const r = await first<{ id: number }>(c.env.DB, "INSERT INTO support_faq_sections (title, sort, created_at) VALUES (?, ?, ?) RETURNING id", p.data.title, sort, Date.now());
    return c.json({ id: r!.id });
  });
  owner.put("/support-faq-sections/order", async (c) => {
    const p = await parseBody(c, z.object({ ids: z.array(z.number().int().positive()).max(50) }));
    if (!p.ok) return p.res;
    await c.env.DB.batch(p.data.ids.map((id, i) => c.env.DB.prepare("UPDATE support_faq_sections SET sort = ? WHERE id = ?").bind(i, id)));
    return c.json({ ok: true });
  });
  owner.put("/support-faq-sections/:id", async (c) => {
    const p = await parseBody(c, sectionSchema);
    if (!p.ok) return p.res;
    await run(c.env.DB, "UPDATE support_faq_sections SET title = ? WHERE id = ?", p.data.title, idParam(c));
    return c.json({ ok: true });
  });
  // Deleting a section keeps its questions (they move to «بدون قسم»).
  owner.delete("/support-faq-sections/:id", async (c) => {
    await run(c.env.DB, "UPDATE support_faq SET section_id = NULL WHERE section_id = ?", idParam(c));
    await run(c.env.DB, "DELETE FROM support_faq_sections WHERE id = ?", idParam(c));
    return c.json({ ok: true });
  });
  // Many questions at once from pasted text (sections created by title; a question already there is skipped).
  owner.post("/support-faq/import", async (c) => {
    const p = await parseBody(c, z.object({ text: z.string().max(100_000) }));
    if (!p.ok) return p.res;
    const parsed = parseFaqText(p.data.text);
    if (!parsed.sections.length) return apiError(c, 422, "validation", "ما لقينا أسئلة — كل سؤال يبدأ بـ «س:» وجوابه بـ «ج:»");
    // A question already there (same text) is moved to the pasted section and gets the pasted answer — not duplicated.
    const rows = await all<{ id: number; question: string; section_id: number | null }>(c.env.DB, "SELECT id, question, section_id FROM support_faq");
    const existing = new Map(rows.map((r) => [normFaq(r.question), r.id]));
    const left = new Set<number>();
    const sections = await all<{ id: number; title: string }>(c.env.DB, "SELECT id, title FROM support_faq_sections");
    let sSort = ((await first<{ n: number | null }>(c.env.DB, "SELECT MAX(sort) AS n FROM support_faq_sections"))?.n ?? 0) + 1;
    let qSort = ((await first<{ n: number | null }>(c.env.DB, "SELECT MAX(sort) AS n FROM support_faq"))?.n ?? 0) + 1;
    const now = Date.now();
    let added = 0;
    let updated = 0;
    for (const sec of parsed.sections) {
      let sid = sections.find((s) => normFaq(s.title) === normFaq(sec.title))?.id;
      if (!sid) {
        if (sections.length >= 50) return apiError(c, 409, "too_many", "الحد 50 قسم");
        sid = (await first<{ id: number }>(c.env.DB, "INSERT INTO support_faq_sections (title, sort, created_at) VALUES (?, ?, ?) RETURNING id", sec.title, sSort++, now))!.id;
        sections.push({ id: sid, title: sec.title });
      }
      for (const it of sec.items) {
        const video = it.video_url && /^https:\/\/((www\.|m\.)?youtube\.com|youtu\.be|(www\.)?instagram\.com)\//i.test(it.video_url) ? it.video_url : null;
        const known = existing.get(normFaq(it.question));
        if (known) {
          const was = rows.find((r) => r.id === known)?.section_id;
          if (was && was !== sid) left.add(was);
          await run(c.env.DB, "UPDATE support_faq SET answer = ?, video_url = COALESCE(?, video_url), section_id = ?, sort = ?, updated_at = ? WHERE id = ?", it.answer, video, sid, qSort++, now, known);
          updated++;
          continue;
        }
        const r = await first<{ id: number }>(c.env.DB, "INSERT INTO support_faq (question, answer, video_url, section_id, sort, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?) RETURNING id", it.question, it.answer, video, sid, qSort++, now, now);
        existing.set(normFaq(it.question), r!.id);
        added++;
      }
    }
    // A section the import emptied (e.g. «عام») is removed; sections the owner left empty on purpose stay.
    for (const id of left) await run(c.env.DB, "DELETE FROM support_faq_sections WHERE id = ? AND NOT EXISTS (SELECT 1 FROM support_faq f WHERE f.section_id = ?)", id, id);
    await audit(c.env.DB, T(c), c.get("session").username, "support.faq_import", String(added), { updated });
    return c.json({ ok: true, added, updated });
  });
  owner.delete("/support-faq/:id", async (c) => {
    await run(c.env.DB, "DELETE FROM support_faq WHERE id = ?", idParam(c));
    return c.json({ ok: true });
  });
  // Canned replies for the owner's answers.
  const cannedSchema = z.object({ title: z.string().trim().min(1).max(60), body: z.string().trim().min(1).max(2000) });
  owner.get("/support-canned", async (c) => c.json(await all(c.env.DB, "SELECT id, title, body FROM support_canned ORDER BY id LIMIT 100")));
  owner.post("/support-canned", async (c) => {
    const p = await parseBody(c, cannedSchema);
    if (!p.ok) return p.res;
    if (((await first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM support_canned"))?.n ?? 0) >= 100) return apiError(c, 409, "too_many", "الحد 100 رد جاهز");
    const r = await first<{ id: number }>(c.env.DB, "INSERT INTO support_canned (title, body, created_at) VALUES (?, ?, ?) RETURNING id", p.data.title, p.data.body, Date.now());
    return c.json({ id: r!.id });
  });
  owner.put("/support-canned/:id", async (c) => {
    const p = await parseBody(c, cannedSchema);
    if (!p.ok) return p.res;
    await run(c.env.DB, "UPDATE support_canned SET title = ?, body = ? WHERE id = ?", p.data.title, p.data.body, idParam(c));
    return c.json({ ok: true });
  });
  owner.delete("/support-canned/:id", async (c) => {
    await run(c.env.DB, "DELETE FROM support_canned WHERE id = ?", idParam(c));
    return c.json({ ok: true });
  });
  // The expected response time and the service-wide incident banner.
  owner.get("/support-settings", async (c) =>
    c.json({
      response_time: await getSetting<string>(c.env.DB, OWNER_TENANT, "support_response_time", ""),
      default_response_time: DEFAULT_RESPONSE_TIME,
      incident: (await getSetting<Incident | null>(c.env.DB, OWNER_TENANT, "support_incident", null)) ?? { active: false, text: "", tone: "warn" },
    }),
  );
  owner.put("/support-settings", async (c) => {
    const p = await parseBody(c, z.object({ response_time: z.string().trim().max(160).optional(), incident: z.object({ active: z.boolean(), text: z.string().trim().max(300), tone: z.enum(["info", "warn", "bad"]) }).optional() }));
    if (!p.ok) return p.res;
    if (p.data.incident?.active && !p.data.incident.text) return apiError(c, 422, "validation", "اكتب نص الإعلان");
    if (p.data.response_time !== undefined) await setSetting(c.env.DB, OWNER_TENANT, "support_response_time", p.data.response_time);
    if (p.data.incident) {
      await setSetting(c.env.DB, OWNER_TENANT, "support_incident", p.data.incident);
      await audit(c.env.DB, T(c), c.get("session").username, "support.incident", p.data.incident.active ? "on" : "off", { text: p.data.incident.text });
    }
    return c.json({ ok: true });
  });
  owner.get("/support/attachment/:mid", async (c) => {
    const m = await first<{ att_key: string }>(c.env.DB, "SELECT att_key FROM support_messages WHERE id = ? AND att_key IS NOT NULL AND att_deleted_at IS NULL", Number(c.req.param("mid")) || 0);
    const obj = m && c.env.MEDIA ? await c.env.MEDIA.get(m.att_key) : null;
    if (!obj) return c.text("not found", 404);
    return new Response(obj.body, { headers: { "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream", "Cache-Control": "private, max-age=600", "X-Content-Type-Options": "nosniff" } });
  });
  owner.get("/support/:id", async (c) => {
    const id = idParam(c);
    const t = await first(
      c.env.DB,
      `SELECT t.id, t.tenant_id, n.name AS tenant_name, t.subject, t.category, t.state, t.priority, t.status, t.created_at, ${WHO}
         FROM support_threads t JOIN tenants n ON n.id = t.tenant_id WHERE t.id = ?`,
      id,
    );
    if (!t) return apiError(c, 404, "not_found", "الطلب غير موجود");
    await run(c.env.DB, "UPDATE support_threads SET owner_read_at = ? WHERE id = ?", Date.now(), id);
    return c.json({ thread: t, messages: await all(c.env.DB, `SELECT ${MSG_COLS} FROM support_messages WHERE thread_id = ? ORDER BY id LIMIT 500`, id) });
  });
  owner.post("/support/:id/reply", async (c) => {
    const id = idParam(c);
    const p = await parseBody(c, z.object({ body: z.string().trim().min(1).max(4000), state: z.enum(["in_progress", "waiting", "resolved"]).optional(), close: z.boolean().optional() }));
    if (!p.ok) return p.res;
    const t = await first<{ id: number; tenant_id: number; subject: string }>(c.env.DB, "SELECT id, tenant_id, subject FROM support_threads WHERE id = ?", id);
    if (!t) return apiError(c, 404, "not_found", "الطلب غير موجود");
    const now = Date.now();
    const state = p.data.state ?? (p.data.close ? "resolved" : "waiting");
    const m = await first<{ id: number }>(c.env.DB, "INSERT INTO support_messages (thread_id, sender, body, created_at) VALUES (?, 'owner', ?, ?) RETURNING id", id, p.data.body, now);
    await run(c.env.DB, "UPDATE support_threads SET last_from = 'owner', owner_read_at = ? WHERE id = ?", now, id);
    await setState(c.env.DB, t.id, state, now);
    await notify(c.env, t.tenant_id, "support_reply", `🎧 رد الدعم على طلبك رقم ${ticketNo(t.id)} (${STATES[state]}): ${t.subject}\n${p.data.body.slice(0, 300)}`, undefined, { link: `/support?thread=${t.id}` });
    return c.json({ ok: true, message_id: m!.id });
  });
  // State and priority set by the owner; a new state is told to the customer.
  owner.post("/support/:id/meta", async (c) => {
    const p = await parseBody(c, z.object({ state: z.enum(["new", "in_progress", "waiting", "resolved"]).optional(), priority: z.enum(["low", "normal", "high", "urgent"]).optional() }));
    if (!p.ok) return p.res;
    const t = await first<{ id: number; tenant_id: number; subject: string; state: string }>(c.env.DB, "SELECT id, tenant_id, subject, state FROM support_threads WHERE id = ?", idParam(c));
    if (!t) return apiError(c, 404, "not_found", "الطلب غير موجود");
    if (p.data.priority) await run(c.env.DB, "UPDATE support_threads SET priority = ? WHERE id = ?", p.data.priority, t.id);
    if (p.data.state && p.data.state !== t.state) {
      await setState(c.env.DB, t.id, p.data.state);
      await notifyState(c.env, t, p.data.state);
    }
    return c.json({ ok: true });
  });
  // A private message to one customer: their bell, and their Telegram when they set it up.
  owner.post("/tenants/:id/message", async (c) => {
    const id = idParam(c);
    const p = await parseBody(c, z.object({ title: z.string().trim().min(3).max(200), body: z.string().trim().max(1000).optional(), link: z.enum(MESSAGE_LINK_PATHS).optional(), days: z.number().int().min(1).max(365).optional() }));
    if (!p.ok) return p.res;
    const t = id && (await first<{ id: number; is_owner: number }>(c.env.DB, "SELECT id, is_owner FROM tenants WHERE id = ?", id));
    if (!t || t.is_owner) return apiError(c, 404, "not_found", "العميل غير موجود");
    if (!(await rateLimit(c.env.DB, "owner_message", 60, 3_600_000))) return apiError(c, 429, "rate_limited", "أرسلت رسائل كثيرة — جرّب بعد شوي");
    await sendOwnerMessage(c.env, { tenantId: t.id, title: p.data.title, body: p.data.body ?? null, link: p.data.link ?? "/", days: p.data.days ?? 30 });
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
              (SELECT u.messages FROM usage_counters u WHERE u.tenant_id = t.id
                  AND u.month = 'c' || COALESCE(t.plan_started_at, t.created_at) || '-' || MAX(0, (? - COALESCE(t.plan_started_at, t.created_at)) / ${CYCLE_MS})) AS messages_month,
              (SELECT json_extract(p.limits, '$.monthly_messages') FROM plans p WHERE p.id = t.plan_id) AS messages_limit,
              (SELECT u.username FROM admin_users u WHERE u.tenant_id = t.id ORDER BY u.id LIMIT 1) AS username,
              (SELECT u.email FROM admin_users u WHERE u.tenant_id = t.id ORDER BY u.id LIMIT 1) AS email,
              (SELECT u.email_verified_at FROM admin_users u WHERE u.tenant_id = t.id ORDER BY u.id LIMIT 1) AS email_verified_at,
              (SELECT u.totp_enabled_at FROM admin_users u WHERE u.tenant_id = t.id ORDER BY u.id LIMIT 1) AS totp_enabled_at,
              (SELECT a.username FROM instagram_accounts a WHERE a.tenant_id = t.id AND a.is_demo = 0 ORDER BY (a.status = 'active') DESC, a.updated_at DESC LIMIT 1) AS ig_username,
              (SELECT a.status FROM instagram_accounts a WHERE a.tenant_id = t.id AND a.is_demo = 0 ORDER BY (a.status = 'active') DESC, a.updated_at DESC LIMIT 1) AS ig_status,
              (SELECT a.follow_gate_allowed FROM instagram_accounts a WHERE a.tenant_id = t.id AND a.is_demo = 0 ORDER BY (a.status = 'active') DESC, a.updated_at DESC LIMIT 1) AS follow_gate_allowed,
              (SELECT COUNT(*) FROM campaigns c WHERE c.tenant_id = t.id AND c.deleted_at IS NULL) AS campaigns,
              (SELECT COUNT(*) FROM campaigns c WHERE c.tenant_id = t.id AND c.deleted_at IS NULL AND c.status = 'active') AS active_campaigns,
              (SELECT COUNT(*) FROM conversation_flows f WHERE f.is_demo = 0 AND f.created_at > ? AND f.account_id IN (SELECT id FROM instagram_accounts WHERE tenant_id = t.id)) AS flows_30d,
              (SELECT MAX(s.last_seen_at) FROM sessions s JOIN admin_users u ON u.id = s.user_id WHERE u.tenant_id = t.id) AS last_seen_at
         FROM tenants t ORDER BY t.is_owner DESC, t.id DESC`,
      Date.now(),
      since,
    );
    return c.json(rows);
  });
  owner.post("/tenants", async (c) => {
    const p = await parseBody(c, tenantCreateSchema);
    if (!p.ok) return p.res;
    if (await first(c.env.DB, "SELECT 1 FROM admin_users WHERE username = ? COLLATE NOCASE", p.data.username)) return apiError(c, 409, "username_taken", "اسم الحساب هذا مسجّل من قبل — اختر غيره");
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
    await withSchedulingNotice(c.env, t.id, () => run(c.env.DB, "UPDATE tenants SET plan_id = ?, plan_expires_at = ?, plan_started_at = ?, expiry_notice_at = NULL, updated_at = ? WHERE id = ?", p.data.plan_id, expires, started, now, t.id));
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
    await deleteTenantSupportFiles(c.env, t.id);
    await deleteTenantCardFonts(c.env, t.id);
    await deleteTenantData(c.env.DB, t.id);
    await audit(c.env.DB, T(c), c.get("session").username, "tenant.deleted", String(t.id), { name: t.name });
    return c.json({ ok: true });
  });

  owner.get("/plans", async (c) => c.json(await listPlans(c.env.DB)));
  // Card payments (Moyasar), newest first, with the paid total.
  owner.get("/card-payments", async (c) => {
    const rows = await all(
      c.env.DB,
      `SELECT k.id, k.tenant_id, t.name AS tenant_name, k.plan_id, p.name AS plan_name, k.days, k.amount, k.status, k.invoice_id, k.paid_at, k.created_at
         FROM card_payments k LEFT JOIN tenants t ON t.id = k.tenant_id LEFT JOIN plans p ON p.id = k.plan_id
        ORDER BY k.id DESC LIMIT 200`,
    );
    const total = await first<{ n: number; sum: number | null }>(c.env.DB, "SELECT COUNT(*) AS n, SUM(amount) AS sum FROM card_payments WHERE status = 'paid'");
    return c.json({ enabled: cardEnabled(c.env), test_mode: isTestKey(c.env), payments: rows, paid_count: total?.n ?? 0, paid_total: (total?.sum ?? 0) / 100 });
  });
  // Upgrades (automatic), newest first: who moved from which plan to which, the usage then and the amount paid.
  owner.get("/upgrades", async (c) => {
    const rows = await all<any>(
      c.env.DB,
      `SELECT u.*, t.name AS tenant_name, f.name AS from_name, p.name AS to_name
         FROM plan_upgrades u LEFT JOIN tenants t ON t.id = u.tenant_id LEFT JOIN plans f ON f.id = u.from_plan LEFT JOIN plans p ON p.id = u.to_plan
        WHERE u.status IN ('paid', 'done') ORDER BY u.id DESC LIMIT 100`,
    );
    return c.json({ enabled: cardEnabled(c.env), upgrades: rows });
  });
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
    // empty = the plan's own price when it is in SAR; 0 = no card payment for this plan
    const card = p.data.card_price_sar === null || p.data.card_price_sar === undefined ? null : Math.round(p.data.card_price_sar * 100);
    const before = amount !== null && p.data.price_before ? p.data.price_before : null;
    await run(
      c.env.DB,
      "UPDATE plans SET name = ?, price_label = ?, price_amount = ?, price_before = ?, price_currency = ?, price_period = ?, card_price_halalas = ?, description = ?, limits = ?, active = ?, updated_at = ? WHERE id = ?",
      p.data.name, label, amount, before, currency, period, card, p.data.description ?? null, JSON.stringify(p.data.limits), p.data.active ? 1 : 0, Date.now(), pid,
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

  // ---- Payment methods (banks / wallets and their accounts), shown to buyers
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
      card_button_label: await getSetting<string>(c.env.DB, OWNER_TENANT, "card_button_label", ""),
      silence_alert: await getSetting<boolean>(c.env.DB, OWNER_TENANT, "silence_alert", true),
      price_note: (await getSetting<string | null>(c.env.DB, OWNER_TENANT, "price_note", null)) ?? DEFAULT_PRICE_NOTE,
      exchange_rates: knownRates(await getSetting<ExchangeRates>(c.env.DB, OWNER_TENANT, "exchange_rates", DEFAULT_RATES)),
      code_box: await codeBoxOf(c.env.DB),
    }),
  );
  owner.put("/settings", async (c) => {
    const httpsOrEmpty = z.string().trim().max(300).refine((v) => v === "" || /^https:\/\//.test(v), "الرابط يجب أن يبدأ بـ https://");
    const p = await parseBody(c, z.object({ sales_contact: httpsOrEmpty.optional(), app_download_url: httpsOrEmpty.optional(), card_button_label: z.string().trim().max(40).optional(), silence_alert: z.boolean().optional(), price_note: z.string().trim().max(60).optional(), exchange_rates: exchangeRatesSchema.optional(),
      code_box: z.object({
        enabled: z.boolean(),
        title: z.string().trim().max(60),
        text: z.string().trim().max(400),
        button_label: z.string().trim().max(40),
        // WhatsApp / Instagram / any https link, or an email (mailto:).
        button_url: z.string().trim().max(300).refine((v) => v === "" || /^(https:\/\/|mailto:)/.test(v), "الرابط يبدأ بـ https:// أو mailto:"),
      }).optional() }));
    if (!p.ok) return p.res;
    if (p.data.exchange_rates) await setSetting(c.env.DB, OWNER_TENANT, "exchange_rates", { USD: 1, ...p.data.exchange_rates });
    if (p.data.sales_contact !== undefined) await setSetting(c.env.DB, OWNER_TENANT, "sales_contact", p.data.sales_contact);
    if (p.data.app_download_url !== undefined) await setSetting(c.env.DB, OWNER_TENANT, "app_download_url", p.data.app_download_url);
    if (p.data.card_button_label !== undefined) await setSetting(c.env.DB, OWNER_TENANT, "card_button_label", p.data.card_button_label);
    if (p.data.silence_alert !== undefined) await setSetting(c.env.DB, OWNER_TENANT, "silence_alert", p.data.silence_alert);
    if (p.data.price_note !== undefined) await setSetting(c.env.DB, OWNER_TENANT, "price_note", p.data.price_note);
    if (p.data.code_box) await setSetting(c.env.DB, OWNER_TENANT, "code_box", p.data.code_box);
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
    if (T(c) === 1 && emailEnabled(c.env)) {
      const e = await lastEmailError(c.env);
      checks.push({ name: "الإيميل (Resend) — آخر خطأ", ok: e ? null : true, detail: e ? `${new Date(e.at).toISOString()} — ${e.error}` : "لا أخطاء مسجّلة" });
    }
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
    if (d.utm && !ent.limits.utm) d.utm = false;
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
  // ---- Customer fonts for congratulation cards: stored privately in R2 (2 per customer, 2 MB each), read back
  // by the card editor only. The customer confirms they have the right to use the font.
  type CardFont = { id: string; name: string; size: number; created_at: number };
  const FONT_BYTES = 2 * 1024 * 1024;
  const fontKind = (b: Uint8Array): string | null => {
    const tag = String.fromCharCode(b[0], b[1], b[2], b[3]);
    if (tag === "wOF2") return "font/woff2";
    if (tag === "wOFF") return "font/woff";
    if (tag === "OTTO") return "font/otf";
    if ((b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0) || tag === "true") return "font/ttf";
    return null;
  };
  api.get("/card-fonts", async (c) => c.json(await getSetting<CardFont[]>(c.env.DB, T(c), "card_fonts", [])));
  api.post("/card-fonts", async (c) => {
    if (!c.env.MEDIA) return apiError(c, 503, "no_storage", "مساحة حفظ الملفات غير مفعّلة على الخادم");
    const p = await parseBody(c, z.object({ name: z.string().trim().min(1).max(40), data: z.string().max(3_000_000), licensed: z.literal(true) }));
    if (!p.ok) return p.res;
    const fonts = await getSetting<CardFont[]>(c.env.DB, T(c), "card_fonts", []);
    if (fonts.length >= 2) return apiError(c, 409, "limit", "الحد خطّين — احذف خط قبل ما ترفع جديد");
    let bytes: Uint8Array;
    try {
      bytes = fromB64(p.data.data.replace(/^data:[^,]*,/, ""));
    } catch {
      return apiError(c, 422, "invalid", "الملف غير صالح");
    }
    if (bytes.length > FONT_BYTES) return apiError(c, 422, "size", "الخط أكبر من 2 ميقا");
    const mime = bytes.length >= 4 ? fontKind(bytes) : null;
    if (!mime) return apiError(c, 422, "type", "الملف مو خط — المقبول TTF أو OTF أو WOFF أو WOFF2");
    const id = randomToken(10).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || String(Date.now());
    await c.env.MEDIA.put(cardFontKey(T(c), id), bytes, { httpMetadata: { contentType: mime } });
    const font: CardFont = { id, name: p.data.name, size: bytes.length, created_at: Date.now() };
    await setSetting(c.env.DB, T(c), "card_fonts", [...fonts, font]);
    await audit(c.env.DB, T(c), c.get("session").username, "card_font.added", id, { name: font.name, size: font.size });
    return c.json({ ok: true, font });
  });
  api.get("/card-fonts/:id", async (c) => {
    const id = c.req.param("id");
    const fonts = await getSetting<CardFont[]>(c.env.DB, T(c), "card_fonts", []);
    if (!fonts.some((f) => f.id === id) || !c.env.MEDIA) return apiError(c, 404, "not_found", "الخط غير موجود");
    const obj = await c.env.MEDIA.get(cardFontKey(T(c), id));
    if (!obj) return apiError(c, 404, "not_found", "الخط غير موجود");
    return new Response(obj.body, { headers: { "Content-Type": obj.httpMetadata?.contentType ?? "font/ttf", "Cache-Control": "private, max-age=86400" } });
  });
  api.delete("/card-fonts/:id", async (c) => {
    const id = c.req.param("id");
    const fonts = await getSetting<CardFont[]>(c.env.DB, T(c), "card_fonts", []);
    if (!fonts.some((f) => f.id === id)) return c.json({ ok: true });
    await c.env.MEDIA?.delete(cardFontKey(T(c), id)).catch(() => undefined);
    await setSetting(c.env.DB, T(c), "card_fonts", fonts.filter((f) => f.id !== id));
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
    const text = p.data.kind === "report" ? await buildDailyReport(c.env.DB, T(c)) : "✅ تم ربط إشعارات شيّك بنجاح. ستصلك التنبيهات والتقرير اليومي هنا.";
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
    if (label === "none") where += " AND p.inbox_label IS NULL";
    else if (label) {
      // a built-in label or one the merchant typed
      where += " AND p.inbox_label = ?";
      params.push(label.slice(0, 24));
    }
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
      all<any>(c.env.DB, "SELECT id, direction, source, kind, text, created_at, sent_by FROM messages WHERE participant_id = ? ORDER BY id DESC LIMIT 200", id),
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
    // A built-in label (inquiry / order / complaint / other) or any short label the merchant types.
    const body = await parseBody(c, z.object({ label: z.string().trim().min(1).max(24).nullable() }));
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
      all(c.env.DB, "SELECT id, kind, title, body, link, read_at, expires_at, owner_message_id, created_at FROM app_notifications WHERE tenant_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY id DESC LIMIT 50", T(c), Date.now()),
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
  // The customer tapped a notification (its link opened).
  api.post("/app-notifications/:id/click", async (c) => {
    const now = Date.now();
    await c.env.DB.batch([
      receiptUpdate(c.env.DB, T(c), "clicked_at", "id = ?3", [idParam(c)], now),
      c.env.DB.prepare("UPDATE app_notifications SET clicked_at = COALESCE(clicked_at, ?), read_at = COALESCE(read_at, ?) WHERE id = ? AND tenant_id = ?").bind(now, now, idParam(c), T(c)),
    ]);
    return c.json({ ok: true });
  });
  api.delete("/app-notifications/:id", async (c) => {
    // The owner still sees that it was delivered / read / opened, and that it was removed.
    await c.env.DB.batch([
      receiptUpdate(c.env.DB, T(c), "deleted_at", "id = ?3", [idParam(c)], Date.now()),
      c.env.DB.prepare("DELETE FROM app_notifications WHERE id = ? AND tenant_id = ?").bind(idParam(c), T(c)),
    ]);
    return c.json({ ok: true });
  });
  // Clears every read notification of the bell.
  api.delete("/app-notifications", async (c) => {
    await c.env.DB.batch([
      receiptUpdate(c.env.DB, T(c), "deleted_at", "read_at IS NOT NULL", [], Date.now()),
      c.env.DB.prepare("DELETE FROM app_notifications WHERE tenant_id = ? AND read_at IS NOT NULL").bind(T(c)),
    ]);
    return c.json({ ok: true });
  });
  api.post("/app-notifications/read", async (c) => {
    const now = Date.now();
    await c.env.DB.batch([
      receiptUpdate(c.env.DB, T(c), "read_at", "read_at IS NULL", [], now),
      c.env.DB.prepare("UPDATE app_notifications SET read_at = ? WHERE tenant_id = ? AND read_at IS NULL").bind(now, T(c)),
    ]);
    return c.json({ ok: true });
  });

  // ---- Referral: the customer's invitation link
  api.get("/referral", async (c) => {
    if (c.get("session").is_owner) return apiError(c, 409, "owner", "الإحالة للعملاء");
    return c.json(await referralStats(c.env.DB, T(c)));
  });

  // ---- Support center (customer): tickets with the service owner, one optional file per message.
  const SUP_MSG_COLS = "id, sender, body, created_at, att_mime, att_size, (att_key IS NOT NULL AND att_deleted_at IS NULL) AS has_att, (att_deleted_at IS NOT NULL) AS att_removed";
  api.get("/support", async (c) =>
    c.json(
      await all(
        c.env.DB,
        `SELECT t.id, t.subject, t.category, t.state, t.status, t.last_from, t.created_at, t.updated_at, (t.last_from = 'owner' AND COALESCE(t.customer_read_at, 0) < t.updated_at) AS unread,
                (SELECT body FROM support_messages m WHERE m.thread_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_body
           FROM support_threads t WHERE t.tenant_id = ? ORDER BY (t.state = 'resolved'), t.updated_at DESC LIMIT 100`,
        T(c),
      ),
    ),
  );
  api.post("/support", async (c) => {
    const p = await parseBody(c, z.object({ category: z.enum(["tech", "question", "billing", "suggestion"]).default("question"), subject: z.string().trim().min(3).max(120), body: z.string().trim().min(1).max(4000) }));
    if (!p.ok) return p.res;
    if (c.get("session").is_owner) return apiError(c, 409, "owner", "أنت صاحب الخدمة — الدعم للعملاء");
    if (!(await rateLimit(c.env.DB, `support_new:${T(c)}`, 10, 86_400_000))) return apiError(c, 429, "rate_limited", "فتحت طلبات كثيرة اليوم — كمّل في طلب موجود");
    const now = Date.now();
    const t = await first<{ id: number }>(
      c.env.DB,
      "INSERT INTO support_threads (tenant_id, subject, category, state, last_from, customer_read_at, created_at, updated_at) VALUES (?, ?, ?, 'new', 'customer', ?, ?, ?) RETURNING id",
      T(c), p.data.subject, p.data.category, now, now, now,
    );
    const m = await first<{ id: number }>(c.env.DB, "INSERT INTO support_messages (thread_id, sender, body, created_at) VALUES (?, 'customer', ?, ?) RETURNING id", t!.id, p.data.body, now);
    const name = (await first<{ name: string }>(c.env.DB, "SELECT name FROM tenants WHERE id = ?", T(c)))?.name ?? "عميل";
    await notify(c.env, OWNER_TENANT, "support", `🎧 طلب دعم جديد رقم ${ticketNo(t!.id)} (${CATEGORIES[p.data.category]}) من «${name}»: ${p.data.subject}\n${p.data.body.slice(0, 300)}`, undefined, { link: `/owner?tab=support&thread=${t!.id}` });
    return c.json({ ok: true, id: t!.id, number: ticketNo(t!.id), message_id: m!.id });
  });
  api.get("/support/attachment/:mid", async (c) => {
    const m = await first<{ att_key: string }>(
      c.env.DB,
      "SELECT m.att_key FROM support_messages m JOIN support_threads t ON t.id = m.thread_id WHERE m.id = ? AND t.tenant_id = ? AND m.att_key IS NOT NULL AND m.att_deleted_at IS NULL",
      Number(c.req.param("mid")) || 0, T(c),
    );
    const obj = m && c.env.MEDIA ? await c.env.MEDIA.get(m.att_key) : null;
    if (!obj) return c.text("not found", 404);
    return new Response(obj.body, { headers: { "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream", "Cache-Control": "private, max-age=600", "X-Content-Type-Options": "nosniff" } });
  });
  api.get("/support/:id", async (c) => {
    const id = idParam(c);
    const t = await first(c.env.DB, "SELECT id, subject, category, state, status, created_at FROM support_threads WHERE id = ? AND tenant_id = ?", id, T(c));
    if (!t) return apiError(c, 404, "not_found", "الطلب غير موجود");
    await run(c.env.DB, "UPDATE support_threads SET customer_read_at = ? WHERE id = ?", Date.now(), id);
    return c.json({ thread: t, messages: await all(c.env.DB, `SELECT ${SUP_MSG_COLS} FROM support_messages WHERE thread_id = ? ORDER BY id LIMIT 500`, id) });
  });
  api.post("/support/:id/reply", async (c) => {
    const id = idParam(c);
    const p = await parseBody(c, z.object({ body: z.string().trim().min(1).max(4000) }));
    if (!p.ok) return p.res;
    const t = await first<{ id: number; subject: string; state: string }>(c.env.DB, "SELECT id, subject, state FROM support_threads WHERE id = ? AND tenant_id = ?", id, T(c));
    if (!t) return apiError(c, 404, "not_found", "الطلب غير موجود");
    if (!(await rateLimit(c.env.DB, `support_reply:${T(c)}`, 60, 3_600_000))) return apiError(c, 429, "rate_limited", "رسائل كثيرة — جرّب بعد شوي");
    const now = Date.now();
    const m = await first<{ id: number }>(c.env.DB, "INSERT INTO support_messages (thread_id, sender, body, created_at) VALUES (?, 'customer', ?, ?) RETURNING id", id, p.data.body, now);
    await run(c.env.DB, "UPDATE support_threads SET last_from = 'customer', customer_read_at = ? WHERE id = ?", now, id);
    await setState(c.env.DB, t.id, stateAfterCustomer(t.state), now);
    const name = (await first<{ name: string }>(c.env.DB, "SELECT name FROM tenants WHERE id = ?", T(c)))?.name ?? "عميل";
    await notify(c.env, OWNER_TENANT, "support", `🎧 رد من «${name}» على الطلب رقم ${ticketNo(t.id)}${t.state === "resolved" ? " (انفتح من جديد)" : ""}: ${t.subject}\n${p.data.body.slice(0, 300)}`, undefined, { link: `/owner?tab=support&thread=${t.id}` });
    return c.json({ ok: true, message_id: m!.id });
  });
  // The file of a message the customer just sent (body = the file): an image up to 5 MB or a video up to 25 MB.
  api.put("/support/:id/messages/:mid/attachment", async (c) => {
    if (!c.env.MEDIA) return apiError(c, 503, "no_storage", "مساحة حفظ الملفات غير مفعّلة على الخادم");
    const id = idParam(c) ?? 0;
    const m = await ownMessage(c.env.DB, T(c), id, Number(c.req.param("mid")) || 0);
    if (!m || m.sender !== "customer") return apiError(c, 404, "not_found", "الرسالة غير موجودة");
    if (m.att_key) return apiError(c, 409, "exists", "الرسالة فيها ملف من قبل");
    if (Date.now() - m.created_at > 3_600_000) return apiError(c, 409, "too_late", "أرفق الملف مع رسالة جديدة");
    const mime = (c.req.header("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
    const limit = attachLimit(mime);
    if (!limit) return apiError(c, 422, "type", "نوع الملف غير مدعوم: صورة (JPG / PNG / WEBP) أو فيديو (MP4 / MOV)");
    const size = Number(c.req.header("Content-Length") ?? 0);
    if (!size || size > limit) return apiError(c, 422, "size", limit === ATTACH.imageBytes ? "الصورة أكبر من 5 ميجا" : "الفيديو أكبر من 25 ميجا");
    if (!c.req.raw.body) return apiError(c, 400, "empty", "الملف فاضي");
    if (!(await rateLimit(c.env.DB, `support_upload:${T(c)}`, 30, 86_400_000))) return apiError(c, 429, "rate_limited", "رفعت ملفات كثيرة اليوم");
    const key = attachKey(T(c), id, m.id, randomToken(10), mime);
    const obj = await c.env.MEDIA.put(key, c.req.raw.body, { httpMetadata: { contentType: mime } });
    if (!obj || obj.size > limit) {
      await c.env.MEDIA.delete(key).catch(() => undefined);
      return apiError(c, 422, "size", "الملف أكبر من المسموح");
    }
    await run(c.env.DB, "UPDATE support_messages SET att_key = ?, att_mime = ?, att_size = ? WHERE id = ?", key, mime, obj.size, m.id);
    return c.json({ ok: true });
  });

  // ---- DM menu («القائمة التلقائية»): the customer's own menu, and how often each option was tapped
  api.get("/dm-menu", async (c) => {
    const e = await ENT(c);
    const menu = (await getSetting<DmMenu | null>(c.env.DB, T(c), "dm_menu", null)) ?? emptyMenu();
    const taps = await all<{ node_key: string; taps: number }>(c.env.DB, "SELECT node_key, taps FROM dm_menu_taps WHERE tenant_id = ?", T(c));
    return c.json({ menu, available: e.owner || (e.active && !!e.limits.dm_menu), taps: Object.fromEntries(taps.map((t) => [t.node_key, t.taps])) });
  });
  api.put("/dm-menu", async (c) => {
    const p = await parseBody(c, dmMenuSchema);
    if (!p.ok) return p.res;
    // Only the automatic menu is offered now: ice breakers and the persistent menu are cleared (also on Instagram).
    p.data.ice_breakers = [];
    p.data.persistent = [];
    p.data.keywords = p.data.keywords.filter((k) => k);
    const problem = menuProblem(p.data.root as MenuNode) ?? keywordsProblem(p.data as DmMenu) ?? extrasProblem(p.data as DmMenu);
    if (problem) return apiError(c, 422, "validation", problem);
    const parts = menuParts(p.data as DmMenu);
    if (parts.auto || parts.ice || parts.persistent) {
      const e = await ENT(c);
      if (!e.owner && !(e.active && e.limits.dm_menu)) return apiError(c, 403, "plan_feature", "القائمة التلقائية مو ضمن باقتك — رقّ باقتك من «اشتراكي»");
    }
    await setSetting(c.env.DB, T(c), "dm_menu", p.data);
    await audit(c.env.DB, T(c), c.get("session").username, "dm_menu.saved", p.data.enabled ? "on" : "off");
    // Ice breakers and persistent menu live on the Instagram account itself.
    const profile = await syncMenuProfile(c.env, T(c), p.data as DmMenu).catch((e) => [{ username: null, ok: false, error: String(e?.message ?? e).slice(0, 200) }]);
    return c.json({ ok: true, profile });
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
    await recordMessage(c.env.DB, { accountId: a.id, participantId: p.id, direction: "out", source: "manual", kind: "message", text: body.data.text, mid: r.data.message_id ?? null, at: now, sentBy: c.get("session").role === "staff" ? (c.get("session").display_name ?? c.get("session").username) : null });
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
    c.header("Content-Disposition", `attachment; filename="shayyek-backup-${new Date().toISOString().slice(0, 10)}.json"`);
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
