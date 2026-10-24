import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DB, resetDb, seedAccount, TEST_ENV } from "./helpers";
import { getEntitlement, usageCycle } from "../src/worker/services/plans";
import { runPlanAlerts } from "../src/worker/services/notify";

const BASE = "https://hsn.example.workers.dev";
const SELF = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
type H = Record<string, string>;

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
});
async function register(username: string) {
  const code = (await call("/api/owner/codes", OWNER, "POST", { plan_id: "basic", days: 30, count: 1 })).body.codes[0];
  expect((await call("/api/auth/register", {}, "POST", { name: `متجر ${username}`, username, password: "another-strong-password", code })).status).toBe(200);
  const h = await login(username, "another-strong-password");
  const tid = (await DB.prepare("SELECT tenant_id FROM admin_users WHERE username = ?").bind(username).first<any>()).tenant_id as number;
  return { h, tid };
}
const setUsage = async (tid: number, n: number) =>
  DB.prepare("INSERT INTO usage_counters (tenant_id, month, messages) VALUES (?, ?, ?) ON CONFLICT(tenant_id, month) DO UPDATE SET messages = excluded.messages").bind(tid, (await usageCycle(DB, tid)).key, n).run();

// ---- Moyasar stub (same shape as the plan payments tests)
let reqs: Array<{ method: string; url: string; body: any }> = [];
let remote: { status: string } = { status: "initiated" };
const realFetch = globalThis.fetch;
function stubMoyasar() {
  reqs = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://api.moyasar.com/")) {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      reqs.push({ method: init?.method ?? "GET", url, body });
      if (init?.method === "POST") return new Response(JSON.stringify({ id: "inv_topup01", status: "initiated", amount: body.amount, currency: body.currency, url: "https://checkout.moyasar.com/invoices/inv_topup01" }), { status: 201 });
      const created = reqs.find((r) => r.method === "POST")?.body;
      return new Response(JSON.stringify({ id: "inv_topup01", status: remote.status, amount: created?.amount, currency: "SAR" }), { status: 200 });
    }
    return realFetch(input as any, init);
  });
}
afterEach(() => vi.unstubAllGlobals());

describe("message top-ups", () => {
  it("the owner manages packs; a customer of an allowed plan sees active ones only, from the threshold", async () => {
    const { h, tid } = await register("shop_a");
    const a = (await call("/api/owner/topups/packs", OWNER, "POST", { messages: 5000, price: 35, badge: "الأكثر طلبًا" })).body.id;
    await call("/api/owner/topups/packs", OWNER, "POST", { messages: 2000, price: 15, active: false });
    await call("/api/owner/topups/packs", OWNER, "POST", { messages: 50000, price: 250, plan_ids: ["pro"] });
    expect((await call("/api/owner/topups/packs", h, "POST", { messages: 1, price: 1 })).status).toBe(403); // customers cannot

    let st = (await call("/api/topups", h)).body;
    expect(st.packs.map((p: any) => p.id)).toEqual([a]); // inactive and pro-only hidden from basic
    expect(st.packs[0]).toMatchObject({ messages: 5000, price: 35, badge: "الأكثر طلبًا" });
    expect(st.show).toBe(false); // 0 of 1,000 used, below 90%
    await setUsage(tid, 950);
    st = (await call("/api/topups", h)).body;
    expect(st.show).toBe(true);
    expect(st.out).toBe(false);
  });

  it("buying a pack: invoice for the pack price, credit added to this cycle once paid, limit raised for that customer only", async () => {
    stubMoyasar();
    const { h, tid } = await register("shop_a");
    const other = await register("shop_b");
    const pack = (await call("/api/owner/topups/packs", OWNER, "POST", { messages: 5000, price: 35 })).body.id;
    await setUsage(tid, 1000);
    expect((await call("/api/promos", h)).body.popup).toMatchObject({ buy: true, cta: "اشحن رسائل" });

    const r = await call("/api/topups/pay", h, "POST", { pack_id: pack });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ messages: 5000, amount: 35, url: "https://checkout.moyasar.com/invoices/inv_topup01" });
    expect(reqs[0].body).toMatchObject({ amount: 3500, currency: "SAR" });
    expect((await getEntitlement(DB, tid)).limits.monthly_messages).toBe(1000); // not before paying

    remote = { status: "paid" };
    const s = await call(`/api/subscription/pay/${r.body.id}`, h);
    expect(s.body).toMatchObject({ status: "paid", topup_messages: 5000 });
    await call(`/api/subscription/pay/${r.body.id}`, h); // checking again does not add it twice
    const ent = await getEntitlement(DB, tid);
    expect(ent.limits.monthly_messages).toBe(6000);
    expect(ent.extra_messages).toBe(5000);
    expect((await getEntitlement(DB, other.tid)).limits.monthly_messages).toBe(1000); // isolation
    expect((await call("/api/promos", h)).body.popup).toBeNull(); // not out any more
    const st = (await call("/api/topups", h)).body;
    expect(st).toMatchObject({ used: 1000, limit: 6000, plan_limit: 1000, extra: 5000, purchases: 1 });
    expect((await call("/api/topups", other.h)).body.history).toEqual([]);
    const notes = (await DB.prepare("SELECT tenant_id, title FROM app_notifications WHERE title LIKE '%شحن%' ORDER BY id").all<any>()).results;
    expect(notes.map((n: any) => n.tenant_id).sort()).toEqual([1, tid].sort());
  });

  it("the cap per cycle, staff, card off, and packs for another plan are refused", async () => {
    stubMoyasar();
    const { h } = await register("shop_a");
    const pack = (await call("/api/owner/topups/packs", OWNER, "POST", { messages: 2000, price: 15 })).body.id;
    const pro = (await call("/api/owner/topups/packs", OWNER, "POST", { messages: 2000, price: 15, plan_ids: ["pro"] })).body.id;
    expect((await call("/api/topups/pay", h, "POST", { pack_id: pro })).status).toBe(404);
    await call("/api/owner/topups/settings", OWNER, "PUT", { max_per_cycle: 1, show_at_pct: 90, popup: { enabled: true, title: "خلصت", body: "اشحن الحين", cta: "اشحن", cancel: "لاحقًا" } });
    const r = await call("/api/topups/pay", h, "POST", { pack_id: pack });
    remote = { status: "paid" };
    await call(`/api/subscription/pay/${r.body.id}`, h);
    const again = await call("/api/topups/pay", h, "POST", { pack_id: pack });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("capped");
    expect((await call("/api/topups/pay", OWNER, "POST", { pack_id: pack })).status).toBe(409);
  });

  it("the owner can gift messages, and the out-of-messages window text comes from the owner's settings", async () => {
    const { h, tid } = await register("shop_a");
    await call("/api/owner/topups/settings", OWNER, "PUT", { max_per_cycle: 0, show_at_pct: 90, popup: { enabled: true, title: "رصيدك خلص", body: "اشحن وارجع للردود", cta: "يلا نشحن", cancel: "بعدين" } });
    await setUsage(tid, 1000);
    expect((await call("/api/promos", h)).body.popup).toMatchObject({ title: "رصيدك خلص", body: "اشحن وارجع للردود", cta: "يلا نشحن", cancel: "بعدين", buy: false });
    expect((await call(`/api/owner/tenants/${tid}/credits`, OWNER, "POST", { messages: 500 })).status).toBe(200);
    expect((await getEntitlement(DB, tid)).limits.monthly_messages).toBe(1500);
    expect((await call("/api/promos", h)).body.popup).toBeNull();
  });

  it("a customer who runs out gets the ready message automatically (owner's edited copy); the owner is told", async () => {
    const { h, tid } = await register("shop_a");
    const t = (await call("/api/owner/message-templates", OWNER)).body.templates;
    t.private = t.private.map((x: any) => (x.label === "خلصت الرسائل" ? { ...x, title: "رصيدك خلص يا {الاسم}" } : x));
    expect((await call("/api/owner/message-templates", OWNER, "PUT", t)).status).toBe(200);
    await setUsage(tid, 1000);
    const at = Math.floor(Date.now() / 600_000) * 600_000 + 3 * 60_000;
    await runPlanAlerts(TEST_ENV, at);
    const mine = (await DB.prepare("SELECT kind, title FROM app_notifications WHERE tenant_id = ?").bind(tid).all<any>()).results;
    expect(mine).toMatchObject([{ kind: "message", title: "✉️ رصيدك خلص يا متجر shop_a" }]);
    const owner = (await DB.prepare("SELECT title FROM app_notifications WHERE tenant_id = 1 AND title LIKE '%خلّص%'").all<any>()).results;
    expect(owner).toHaveLength(1);
    expect(owner[0].title).toContain("تلقائيًا");
    expect((await call("/api/cycle", h)).body).toEqual({ used: 1000, limit: 1000, extra: 0 });
  });
});

describe("offers", () => {
  const offer = (o: Record<string, unknown> = {}) => ({ title: "خصم 30%", body: "على الباقة الاحترافية", cta: "اشترك", link: "/subscription", theme: "violet", icon: "🎁", ends_at: Date.now() + 86_400_000, audience: "all", ...o });

  it("shows running offers to every customer or only the chosen ones", async () => {
    const a = await register("shop_a");
    const b = await register("shop_b");
    const all = (await call("/api/owner/offers", OWNER, "POST", offer())).body.id;
    const onlyB = (await call("/api/owner/offers", OWNER, "POST", offer({ title: "عرض خاص لك", audience: "tenants", tenant_ids: [b.tid] }))).body.id;
    await call("/api/owner/offers", OWNER, "POST", offer({ title: "انتهى", ends_at: Date.now() + 1000, starts_at: Date.now() - 5000 }));
    await DB.prepare("UPDATE offers SET ends_at = ? WHERE title = 'انتهى'").bind(Date.now() - 1).run();
    await call("/api/owner/offers", OWNER, "POST", offer({ title: "موقوف", active: false }));
    await call("/api/owner/offers", OWNER, "POST", offer({ title: "لاحقًا", starts_at: Date.now() + 3_600_000 }));

    expect((await call("/api/promos", a.h)).body.offers.map((o: any) => o.id)).toEqual([all]);
    expect((await call("/api/promos", b.h)).body.offers.map((o: any) => o.id).sort()).toEqual([all, onlyB].sort());
    expect((await call(`/api/offers/${onlyB}/click`, a.h, "POST")).body.ok).toBe(false); // not theirs
    expect((await call(`/api/offers/${onlyB}/click`, b.h, "POST")).body.ok).toBe(true);
    const list = (await call("/api/owner/offers", OWNER)).body.offers;
    expect(list.find((o: any) => o.id === onlyB).clicks).toBe(1);
  });

  it("validates links, themes and audience; customers cannot manage offers", async () => {
    const a = await register("shop_a");
    expect((await call("/api/owner/offers", OWNER, "POST", offer({ link: "javascript:alert(1)" }))).status).toBe(422);
    expect((await call("/api/owner/offers", OWNER, "POST", offer({ theme: "nope" }))).status).toBe(422);
    expect((await call("/api/owner/offers", OWNER, "POST", offer({ audience: "tenants", tenant_ids: [] }))).status).toBe(422);
    expect((await call("/api/owner/offers", OWNER, "POST", offer({ link: "https://shayyek.sa/offer" }))).status).toBe(200);
    expect((await call("/api/owner/offers", a.h, "POST", offer())).status).toBe(403);
  });

  it("offer details: who saw it, who opened it, who paid after it; ready offer templates are editable", async () => {
    stubMoyasar();
    const a = await register("shop_a");
    const b = await register("shop_b");
    const id = (await call("/api/owner/offers", OWNER, "POST", offer())).body.id;
    await call("/api/promos", a.h);
    await call("/api/promos", a.h); // seen twice = once
    await call("/api/promos", b.h);
    await call(`/api/offers/${id}/click`, a.h, "POST");
    const pack = (await call("/api/owner/topups/packs", OWNER, "POST", { messages: 2000, price: 15 })).body.id;
    const r = await call("/api/topups/pay", a.h, "POST", { pack_id: pack });
    remote = { status: "paid" };
    await call(`/api/subscription/pay/${r.body.id}`, a.h);
    const st = (await call(`/api/owner/offers/${id}/stats`, OWNER)).body;
    expect(st).toMatchObject({ targeted: 2, viewed: 2, clicked: 1, converted: 1, revenue: 15 });
    expect(st.people[0]).toMatchObject({ tenant_id: a.tid, bought: [{ what: "2,000 رسالة إضافية", amount: 15 }] });
    expect(st.people[1].tenant_id).toBe(b.tid);
    expect((await call(`/api/owner/offers/${id}/stats`, a.h)).status).toBe(403);

    const tpl = (await call("/api/owner/offer-templates", OWNER)).body;
    expect(tpl.templates.length).toBeGreaterThan(3);
    const next = [{ ...tpl.templates[0], label: "عرضي", title: "عرض رمضان" }];
    expect((await call("/api/owner/offer-templates", OWNER, "PUT", next)).status).toBe(200);
    expect((await call("/api/owner/offer-templates", OWNER)).body.templates).toMatchObject([{ label: "عرضي", title: "عرض رمضان" }]);
    expect((await call("/api/owner/offer-templates", OWNER, "PUT", [{ ...next[0], link: "javascript:x" }])).status).toBe(422);
  });

  it("audience by plan: subscribers of chosen plans, or everyone except them", async () => {
    const a = await register("shop_a"); // basic
    const b = await register("shop_b");
    await DB.prepare("UPDATE tenants SET plan_id = 'pro' WHERE id = ?").bind(b.tid).run();
    const onlyPro = (await call("/api/owner/offers", OWNER, "POST", offer({ audience: "plans", plan_ids: ["pro"] }))).body.id;
    const notPro = (await call("/api/owner/offers", OWNER, "POST", offer({ audience: "except_plans", plan_ids: ["pro"] }))).body.id;
    expect((await call("/api/owner/offers", OWNER, "POST", offer({ audience: "plans", plan_ids: [] }))).status).toBe(422);
    expect((await call("/api/promos", a.h)).body.offers.map((o: any) => o.id)).toEqual([notPro]);
    expect((await call("/api/promos", b.h)).body.offers.map((o: any) => o.id)).toEqual([onlyPro]);
    expect((await call(`/api/owner/offers/${onlyPro}/stats`, OWNER)).body.targeted).toBe(1);
  });

  it("a real discount: only the customer the offer is for pays less, on the chosen plan, while it runs", async () => {
    stubMoyasar();
    await DB.prepare("UPDATE plans SET card_price_halalas = 9900, price_period = 'month' WHERE id = 'pro'").run();
    await DB.prepare("UPDATE plans SET card_price_halalas = 4900, price_period = 'month' WHERE id = 'basic'").run();
    const a = await register("shop_a");
    const b = await register("shop_b");
    await call("/api/owner/offers", OWNER, "POST", offer({ audience: "tenants", tenant_ids: [a.tid], discount_pct: 30, discount_plans: ["pro"] }));
    const proFor = async (h: H) => (await call("/api/subscription", h)).body.plans.find((p: any) => p.id === "pro");
    expect(await proFor(a.h)).toMatchObject({ card_price: 99, offer_pct: 30, offer_card_price: 69.3 });
    expect((await proFor(b.h)).offer_pct).toBeUndefined();
    expect((await call("/api/subscription", a.h)).body.plans.find((p: any) => p.id === "basic").offer_pct).toBeUndefined(); // other plan
    // the upgrade difference (49 → 99 on day 0 = 50 SAR) gets 30% off for her only
    expect((await call("/api/subscription/upgrade/quote?plan_id=pro", a.h)).body).toMatchObject({ amount: 35, discount_pct: 30 });
    expect((await call("/api/subscription/upgrade/quote?plan_id=pro", b.h)).body).toMatchObject({ amount: 50, discount_pct: 0 });
    await call("/api/subscription/upgrade", a.h, "POST", { plan_id: "pro" });
    expect(reqs.at(-1)!.body.amount).toBe(3500);
    const pay = await DB.prepare("SELECT offer_id FROM card_payments ORDER BY id DESC LIMIT 1").first<any>();
    expect(pay.offer_id).not.toBeNull();
  });

  it("the owner can take messages off a customer's cycle too (not below zero)", async () => {
    const { tid } = await register("shop_a");
    expect((await call(`/api/owner/tenants/${tid}/credits`, OWNER, "POST", { messages: -400 })).body).toMatchObject({ ok: true, limit: 600 });
    expect((await getEntitlement(DB, tid)).limits.monthly_messages).toBe(600);
    expect((await call(`/api/owner/tenants/${tid}/credits`, OWNER, "POST", { messages: -700 })).status).toBe(422);
    expect((await call(`/api/owner/tenants/${tid}/credits`, OWNER, "POST", { messages: 0 })).status).toBe(422);
    const notes = (await DB.prepare("SELECT COUNT(*) AS n FROM app_notifications WHERE tenant_id = ?").bind(tid).first<any>()).n;
    expect(notes).toBe(0); // taking messages off is silent
  });

  it("the owner's customer list shows this cycle's used messages and the added / taken-off ones", async () => {
    const { tid } = await register("shop_a");
    await setUsage(tid, 120);
    await call(`/api/owner/tenants/${tid}/credits`, OWNER, "POST", { messages: 200 });
    let row = (await call("/api/owner/tenants", OWNER)).body.find((t: any) => t.id === tid);
    expect(row).toMatchObject({ messages_month: 120, messages_limit: 1000, messages_extra: 200 });
    await call(`/api/owner/tenants/${tid}/credits`, OWNER, "POST", { messages: -500 });
    row = (await call("/api/owner/tenants", OWNER)).body.find((t: any) => t.id === tid);
    expect(row.messages_extra).toBe(-300);
  });

  it("payments report: totals, by kind / plan / pack / offer, owner only", async () => {
    stubMoyasar();
    await DB.prepare("UPDATE plans SET card_price_halalas = 4900, price_period = 'month' WHERE id = 'basic'").run();
    const a = await register("shop_a");
    const offerId = (await call("/api/owner/offers", OWNER, "POST", offer({ discount_pct: 20, discount_plans: ["basic"] }))).body.id;
    const pack = (await call("/api/owner/topups/packs", OWNER, "POST", { messages: 2000, price: 15 })).body.id;
    remote = { status: "paid" };
    const r1 = await call("/api/subscription/pay", a.h, "POST", { plan_id: "basic" });
    await call(`/api/subscription/pay/${r1.body.id}`, a.h);
    // the stub hands out one invoice id: retire the first before the second payment
    await DB.prepare("UPDATE card_payments SET invoice_id = 'inv_done1' WHERE id = ?").bind(r1.body.id).run();
    reqs = [];
    const r2 = await call("/api/topups/pay", a.h, "POST", { pack_id: pack });
    await call(`/api/subscription/pay/${r2.body.id}`, a.h);
    const rep = (await call("/api/owner/payments-report?days=30", OWNER)).body;
    expect(rep.total).toMatchObject({ count: 2, revenue: 39.2 + 15, customers: 1 });
    expect(rep.by_kind.map((g: any) => g.label).sort()).toEqual(["اشتراك باقة", "رسائل إضافية"].sort());
    expect(rep.by_plan[0]).toMatchObject({ key: "basic", count: 1, revenue: 39.2 });
    expect(rep.by_pack[0]).toMatchObject({ key: 2000, count: 1, revenue: 15 });
    expect(rep.by_offer[0]).toMatchObject({ key: offerId, count: 1, revenue: 39.2 });
    expect(rep.payments).toHaveLength(2);
    expect((await call("/api/owner/payments-report", a.h)).status).toBe(403);

    // the owner's costs: gateway fee (% + fixed) and VAT inside the price → per-payment and total net
    const fee = (await call("/api/owner/payments-report?days=30&fee_pct=2&fee_fixed=1&vat_pct=15", OWNER)).body;
    const gross = 39.2 + 15;
    const vat = Math.round((gross * 15) / 115 * 100) / 100;
    const gw = Math.round((gross * 0.02 + 2) * 100) / 100;
    expect(fee.fees).toEqual({ fee_pct: 2, fee_fixed: 1, vat_pct: 15 });
    expect(fee.total.vat).toBeCloseTo(vat, 1);
    expect(fee.total.fee).toBeCloseTo(gw, 1);
    expect(fee.total.net).toBeCloseTo(gross - vat - gw, 1);
    const one = fee.payments.find((x: any) => x.amount === 15);
    expect(one).toMatchObject({ vat: 1.96, fee: 1.3, net: 11.74 });
    // a custom date range (whole Riyadh days): today has both payments, a past range has none
    const today = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
    expect((await call(`/api/owner/payments-report?from=${today}&to=${today}`, OWNER)).body.total.count).toBe(2);
    expect((await call("/api/owner/payments-report?from=2020-01-01&to=2020-01-31", OWNER)).body.total.count).toBe(0);
    expect((await call("/api/owner/payments-report?from=2020-02-01&to=2020-01-01", OWNER)).status).toBe(400);

    // deleting the whole payments record needs the owner's own password; a customer cannot
    expect((await call("/api/owner/payments/delete-all", a.h, "POST", { password: "a-very-strong-password" })).status).toBe(403);
    expect((await call("/api/owner/payments/delete-all", OWNER, "POST", { password: "wrong-password" })).status).toBe(403);
    await DB.prepare("INSERT INTO card_payments (tenant_id, plan_id, days, amount, currency, status, created_at, updated_at) VALUES (?, 'basic', 30, 100, 'SAR', 'initiated', ?, ?)").bind(a.tid, Date.now(), Date.now()).run();
    const del = await call("/api/owner/payments/delete-all", OWNER, "POST", { password: "a-very-strong-password" });
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(2);
    // a payment started just now stays, so it is still activated when the gateway confirms it
    expect((await DB.prepare("SELECT status FROM card_payments").all<any>()).results.map((r: any) => r.status)).toEqual(["initiated"]);
    expect((await call("/api/owner/payments-report?days=30", OWNER)).body.total.count).toBe(0);
  });

  it("messages the owner takes off count as gone: the window and the alert follow the bar", async () => {
    const { h, tid } = await register("shop_cut");
    const base = { max_per_cycle: 0, show_at_pct: 90, alert_steps: [85, 90, 95], popup: { enabled: true, title: "الرجاء شراء الشحن", body: "اشحن", cta: "اشحن رسائل", cancel: "لاحقًا", show_at: 90, delay_min: 0 } };
    expect((await call("/api/owner/topups/settings", OWNER, "PUT", base)).status).toBe(200);
    expect((await call("/api/promos", h)).body.popup).toBeNull();
    // basic = 1,000 messages; 950 taken off, none used → 50 left = 95% gone
    expect((await call(`/api/owner/tenants/${tid}/credits`, OWNER, "POST", { messages: -950 })).status).toBe(200);
    const promos = (await call("/api/promos", h)).body;
    expect(promos.popup).toMatchObject({ title: "الرجاء شراء الشحن" });
    const at = Math.floor(Date.now() / 600_000) * 600_000 + 3 * 60_000;
    expect(await runPlanAlerts(TEST_ENV, at)).toBe(1);
    const note = await DB.prepare("SELECT title, body FROM app_notifications WHERE tenant_id = ? ORDER BY id DESC LIMIT 1").bind(tid).first<any>();
    expect(note.title).toContain("95%");
    expect(note.body).toContain("باقي 50 رسالة");
  });

  it("the owner sets the usage-note steps and when the window shows (share used + delay)", async () => {
    const { h, tid } = await register("shop_a");
    const base = { max_per_cycle: 0, show_at_pct: 90, popup: { enabled: true, title: "قربت تخلص", body: "اشحن الحين", cta: "اشحن", cancel: "لاحقًا", show_at: 80, delay_min: 5 } };
    expect((await call("/api/owner/topups/settings", OWNER, "PUT", { ...base, alert_steps: [70, 90] })).status).toBe(200);
    await setUsage(tid, 790);
    expect((await call("/api/promos", h)).body.popup).toBeNull(); // below 80%
    await setUsage(tid, 800);
    expect((await call("/api/promos", h)).body.popup).toMatchObject({ title: "قربت تخلص", delay_min: 5 });
    const at = Math.floor(Date.now() / 600_000) * 600_000 + 3 * 60_000;
    expect(await runPlanAlerts(TEST_ENV, at)).toBe(1); // 70% step
    await setUsage(tid, 880);
    expect(await runPlanAlerts(TEST_ENV, at)).toBe(0); // no 85% step any more
    await setUsage(tid, 900);
    expect(await runPlanAlerts(TEST_ENV, at)).toBe(1); // 90%
    const titles = (await DB.prepare("SELECT title FROM app_notifications WHERE tenant_id = ? ORDER BY id").bind(tid).all<any>()).results.map((r: any) => r.title.match(/\d+%/)?.[0]);
    expect(titles).toEqual(["70%", "90%"]);
  });
});
