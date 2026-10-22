import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DB, resetDb, seedAccount } from "./helpers";
import { usageCycle } from "../src/worker/services/plans";

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
async function register(username: string) {
  const code = (await call("/api/owner/codes", OWNER, "POST", { plan_id: "basic", days: 10, count: 1 })).body.codes[0];
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

const notes = async (tid: number) => (await DB.prepare("SELECT title, body FROM app_notifications WHERE tenant_id = ? ORDER BY id").bind(tid).all<any>()).results.map((r) => `${r.title} ${r.body ?? ""}`);
/** Puts the customer `passed` days into a 30-day subscription of `plan`, with `used` messages in this cycle. */
async function setSub(tid: number, plan: string, passed: number, used = 0) {
  const now = Date.now();
  await DB.prepare("UPDATE tenants SET plan_id = ?, plan_started_at = ?, plan_expires_at = ? WHERE id = ?").bind(plan, now - passed * DAY, now + (30 - passed) * DAY, tid).run();
  if (used) {
    const cy = await usageCycle(DB, tid);
    await DB.prepare("INSERT INTO usage_counters (tenant_id, month, messages) VALUES (?, ?, ?) ON CONFLICT(tenant_id, month) DO UPDATE SET messages = excluded.messages").bind(tid, cy.key, used).run();
  }
}

describe("plan upgrade (automatic): pay the difference, same expiry; no downgrade while subscribed", () => {
  beforeEach(async () => {
    await DB.prepare("UPDATE plans SET card_price_halalas = 4900 WHERE id = 'basic'").run();
    await DB.prepare("UPDATE plans SET card_price_halalas = 9900 WHERE id = 'pro'").run();
  });

  it("the price follows the days left and the usage (basic 49 → pro 99 a month, 1000 messages)", async () => {
    const { h, tid } = await register("shop_a");
    const q = async () => (await call("/api/subscription/upgrade/quote?plan_id=pro", h)).body;
    await setSub(tid, "basic", 0);
    expect(await q()).toMatchObject({ amount: 50, used_messages: 0, days_left: 30, messages_limit: 1000 });
    // half the time passed, half the messages used → the difference for the days left
    await setSub(tid, "basic", 15, 500);
    expect(await q()).toMatchObject({ amount: 25, used_messages: 500, days_left: 15 });
    // half the time passed but all messages used → nothing left of the current plan to credit
    await setSub(tid, "basic", 15, 1000);
    expect(await q()).toMatchObject({ amount: 50, credit: 0 });
    // a few messages on day 0 barely change it
    await setSub(tid, "basic", 0, 100);
    expect((await q()).amount).toBe(55);
  });

  it("pay → the plan changes at once, the expiry stays, the owner sees it; no approval needed", async () => {
    const { h, tid } = await register("shop_a");
    await setSub(tid, "basic", 2, 40);
    const before = await tenant(tid);
    const amount = (await call("/api/subscription/upgrade/quote?plan_id=pro", h)).body.amount;
    stubMoyasar();
    const pay = await call("/api/subscription/upgrade", h, "POST", { plan_id: "pro" });
    expect(pay.status).toBe(200);
    expect(pay.body.url).toContain("checkout.moyasar.com");
    expect(reqs[0].body).toMatchObject({ amount: amount * 100, currency: "SAR", metadata: { upgrade_id: String(pay.body.upgrade_id) } });
    expect((await tenant(tid)).plan_id).toBe("basic");
    remote = { status: "paid" };
    expect((await call(`/api/subscription/pay/${pay.body.id}`, h)).body).toMatchObject({ status: "paid", upgrade: true });
    const after = await tenant(tid);
    expect(after.plan_id).toBe("pro");
    expect(after.plan_expires_at).toBe(before.plan_expires_at);
    expect((await call("/api/subscription/upgrade", h)).body.upgrade).toMatchObject({ status: "paid", to_plan: "pro" });
    expect((await call("/api/owner/upgrades", OWNER)).body.upgrades[0]).toMatchObject({ tenant_id: tid, from_plan: "basic", to_plan: "pro", used_messages: 40, amount: amount * 100, status: "paid" });
    expect(await notes(1)).toEqual(expect.arrayContaining([expect.stringContaining("دفع فرق ترقية")]));
    // a second callback changes nothing
    expect((await call("/webhooks/moyasar", {}, "POST", { id: "inv_0001abcd" })).body.result).toBe("paid");
    expect((await notes(tid)).filter((t) => t.includes("تمت ترقية باقتك"))).toHaveLength(1);
  });

  it("no moving down while subscribed (card or code), moving up only by upgrade; renewing the same plan is fine", async () => {
    const { h, tid } = await register("shop_a");
    await setSub(tid, "pro", 5);
    stubMoyasar();
    expect((await call("/api/subscription/pay", h, "POST", { plan_id: "basic" })).body.error.code).toBe("downgrade");
    expect((await call("/api/subscription/upgrade/quote?plan_id=basic", h)).body.error.code).toBe("not_higher");
    const code = (await call("/api/owner/codes", OWNER, "POST", { plan_id: "basic", days: 30, count: 1 })).body.codes[0];
    expect((await call("/api/subscription/redeem", h, "POST", { code })).body.error.code).toBe("downgrade");
    expect((await tenant(tid)).plan_id).toBe("pro");
    await DB.prepare("UPDATE plans SET card_price_halalas = 19900 WHERE id = 'max'").run();
    expect((await call("/api/subscription/pay", h, "POST", { plan_id: "max" })).body.error.code).toBe("use_upgrade");
    expect((await call("/api/subscription/pay", h, "POST", { plan_id: "pro" })).status).toBe(200);
    // after the subscription ends, any plan
    await DB.prepare("UPDATE tenants SET plan_expires_at = ? WHERE id = ?").bind(Date.now() - 1000, tid).run();
    expect((await call("/api/subscription/redeem", h, "POST", { code })).status).toBe(200);
    expect((await tenant(tid)).plan_id).toBe("basic");
    expect((await call("/api/subscription/upgrade/quote?plan_id=pro", h)).status).toBe(200);
    await DB.prepare("UPDATE tenants SET plan_expires_at = ? WHERE id = ?").bind(Date.now() - 1000, tid).run();
    expect((await call("/api/subscription/upgrade/quote?plan_id=pro", h)).body.error.code).toBe("no_active_plan");
  });

  it("isolation: a customer never sees another customer's upgrade; customers cannot read the owner's list", async () => {
    const a = await register("shop_a");
    const b = await register("shop_b");
    stubMoyasar();
    await call("/api/subscription/upgrade", a.h, "POST", { plan_id: "pro" });
    remote = { status: "paid" };
    await call("/webhooks/moyasar", {}, "POST", { id: "inv_0001abcd" });
    expect((await tenant(a.tid)).plan_id).toBe("pro");
    expect((await tenant(b.tid)).plan_id).toBe("basic");
    expect((await call("/api/subscription/upgrade", b.h)).body.upgrade).toBeNull();
    expect((await call("/api/owner/upgrades", b.h)).status).toBe(403);
  });
});
