import { usageCycle } from "../src/worker/services/plans";
import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { commentPayload, DB, deliver, MockMeta, resetDb, seedAccount, uid } from "./helpers";

const BASE = "https://hsn.example.workers.dev";
const SELF = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
type H = Record<string, string>;
const IG_B = "17841400000000002";

async function call(path: string, h: H = {}, method = "GET", body?: unknown) {
  const r = await SELF.fetch(new Request(BASE + path, { method, headers: { "Content-Type": "application/json", ...h }, body: body === undefined ? undefined : JSON.stringify(body) }));
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, body: json };
}
async function login(username: string, password: string): Promise<H> {
  const r = await call("/api/auth/login", {}, "POST", { username, password, client: "app" });
  if (!r.body.token) throw new Error(`login failed: ${JSON.stringify(r.body)}`);
  return { Authorization: `Bearer ${r.body.token}` };
}
const campaign = (name: string, type = "comment") => ({ name, type, final_text: `محتوى ${name}`, keywords: [{ keyword: "كورس", kind: "include", match_type: "contains" }], public_reply_enabled: true, public_reply_text: "شيّك الخاص" });

let OWNER: H;
beforeEach(async () => {
  await resetDb();
  await seedAccount();
  await call("/api/auth/setup", {}, "POST", { setup_token: "test_setup_token_123456", username: "admin", password: "a-very-strong-password" });
  OWNER = await login("admin", "a-very-strong-password");
});

async function codes(plan: string, days: number, count = 1): Promise<string[]> {
  const r = await call("/api/owner/codes", OWNER, "POST", { plan_id: plan, days, count });
  expect(r.status).toBe(200);
  return r.body.codes;
}
async function customerWithAccount(username = "shop_b"): Promise<{ h: H; tid: number }> {
  const r = await call("/api/owner/tenants", OWNER, "POST", { name: `متجر ${username}`, username, password: "another-strong-password" });
  const now = Date.now();
  await DB.prepare("INSERT INTO instagram_accounts (tenant_id, ig_user_id, username, status, token_ciphertext, token_iv, created_at, updated_at) VALUES (?, ?, 'b_ig', 'active', 'x', 'y', ?, ?)").bind(r.body.id, IG_B, now, now).run();
  return { h: await login(username, "another-strong-password"), tid: r.body.id };
}
const commentOnB = (text = "أبغى الكورس") => {
  const p = commentPayload({ text, commentId: uid("c"), time: Date.now() + 2000 });
  (p as any).entry[0].id = IG_B;
  return p;
};

describe("activation codes", () => {
  it("codes are shown once, stored hashed, single-use, revocable; renewing early adds the days after the current expiry", async () => {
    const [code] = await codes("pro", 30);
    expect(code).toMatch(/^HSN-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const stored = await DB.prepare("SELECT code_hash, hint FROM activation_codes").first<any>();
    expect(stored.code_hash).not.toContain(code.slice(4, 8));
    expect(stored.hint).toBe(code.slice(-4));
    const { h, tid } = await customerWithAccount();
    expect((await call("/api/subscription", h)).body.active).toBe(false);
    // typed loosely (lowercase, spaces) still works
    const r = await call("/api/subscription/redeem", h, "POST", { code: ` ${code.toLowerCase().replace(/-/g, " ")} ` });
    expect(r.status).toBe(200);
    const sub = (await call("/api/subscription", h)).body;
    expect(sub.active).toBe(true);
    expect(sub.plan.id).toBe("pro");
    expect((await call("/api/subscription/redeem", h, "POST", { code })).status).toBe(422); // used
    const [second] = await codes("pro", 10);
    const before = (await DB.prepare("SELECT plan_expires_at FROM tenants WHERE id = ?").bind(tid).first<any>()).plan_expires_at;
    await call("/api/subscription/redeem", h, "POST", { code: second });
    const after = (await DB.prepare("SELECT plan_expires_at FROM tenants WHERE id = ?").bind(tid).first<any>()).plan_expires_at;
    expect(after - before).toBe(10 * 86_400_000);
    const [third] = await codes("basic", 5);
    const list = (await call("/api/owner/codes", OWNER)).body;
    await call(`/api/owner/codes/${list[0].id}/revoke`, OWNER, "POST", {});
    expect((await call("/api/subscription/redeem", h, "POST", { code: third })).body.error.code).toBe("revoked");
    expect((await call("/api/owner/codes", h)).status).toBe(403);
  });

  it("self sign-up needs a valid code; a wrong code creates nothing", async () => {
    expect((await call("/api/auth/register", {}, "POST", { name: "نور", username: "noor", password: "noor-strong-pass-1", code: "HSN-AAAA-BBBB-CCCC" })).status).toBe(422);
    expect((await DB.prepare("SELECT COUNT(*) AS n FROM tenants").first<any>()).n).toBe(1);
    const [code] = await codes("basic", 30);
    expect((await call("/api/auth/register", {}, "POST", { name: "نور", username: "noor", password: "noor-strong-pass-1", code })).status).toBe(200);
    const h = await login("noor", "noor-strong-pass-1");
    const sub = (await call("/api/subscription", h)).body;
    expect(sub.active).toBe(true);
    expect(sub.plan.id).toBe("basic");
    expect((await call("/api/templates", h)).body.length).toBe(3);
    expect((await call("/api/auth/register", {}, "POST", { name: "x", username: "noor2", password: "noor-strong-pass-1", code })).status).toBe(422); // code used
  });
});

describe("plan limits", () => {
  it("no or expired subscription: nothing runs and campaigns cannot be activated", async () => {
    const { h, tid } = await customerWithAccount();
    const c = await call("/api/campaigns", h, "POST", campaign("a"));
    expect((await call(`/api/campaigns/${c.body.id}/status`, h, "POST", { status: "active" })).status).toBe(403);
    await call(`/api/owner/tenants/${tid}/plan`, OWNER, "POST", { plan_id: "pro", days: 30 });
    expect((await call(`/api/campaigns/${c.body.id}/status`, h, "POST", { status: "active" })).status).toBe(200);
    const meta = new MockMeta();
    await deliver(commentOnB(), meta);
    expect(meta.sends().length).toBeGreaterThan(0);
    expect((await DB.prepare("SELECT messages FROM usage_counters WHERE tenant_id = ?").bind(tid).first<any>()).messages).toBeGreaterThan(0);
    // expire it
    await DB.prepare("UPDATE tenants SET plan_expires_at = ? WHERE id = ?").bind(Date.now() - 1000, tid).run();
    const n = meta.sends().length;
    await deliver(commentOnB(), meta);
    expect(meta.sends().length).toBe(n);
    expect((await DB.prepare("SELECT reason FROM webhook_events ORDER BY id DESC LIMIT 1").first<any>()).reason).toContain("subscription_inactive");
  });

  it("basic plan: campaign count, events and features are enforced", async () => {
    const { h, tid } = await customerWithAccount();
    await call(`/api/owner/tenants/${tid}/plan`, OWNER, "POST", { plan_id: "basic", days: 30 });
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) ids.push((await call("/api/campaigns", h, "POST", campaign(`c${i}`))).body.id);
    for (let i = 0; i < 3; i++) expect((await call(`/api/campaigns/${ids[i]}/status`, h, "POST", { status: "active" })).status).toBe(200);
    expect((await call(`/api/campaigns/${ids[3]}/status`, h, "POST", { status: "active" })).body.error.code).toBe("plan_campaigns");
    const story = await call("/api/campaigns", h, "POST", { ...campaign("s", "story_reply"), public_reply_enabled: false });
    await call(`/api/campaigns/${ids[0]}/status`, h, "POST", { status: "paused" });
    expect((await call(`/api/campaigns/${story.body.id}/status`, h, "POST", { status: "active" })).body.error.code).toBe("plan_event");
    // public reply saved switched off
    expect((await DB.prepare("SELECT public_reply_enabled FROM campaigns WHERE id = ?").bind(ids[0]).first<any>()).public_reply_enabled).toBe(0);
    expect((await call("/api/notifications", h, "PUT", { enabled: true })).body.error.code).toBe("plan_feature");
    expect((await call("/api/logs/export?type=events", h)).status).toBe(403);
    expect((await call("/api/recover", h, "POST", {})).status).toBe(403);
    expect((await call("/api/card-designs", h, "POST", { name: "x", design: {} })).status).toBe(403);
  });

  it("the monthly message allowance stops new triggers", async () => {
    const { h, tid } = await customerWithAccount();
    await call(`/api/owner/tenants/${tid}/plan`, OWNER, "POST", { plan_id: "basic", days: 30 });
    const c = await call("/api/campaigns", h, "POST", campaign("a"));
    await call(`/api/campaigns/${c.body.id}/status`, h, "POST", { status: "active" });
    await DB.prepare("INSERT INTO usage_counters (tenant_id, month, messages) VALUES (?, ?, 1000)").bind(tid, (await usageCycle(DB, tid)).key).run();
    const meta = new MockMeta();
    await deliver(commentOnB(), meta);
    expect(meta.sends()).toHaveLength(0);
    expect((await DB.prepare("SELECT reason FROM webhook_events ORDER BY id DESC LIMIT 1").first<any>()).reason).toContain("monthly_limit_reached");
  });

  it("the owner is never limited", async () => {
    const sub = (await call("/api/subscription", OWNER)).body;
    expect(sub.owner).toBe(true);
    expect(sub.active).toBe(true);
    expect(sub.limits.monthly_messages).toBeNull();
  });
});

describe("owner tools", () => {
  it("deleting a customer removes all of its data, needs the exact name, and never the owner", async () => {
    const { h, tid } = await customerWithAccount();
    await call(`/api/owner/tenants/${tid}/plan`, OWNER, "POST", { plan_id: "max", days: 30 });
    const c = await call("/api/campaigns", h, "POST", campaign("a"));
    await call(`/api/campaigns/${c.body.id}/status`, h, "POST", { status: "active" });
    await deliver(commentOnB(), new MockMeta());
    expect((await call(`/api/owner/tenants/${tid}`, OWNER, "DELETE", { confirm: "غلط" })).status).toBe(422);
    expect((await call(`/api/owner/tenants/${tid}`, OWNER, "DELETE", { confirm: "متجر shop_b" })).status).toBe(200);
    for (const t of ["conversation_flows", "participants"]) {
      const n = (await DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<any>()).n;
      expect([t, n]).toEqual([t, 0]);
    }
    for (const t of ["campaigns", "templates"]) {
      const n = (await DB.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE tenant_id = ?`).bind(tid).first<any>()).n;
      expect([t, n]).toEqual([t, 0]);
    }
    expect((await DB.prepare("SELECT COUNT(*) AS n FROM instagram_accounts WHERE tenant_id = ?").bind(tid).first<any>()).n).toBe(0);
    expect((await DB.prepare("SELECT COUNT(*) AS n FROM admin_users WHERE tenant_id = ?").bind(tid).first<any>()).n).toBe(0);
    expect((await call("/api/campaigns", h)).status).toBe(401);
    expect((await call("/api/owner/tenants/1", OWNER, "DELETE", { confirm: "المالك" })).status).toBe(409);
    expect((await DB.prepare("SELECT COUNT(*) AS n FROM instagram_accounts WHERE tenant_id = 1").first<any>()).n).toBe(1);
  });

  it("simulator, campaign stats and undo are in the max plan only (unless the owner turns them on)", async () => {
    const { h, tid } = await customerWithAccount();
    await call(`/api/owner/tenants/${tid}/plan`, OWNER, "POST", { plan_id: "pro", days: 30 });
    const cid = (await call("/api/campaigns", h, "POST", campaign("c"))).body.id;
    const sim = { campaign_id: cid, event: "comment", text: "أبغى الكورس", participant: "x", reset: true };
    expect((await call("/api/simulate", h, "POST", sim)).body.error.code).toBe("plan_feature");
    expect((await call(`/api/campaigns/${cid}/stats`, h)).status).toBe(403);
    expect((await call(`/api/campaigns/${cid}/people`, h)).status).toBe(403);
    expect((await call("/api/undo", h)).status).toBe(403);
    expect([403, 404]).toContain((await call("/api/undo/1", h, "POST", {})).status); // ownership guard may answer first
    // the owner turns the simulator on for "pro": it works without any code change
    const pro = (await call("/api/owner/plans", OWNER)).body.find((p: any) => p.id === "pro");
    const put = await call("/api/owner/plans/pro", OWNER, "PUT", { name: pro.name, active: true, limits: { ...pro.limits, simulator: true } });
    expect(put.status).toBe(200);
    expect((await call("/api/simulate", h, "POST", sim)).status).toBe(200);
    expect((await call(`/api/campaigns/${cid}/stats`, h)).status).toBe(403);
    await call(`/api/owner/tenants/${tid}/plan`, OWNER, "POST", { plan_id: "max", days: 30 });
    expect((await call(`/api/campaigns/${cid}/stats`, h)).status).toBe(200);
    expect((await call(`/api/campaigns/${cid}/people`, h)).status).toBe(200);
    expect((await call("/api/undo", h)).status).toBe(200);
    // the owner is never limited
    expect((await call("/api/undo", OWNER)).status).toBe(200);
  });

  it("owner adjusts a customer's subscription: add, subtract, plan-only change, exact date; the period start is kept", async () => {
    const { h, tid } = await customerWithAccount();
    const DAY = 86_400_000;
    const plan = (body: unknown) => call(`/api/owner/tenants/${tid}/plan`, OWNER, "POST", body);
    const row = () => DB.prepare("SELECT plan_id, plan_expires_at, plan_started_at FROM tenants WHERE id = ?").bind(tid).first<any>();
    const t0 = Date.now();
    expect((await plan({ plan_id: "basic", days: 30 })).status).toBe(200);
    const a = await row();
    expect(a.plan_started_at).toBeGreaterThanOrEqual(t0);
    expect(Math.round((a.plan_expires_at - a.plan_started_at) / DAY)).toBe(30);
    await plan({ plan_id: "basic", days: 10 }); // extend: after the current expiry, same start
    const b = await row();
    expect(Math.round((b.plan_expires_at - a.plan_expires_at) / DAY)).toBe(10);
    expect(b.plan_started_at).toBe(a.plan_started_at);
    await plan({ plan_id: "basic", days: -5 }); // subtract
    expect(Math.round(((await row()).plan_expires_at - b.plan_expires_at) / DAY)).toBe(-5);
    const before = (await row()).plan_expires_at;
    await plan({ plan_id: "pro" }); // plan only
    expect(await row()).toMatchObject({ plan_id: "pro", plan_expires_at: before });
    const exact = Date.now() + 3 * DAY;
    await plan({ plan_id: "pro", expires_at: exact });
    expect((await row()).plan_expires_at).toBe(exact);
    // the owner's list carries what the bar needs
    const listed = (await call("/api/owner/tenants", OWNER)).body.find((x: any) => x.id === tid);
    expect(listed.plan_started_at).toBe(a.plan_started_at);
    // customers cannot use the owner endpoint
    expect((await call(`/api/owner/tenants/${tid}/plan`, h, "POST", { plan_id: "max", days: 365 })).status).toBe(403);
  });

  it("structured price with currency, the public plans endpoint, and the app download link", async () => {
    const pro = (await call("/api/owner/plans", OWNER)).body.find((p: any) => p.id === "pro");
    const put = await call("/api/owner/plans/pro", OWNER, "PUT", { name: pro.name, active: true, limits: pro.limits, price_amount: 149, price_currency: "SAR", price_period: "month" });
    expect(put.status).toBe(200);
    const pub = await call("/api/public/plans"); // no login
    expect(pub.status).toBe(200);
    expect(pub.body.plans.find((p: any) => p.id === "pro").price_label).toBe("149 ر.س / شهريًا");
    await call("/api/owner/plans/pro", OWNER, "PUT", { name: pro.name, active: true, limits: pro.limits, price_amount: 40, price_currency: "USD", price_period: "year" });
    expect((await call("/api/public/plans")).body.plans.find((p: any) => p.id === "pro").price_label).toBe("40 $ / سنويًا");
    await call("/api/owner/settings", OWNER, "PUT", { sales_contact: "https://wa.me/966500000000" });
    expect((await call("/api/public/plans")).body.sales_contact).toBe("https://wa.me/966500000000");
    // download link: the stable APK on this domain by default, or the owner's link
    const { h } = await customerWithAccount();
    expect((await call("/api/subscription", h)).body.app_download_url).toBe(`${BASE}/app.apk`);
    await call("/api/owner/settings", OWNER, "PUT", { app_download_url: "https://example.com/folder" });
    expect((await call("/api/subscription", h)).body.app_download_url).toBe("https://example.com/folder");
    expect((await call("/api/owner/settings", OWNER, "PUT", { app_download_url: "http://insecure" })).status).toBe(422);
    expect((await call("/api/owner/settings", h, "PUT", { app_download_url: "https://x.com" })).status).toBe(403);
  });

  it("payment methods: banks with several accounts and a logo, shown publicly; owner only", async () => {
    const logo = "data:image/png;base64,iVBORw0KGgo=";
    const prov = await call("/api/owner/payment-providers", OWNER, "POST", { name: "بنك الراجحي", kind: "bank", logo });
    expect(prov.status).toBe(200);
    for (const [currency, number] of [["SAR", "111"], ["SAR", "222"], ["USD", "333"]]) {
      expect((await call(`/api/owner/payment-providers/${prov.body.id}/accounts`, OWNER, "POST", { holder: "حسن", number, currency })).status).toBe(200);
    }
    expect((await call("/api/owner/payment-providers", OWNER, "POST", { name: "x", kind: "exchange" })).status).toBe(422);
    const ex = await call("/api/owner/payment-providers", OWNER, "POST", { name: "محفظة STC", kind: "wallet" });
    await call(`/api/owner/payment-providers/${ex.body.id}/accounts`, OWNER, "POST", { holder: "حسن", number: "444", currency: "SAR" });
    await call(`/api/owner/payment-providers/${ex.body.id}/move`, OWNER, "POST", { dir: "up" });
    // a bank with no account yet is not shown to buyers (the owner still sees it)
    await call("/api/owner/payment-providers", OWNER, "POST", { name: "جهة فارغة", kind: "bank" });
    expect((await call("/api/owner/payment-methods", OWNER)).body.map((p: any) => p.name)).toContain("جهة فارغة");
    const pub = (await call("/api/public/plans")).body;
    expect(pub.payment_methods.map((p: any) => p.name)).toEqual(["محفظة STC", "بنك الراجحي"]);
    const bank = pub.payment_methods[1];
    expect(bank.logo).toBe(logo);
    expect(bank.accounts.map((a: any) => a.currency)).toEqual(["SAR", "SAR", "USD"]);
    // edit + delete an account, bad logo rejected
    const aid = bank.accounts[0].id;
    expect((await call(`/api/owner/payment-accounts/${aid}`, OWNER, "PUT", { holder: "حسن علي", number: "999", currency: "USD" })).status).toBe(200);
    await call(`/api/owner/payment-accounts/${bank.accounts[1].id}`, OWNER, "DELETE");
    expect((await call("/api/public/plans")).body.payment_methods[1].accounts.map((a: any) => [a.number, a.currency])).toEqual([["999", "USD"], ["333", "USD"]]);
    expect((await call("/api/owner/payment-providers", OWNER, "POST", { name: "x", logo: "javascript:alert(1)" })).status).toBe(422);
    expect((await call(`/api/owner/payment-providers/${prov.body.id}/accounts`, OWNER, "POST", { holder: "a", number: "1", currency: "EUR" })).status).toBe(422);
    // customers cannot change them
    const { h } = await customerWithAccount();
    expect((await call("/api/owner/payment-providers", h, "POST", { name: "x" })).status).toBe(403);
    expect((await call("/api/subscription", h)).body.payment_methods).toHaveLength(2);
    await call(`/api/owner/payment-providers/${prov.body.id}`, OWNER, "DELETE");
    expect((await DB.prepare("SELECT COUNT(*) AS n FROM payment_accounts WHERE provider_id = ?").bind(prov.body.id).first<any>()).n).toBe(0);
  });

  it("prices are in riyals (dollars only for old plans); old stored rates for other currencies are not shown", async () => {
    await DB.prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('exchange_rates', ?, 0)").bind(JSON.stringify({ USD: 1, SAR: 3.8, YER: 1700, YER_SAN: 530 })).run();
    expect((await call("/api/public/plans")).body.rates).toEqual({ USD: 1, SAR: 3.8 });
    expect((await call("/api/owner/settings", OWNER, "PUT", { exchange_rates: { SAR: 0 } })).status).toBe(422);
    const pro = (await call("/api/owner/plans", OWNER)).body.find((p: any) => p.id === "pro");
    expect((await call("/api/owner/plans/pro", OWNER, "PUT", { name: pro.name, active: true, limits: pro.limits, price_amount: 10, price_currency: "EUR" })).status).toBe(422);
    expect((await call("/api/owner/plans/pro", OWNER, "PUT", { name: pro.name, active: true, limits: pro.limits, price_amount: 50, price_currency: "YER_SAN" })).status).toBe(422);
    expect((await call("/api/owner/plans/pro", OWNER, "PUT", { name: pro.name, active: true, limits: pro.limits, price_amount: 5000, price_currency: "SAR" })).status).toBe(200);
    expect((await call("/api/public/plans")).body.plans.find((p: any) => p.id === "pro")).toMatchObject({ price_amount: 5000, price_currency: "SAR", price_label: "5,000 ر.س / شهريًا" });
  });

  it("codes keep who used them after the customer is deleted, and any code can be deleted", async () => {
    const [code] = await codes("basic", 30);
    const reg = await call("/api/auth/register", {}, "POST", { name: "متجر سارة", username: "shop_sara", password: "sara-strong-pass-123", code });
    expect(reg.status).toBe(200);
    let list = (await call("/api/owner/codes", OWNER)).body;
    expect(list[0]).toMatchObject({ used_by: "متجر سارة", used_by_username: "shop_sara", customer_exists: 1 });
    const tid = (await DB.prepare("SELECT tenant_id FROM admin_users WHERE username = 'shop_sara'").first<any>()).tenant_id;
    // a code redeemed before names were stored: deleting the customer still records who it was
    await DB.prepare("UPDATE activation_codes SET used_by_name = NULL, used_by_username = NULL WHERE used_by_tenant = ?").bind(tid).run();
    await call(`/api/owner/tenants/${tid}`, OWNER, "DELETE", { confirm: "متجر سارة" });
    list = (await call("/api/owner/codes", OWNER)).body;
    expect(list[0]).toMatchObject({ used_by: "متجر سارة", used_by_username: "shop_sara", customer_exists: 0 });
    const [revoked] = await codes("pro", 7);
    const rid = (await call("/api/owner/codes", OWNER)).body[0].id;
    await call(`/api/owner/codes/${rid}/revoke`, OWNER, "POST", {});
    expect((await call(`/api/owner/codes/${rid}`, OWNER, "DELETE")).status).toBe(200);
    expect((await call(`/api/owner/codes/${list[0].id}`, OWNER, "DELETE")).status).toBe(200);
    expect((await call("/api/owner/codes", OWNER)).body).toHaveLength(0);
    expect(revoked).toMatch(/^HSN-/);
  });

  it("login banner: the owner sets it, everyone gets it as a cacheable image, customers cannot change it", async () => {
    expect((await call("/api/public/branding")).body.login_banner).toBeNull();
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    expect((await call("/api/owner/login-banner", OWNER, "PUT", { image: png })).status).toBe(200);
    const url = (await call("/api/public/branding")).body.login_banner;
    expect(url).toMatch(/^\/api\/public\/login-banner\?v=\d+$/);
    const img = await SELF.fetch(new Request(BASE + url));
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await img.arrayBuffer()).slice(1, 4)).toEqual(new Uint8Array([80, 78, 71])); // "PNG"
    expect((await call("/api/owner/login-banner", OWNER, "PUT", { image: "data:text/html;base64,PGgxPg==" })).status).toBe(422);
    const { h } = await customerWithAccount();
    expect((await call("/api/owner/login-banner", h, "PUT", { image: null })).status).toBe(403);
    // a separate phone image
    await call("/api/owner/login-banner", OWNER, "PUT", { variant: "mobile", image: png });
    const mob = (await call("/api/public/branding")).body.login_banner_mobile;
    expect(mob).toMatch(/k=mobile/);
    expect((await SELF.fetch(new Request(BASE + mob))).status).toBe(200);
    // texts + logo, then back to defaults
    const texts = { title: "عنوان", subtitle: "وصف", points: [{ title: "أ", desc: "" }, { title: "ب", desc: "د" }, { title: "", desc: "" }] };
    expect((await call("/api/owner/branding", OWNER, "PUT", { texts, logo: png, app_icon: png })).status).toBe(200);
    expect((await call("/api/public/branding")).body).toMatchObject({ texts, logo: png, app_icon: png, app_download_url: `${BASE}/app.apk` });
    expect((await call("/api/owner/branding", OWNER, "PUT", { texts: { ...texts, points: [] }, logo: null })).status).toBe(422);
    // 1–6 points, each icon a Remix Icon name or an uploaded PNG
    const six = Array.from({ length: 6 }, (_, i) => ({ title: `ن${i}`, desc: "", icon: i % 2 ? "ri:rocket-line" : png }));
    expect((await call("/api/owner/branding", OWNER, "PUT", { texts: { ...texts, points: six }, logo: null })).status).toBe(200);
    expect((await call("/api/public/branding")).body.texts.points[1].icon).toBe("ri:rocket-line");
    expect((await call("/api/owner/branding", OWNER, "PUT", { texts: { ...texts, points: [...six, six[0]] }, logo: null })).status).toBe(422);
    for (const icon of ["https://evil.example/x.png", "ri:Bad Name", "data:image/svg+xml;base64,PHN2Zz4="])
      expect((await call("/api/owner/branding", OWNER, "PUT", { texts: { ...texts, points: [{ title: "أ", desc: "", icon }] }, logo: null })).status).toBe(422);
    await call("/api/owner/branding", OWNER, "PUT", { texts: null, logo: null });
    expect((await call("/api/public/branding")).body).toMatchObject({ texts: null, logo: null });
    await call("/api/owner/login-banner", OWNER, "PUT", { image: null });
    await call("/api/owner/login-banner", OWNER, "PUT", { variant: "mobile", image: null });
    expect((await call("/api/public/branding")).body).toMatchObject({ login_banner: null, login_banner_mobile: null });
    expect((await SELF.fetch(new Request(BASE + "/api/public/login-banner"))).status).toBe(404);
  });

  it("the owner sets the order of the plan points; unknown keys are dropped and missing ones appended", async () => {
    const def = (await call("/api/public/plans")).body.feature_order;
    expect(def.slice(0, 4)).toEqual(["events", "active_campaigns", "monthly_messages", "store"]);
    expect((await call("/api/owner/feature-order", OWNER, "PUT", { order: ["recover", "bogus", "events", "recover"] })).status).toBe(200);
    const got = (await call("/api/public/plans")).body.feature_order;
    expect(got.slice(0, 2)).toEqual(["recover", "events"]);
    expect(got).not.toContain("bogus");
    expect([...got].sort()).toEqual([...def].sort());
    expect((await call("/api/owner/feature-order", {}, "PUT", { order: [] })).status).toBe(401);
  });

  it("the featured badge goes on any plan with the owner's text, or none; wallets are a payment kind", async () => {
    expect((await call("/api/public/plans")).body.featured).toEqual({ plan_id: "pro", label: "الأكثر طلبًا" });
    expect((await call("/api/owner/featured-plan", OWNER, "PUT", { plan_id: "max", label: "الأفضل قيمة" })).status).toBe(200);
    expect((await call("/api/public/plans")).body.featured).toEqual({ plan_id: "max", label: "الأفضل قيمة" });
    await call("/api/owner/featured-plan", OWNER, "PUT", { plan_id: null, label: "x" });
    expect((await call("/api/public/plans")).body.featured.plan_id).toBeNull();
    expect((await call("/api/owner/featured-plan", OWNER, "PUT", { plan_id: "nope", label: "x" })).status).toBe(422);
    const { h } = await customerWithAccount();
    expect((await call("/api/owner/featured-plan", h, "PUT", { plan_id: "max", label: "x" })).status).toBe(403);
    const w = await call("/api/owner/payment-providers", OWNER, "POST", { name: "محفظة جيب", kind: "wallet" });
    await call(`/api/owner/payment-providers/${w.body.id}/accounts`, OWNER, "POST", { holder: "حسن", number: "777", currency: "SAR" });
    expect(w.status).toBe(200);
    expect((await call("/api/public/plans")).body.payment_methods[0].kind).toBe("wallet");
  });

  it("plans are editable and the public pricing page shows them", async () => {
    const plans = (await call("/api/owner/plans", OWNER)).body;
    const pro = plans.find((p: any) => p.id === "pro");
    const put = await call("/api/owner/plans/pro", OWNER, "PUT", { ...pro, price_label: "149 ر.س / شهريًا", active: true });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    await call("/api/owner/settings", OWNER, "PUT", { sales_contact: "https://wa.me/966500000000" });
    const page = await SELF.fetch(new Request(BASE + "/pricing", { redirect: "manual" }));
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe("/#/plans");
    const pub = (await call("/api/public/plans")).body;
    expect(pub.plans.find((p: any) => p.id === "pro").price_label).toBe("149 ر.س / شهريًا");
    expect(pub.plans.map((p: any) => p.name)).toContain("الكامل");
    expect(pub.sales_contact).toBe("https://wa.me/966500000000");
  });
});

describe("the free plan", () => {
  const activateFree = async () => {
    const limits = JSON.parse((await DB.prepare("SELECT limits FROM plans WHERE id = 'free'").first<any>()).limits);
    return call("/api/owner/plans/free", OWNER, "PUT", { name: "الباقة المجانية", free: true, price_label: "مجاناً", price_period: "month", active: true, limits: { public_reply: false, link_tracking: false, inbox_manual: false, telegram: false, recover: false, csv_export: false, draws_per_month: 0, draw_video: false, cards: false, ...limits } });
  };
  const confirmEmail = (username: string, email = `${username}@example.com`) =>
    DB.prepare("UPDATE admin_users SET email = ?, email_verified_at = ? WHERE username = ?").bind(email, Date.now(), username).run();
  /** A customer (made by the owner) with a confirmed email, signed in from a given network. */
  async function customer(username: string, ip = "10.0.0.1") {
    const r = await call("/api/owner/tenants", OWNER, "POST", { name: `متجر ${username}`, username, password: "another-strong-password" });
    await confirmEmail(username);
    const h = { ...(await login(username, "another-strong-password")), "CF-Connecting-IP": ip };
    return { h, tid: r.body.id as number };
  }
  const takeFree = (h: H) => call("/api/subscription/free", h, "POST", { plan_id: "free" });

  it("is off until the owner turns it on; sign-up confirms the email inside the form and starts the plan right away", async () => {
    const { vi } = await import("vitest");
    const sent: string[] = [];
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (u: any, init?: RequestInit) => {
      if (String(u).includes("resend.com")) {
        sent.push(String(JSON.parse(String(init?.body)).text));
        return new Response("{}", { status: 200 });
      }
      return real(u, init);
    });
    try {
      const body = (extra: Record<string, unknown> = {}) => ({ name: "متجر", username: "free_a", password: "another-strong-password", plan_id: "free", email: "free_a@example.com", ...extra });
      expect((await call("/api/auth/register", {}, "POST", body())).status).toBe(422); // the plan is off
      const put = await activateFree();
      expect(put.status, JSON.stringify(put.body)).toBe(200);
      const plan = (await call("/api/public/plans")).body.plans.find((p: any) => p.id === "free");
      expect(plan).toMatchObject({ free: true, price_label: "مجاناً", card_price: null });
      // no code yet / throw-away email: refused, nothing created
      expect((await call("/api/auth/register", {}, "POST", body())).body.error.code).toBe("email_code_required");
      expect((await call("/api/auth/register/email-code", {}, "POST", { email: "x@yopmail.com" })).body.error.code).toBe("email_disposable");
      expect((await call("/api/auth/register/email-code", {}, "POST", { email: "free_a@example.com" })).status).toBe(200);
      const code = sent.at(-1)!.match(/\d{6}/)![0];
      const wrong = code === "000000" ? "111111" : "000000";
      expect((await call("/api/auth/register", {}, "POST", body({ email_code: wrong }))).body.error.code).toBe("invalid_email_code");
      expect(await DB.prepare("SELECT 1 FROM admin_users WHERE username = 'free_a'").first()).toBeNull();
      expect((await call("/api/auth/register", {}, "POST", body({ email_code: code }))).status).toBe(200);
      const t = await DB.prepare("SELECT t.plan_id, t.plan_expires_at, u.email, u.email_verified_at FROM tenants t JOIN admin_users u ON u.tenant_id = t.id WHERE u.username = 'free_a'").first<any>();
      expect(t.plan_id).toBe("free");
      expect(t.plan_expires_at).toBeGreaterThan(Date.now() + 29 * 86_400_000);
      expect(t.email).toBe("free_a@example.com");
      expect(t.email_verified_at).toBeTruthy();
      expect(await DB.prepare("SELECT COUNT(*) AS n FROM card_payments").first<any>()).toMatchObject({ n: 0 });
      // the same email cannot back a second sign-up
      expect((await call("/api/auth/register/email-code", {}, "POST", { email: "free_a@example.com" })).body.error.code).toBe("email_taken");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a new account without a plan gets no «out of messages» window", async () => {
    await activateFree();
    const r = await call("/api/owner/tenants", OWNER, "POST", { name: "متجر", username: "no_plan", password: "another-strong-password" });
    expect(r.status).toBe(200);
    const h = await login("no_plan", "another-strong-password");
    const promos = (await call("/api/promos", h)).body;
    expect(promos.popup).toBeNull();
    expect(promos.topup.out).toBe(false);
  });

  it("a customer takes it once per period, can move up to a paid plan, and cannot drop to it from a paid one", async () => {
    await activateFree();
    const { h, tid } = await customer("shop_f");
    expect((await call("/api/subscription/free", h, "POST", { plan_id: "basic" })).status).toBe(404); // not a free plan
    expect((await takeFree(h)).status).toBe(200);
    expect((await takeFree(h)).status).toBe(409);
    // free → paid: a fresh full period on the paid plan (not added to the free days)
    const [code] = await codes("basic", 30);
    const before = Date.now();
    expect((await call("/api/subscription/redeem", h, "POST", { code })).status).toBe(200);
    const t = await DB.prepare("SELECT plan_id, plan_expires_at FROM tenants WHERE id = ?").bind(tid).first<any>();
    expect(t.plan_id).toBe("basic");
    expect(t.plan_expires_at).toBeLessThan(before + 31 * 86_400_000);
    // paid → free while the paid plan runs: blocked
    expect((await takeFree(h)).status).toBe(409);
  });

  it("refuses throw-away email addresses", async () => {
    await activateFree();
    const { h } = await customer("shop_t");
    await confirmEmail("shop_t", "x@mailinator.com");
    const r = await takeFree(h);
    expect(r.body.error.code).toBe("email_disposable");
  });

  it("at most 3 new free accounts per network per week; renewing your own does not count", async () => {
    await activateFree();
    for (const u of ["net_a1", "net_a2", "net_a3"]) expect((await takeFree((await customer(u, "10.9.9.9")).h)).status).toBe(200);
    const fourth = await takeFree((await customer("net_a4", "10.9.9.9")).h);
    expect(fourth.status).toBe(409);
    expect(fourth.body.error.code).toBe("free_network_limit");
    // another network is fine
    expect((await takeFree((await customer("net_b1", "10.8.8.8")).h)).status).toBe(200);
  });

  it("is given once per Instagram account: another customer connecting the same account loses the free plan, and the owner sees it flagged", async () => {
    const { checkFreeOnConnect } = await import("../src/worker/services/freeplan");
    const env = (await import("cloudflare:workers")).env as any;
    await activateFree();
    const now = Date.now();
    const a = await customer("ig_first");
    await DB.prepare("INSERT INTO instagram_accounts (tenant_id, ig_user_id, username, status, token_ciphertext, token_iv, created_at, updated_at) VALUES (?, '1784DUP', 'dup_shop', 'active', 'x', 'y', ?, ?)").bind(a.tid, now, now).run();
    expect((await takeFree(a.h)).status).toBe(200);
    expect(await DB.prepare("SELECT tenant_id FROM free_claims WHERE ig_user_id = '1784DUP'").first<any>()).toMatchObject({ tenant_id: a.tid });

    // the first customer is deleted and the account signs up again: the claim stays with the Instagram account
    expect((await call(`/api/owner/tenants/${a.tid}`, OWNER, "DELETE", { confirm: "متجر ig_first" })).status).toBe(200);
    const b = await customer("ig_second", "10.0.0.2");
    expect((await takeFree(b.h)).status).toBe(200); // no account connected yet
    await DB.prepare("INSERT INTO instagram_accounts (tenant_id, ig_user_id, username, status, token_ciphertext, token_iv, created_at, updated_at) VALUES (?, '1784DUP', 'dup_shop', 'active', 'x', 'y', ?, ?)").bind(b.tid, now, now).run();
    expect(await checkFreeOnConnect(env, b.tid, "1784DUP", "dup_shop")).toBe("ended");
    const ent = (await call("/api/subscription", b.h)).body;
    expect(ent.active).toBe(false);
    // trying again with that account is refused
    expect((await takeFree(b.h)).body.error.code).toBe("free_used_ig");
    // the customer is told, and the owner's list flags the account
    expect(await DB.prepare("SELECT COUNT(*) AS n FROM app_notifications WHERE tenant_id = ? AND title = 'انتهت الباقة المجانية'").bind(b.tid).first<any>()).toMatchObject({ n: 1 });
    const row = (await call("/api/owner/tenants", OWNER)).body.find((t: any) => t.id === b.tid);
    expect(row.dup_ig).toMatchObject({ username: "dup_shop", first_tenant_id: 0, blocked: 1 });
    // a paid plan is still open to them
    const [code] = await codes("basic", 30);
    expect((await call("/api/subscription/redeem", b.h, "POST", { code })).status).toBe(200);
    // a different, fresh account on the free plan just claims it
    const c = await customer("ig_third", "10.0.0.3");
    expect((await takeFree(c.h)).status).toBe(200);
    expect(await checkFreeOnConnect(env, c.tid, "1784NEW", "new_shop")).toBe("claimed");
  });
});
