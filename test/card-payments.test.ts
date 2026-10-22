import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DB, resetDb, seedAccount } from "./helpers";

const BASE = "https://hsn.example.workers.dev";
const SELF = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
type H = Record<string, string>;
const DAY = 86_400_000;

async function call(path: string, h: H = {}, method = "GET", body?: unknown) {
  const r = await SELF.fetch(new Request(BASE + path, { method, headers: { "Content-Type": "application/json", ...h }, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}
async function login(username: string, password: string): Promise<H> {
  const r = await call("/api/auth/login", {}, "POST", { username, password, client: "app" });
  if (!r.body?.token) throw new Error(`login failed: ${JSON.stringify(r.body)}`);
  return { Authorization: `Bearer ${r.body.token}` };
}

let OWNER: H;
beforeEach(async () => {
  await resetDb();
  await seedAccount();
  await call("/api/auth/setup", {}, "POST", { setup_token: "test_setup_token_123456", username: "admin", password: "a-very-strong-password" });
  OWNER = await login("admin", "a-very-strong-password");
  await DB.prepare("UPDATE plans SET card_price_halalas = 0, price_period = 'month'").run();
});
/** A customer on the pro plan for 10 days (paying pro by card renews it; moving to another plan is an upgrade). */
async function register(username: string) {
  const code = (await call("/api/owner/codes", OWNER, "POST", { plan_id: "pro", days: 10, count: 1 })).body.codes[0];
  expect((await call("/api/auth/register", {}, "POST", { name: `متجر ${username}`, username, password: "another-strong-password", code })).status).toBe(200);
  const h = await login(username, "another-strong-password");
  const tid = (await DB.prepare("SELECT tenant_id FROM admin_users WHERE username = ?").bind(username).first<any>()).tenant_id as number;
  return { h, tid };
}
const tenant = async (tid: number) => (await DB.prepare("SELECT plan_id, plan_expires_at FROM tenants WHERE id = ?").bind(tid).first<any>()) as { plan_id: string; plan_expires_at: number };

// ---- Moyasar stub: records requests; GET returns whatever `remote` says about the invoice.
type Req = { method: string; url: string; auth: string; body: any };
let reqs: Req[] = [];
let remote: { status: string; amount?: number; currency?: string } = { status: "initiated" };
const realFetch = globalThis.fetch;
function stubMoyasar() {
  reqs = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://api.moyasar.com/")) {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      reqs.push({ method: init?.method ?? "GET", url, auth: (init?.headers as Record<string, string>).Authorization, body });
      if (init?.method === "POST") return new Response(JSON.stringify({ id: "inv_0001abcd", status: "initiated", amount: body.amount, currency: body.currency, url: "https://checkout.moyasar.com/invoices/inv_0001abcd" }), { status: 201 });
      const created = reqs.find((r) => r.method === "POST")?.body;
      return new Response(JSON.stringify({ id: "inv_0001abcd", status: remote.status, amount: remote.amount ?? created?.amount, currency: remote.currency ?? "SAR" }), { status: 200 });
    }
    return realFetch(input as any, init);
  });
}
afterEach(() => vi.unstubAllGlobals());

describe("card payments (Moyasar)", () => {
  it("owner sets a fixed SAR price; the catalog shows it only for plans that have one", async () => {
    const plans = (await call("/api/owner/plans", OWNER)).body as any[];
    const pro = plans.find((p) => p.id === "pro");
    const r = await call("/api/owner/plans/pro", OWNER, "PUT", { name: pro.name, price_amount: pro.price_amount, price_currency: pro.price_currency, price_period: "month", card_price_sar: 149.5, description: pro.description ?? undefined, active: true, limits: pro.limits });
    expect(r.status).toBe(200);
    expect((await DB.prepare("SELECT card_price_halalas FROM plans WHERE id = 'pro'").first<any>()).card_price_halalas).toBe(14950);
    const { h } = await register("shop_a");
    const sub = (await call("/api/subscription", h)).body;
    expect(sub.card_payments).toBe(true);
    expect(sub.plans.find((p: any) => p.id === "pro").card_price).toBe(149.5);
    expect(sub.plans.find((p: any) => p.id === "basic").card_price).toBeNull();
  });

  it("empty card price = the plan's own SAR price; 0 switches card payment off", async () => {
    await DB.prepare("UPDATE plans SET price_amount = 2, price_currency = 'SAR', card_price_halalas = NULL WHERE id = 'pro'").run();
    await DB.prepare("UPDATE plans SET price_amount = 5, price_currency = 'USD', card_price_halalas = NULL WHERE id = 'max'").run();
    const plans = (await call("/api/public/plans")).body.plans as any[];
    expect(plans.find((p) => p.id === "pro").card_price).toBe(2);
    expect(plans.find((p) => p.id === "max").card_price).toBeNull();
    await DB.prepare("UPDATE plans SET card_price_halalas = 0 WHERE id = 'pro'").run();
    expect(((await call("/api/public/plans")).body.plans as any[]).find((p) => p.id === "pro").card_price).toBeNull();
  });

  it("sign-up without a code for a card-payable plan: no plan until it is paid, then activated", async () => {
    await DB.prepare("UPDATE plans SET card_price_halalas = 9900 WHERE id = 'pro'").run();
    // no code and no payable plan: refused, nothing created
    expect((await call("/api/auth/register", {}, "POST", { name: "متجر", username: "shop_x", password: "another-strong-password" })).body.error.code).toBe("code_required");
    expect((await call("/api/auth/register", {}, "POST", { name: "متجر", username: "shop_x", password: "another-strong-password", plan_id: "basic" })).body.error.code).toBe("code_required");
    expect(await DB.prepare("SELECT 1 FROM admin_users WHERE username = 'shop_x'").first()).toBeNull();

    expect((await call("/api/auth/register", {}, "POST", { name: "متجر", username: "shop_x", password: "another-strong-password", plan_id: "pro" })).status).toBe(200);
    const h = await login("shop_x", "another-strong-password");
    const tid = (await DB.prepare("SELECT tenant_id FROM admin_users WHERE username = 'shop_x'").first<any>()).tenant_id;
    expect((await tenant(tid)).plan_id).toBeNull();
    expect((await call("/api/subscription", h)).body.active).toBe(false);
    stubMoyasar();
    const pay = await call("/api/subscription/pay", h, "POST", { plan_id: "pro" });
    expect(pay.status).toBe(200);
    remote = { status: "paid" };
    expect((await call("/webhooks/moyasar", {}, "POST", { id: "inv_0001abcd" })).body.result).toBe("paid");
    const sub = (await call("/api/subscription", h)).body;
    expect(sub).toMatchObject({ active: true, plan: { id: "pro" } });
    expect(sub.expires_at - Date.now()).toBeGreaterThan(29 * DAY);
  });

  it("pay → forged callback does nothing → real paid invoice activates once (30 days after the current expiry)", async () => {
    await DB.prepare("UPDATE plans SET card_price_halalas = 9900 WHERE id = 'pro'").run();
    const { h, tid } = await register("shop_a");
    const before = (await tenant(tid)).plan_expires_at;
    stubMoyasar();
    const pay = await call("/api/subscription/pay", h, "POST", { plan_id: "pro" });
    expect(pay.status).toBe(200);
    expect(pay.body.url).toBe("https://checkout.moyasar.com/invoices/inv_0001abcd");
    expect(reqs[0]).toMatchObject({ method: "POST", url: "https://api.moyasar.com/v1/invoices", auth: `Basic ${btoa("sk_test_moyasar:")}` });
    expect(reqs[0].body).toMatchObject({ amount: 9900, currency: "SAR", callback_url: `${BASE}/webhooks/moyasar`, success_url: `${BASE}/#/subscription?paid=${pay.body.id}` });

    // A callback claiming "paid" while Moyasar says otherwise changes nothing.
    remote = { status: "initiated" };
    expect((await call("/webhooks/moyasar", {}, "POST", { id: "inv_0001abcd", status: "paid", amount: 9900, currency: "SAR" })).body.result).toBe("initiated");
    expect((await tenant(tid)).plan_expires_at).toBe(before);
    expect((await call(`/api/subscription/pay/${pay.body.id}`, h)).body.status).toBe("initiated");

    // Paid for real: activated, and a second callback / status check does not add days again.
    remote = { status: "paid" };
    expect((await call("/webhooks/moyasar", {}, "POST", { id: "inv_0001abcd" })).body.result).toBe("paid");
    const t = await tenant(tid);
    expect(t.plan_id).toBe("pro");
    expect(t.plan_expires_at - before).toBe(30 * DAY);
    expect((await call("/webhooks/moyasar", {}, "POST", { id: "inv_0001abcd" })).body.result).toBe("paid");
    expect((await call(`/api/subscription/pay/${pay.body.id}`, h)).body).toMatchObject({ status: "paid", amount: 99, days: 30 });
    expect((await tenant(tid)).plan_expires_at).toBe(t.plan_expires_at);

    const notes = await DB.prepare("SELECT tenant_id, title FROM app_notifications WHERE kind = 'plan' ORDER BY id").all<any>();
    expect(notes.results.filter((n: any) => n.tenant_id === tid)).toHaveLength(1);
    const list = (await call("/api/owner/card-payments", OWNER)).body;
    expect(list).toMatchObject({ enabled: true, test_mode: true, paid_count: 1, paid_total: 99 });
    expect(list.payments[0]).toMatchObject({ tenant_id: tid, plan_id: "pro", status: "paid" });
  });

  it("a paid invoice with a different amount or currency is not activated", async () => {
    await DB.prepare("UPDATE plans SET card_price_halalas = 9900 WHERE id = 'pro'").run();
    const { h, tid } = await register("shop_a");
    const before = (await tenant(tid)).plan_expires_at;
    stubMoyasar();
    const pay = await call("/api/subscription/pay", h, "POST", { plan_id: "pro" });
    remote = { status: "paid", amount: 100 };
    expect((await call("/webhooks/moyasar", {}, "POST", { id: "inv_0001abcd" })).body.result).toBe("mismatch");
    expect((await tenant(tid)).plan_expires_at).toBe(before);
    expect((await call(`/api/subscription/pay/${pay.body.id}`, h)).body.status).toBe("mismatch");
  });

  it("isolation: a customer cannot read another customer's payment; unknown invoices are ignored without a gateway call", async () => {
    await DB.prepare("UPDATE plans SET card_price_halalas = 9900 WHERE id = 'pro'").run();
    const a = await register("shop_a");
    const b = await register("shop_b");
    const bBefore = (await tenant(b.tid)).plan_expires_at;
    stubMoyasar();
    const pay = await call("/api/subscription/pay", a.h, "POST", { plan_id: "pro" });
    expect((await call(`/api/subscription/pay/${pay.body.id}`, b.h)).status).toBe(404);
    const n = reqs.length;
    expect((await call("/webhooks/moyasar", {}, "POST", { id: "inv_someone_else" })).body.result).toBe("unknown");
    expect(reqs.length).toBe(n);
    expect((await call("/webhooks/moyasar", {}, "POST", { id: "../x" })).status).toBe(400);
    expect((await tenant(b.tid)).plan_expires_at).toBe(bBefore);
  });

  it("plans without a card price or without a period cannot be paid by card; the owner never pays", async () => {
    const { h } = await register("shop_a");
    stubMoyasar();
    expect((await call("/api/subscription/pay", h, "POST", { plan_id: "pro" })).body.error.code).toBe("not_payable");
    await DB.prepare("UPDATE plans SET card_price_halalas = 9900, price_period = 'once' WHERE id = 'pro'").run();
    expect((await call("/api/subscription/pay", h, "POST", { plan_id: "pro" })).body.error.code).toBe("not_payable");
    expect((await call("/api/subscription/pay", OWNER, "POST", { plan_id: "pro" })).status).toBe(409);
    expect(reqs).toHaveLength(0);
  });

  it("serves the refund policy page", async () => {
    const r = await SELF.fetch(new Request(BASE + "/refund"));
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("سياسة الاسترجاع");
  });
});

describe("plan page: price before the discount and the card button text", () => {
  it("the owner sets a struck-through old price per plan and the button text; buyers see them", async () => {
    const plan = (await call("/api/owner/plans", OWNER)).body.find((p: any) => p.id === "basic");
    const body = { name: plan.name, price_amount: 79, price_before: 120, price_currency: "SAR", price_period: "month", active: true, limits: plan.limits };
    expect((await call("/api/owner/plans/basic", OWNER, "PUT", body)).status).toBe(200);
    expect((await call("/api/owner/settings", OWNER, "PUT", { card_button_label: "ابدأ الحين" })).status).toBe(200);
    let pub = (await call("/api/public/plans")).body;
    expect(pub.plans.find((p: any) => p.id === "basic").price_before).toBe(120);
    expect(pub.card_button_label).toBe("ابدأ الحين");
    // an old price at or below the price is not shown; an empty label falls back to «اشترك الآن»
    expect((await call("/api/owner/plans/basic", OWNER, "PUT", { ...body, price_before: 70 })).status).toBe(200);
    expect((await call("/api/owner/settings", OWNER, "PUT", { card_button_label: "" })).status).toBe(200);
    pub = (await call("/api/public/plans")).body;
    expect(pub.plans.find((p: any) => p.id === "basic").price_before).toBeNull();
    expect(pub.card_button_label).toBe("اشترك الآن");
  });
});

describe("plan page: note next to the price", () => {
  it("shows «شامل الضريبة المضافة 15%» by default; the owner can change it or clear it", async () => {
    expect((await call("/api/public/plans")).body.price_note).toBe("شامل الضريبة المضافة 15%");
    expect((await call("/api/owner/settings", OWNER, "PUT", { price_note: "السعر شامل الضريبة" })).status).toBe(200);
    expect((await call("/api/public/plans")).body.price_note).toBe("السعر شامل الضريبة");
    expect((await call("/api/owner/settings", OWNER, "PUT", { price_note: "" })).status).toBe(200);
    expect((await call("/api/public/plans")).body.price_note).toBe("");
  });
});
