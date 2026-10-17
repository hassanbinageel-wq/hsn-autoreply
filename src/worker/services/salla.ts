import type { Env } from "../env";
import { all, audit, first, run } from "../lib/db";
import { decryptSecret, encryptSecret, hex, timingSafeEqual } from "../lib/crypto";
import { serviceDomain } from "./domain";

/**
 * Salla store connection through Salla's official OAuth 2.0 ("Custom mode": the merchant approves on Salla and
 * comes back to /oauth/salla/callback with a code) and Salla webhooks. Read-only scopes (orders, products, special
 * offers); no shopper personal data is stored.
 *
 * From Salla's docs / official SDKs: authorize https://accounts.salla.sa/oauth2/auth, token
 * https://accounts.salla.sa/oauth2/token (scope offline_access gives a refresh token; access tokens last ~14 days;
 * a refresh token must not be reused in parallel), merchant info https://accounts.salla.sa/oauth2/user/info,
 * Admin API https://api.salla.dev/admin/v2. Webhooks carry {event, merchant, created_at, data} and are secured by
 * a signature (X-Salla-Signature: SHA-256 HMAC of the raw body with the webhook secret) or a token
 * (Authorization header equal to the secret) — both are accepted.
 */

const ACCOUNTS = "https://accounts.salla.sa/oauth2";
const API = "https://api.salla.dev/admin/v2";
export type Fetch = typeof fetch;
const defaultFetch: Fetch = (i, init) => fetch(i, init);

export function sallaConfigured(env: Env): boolean {
  return !!env.SALLA_CLIENT_ID && !!env.SALLA_CLIENT_SECRET;
}
export function sallaRedirectUri(env: Env): string {
  const d = serviceDomain(env);
  return d ? `https://${d}/oauth/salla/callback` : `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/oauth/salla/callback`;
}
export function sallaAuthorizeUrl(env: Env, state: string): string {
  const u = new URL(`${ACCOUNTS}/auth`);
  u.searchParams.set("client_id", env.SALLA_CLIENT_ID ?? "");
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", sallaRedirectUri(env));
  // The read-only scopes the app is configured with in the Partner Portal, plus offline_access for a refresh token.
  u.searchParams.set("scope", SALLA_SCOPES.join(" "));
  u.searchParams.set("state", state);
  return u.toString();
}

export const SALLA_SCOPES = ["offline_access", "products.read", "orders.read"] as const;

const aad = (merchantId: string) => `salla-token:${merchantId}`;
const aadRefresh = (merchantId: string) => `salla-refresh:${merchantId}`;

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  expires?: number;
}

async function tokenRequest(env: Env, body: Record<string, string>, f: Fetch): Promise<TokenResponse> {
  const r = await f(`${ACCOUNTS}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: env.SALLA_CLIENT_ID ?? "", client_secret: env.SALLA_CLIENT_SECRET ?? "", ...body }).toString(),
  });
  const j = (await r.json().catch(() => ({}))) as TokenResponse & { error?: string; error_description?: string; message?: string };
  if (!r.ok || !j.access_token) throw new Error(`token: ${j.error_description ?? j.error ?? j.message ?? `HTTP ${r.status}`}`.slice(0, 200));
  return j;
}

function expiry(t: TokenResponse, now: number): number {
  if (t.expires && t.expires > 1e9) return t.expires * 1000;
  return now + (t.expires_in ?? 14 * 86_400) * 1000;
}

async function saveTokens(env: Env, storeId: number, merchantId: string, t: TokenResponse, now: number) {
  const a = await encryptSecret(t.access_token!, env.TOKEN_ENC_KEY, aad(merchantId));
  const r = t.refresh_token ? await encryptSecret(t.refresh_token, env.TOKEN_ENC_KEY, aadRefresh(merchantId)) : null;
  await run(
    env.DB,
    `UPDATE stores SET token_ciphertext = ?, token_iv = ?, refresh_ciphertext = COALESCE(?, refresh_ciphertext), refresh_iv = COALESCE(?, refresh_iv),
       token_expires_at = ?, status = 'active', last_error = NULL, updated_at = ? WHERE id = ?`,
    a.ciphertext,
    a.iv,
    r?.ciphertext ?? null,
    r?.iv ?? null,
    expiry(t, now),
    now,
    storeId,
  );
}

export interface ConnectStoreResult {
  ok: boolean;
  error?: string;
  storeId?: number;
  name?: string;
  /** The customer the store belongs to (0 = installed from Salla, waiting to be claimed). */
  tenantId?: number;
}

/** Code → tokens → merchant info → store row for this customer (a Salla store belongs to one customer only). */
export async function completeSallaOAuth(env: Env, code: string, tenantId: number, f: Fetch = defaultFetch, now = Date.now()): Promise<ConnectStoreResult> {
  let t: TokenResponse;
  try {
    t = await tokenRequest(env, { grant_type: "authorization_code", code, redirect_uri: sallaRedirectUri(env), scope: "offline_access" }, f);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const info = await f(`${ACCOUNTS}/user/info`, { headers: { Authorization: `Bearer ${t.access_token}`, Accept: "application/json" } });
  const ij = (await info.json().catch(() => ({}))) as { data?: { merchant?: { id?: number | string; name?: string; domain?: string; avatar?: string; username?: string } } };
  const m = ij.data?.merchant;
  if (!info.ok || !m?.id) return { ok: false, error: `user_info: HTTP ${info.status}` };
  const merchantId = String(m.id);
  const owner = await first<{ id: number; tenant_id: number }>(env.DB, "SELECT id, tenant_id FROM stores WHERE platform = 'salla' AND merchant_id = ?", merchantId);
  // An install from Salla's side (tenantId 0) for a store someone already owns only refreshes its tokens.
  if (tenantId === 0 && owner && owner.tenant_id !== 0) {
    await run(env.DB, "UPDATE stores SET status = 'active', updated_at = ? WHERE id = ?", now, owner.id);
    await saveTokens(env, owner.id, merchantId, t, now);
    return { ok: true, storeId: owner.id, name: m.name, tenantId: owner.tenant_id };
  }
  // tenant 0 = installed from Salla but not claimed by an HSN customer yet (see claimStore).
  if (owner && owner.tenant_id !== tenantId && owner.tenant_id !== 0) {
    await audit(env.DB, tenantId, "system", "store.connect_refused", merchantId, { reason: "owned_by_other_tenant" });
    return { ok: false, error: "هذا المتجر مربوط بعميل آخر في الخدمة — تواصل مع الإدارة" };
  }
  // One Salla store per customer: a newly connected store replaces the previous one.
  if (tenantId !== 0) await run(env.DB, "UPDATE stores SET status = 'disconnected', token_ciphertext = NULL, token_iv = NULL, refresh_ciphertext = NULL, refresh_iv = NULL, updated_at = ? WHERE tenant_id = ? AND platform = 'salla' AND merchant_id != ?", now, tenantId, merchantId);
  const row = await first<{ id: number }>(
    env.DB,
    `INSERT INTO stores (tenant_id, platform, merchant_id, name, domain, avatar_url, status, connected_at, created_at, updated_at)
     VALUES (?, 'salla', ?, ?, ?, ?, 'active', ?, ?, ?)
     ON CONFLICT(platform, merchant_id) DO UPDATE SET name = excluded.name, domain = excluded.domain, avatar_url = excluded.avatar_url,
       tenant_id = CASE WHEN stores.tenant_id = 0 THEN excluded.tenant_id ELSE stores.tenant_id END,
       status = 'active', connected_at = excluded.connected_at, updated_at = excluded.updated_at
     RETURNING id`,
    tenantId,
    merchantId,
    m.name ?? m.username ?? null,
    m.domain ?? null,
    m.avatar ?? null,
    now,
    now,
    now,
  );
  await saveTokens(env, row!.id, merchantId, t, now);
  const linked = await first<{ tenant_id: number }>(env.DB, "SELECT tenant_id FROM stores WHERE id = ?", row!.id);
  if (tenantId !== 0) await audit(env.DB, tenantId, "admin", "store.connected", merchantId, { platform: "salla", name: m.name });
  return { ok: true, storeId: row!.id, name: m.name, tenantId: linked?.tenant_id ?? tenantId };
}

interface StoreRow {
  id: number;
  tenant_id: number;
  merchant_id: string;
  token_ciphertext: string | null;
  token_iv: string | null;
  refresh_ciphertext: string | null;
  refresh_iv: string | null;
  token_expires_at: number | null;
  status: string;
}

/** A valid access token, refreshed (once, serialized by the status check) when it expires within a day. */
export async function storeToken(env: Env, store: StoreRow, f: Fetch = defaultFetch, now = Date.now()): Promise<string | null> {
  if (store.status !== "active" || !store.token_ciphertext || !store.token_iv) return null;
  if (store.token_expires_at && store.token_expires_at - now < 86_400_000 && store.refresh_ciphertext && store.refresh_iv) {
    const refreshed = await refreshStore(env, store, f, now);
    if (refreshed) return refreshed;
  }
  try {
    return await decryptSecret(store.token_ciphertext, store.token_iv, env.TOKEN_ENC_KEY, aad(store.merchant_id));
  } catch {
    return null;
  }
}

async function refreshStore(env: Env, store: StoreRow, f: Fetch, now: number): Promise<string | null> {
  // Claim the refresh so two runs never use the same refresh token (Salla invalidates reused ones).
  const claimed = await run(env.DB, "UPDATE stores SET updated_at = ? WHERE id = ? AND updated_at < ?", now, store.id, now - 60_000);
  if (!claimed.meta.changes) return null;
  try {
    const rt = await decryptSecret(store.refresh_ciphertext!, store.refresh_iv!, env.TOKEN_ENC_KEY, aadRefresh(store.merchant_id));
    const t = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: rt }, f);
    await saveTokens(env, store.id, store.merchant_id, t, now);
    return t.access_token!;
  } catch (e) {
    await run(env.DB, "UPDATE stores SET status = 'needs_reauth', last_error = ?, updated_at = ? WHERE id = ?", (e as Error).message.slice(0, 300), now, store.id);
    await audit(env.DB, store.tenant_id, "system", "store.needs_reauth", store.merchant_id, { message: (e as Error).message.slice(0, 200) });
    return null;
  }
}

/** Daily: refresh tokens that expire within 3 days. */
export async function refreshStoreTokens(env: Env, f: Fetch = defaultFetch, now = Date.now()): Promise<void> {
  const rows = await all<StoreRow>(env.DB, "SELECT * FROM stores WHERE platform = 'salla' AND status = 'active' AND token_expires_at < ?", now + 3 * 86_400_000);
  for (const s of rows) await refreshStore(env, s, f, now);
}

// ---- products ----------------------------------------------------------------------------------------------------

function productRow(p: any) {
  const price = p?.price?.amount ?? p?.sale_price?.amount ?? (typeof p?.price === "number" ? p.price : null);
  return {
    id: String(p?.id ?? ""),
    name: typeof p?.name === "string" ? p.name.slice(0, 300) : null,
    url: p?.urls?.customer ?? p?.url ?? null,
    image: p?.main_image ?? p?.thumbnail ?? p?.images?.[0]?.url ?? null,
    price: typeof price === "number" ? price : price ? Number(price) || null : null,
    currency: p?.price?.currency ?? p?.currency ?? null,
    status: p?.status ?? null,
  };
}

export function upsertProductStmt(db: D1Database, storeId: number, p: any, now: number) {
  const r = productRow(p);
  return db
    .prepare(
      `INSERT INTO store_products (store_id, product_id, name, url, image_url, price, currency, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(store_id, product_id) DO UPDATE SET name = COALESCE(excluded.name, name), url = COALESCE(excluded.url, url),
         image_url = COALESCE(excluded.image_url, image_url), price = COALESCE(excluded.price, price), currency = COALESCE(excluded.currency, currency),
         status = COALESCE(excluded.status, status), updated_at = excluded.updated_at`,
    )
    .bind(storeId, r.id, r.name, r.url, r.image, r.price, r.currency, r.status, now);
}

/** Reads the store's products (a few pages per run; Salla's Admin API is paginated). */
export async function syncProducts(env: Env, storeId: number, f: Fetch = defaultFetch, now = Date.now(), maxPages = 5): Promise<number> {
  const store = await first<StoreRow>(env.DB, "SELECT * FROM stores WHERE id = ?", storeId);
  if (!store) return 0;
  const token = await storeToken(env, store, f, now);
  if (!token) return 0;
  let n = 0;
  for (let page = 1; page <= maxPages; page++) {
    const r = await f(`${API}/products?page=${page}&per_page=60`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (!r.ok) {
      // Keep Salla's own message to see why (scope, store state, token). Orders keep arriving by webhook meanwhile,
      // so a failed product read alone does not mark the store as needing re-authorization.
      const body = (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 220);
      await run(env.DB, "UPDATE stores SET last_error = ?, updated_at = ? WHERE id = ?", `قراءة المنتجات: HTTP ${r.status} ${body}`.slice(0, 300), now, storeId);
      return n;
    }
    const j = (await r.json().catch(() => ({}))) as { data?: any[]; pagination?: { currentPage?: number; totalPages?: number } };
    const items = (j.data ?? []).filter((p) => p?.id);
    if (items.length) await env.DB.batch(items.map((p) => upsertProductStmt(env.DB, storeId, p, now)));
    n += items.length;
    if (!j.pagination?.totalPages || page >= j.pagination.totalPages) break;
  }
  await run(env.DB, "UPDATE stores SET products_synced_at = ?, last_error = NULL WHERE id = ?", now, storeId);
  return n;
}

// ---- webhooks ----------------------------------------------------------------------------------------------------

export async function verifySallaWebhook(env: Env, raw: Uint8Array, signature: string | null, authorization: string | null): Promise<boolean> {
  const secret = env.SALLA_WEBHOOK_SECRET;
  if (!secret) return false;
  if (signature) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = hex(await crypto.subtle.sign("HMAC", key, raw));
    return timingSafeEqual(mac, signature.trim().toLowerCase());
  }
  if (authorization) return timingSafeEqual(authorization.replace(/^Bearer\s+/i, "").trim(), secret);
  return false;
}

const ms = (v: unknown): number | null => {
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  if (typeof v === "string") {
    const t = Date.parse(v.includes("T") || v.includes("Z") ? v : `${v.replace(" ", "T")}+03:00`);
    return Number.isFinite(t) ? t : null;
  }
  if (v && typeof v === "object" && "date" in (v as any)) return ms((v as any).date);
  return null;
};

/** Only what the analytics need from an order — no shopper name, phone, email or address. */
export function parseOrder(d: any) {
  const amount = d?.amounts?.total?.amount ?? d?.total?.amount ?? (typeof d?.total === "number" ? d.total : null);
  const coupon = d?.coupon?.code ?? d?.coupon_code ?? (Array.isArray(d?.amounts?.discounts) ? d.amounts.discounts.find((x: any) => x?.code)?.code : null) ?? null;
  const items = (Array.isArray(d?.items) ? d.items : []).map((i: any) => ({
    product_id: String(i?.product?.id ?? i?.product_id ?? i?.id ?? ""),
    name: typeof i?.name === "string" ? i.name.slice(0, 200) : null,
    qty: Number(i?.quantity ?? 1) || 1,
    amount: Number(i?.amounts?.total?.amount ?? i?.amounts?.price_without_tax?.amount ?? i?.price?.amount ?? 0) || 0,
  }));
  return {
    id: String(d?.id ?? ""),
    reference: d?.reference_id != null ? String(d.reference_id) : null,
    status: String(d?.status?.slug ?? d?.status?.customized?.slug ?? d?.status?.name ?? d?.status ?? "").slice(0, 60) || null,
    total: typeof amount === "number" ? amount : amount ? Number(amount) || null : null,
    currency: d?.amounts?.total?.currency ?? d?.currency ?? null,
    coupon: coupon ? String(coupon).trim().toUpperCase().slice(0, 60) : null,
    items,
    ordered_at: ms(d?.date) ?? ms(d?.created_at) ?? null,
  };
}

/** Applies one verified webhook. Unknown merchants and events are ignored. */
export async function handleSallaWebhook(env: Env, body: any, now = Date.now()): Promise<string> {
  const event = String(body?.event ?? "");
  const merchantId = String(body?.merchant ?? "");
  const d = body?.data ?? {};
  const store = await first<StoreRow & { name: string | null }>(env.DB, "SELECT * FROM stores WHERE platform = 'salla' AND merchant_id = ?", merchantId);
  if (!store) return "unknown_store";
  if (event === "app.uninstalled") {
    await run(env.DB, "UPDATE stores SET status = 'disconnected', token_ciphertext = NULL, token_iv = NULL, refresh_ciphertext = NULL, refresh_iv = NULL, updated_at = ? WHERE id = ?", now, store.id);
    await audit(env.DB, store.tenant_id, "system", "store.uninstalled", merchantId);
    return "uninstalled";
  }
  if (event === "app.store.authorize" && d?.access_token) {
    await saveTokens(env, store.id, merchantId, { access_token: d.access_token, refresh_token: d.refresh_token, expires: d.expires }, now);
    return "tokens";
  }
  if (store.status === "disconnected") return "disconnected";
  if (event.startsWith("order.")) {
    const o = parseOrder(d);
    if (!o.id) return "no_id";
    if (event === "order.deleted") {
      await run(env.DB, "UPDATE store_orders SET deleted = 1, updated_at = ? WHERE store_id = ? AND order_id = ?", now, store.id, o.id);
      return "deleted";
    }
    const status = event === "order.cancelled" ? "canceled" : event === "order.refunded" ? "refunded" : o.status;
    // Partial events (status / coupon / total updates) keep what they do not carry.
    await run(
      env.DB,
      `INSERT INTO store_orders (store_id, order_id, reference, status, total, currency, coupon, items, ordered_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(store_id, order_id) DO UPDATE SET reference = COALESCE(excluded.reference, reference), status = COALESCE(excluded.status, status),
         total = COALESCE(excluded.total, total), currency = COALESCE(excluded.currency, currency), coupon = COALESCE(excluded.coupon, coupon),
         items = CASE WHEN excluded.items != '[]' THEN excluded.items ELSE items END, updated_at = excluded.updated_at`,
      store.id,
      o.id,
      o.reference,
      status,
      o.total,
      o.currency,
      o.coupon,
      JSON.stringify(o.items.filter((i: any) => i.product_id)),
      o.ordered_at ?? now,
      now,
    );
    return "order";
  }
  if (event.startsWith("product.")) {
    if (!d?.id) return "no_id";
    if (event === "product.deleted") {
      await run(env.DB, "UPDATE store_products SET status = 'deleted', updated_at = ? WHERE store_id = ? AND product_id = ?", now, store.id, String(d.id));
      return "product_deleted";
    }
    await env.DB.batch([upsertProductStmt(env.DB, store.id, d, now)]);
    return "product";
  }
  return "ignored";
}

/**
 * Claims a store installed from Salla's side (no HSN state in the callback) for the signed-in customer, with the
 * one-time claim token shown on the callback page. A store that already belongs to someone cannot be claimed.
 */
export async function claimStore(env: Env, storeId: number, tenantId: number, now = Date.now()): Promise<boolean> {
  const s = await first<{ id: number; merchant_id: string }>(env.DB, "SELECT id, merchant_id FROM stores WHERE id = ? AND tenant_id = 0", storeId);
  if (!s) return false;
  await run(env.DB, "UPDATE stores SET status = 'disconnected', token_ciphertext = NULL, token_iv = NULL, refresh_ciphertext = NULL, refresh_iv = NULL, updated_at = ? WHERE tenant_id = ? AND platform = 'salla'", now, tenantId);
  await run(env.DB, "UPDATE stores SET tenant_id = ?, updated_at = ? WHERE id = ? AND tenant_id = 0", tenantId, now, storeId);
  await audit(env.DB, tenantId, "admin", "store.connected", s.merchant_id, { platform: "salla", via: "salla_install" });
  return true;
}
