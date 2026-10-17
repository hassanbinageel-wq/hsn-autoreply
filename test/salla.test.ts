import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DB, resetDb, seedAccount, TEST_ENV } from "./helpers";
import { claimStore, completeSallaOAuth, handleSallaWebhook, parseOrder, sallaAuthorizeUrl, verifySallaWebhook } from "../src/worker/services/salla";
import { normalizeUrl, storeAnalytics, storeProductCosts } from "../src/worker/services/store";

const BASE = "https://hsn.example.workers.dev";
const SELF = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
const DAY = 86_400_000;

/** Fake Salla accounts API: token exchange + merchant info. No network. */
function fakeSalla(merchantId = 9001) {
  const calls: string[] = [];
  const f = (async (u: string, init?: RequestInit) => {
    calls.push(String(u));
    if (String(u).endsWith("/oauth2/token")) {
      const body = String(init?.body ?? "");
      if (!body.includes("client_secret=salla_test_secret")) return new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 });
      return new Response(JSON.stringify({ access_token: "acc_" + merchantId, refresh_token: "ref_" + merchantId, expires_in: 14 * 86400 }));
    }
    if (String(u).endsWith("/oauth2/user/info")) return new Response(JSON.stringify({ data: { id: 1, merchant: { id: merchantId, name: "متجر تجريبي", domain: "https://demo.salla.sa" } } }));
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

async function hmac(secret: string, body: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const orderPayload = (id: string, opts: { total?: number; coupon?: string; status?: string; product?: string; at?: string } = {}) => ({
  event: "order.created",
  merchant: 9001,
  created_at: "2026-10-17 12:00:00",
  data: {
    id,
    reference_id: 1000 + Number(id.replace(/\D/g, "") || 0),
    status: { slug: opts.status ?? "under_review", name: "بإنتظار المراجعة" },
    amounts: { total: { amount: opts.total ?? 150, currency: "SAR" } },
    coupon: opts.coupon ? { code: opts.coupon } : null,
    date: { date: opts.at ?? new Date(Date.now() - DAY).toISOString() },
    customer: { first_name: "سارة", mobile: "+966500000000", email: "s@example.com" },
    shipping: { address: { street: "شارع سري" } },
    items: [{ id: 1, name: "عباية", quantity: 2, product: { id: opts.product ?? 555 }, amounts: { total: { amount: opts.total ?? 150 } } }],
  },
});

beforeEach(async () => {
  await resetDb();
  await seedAccount();
});

describe("Salla store connection", () => {
  it("connects a store through OAuth (code → tokens → merchant) and keeps a store with one customer only", async () => {
    const { f } = fakeSalla();
    const r = await completeSallaOAuth(TEST_ENV, "code123", 1, f);
    expect(r).toMatchObject({ ok: true, name: "متجر تجريبي" });
    const s = await DB.prepare("SELECT * FROM stores WHERE id = ?").bind(r.storeId).first<any>();
    expect(s).toMatchObject({ tenant_id: 1, platform: "salla", merchant_id: "9001", status: "active" });
    expect(s.token_ciphertext).not.toContain("acc_9001"); // encrypted at rest
    expect(s.token_expires_at).toBeGreaterThan(Date.now() + 13 * DAY);
    // the same Salla store cannot be taken by another customer
    const other = await completeSallaOAuth(TEST_ENV, "code456", 2, f);
    expect(other.ok).toBe(false);
    expect(other.error).toContain("عميل آخر");
    // the authorize link asks Salla for a refresh token and returns to our callback
    const u = new URL(sallaAuthorizeUrl(TEST_ENV, "st"));
    expect(u.origin + u.pathname).toBe("https://accounts.salla.sa/oauth2/auth");
    expect(u.searchParams.get("scope")).toBe("offline_access products.read orders.read");
    expect(u.searchParams.get("redirect_uri")).toContain("/oauth/salla/callback");
  });

  it("verifies webhooks by signature (HMAC-SHA256 of the raw body) or token, and rejects anything else", async () => {
    const body = JSON.stringify(orderPayload("o1"));
    const raw = new TextEncoder().encode(body);
    expect(await verifySallaWebhook(TEST_ENV, raw, await hmac("salla_webhook_secret_test", body), null)).toBe(true);
    expect(await verifySallaWebhook(TEST_ENV, raw, await hmac("wrong", body), null)).toBe(false);
    expect(await verifySallaWebhook(TEST_ENV, raw, null, "salla_webhook_secret_test")).toBe(true);
    expect(await verifySallaWebhook(TEST_ENV, raw, null, "nope")).toBe(false);
    expect(await verifySallaWebhook(TEST_ENV, raw, null, null)).toBe(false);
    // through the route: unsigned → 401, signed → stored
    await completeSallaOAuth(TEST_ENV, "c", 1, fakeSalla().f);
    expect((await SELF.fetch(new Request(`${BASE}/webhooks/salla`, { method: "POST", body }))).status).toBe(401);
    const ok = await SELF.fetch(new Request(`${BASE}/webhooks/salla`, { method: "POST", body, headers: { "X-Salla-Signature": await hmac("salla_webhook_secret_test", body) } }));
    expect(ok.status).toBe(200);
    expect(await DB.prepare("SELECT order_id FROM store_orders").first<any>()).toMatchObject({ order_id: "o1" });
  });

  it("stores orders without any shopper personal data, applies status updates, cancellations and products", async () => {
    await completeSallaOAuth(TEST_ENV, "c", 1, fakeSalla().f);
    expect(await handleSallaWebhook(TEST_ENV, orderPayload("o1", { coupon: "reel18" }))).toBe("order");
    const row = await DB.prepare("SELECT * FROM store_orders WHERE order_id = 'o1'").first<any>();
    expect(row).toMatchObject({ total: 150, currency: "SAR", coupon: "REEL18", status: "under_review" });
    const stored = JSON.stringify(row);
    for (const pii of ["سارة", "+966500000000", "s@example.com", "شارع سري"]) expect(stored).not.toContain(pii);
    expect(JSON.parse(row.items)).toEqual([{ product_id: "555", name: "عباية", qty: 2, amount: 150 }]);
    // a partial status update keeps the items and amount
    await handleSallaWebhook(TEST_ENV, { event: "order.status.updated", merchant: 9001, data: { id: "o1", status: { slug: "completed" } } });
    expect(await DB.prepare("SELECT status, total, items FROM store_orders WHERE order_id = 'o1'").first<any>()).toMatchObject({ status: "completed", total: 150 });
    await handleSallaWebhook(TEST_ENV, { event: "order.cancelled", merchant: 9001, data: { id: "o1" } });
    expect((await DB.prepare("SELECT status FROM store_orders WHERE order_id = 'o1'").first<any>()).status).toBe("canceled");
    // products; unknown merchants are ignored; uninstall disconnects
    await handleSallaWebhook(TEST_ENV, { event: "product.created", merchant: 9001, data: { id: 555, name: "عباية سوداء", price: { amount: 75, currency: "SAR" }, urls: { customer: "https://demo.salla.sa/p555/abaya" } } });
    expect(await DB.prepare("SELECT name, price, url FROM store_products WHERE product_id = '555'").first<any>()).toMatchObject({ name: "عباية سوداء", price: 75 });
    expect(await handleSallaWebhook(TEST_ENV, orderPayload("x9", {}) && { ...orderPayload("x9"), merchant: 1234 })).toBe("unknown_store");
    expect(await handleSallaWebhook(TEST_ENV, { event: "app.uninstalled", merchant: 9001, data: {} })).toBe("uninstalled");
    expect((await DB.prepare("SELECT status, token_ciphertext FROM stores").first<any>())).toMatchObject({ status: "disconnected", token_ciphertext: null });
    expect(parseOrder({ id: 5, total: { amount: "99.5" } }).total).toBe(99.5);
  });

  it("attributes orders to campaigns by discount code, links products by URL, excludes cancelled orders, and isolates customers", async () => {
    await completeSallaOAuth(TEST_ENV, "c", 1, fakeSalla().f);
    await handleSallaWebhook(TEST_ENV, { event: "product.created", merchant: 9001, data: { id: 555, name: "عباية", urls: { customer: "https://demo.salla.sa/p555/abaya" } } });
    const now = Date.now();
    await DB.prepare("INSERT INTO campaigns (tenant_id, name, type, status, final_text, final_url, store_coupon, created_at, updated_at) VALUES (1, 'حملة العباية', 'comment', 'active', 'x', 'https://www.demo.salla.sa/p555/abaya/?utm=ig', 'REEL18', ?, ?)").bind(now, now).run();
    await handleSallaWebhook(TEST_ENV, orderPayload("o1", { coupon: "REEL18", total: 200 }));
    await handleSallaWebhook(TEST_ENV, orderPayload("o2", { total: 100 }));
    await handleSallaWebhook(TEST_ENV, orderPayload("o3", { coupon: "REEL18", total: 999, status: "canceled" }));
    const a: any = await storeAnalytics(DB, 1, { from: now - 7 * DAY, to: now + 60_000, tzOffsetMin: 180 });
    expect(a.totals).toMatchObject({ orders: 2, revenue: 300, excluded: 1, attributed_orders: 1, attributed_revenue: 200 });
    const camp = a.campaigns.find((c: any) => c.name === "حملة العباية");
    expect(camp).toMatchObject({ coupon: "REEL18", orders: 1, revenue: 200, product: { id: "555" } });
    expect(a.products[0]).toMatchObject({ id: "555", orders: 2, units: 4 });
    expect(a.products[0].campaigns.map((c: any) => c.name)).toEqual(["حملة العباية"]);
    expect(normalizeUrl("https://www.demo.salla.sa/p555/abaya/?x=1")).toBe(normalizeUrl("https://demo.salla.sa/p555/abaya"));
    // another customer sees nothing
    expect((await storeAnalytics(DB, 999, { from: now - 7 * DAY, to: now, tzOffsetMin: 180 })).store).toBeNull();
  });

  it("reads money lines, payment method and city, hashes the customer, and computes profit from product costs", async () => {
    await completeSallaOAuth(TEST_ENV, "c", 1, fakeSalla().f);
    // Salla's cost price is read with the product; the cost entered in HSN wins over it.
    await handleSallaWebhook(TEST_ENV, { event: "product.created", merchant: 9001, data: { id: 555, name: "عباية", price: { amount: 100 }, cost_price: 40 } });
    await handleSallaWebhook(TEST_ENV, { event: "product.created", merchant: 9001, data: { id: 777, name: "شنطة", price: { amount: 50 } } });
    const order = (id: string, customer: number, product = 555, total = 230) => {
      const p = orderPayload(id, { total, product: String(product) }) as any;
      p.data.amounts = { sub_total: { amount: 200 }, shipping_cost: { amount: 25 }, tax: { percent: "15", amount: { amount: 30 } }, discounts: [{ code: "X", discount: "25.00" }], total: { amount: total, currency: "SAR" } };
      p.data.payment_method = "mada";
      p.data.customer = { id: customer, first_name: "سارة", city: "الرياض", mobile: "+966500000000" };
      p.data.items[0].amounts.total.amount = 200;
      return p;
    };
    await handleSallaWebhook(TEST_ENV, order("o1", 11));
    await handleSallaWebhook(TEST_ENV, order("o2", 11));
    await handleSallaWebhook(TEST_ENV, order("o3", 22, 777));
    const row = await DB.prepare("SELECT * FROM store_orders WHERE order_id = 'o1'").first<any>();
    expect(row).toMatchObject({ subtotal: 200, shipping: 25, tax: 30, discount: 25, payment_method: "mada", city: "الرياض" });
    expect(row.customer_hash).toMatch(/^[0-9a-f]{24}$/);
    expect(JSON.stringify(row)).not.toContain('"11"');
    const now = Date.now();
    const range = { from: now - 7 * DAY, to: now + 60_000, tzOffsetMin: 180 };
    let a: any = await storeAnalytics(DB, 1, range);
    // net = 230 − 30 − 25 = 175 per order; profit only over orders whose items all have a cost (o1, o2: 2 × 40 each)
    expect(a.totals).toMatchObject({ orders: 3, revenue: 690, net: 525, shipping: 75, tax: 90, discount: 75, profit_orders: 2 });
    expect(a.totals.profit).toBe(2 * (175 - 80));
    expect(a.customers).toMatchObject({ known: 2, new: 2, returning: 0, repeat_in_period: 1 });
    expect(a.payment_methods[0]).toMatchObject({ key: "mada", orders: 3 });
    expect(a.cities[0]).toMatchObject({ key: "الرياض", orders: 3 });
    expect(a.previous).toMatchObject({ orders: 0, revenue: 0 });
    // a default cost % covers the product without a cost; a manual cost overrides Salla's
    await DB.prepare("UPDATE stores SET default_cost_pct = 50").run();
    await DB.prepare("UPDATE store_products SET cost_manual = 60 WHERE product_id = '555'").run();
    a = await storeAnalytics(DB, 1, range);
    expect(a.totals.profit_orders).toBe(3);
    expect(a.totals.profit).toBe(2 * (175 - 120) + (175 - 100));
    // costs are per customer
    expect((await storeProductCosts(DB, 1)).length).toBe(2);
    expect(await storeProductCosts(DB, 999)).toEqual([]);
  });

  it("refuses a callback without a valid state", async () => {
    // no code at all → refused; a code without our state is exchanged with Salla (here: no network → fails), never linked to anyone
    expect((await SELF.fetch(new Request(`${BASE}/oauth/salla/callback?state=forged`))).status).toBe(400);
    const r = await SELF.fetch(new Request(`${BASE}/oauth/salla/callback?code=x&state=forged`, { redirect: "manual" }));
    expect(r.status).not.toBe(200);
    expect(await DB.prepare("SELECT COUNT(*) AS n FROM stores").first<any>()).toMatchObject({ n: 0 });
  });

  it("a store installed from Salla's side waits unclaimed, then belongs to the customer who claims it — only once", async () => {
    const r = await completeSallaOAuth(TEST_ENV, "c", 0, fakeSalla(7777).f);
    expect(r).toMatchObject({ ok: true, tenantId: 0 });
    expect((await storeAnalytics(DB, 1, { from: 0, to: Date.now(), tzOffsetMin: 180 })).store).toBeNull();
    expect(await claimStore(TEST_ENV, r.storeId!, 1)).toBe(true);
    expect(await claimStore(TEST_ENV, r.storeId!, 2)).toBe(false);
    expect((await DB.prepare("SELECT tenant_id FROM stores WHERE id = ?").bind(r.storeId).first<any>()).tenant_id).toBe(1);
    // a later install from Salla only refreshes the tokens of the owned store
    const again = await completeSallaOAuth(TEST_ENV, "c2", 0, fakeSalla(7777).f);
    expect(again.tenantId).toBe(1);
    // and another customer still cannot take it
    expect((await completeSallaOAuth(TEST_ENV, "c3", 2, fakeSalla(7777).f)).ok).toBe(false);
  });
});
