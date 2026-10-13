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

  it("plans are editable and the public pricing page shows them", async () => {
    const plans = (await call("/api/owner/plans", OWNER)).body;
    const pro = plans.find((p: any) => p.id === "pro");
    const put = await call("/api/owner/plans/pro", OWNER, "PUT", { ...pro, price_label: "149 ر.س / شهريًا", active: true });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    await call("/api/owner/settings", OWNER, "PUT", { sales_contact: "https://wa.me/966500000000" });
    const page = await call("/pricing");
    expect(page.status).toBe(200);
    expect(page.body).toContain("149 ر.س / شهريًا");
    expect(page.body).toContain("الكامل");
    expect(page.body).toContain("7042872536");
    expect(page.body).toContain("https://wa.me/966500000000");
    expect(page.body).toContain('role="tooltip"');
    expect(page.body).toContain("المحاكاة");
  });
});
