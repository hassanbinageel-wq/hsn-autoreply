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
    await DB.prepare("INSERT INTO usage_counters (tenant_id, month, messages) VALUES (?, ?, 1000)").bind(tid, new Date().toISOString().slice(0, 7)).run();
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
    const prov = await call("/api/owner/payment-providers", OWNER, "POST", { name: "بنك الكريمي", kind: "bank", logo });
    expect(prov.status).toBe(200);
    for (const [currency, number] of [["YER", "111"], ["SAR", "222"], ["USD", "333"]]) {
      expect((await call(`/api/owner/payment-providers/${prov.body.id}/accounts`, OWNER, "POST", { holder: "حسن", number, currency })).status).toBe(200);
    }
    const ex = await call("/api/owner/payment-providers", OWNER, "POST", { name: "صرافة النجم", kind: "exchange" });
    await call(`/api/owner/payment-providers/${ex.body.id}/move`, OWNER, "POST", { dir: "up" });
    const pub = (await call("/api/public/plans")).body;
    expect(pub.payment_methods.map((p: any) => p.name)).toEqual(["صرافة النجم", "بنك الكريمي"]);
    const bank = pub.payment_methods[1];
    expect(bank.logo).toBe(logo);
    expect(bank.accounts.map((a: any) => a.currency)).toEqual(["YER", "SAR", "USD"]);
    // edit + delete an account, bad logo rejected
    const aid = bank.accounts[0].id;
    expect((await call(`/api/owner/payment-accounts/${aid}`, OWNER, "PUT", { holder: "حسن علي", number: "999", currency: "YER_SAN" })).status).toBe(200);
    await call(`/api/owner/payment-accounts/${bank.accounts[1].id}`, OWNER, "DELETE");
    expect((await call("/api/public/plans")).body.payment_methods[1].accounts.map((a: any) => [a.number, a.currency])).toEqual([["999", "YER_SAN"], ["333", "USD"]]);
    expect((await call("/api/owner/payment-providers", OWNER, "POST", { name: "x", logo: "javascript:alert(1)" })).status).toBe(422);
    expect((await call(`/api/owner/payment-providers/${prov.body.id}/accounts`, OWNER, "POST", { holder: "a", number: "1", currency: "EUR" })).status).toBe(422);
    // customers cannot change them
    const { h } = await customerWithAccount();
    expect((await call("/api/owner/payment-providers", h, "POST", { name: "x" })).status).toBe(403);
    expect((await call("/api/subscription", h)).body.payment_methods).toHaveLength(2);
    await call(`/api/owner/payment-providers/${prov.body.id}`, OWNER, "DELETE");
    expect((await DB.prepare("SELECT COUNT(*) AS n FROM payment_accounts").first<any>()).n).toBe(0);
  });

  it("exchange rates are the owner's and come with the catalog; only four currencies", async () => {
    expect((await call("/api/owner/settings", OWNER, "PUT", { exchange_rates: { SAR: 3.8, YER: 1700, YER_SAN: 530 } })).status).toBe(200);
    expect((await call("/api/public/plans")).body.rates).toEqual({ USD: 1, SAR: 3.8, YER: 1700, YER_SAN: 530 });
    expect((await call("/api/owner/settings", OWNER, "PUT", { exchange_rates: { SAR: 0, YER: 1, YER_SAN: 1 } })).status).toBe(422);
    const pro = (await call("/api/owner/plans", OWNER)).body.find((p: any) => p.id === "pro");
    expect((await call("/api/owner/plans/pro", OWNER, "PUT", { name: pro.name, active: true, limits: pro.limits, price_amount: 10, price_currency: "EUR" })).status).toBe(422);
    expect((await call("/api/owner/plans/pro", OWNER, "PUT", { name: pro.name, active: true, limits: pro.limits, price_amount: 5000, price_currency: "YER_SAN" })).status).toBe(200);
    expect((await call("/api/public/plans")).body.plans.find((p: any) => p.id === "pro")).toMatchObject({ price_amount: 5000, price_currency: "YER_SAN", price_label: "5,000 ر.ي (صنعاء) / شهريًا" });
  });

  it("codes keep who used them after the customer is deleted, and any code can be deleted", async () => {
    const [code] = await codes("basic", 30);
    const reg = await call("/api/auth/register", {}, "POST", { name: "متجر سارة", username: "shop_sara", password: "sara-strong-pass-123", code });
    expect(reg.status).toBe(200);
    let list = (await call("/api/owner/codes", OWNER)).body;
    expect(list[0]).toMatchObject({ used_by: "متجر سارة", used_by_username: "shop_sara", customer_exists: 1 });
    const tid = (await DB.prepare("SELECT tenant_id FROM admin_users WHERE username = 'shop_sara'").first<any>()).tenant_id;
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
    expect((await call("/api/owner/branding", OWNER, "PUT", { texts, logo: png })).status).toBe(200);
    expect((await call("/api/public/branding")).body).toMatchObject({ texts, logo: png });
    expect((await call("/api/owner/branding", OWNER, "PUT", { texts: { ...texts, points: [] }, logo: null })).status).toBe(422);
    await call("/api/owner/branding", OWNER, "PUT", { texts: null, logo: null });
    expect((await call("/api/public/branding")).body).toMatchObject({ texts: null, logo: null });
    await call("/api/owner/login-banner", OWNER, "PUT", { image: null });
    await call("/api/owner/login-banner", OWNER, "PUT", { variant: "mobile", image: null });
    expect((await call("/api/public/branding")).body).toMatchObject({ login_banner: null, login_banner_mobile: null });
    expect((await SELF.fetch(new Request(BASE + "/api/public/login-banner"))).status).toBe(404);
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
