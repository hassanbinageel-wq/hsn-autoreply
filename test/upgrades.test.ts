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

describe("plan upgrade: request → owner approves the difference → pay → same expiry", () => {
  beforeEach(async () => {
    await DB.prepare("UPDATE plans SET card_price_halalas = 4900 WHERE id = 'basic'").run();
    await DB.prepare("UPDATE plans SET card_price_halalas = 9900 WHERE id = 'pro'").run();
  });

  it("unused plan: full difference suggested; pay only after approval; the plan changes and the expiry stays", async () => {
    const { h, tid } = await register("shop_a");
    const before = await tenant(tid);
    expect((await call("/api/subscription/upgrade", h, "POST", { plan_id: "pro" })).status).toBe(200);
    expect(await notes(1)).toEqual(expect.arrayContaining([expect.stringContaining("طلب ترقية")]));
    const list = (await call("/api/owner/upgrades", OWNER)).body.upgrades;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: "pending", from_plan: "basic", to_plan: "pro", used_messages: 0, suggested: 5000 });
    expect(list[0].live).toMatchObject({ used_messages: 0, suggested: 5000, days_left: 10 });
    const id = list[0].id;

    // not approved yet → cannot pay
    expect((await call(`/api/subscription/upgrade/${id}/pay`, h, "POST", {})).status).toBe(409);
    expect((await call(`/api/owner/upgrades/${id}/approve`, OWNER, "POST", { amount_sar: 0.5 })).status).toBe(422);
    expect((await call(`/api/owner/upgrades/${id}/approve`, OWNER, "POST", { amount_sar: 50 })).body).toMatchObject({ ok: true, applied: false });
    expect((await call("/api/subscription/upgrade", h)).body.upgrade).toMatchObject({ id, status: "approved", amount: 50, to_plan: "pro" });

    stubMoyasar();
    const pay = await call(`/api/subscription/upgrade/${id}/pay`, h, "POST", {});
    expect(pay.status).toBe(200);
    expect(reqs[0].body).toMatchObject({ amount: 5000, currency: "SAR", metadata: { upgrade_id: String(id) } });
    expect((await tenant(tid)).plan_id).toBe("basic");
    remote = { status: "paid" };
    expect((await call(`/api/subscription/pay/${pay.body.id}`, h)).body).toMatchObject({ status: "paid", upgrade: true });
    const after = await tenant(tid);
    expect(after.plan_id).toBe("pro");
    expect(after.plan_expires_at).toBe(before.plan_expires_at);
    expect((await DB.prepare("SELECT status, payment_id FROM plan_upgrades WHERE id = ?").bind(id).first<any>())).toMatchObject({ status: "paid", payment_id: pay.body.id });
    // a second callback changes nothing
    expect((await call("/webhooks/moyasar", {}, "POST", { id: "inv_0001abcd" })).body.result).toBe("paid");
    expect((await notes(tid)).filter((t) => t.includes("تمت ترقية باقتك"))).toHaveLength(1);
  });

  it("a payment made after the request was cancelled still upgrades (the customer paid)", async () => {
    const { h, tid } = await register("shop_a");
    await call("/api/subscription/upgrade", h, "POST", { plan_id: "pro" });
    const id = (await call("/api/subscription/upgrade", h)).body.upgrade.id;
    await call(`/api/owner/upgrades/${id}/approve`, OWNER, "POST", { amount_sar: 50 });
    stubMoyasar();
    const pay = await call(`/api/subscription/upgrade/${id}/pay`, h, "POST", {});
    expect((await call(`/api/subscription/upgrade/${id}`, h, "DELETE")).status).toBe(200);
    remote = { status: "paid" };
    expect((await call(`/api/subscription/pay/${pay.body.id}`, h)).body.status).toBe("paid");
    expect((await tenant(tid)).plan_id).toBe("pro");
  });

  it("used plan: the difference for the days left is suggested", async () => {
    const { h, tid } = await register("shop_a");
    const cy = await usageCycle(DB, tid);
    await DB.prepare("INSERT INTO usage_counters (tenant_id, month, messages) VALUES (?, ?, 12)").bind(tid, cy.key).run();
    await call("/api/subscription/upgrade", h, "POST", { plan_id: "pro" });
    const u = (await call("/api/owner/upgrades", OWNER)).body.upgrades[0];
    expect(u.used_messages).toBe(12);
    // 50 SAR a month × 10 days / 30 = 16.67 → 17 SAR
    expect(u.suggested).toBe(1700);
    expect(u.live.full).toBe(5000);
  });

  it("free approval upgrades at once; rejecting tells the customer; lower plans and no-plan customers are refused", async () => {
    const { h, tid } = await register("shop_a");
    expect((await call("/api/subscription/upgrade", h, "POST", { plan_id: "basic" })).body.error.code).toBe("same_plan");
    await DB.prepare("UPDATE plans SET card_price_halalas = 1000 WHERE id = 'max'").run();
    expect((await call("/api/subscription/upgrade", h, "POST", { plan_id: "max" })).body.error.code).toBe("not_higher");

    await call("/api/subscription/upgrade", h, "POST", { plan_id: "pro" });
    let id = (await call("/api/owner/upgrades", OWNER)).body.upgrades[0].id;
    expect((await call(`/api/owner/upgrades/${id}/reject`, OWNER, "POST", { note: "تواصل معنا" })).status).toBe(200);
    expect((await call("/api/subscription/upgrade", h)).body.upgrade).toMatchObject({ status: "rejected", note: "تواصل معنا" });
    expect(await notes(tid)).toEqual(expect.arrayContaining([expect.stringContaining("ما انقبل طلب الترقية")]));

    await call("/api/subscription/upgrade", h, "POST", { plan_id: "pro" });
    id = (await call("/api/subscription/upgrade", h)).body.upgrade.id;
    expect((await call(`/api/owner/upgrades/${id}/approve`, OWNER, "POST", { amount_sar: 0 })).body.applied).toBe(true);
    expect((await tenant(tid)).plan_id).toBe("pro");
    expect((await call(`/api/owner/upgrades/${id}/approve`, OWNER, "POST", { amount_sar: 0 })).status).toBe(409);

    await DB.prepare("UPDATE tenants SET plan_expires_at = ? WHERE id = ?").bind(Date.now() - 1000, tid).run();
    expect((await call("/api/subscription/upgrade", h, "POST", { plan_id: "max" })).body.error.code).toBe("no_active_plan");
  });

  it("isolation: a customer never sees, pays or cancels another customer's upgrade; customers cannot approve", async () => {
    const a = await register("shop_a");
    const b = await register("shop_b");
    await call("/api/subscription/upgrade", a.h, "POST", { plan_id: "pro" });
    const id = (await call("/api/subscription/upgrade", a.h)).body.upgrade.id;
    await call(`/api/owner/upgrades/${id}/approve`, OWNER, "POST", { amount_sar: 50 });
    expect((await call("/api/subscription/upgrade", b.h)).body.upgrade).toBeNull();
    expect((await call(`/api/subscription/upgrade/${id}/pay`, b.h, "POST", {})).status).toBe(404);
    expect((await call(`/api/subscription/upgrade/${id}`, b.h, "DELETE")).status).toBe(404);
    expect((await call(`/api/owner/upgrades/${id}/approve`, b.h, "POST", { amount_sar: 0 })).status).toBe(403);
    expect((await call("/api/owner/upgrades", b.h)).status).toBe(403);
    expect((await tenant(a.tid)).plan_id).toBe("basic");
    // the owner of the request can cancel it
    expect((await call(`/api/subscription/upgrade/${id}`, a.h, "DELETE")).status).toBe(200);
    expect((await call(`/api/subscription/upgrade/${id}/pay`, a.h, "POST", {})).status).toBe(409);
  });
});
