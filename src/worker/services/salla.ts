import type { Env } from "../env";
import { all, audit, first, run } from "../lib/db";
import { decryptSecret, encryptSecret, hex, timingSafeEqual } from "../lib/crypto";
import { serviceDomain } from "./domain";
import { notify } from "./notify";
import { normalizeUrl } from "./store";

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

/** A money value as Salla may send it: a number, a numeric string or { amount }. */
export function money(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") return Number.isFinite(Number(v)) ? Number(v) : null;
  if (v && typeof v === "object" && "amount" in (v as any)) return money((v as any).amount);
  return null;
}

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
    // The merchant's cost price, when set in Salla (read defensively; the cost entered in HSN wins).
    cost: money(p?.cost_price),
    ...stockOf(p),
  };
}

/** Availability as Salla may send it (status "out", is_available false, or a zero quantity without "unlimited"). */
export function stockOf(p: any): { stock: "in" | "out" | null; quantity: number | null } {
  const quantity = typeof p?.quantity === "number" ? p.quantity : p?.quantity != null && p.quantity !== "" && Number.isFinite(Number(p.quantity)) ? Number(p.quantity) : null;
  const known = p?.status != null || p?.is_available != null || quantity !== null;
  if (!known) return { stock: null, quantity: null };
  const out = p?.status === "out" || p?.is_available === false || (p?.unlimited_quantity !== true && quantity !== null && quantity <= 0);
  return { stock: out ? "out" : "in", quantity };
}

export function upsertProductStmt(db: D1Database, storeId: number, p: any, now: number) {
  const r = productRow(p);
  return db
    .prepare(
      `INSERT INTO store_products (store_id, product_id, name, url, image_url, price, currency, status, cost, stock_status, quantity, stock_changed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(store_id, product_id) DO UPDATE SET name = COALESCE(excluded.name, name), url = COALESCE(excluded.url, url),
         image_url = COALESCE(excluded.image_url, image_url), price = COALESCE(excluded.price, price), currency = COALESCE(excluded.currency, currency),
         status = COALESCE(excluded.status, status), cost = COALESCE(excluded.cost, cost),
         stock_changed_at = CASE WHEN excluded.stock_status IS NOT NULL AND excluded.stock_status IS NOT stock_status THEN excluded.stock_changed_at ELSE stock_changed_at END,
         stock_status = COALESCE(excluded.stock_status, stock_status), quantity = COALESCE(excluded.quantity, quantity), updated_at = excluded.updated_at`,
    )
    .bind(storeId, r.id, r.name, r.url, r.image, r.price, r.currency, r.status, r.cost, r.stock, r.quantity, now, now);
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
    const before = await stockBefore(env.DB, storeId, items.map((p) => String(p.id)));
    if (items.length) await env.DB.batch(items.map((p) => upsertProductStmt(env.DB, storeId, p, now)));
    for (const p of items) await applyStockChange(env, store, String(p.id), before.get(String(p.id)) ?? null, stockOf(p).stock, now);
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

/**
 * Only what the analytics need from an order: money lines, payment method, city and the customer id (hashed before
 * it is stored) — no shopper name, phone, email or street address.
 */
export function parseOrder(d: any) {
  const a = d?.amounts ?? {};
  const amount = money(a?.total) ?? money(d?.total);
  const discounts = Array.isArray(a?.discounts) ? a.discounts : [];
  const coupon = d?.coupon?.code ?? d?.coupon_code ?? discounts.find((x: any) => x?.code)?.code ?? null;
  const discountSum = discounts.reduce((t: number | null, x: any) => {
    const v = money(x?.discount) ?? money(x?.amount);
    return v === null ? t : (t ?? 0) + Math.abs(v);
  }, null as number | null);
  const items = (Array.isArray(d?.items) ? d.items : []).map((i: any) => ({
    product_id: String(i?.product?.id ?? i?.product_id ?? i?.id ?? ""),
    name: typeof i?.name === "string" ? i.name.slice(0, 200) : null,
    qty: Number(i?.quantity ?? 1) || 1,
    amount: money(i?.amounts?.total) ?? money(i?.amounts?.price_without_tax) ?? money(i?.price) ?? 0,
  }));
  const customerId = d?.customer?.id ?? d?.customer_id ?? null;
  const city = d?.customer?.city ?? d?.shipping?.address?.city ?? d?.ship_to?.city ?? null;
  const method = d?.payment_method ?? d?.payment?.method ?? null;
  return {
    id: String(d?.id ?? ""),
    reference: d?.reference_id != null ? String(d.reference_id) : null,
    status: String(d?.status?.slug ?? d?.status?.customized?.slug ?? d?.status?.name ?? d?.status ?? "").slice(0, 60) || null,
    total: amount,
    currency: a?.total?.currency ?? d?.currency ?? null,
    coupon: coupon ? String(coupon).trim().toUpperCase().slice(0, 60) : null,
    subtotal: money(a?.sub_total),
    discount: discountSum ?? money(a?.discount) ?? money(a?.total_discount),
    shipping: money(a?.shipping_cost),
    tax: money(a?.tax?.amount) ?? money(a?.tax),
    payment_method: typeof method === "string" && method ? method.slice(0, 40) : null,
    customer_id: customerId != null && customerId !== "" ? String(customerId) : null,
    city: typeof city === "string" && city.trim() ? city.trim().slice(0, 60) : null,
    items,
    ordered_at: ms(d?.date) ?? ms(d?.created_at) ?? null,
  };
}

/** A keyed one-way hash of the platform's customer id: tells returning buyers apart without keeping the id. */
async function customerHash(env: Env, merchantId: string, customerId: string | null): Promise<string | null> {
  if (!customerId) return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.TOKEN_ENC_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`salla-customer:${merchantId}:${customerId}`))).slice(0, 24);
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
      `INSERT INTO store_orders (store_id, order_id, reference, status, total, currency, coupon, items, ordered_at, updated_at,
         subtotal, discount, shipping, tax, payment_method, customer_hash, city)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(store_id, order_id) DO UPDATE SET reference = COALESCE(excluded.reference, reference), status = COALESCE(excluded.status, status),
         total = COALESCE(excluded.total, total), currency = COALESCE(excluded.currency, currency), coupon = COALESCE(excluded.coupon, coupon),
         items = CASE WHEN excluded.items != '[]' THEN excluded.items ELSE items END, updated_at = excluded.updated_at,
         subtotal = COALESCE(excluded.subtotal, subtotal), discount = COALESCE(excluded.discount, discount), shipping = COALESCE(excluded.shipping, shipping),
         tax = COALESCE(excluded.tax, tax), payment_method = COALESCE(excluded.payment_method, payment_method),
         customer_hash = COALESCE(excluded.customer_hash, customer_hash), city = COALESCE(excluded.city, city)`,
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
      o.subtotal,
      o.discount,
      o.shipping,
      o.tax,
      o.payment_method,
      await customerHash(env, merchantId, o.customer_id),
      o.city,
    );
    return "order";
  }
  if (event.startsWith("product.")) {
    if (!d?.id) return "no_id";
    if (event === "product.deleted") {
      await run(env.DB, "UPDATE store_products SET status = 'deleted', updated_at = ? WHERE store_id = ? AND product_id = ?", now, store.id, String(d.id));
      return "product_deleted";
    }
    const before = await stockBefore(env.DB, store.id, [String(d.id)]);
    await env.DB.batch([upsertProductStmt(env.DB, store.id, d, now)]);
    await applyStockChange(env, store, String(d.id), before.get(String(d.id)) ?? null, stockOf(d).stock, now);
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

/** Hourly, one minute per store: a full product re-read once a day, to catch any webhook Salla could not deliver. */
export async function dailyProductResync(env: Env, minute: number, now = Date.now()): Promise<number> {
  const due = await all<{ id: number }>(
    env.DB,
    "SELECT id FROM stores WHERE platform = 'salla' AND status = 'active' AND (id + 13) % 60 = ? AND COALESCE(products_synced_at, 0) < ? LIMIT 2",
    minute,
    now - 23 * 3_600_000,
  );
  let n = 0;
  for (const s of due) n += await syncProducts(env, s.id, defaultFetch, now, 3);
  return n;
}

// ---- stock ------------------------------------------------------------------------------------------------------

async function stockBefore(db: D1Database, storeId: number, ids: string[]): Promise<Map<string, string | null>> {
  if (!ids.length) return new Map();
  const rows = await all<{ product_id: string; stock_status: string | null }>(
    db,
    `SELECT product_id, stock_status FROM store_products WHERE store_id = ? AND product_id IN (${ids.map(() => "?").join(",")})`,
    storeId,
    ...ids,
  );
  return new Map(rows.map((r) => [r.product_id, r.stock_status]));
}

/**
 * A product ran out or came back: the customer's campaigns that link to it react by their stock_action, and the
 * merchant is told. Back in stock: auto-paused campaigns resume and waiting requests become ready to send.
 */
export async function applyStockChange(env: Env, store: { id: number; tenant_id: number }, productId: string, prev: string | null, next: "in" | "out" | null, now = Date.now()): Promise<void> {
  if (!next || prev === next || (prev === null && next === "in")) return;
  const product = await first<{ name: string | null; url: string | null }>(env.DB, "SELECT name, url FROM store_products WHERE store_id = ? AND product_id = ?", store.id, productId);
  const key = normalizeUrl(product?.url);
  if (!key) return;
  const camps = (
    await all<{ id: number; name: string; status: string; stock_action: string; stock_paused: number; final_url: string | null }>(
      env.DB,
      "SELECT id, name, status, stock_action, stock_paused, final_url FROM campaigns WHERE tenant_id = ? AND deleted_at IS NULL AND final_url IS NOT NULL",
      store.tenant_id,
    )
  ).filter((c) => normalizeUrl(c.final_url) === key && (c.status === "active" || c.stock_paused));
  if (!camps.length) return;
  const name = product?.name ?? "منتج";
  if (next === "out") {
    const lines: string[] = [];
    for (const c of camps) {
      if (c.stock_action === "pause" && c.status === "active") {
        await run(env.DB, "UPDATE campaigns SET stock_out_at = ?, status = 'paused', stock_paused = 1, updated_at = ? WHERE id = ?", now, now, c.id);
        lines.push(`⏸️ ${c.name}: أوقفناها مؤقتًا`);
      } else {
        await run(env.DB, "UPDATE campaigns SET stock_out_at = COALESCE(stock_out_at, ?) WHERE id = ?", now, c.id);
        lines.push(c.stock_action === "waitlist" ? `📝 ${c.name}: ترد «خلص المخزون» وتسجّل من يطلب التنبيه` : `▶️ ${c.name}: مستمرة (ترسل الرابط)`);
      }
    }
    await audit(env.DB, store.tenant_id, "system", "store.out_of_stock", productId, { campaigns: camps.map((c) => c.id) });
    await notify(env, store.tenant_id, "stock", `📦 نفد من المخزون: ${name}\nحملات تروّج له:\n${lines.join("\n")}`);
    return;
  }
  // Back in stock.
  let waiting = 0;
  for (const c of camps) {
    await run(env.DB, `UPDATE campaigns SET stock_out_at = NULL${c.stock_paused ? ", status = 'active', stock_paused = 0" : ""}, updated_at = ? WHERE id = ?`, now, c.id);
    const r = await run(env.DB, "UPDATE restock_waitlist SET ready_at = ? WHERE campaign_id = ? AND status = 'waiting' AND ready_at IS NULL", now, c.id);
    waiting += r.meta.changes ?? 0;
  }
  // Requests whose 24-hour window already closed cannot get a message: those people are told by a story.
  const closed = await first<{ n: number }>(
    env.DB,
    `SELECT COUNT(*) AS n FROM restock_waitlist w JOIN participants p ON p.id = w.participant_id
      WHERE w.campaign_id IN (${camps.map(() => "?").join(",")}) AND w.status = 'waiting' AND COALESCE(p.last_user_message_at, 0) < ?`,
    ...camps.map((c) => c.id),
    now - 86_400_000,
  );
  await audit(env.DB, store.tenant_id, "system", "store.back_in_stock", productId, { campaigns: camps.map((c) => c.id), waiting });
  const resumed = camps.filter((c) => c.stock_paused).map((c) => c.name);
  await notify(
    env,
    store.tenant_id,
    "stock",
    `✅ رجع للمخزون: ${name}${resumed.length ? `\n▶️ رجّعنا تشغيل: ${resumed.join("، ")}` : ""}${waiting ? `\n🔔 ${waiting} طلبوا التنبيه — نرسل لمن نافذة الـ24 ساعة عنده مفتوحة` : ""}`,
  );
  await notify(
    env,
    store.tenant_id,
    "story",
    `📣 حان وقت ستوري: «${name}» رجع متوفر\n${closed?.n ? `${closed.n} شخص طلبوا التنبيه وفاتت 24 ساعة على رسالتهم، فما نقدر نراسلهم — ستوري «رجع المنتج» يوصل لهم ولكل متابعينك.` : "ستوري «رجع المنتج» مع الرابط يذكّر متابعينك قبل لا يخلص مرة ثانية."}`,
  );
}
