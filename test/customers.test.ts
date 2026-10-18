import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DB, resetDb, seedAccount } from "./helpers";
import { withUtm } from "../src/shared/template";

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
});
async function code(days = 30): Promise<string> {
  return (await call("/api/owner/codes", OWNER, "POST", { plan_id: "basic", days, count: 1 })).body.codes[0];
}
async function register(username: string, ref?: string) {
  const r = await call("/api/auth/register", {}, "POST", { name: `متجر ${username}`, username, password: "another-strong-password", code: await code(), ref });
  expect(r.status).toBe(200);
  const h = await login(username, "another-strong-password");
  const tid = (await DB.prepare("SELECT tenant_id FROM admin_users WHERE username = ?").bind(username).first<any>()).tenant_id;
  return { h, tid };
}
const expires = async (tid: number) => (await DB.prepare("SELECT plan_expires_at FROM tenants WHERE id = ?").bind(tid).first<any>()).plan_expires_at as number;

describe("owner tools: support, coupons, referrals, health; UTM", () => {
  it("support: a customer writes, the owner is told and replies; nobody else can read it", async () => {
    const a = await register("shop_a");
    const b = await register("shop_b");
    const t = await call("/api/support", a.h, "POST", { subject: "الحملة ما ترد", body: "جربت أعلق وما وصلني شي" });
    expect(t.status).toBe(200);
    const ownerNote = (await call("/api/app-notifications", OWNER)).body.items[0];
    expect(ownerNote).toMatchObject({ kind: "support", link: "/owner?tab=support" });
    expect(ownerNote.title).toContain("متجر shop_a");
    // another customer cannot see or answer it
    expect((await call(`/api/support/${t.body.id}`, b.h)).status).toBe(404);
    expect((await call(`/api/support/${t.body.id}/reply`, b.h, "POST", { body: "x" })).status).toBe(404);
    expect((await call("/api/support", b.h)).body).toEqual([]);
    expect((await call("/api/owner/support", b.h)).status).toBe(403);
    // the owner sees it and replies; the customer is told (with a link to the conversation)
    expect((await call("/api/owner/support", OWNER)).body[0]).toMatchObject({ subject: "الحملة ما ترد", tenant_name: "متجر shop_a", unread: 1 });
    await call(`/api/owner/support/${t.body.id}/reply`, OWNER, "POST", { body: "تم الإصلاح ✅", close: true });
    const note = (await call("/api/app-notifications", a.h)).body.items.find((n: any) => n.kind === "support_reply");
    expect(note.link).toBe(`/support?thread=${t.body.id}`);
    const thread = (await call(`/api/support/${t.body.id}`, a.h)).body;
    expect(thread.thread.status).toBe("closed");
    expect(thread.messages.map((m: any) => m.sender)).toEqual(["customer", "owner"]);
    expect((await call("/api/app-notifications", b.h)).body.items).toEqual([]);
  });

  it("coupons: valid codes show their discount; inactive, expired or used-up codes do not", async () => {
    expect((await call("/api/owner/coupons", OWNER, "POST", { code: "ramadan20", percent: 20, plan_ids: ["pro"], max_uses: 1 })).body).toMatchObject({ ok: true, code: "RAMADAN20" });
    expect((await call("/api/public/coupon?code=ramadan20")).body).toMatchObject({ code: "RAMADAN20", percent: 20, plans: ["pro"] });
    await call("/api/public/coupon/use", {}, "POST", { code: "RAMADAN20" });
    expect((await call("/api/public/coupon?code=RAMADAN20")).status).toBe(404); // max uses reached
    await call("/api/owner/coupons", OWNER, "POST", { code: "OLD", percent: 10, expires_at: Date.now() - DAY });
    expect((await call("/api/public/coupon?code=OLD")).status).toBe(404);
    await call("/api/owner/coupons", OWNER, "POST", { code: "OFF50", percent: 50 });
    const id = (await call("/api/owner/coupons", OWNER)).body.coupons.find((c: any) => c.code === "OFF50").id;
    await call(`/api/owner/coupons/${id}`, OWNER, "PUT", { active: false });
    expect((await call("/api/public/coupon?code=OFF50")).status).toBe(404);
    const a = await register("shop_a");
    expect((await call("/api/owner/coupons", a.h)).status).toBe(403);
  });

  it("referrals: a sign-up with a customer's code gives both bonus days, once", async () => {
    const a = await register("shop_a");
    const r = (await call("/api/referral", a.h)).body;
    expect(r).toMatchObject({ days_per_referral: 7, referred: 0 });
    expect(r.code).toMatch(/^R[A-Z0-9]{6}$/);
    const before = await expires(a.tid);
    const b = await register("shop_b", r.code);
    expect(await expires(a.tid)).toBe(before + 7 * DAY);
    expect((await call("/api/referral", a.h)).body).toMatchObject({ referred: 1, rewarded: 1 });
    expect((await call("/api/app-notifications", a.h)).body.items[0]).toMatchObject({ kind: "referral" });
    expect((await call("/api/app-notifications", b.h)).body.items[0]).toMatchObject({ kind: "referral" });
    // an unknown code does nothing; the reward can be turned off
    await call("/api/owner/referral", OWNER, "PUT", { days: 0 });
    const c = await register("shop_c", r.code);
    expect(await expires(a.tid)).toBe(before + 7 * DAY);
    expect((await DB.prepare("SELECT referred_by FROM tenants WHERE id = ?").bind(c.tid).first<any>()).referred_by).toBe(a.tid);
  });

  it("health: customers at risk come first, with the reasons", async () => {
    const a = await register("shop_a"); // just logged in, no Instagram, no campaign
    const h = (await call("/api/owner/health", OWNER)).body.customers;
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ id: a.tid, risk: "high" });
    expect(h[0].reasons).toEqual(expect.arrayContaining(["إنستقرام غير مربوط", "ما عنده حملة شغّالة"]));
    expect((await call("/api/owner/health", a.h)).status).toBe(403);
  });

  it("store name (login): English only, invisible marks and @ removed, any letter case at login; display name may be Arabic", async () => {
    const c = await code();
    expect((await call("/api/auth/register", {}, "POST", { name: "ماجد", username: "\u200F@Majed.Store", password: "another-strong-password", code: c })).status).toBe(200);
    expect((await DB.prepare("SELECT username FROM admin_users WHERE username = 'Majed.Store'").first<any>())).toBeTruthy();
    expect((await call("/api/auth/login", {}, "POST", { username: "majed.store\u200E", password: "another-strong-password", client: "app" })).body.token).toBeTruthy();
    expect((await call("/api/auth/register", {}, "POST", { name: "خالد", username: "متجر_نور", password: "another-strong-password", code: await code() })).status).toBe(422);
    expect((await call("/api/auth/register", {}, "POST", { name: "خالد", username: "MAJED.STORE", password: "another-strong-password", code: await code() })).status).toBe(409);
  });

  it("a discount code typed in the activation box says where it goes", async () => {
    const a = await register("shop_a");
    await call("/api/owner/coupons", OWNER, "POST", { code: "RAMADAN", percent: 20 });
    const r = await call("/api/subscription/redeem", a.h, "POST", { code: "ramadan" });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: "is_coupon" });
    expect(r.body.error.message).toContain("عندك كود خصم");
  });

  it("owner messages: expiry, reminder (fresh unread copy), delete everywhere; customers delete their own", async () => {
    const a = await register("shop_a");
    await call(`/api/owner/tenants/${a.tid}/message`, OWNER, "POST", { title: "عرض التجديد", link: "/subscription", days: 7 });
    let items = (await call("/api/app-notifications", a.h)).body.items.filter((n: any) => n.kind === "message");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: "✉️ عرض التجديد", link: "/subscription" });
    expect(items[0].expires_at - Date.now()).toBeGreaterThan(6.9 * DAY);
    await call("/api/app-notifications/read", a.h, "POST", {});
    let sent = (await call("/api/owner/messages", OWNER)).body;
    expect(sent[0]).toMatchObject({ tenant_id: a.tid, copies: 1, read: 1, clicked: 0 });
    // another customer cannot mark it; the customer's tap counts as «opened the link»
    const other = await register("shop_x");
    await call(`/api/app-notifications/${items[0].id}/click`, other.h, "POST", {});
    expect((await call("/api/owner/messages", OWNER)).body[0].clicked).toBe(0);
    await call(`/api/app-notifications/${items[0].id}/click`, a.h, "POST", {});
    sent = (await call("/api/owner/messages", OWNER)).body;
    expect(sent[0]).toMatchObject({ clicked: 1, tenant_usernames: "shop_a" });
    const who = (await call(`/api/owner/messages/${sent[0].id}`, OWNER)).body;
    expect(who).toHaveLength(1);
    expect(who[0]).toMatchObject({ tenant_id: a.tid, tenant_usernames: "shop_a" });
    expect(who[0].clicked_at).toBeGreaterThan(0);
    await call(`/api/owner/messages/${sent[0].id}/remind`, OWNER, "POST", {});
    const u = (await call("/api/app-notifications/unread", a.h)).body;
    expect(u.unread).toBe(1);
    expect(u.latest).toMatchObject({ kind: "message" });
    items = (await call("/api/app-notifications", a.h)).body.items.filter((n: any) => n.kind === "message");
    expect(items.map((n: any) => n.title)).toEqual(["🔔 تذكير: ✉️ عرض التجديد"]);
    // the customer deletes it; then the owner deletes the message
    await call(`/api/app-notifications/${items[0].id}`, a.h, "DELETE");
    expect((await call("/api/app-notifications", a.h)).body.items.filter((n: any) => n.kind === "message")).toEqual([]);
    await call(`/api/owner/tenants/${a.tid}/message`, OWNER, "POST", { title: "رسالة ثانية" });
    const id = (await call("/api/owner/messages", OWNER)).body[0].id;
    await call(`/api/owner/messages/${id}`, OWNER, "DELETE");
    expect((await call("/api/app-notifications", a.h)).body.items.filter((n: any) => n.kind === "message")).toEqual([]);
    expect((await call("/api/owner/messages", a.h)).status).toBe(403);
    // delete all
    await call(`/api/owner/tenants/${a.tid}/message`, OWNER, "POST", { title: "ثالثة" });
    await call("/api/owner/messages", OWNER, "DELETE");
    expect((await call("/api/owner/messages", OWNER)).body).toEqual([]);
    expect((await call("/api/app-notifications", a.h)).body.items.filter((n: any) => n.kind === "message")).toEqual([]);
  });

  it("UTM tags: added to shop links, not to chat links, existing tags kept", () => {
    expect(withUtm("https://demo.salla.sa/p1", "ريل الجاكيت")).toBe(`https://demo.salla.sa/p1?utm_source=instagram&utm_medium=hsn&utm_campaign=${encodeURIComponent("ريل-الجاكيت")}`);
    expect(withUtm("https://wa.me/966500000000", "x")).toBe("https://wa.me/966500000000");
    expect(withUtm("https://x.com/a?utm_source=tiktok", "x")).toBe("https://x.com/a?utm_source=tiktok");
    expect(withUtm(null, "x")).toBeNull();
  });
});
