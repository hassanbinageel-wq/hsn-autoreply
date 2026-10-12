import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { commentPayload, DB, deliver, flowsOf, IG_ID, MockMeta, resetDb, seedAccount, uid } from "./helpers";

const BASE = "https://hsn.example.workers.dev";
const SELF = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
type H = Record<string, string>;
const IG_B = "17841400000000002";

async function call(path: string, h: H = {}, method = "GET", body?: unknown) {
  const r = await SELF.fetch(new Request(BASE + path, { method, headers: { "Content-Type": "application/json", ...h }, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}
async function login(username: string, password: string): Promise<H> {
  const r = await SELF.fetch(new Request(BASE + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password, client: "app" }) }));
  const b = (await r.json()) as any;
  if (!b.token) throw new Error(`login failed: ${JSON.stringify(b)}`);
  return { Authorization: `Bearer ${b.token}` };
}
const campaign = (name: string, kw = "كورس") => ({ name, type: "comment", final_text: `محتوى ${name} https://example.com/${name}`, keywords: [{ keyword: kw, kind: "include", match_type: "contains" }] });

let OWNER: H;
let B: H;
let tenantB = 0;

beforeEach(async () => {
  await resetDb();
  await seedAccount(); // the owner's Instagram account (tenant 1)
  await call("/api/auth/setup", {}, "POST", { setup_token: "test_setup_token_123456", username: "admin", password: "a-very-strong-password" });
  OWNER = await login("admin", "a-very-strong-password");
  const r = await call("/api/owner/tenants", OWNER, "POST", { name: "متجر ب", username: "shop_b", password: "another-strong-password" });
  tenantB = r.body.id;
  // B has the full plan for 30 days (subscriptions are covered in subscriptions.test.ts).
  await call(`/api/owner/tenants/${tenantB}/plan`, OWNER, "POST", { plan_id: "max", days: 30 });
  B = await login("shop_b", "another-strong-password");
  // Customer B's own Instagram account.
  const now = Date.now();
  await DB.prepare(
    "INSERT INTO instagram_accounts (tenant_id, ig_user_id, app_scoped_id, username, status, token_ciphertext, token_iv, created_at, updated_at) VALUES (?, ?, 'app_b', 'shop_b_ig', 'active', 'x', 'y', ?, ?)",
  ).bind(tenantB, IG_B, now, now).run();
});

describe("customers (tenants) are isolated", () => {
  it("only the owner can manage customers; the second setup is refused", async () => {
    expect((await call("/api/owner/tenants", B)).status).toBe(403);
    expect((await call("/api/owner/tenants", OWNER)).body.map((t: any) => t.name)).toEqual(["المالك", "متجر ب"]);
    expect((await call("/api/auth/setup", {}, "POST", { setup_token: "test_setup_token_123456", username: "evil", password: "a-very-strong-password" })).status).toBe(409);
    expect((await call("/api/auth/me", B)).body.is_owner).toBe(false);
  });

  it("campaigns, templates, designs and settings are never visible or editable across customers", async () => {
    const a = await call("/api/campaigns", OWNER, "POST", campaign("owner_c"));
    const b = await call("/api/campaigns", B, "POST", campaign("b_c"));
    expect((await call("/api/campaigns", OWNER)).body.map((c: any) => c.name)).toEqual(["owner_c"]);
    expect((await call("/api/campaigns", B)).body.map((c: any) => c.name)).toEqual(["b_c"]);
    // direct access by id → 404, and writes do nothing
    expect((await call(`/api/campaigns/${a.body.id}`, B)).status).toBe(404);
    expect((await call(`/api/campaigns/${a.body.id}/stats`, B)).status).toBe(404);
    expect((await call(`/api/campaigns/${a.body.id}`, B, "PUT", campaign("hacked"))).status).toBe(404);
    expect((await call(`/api/campaigns/${a.body.id}`, B, "DELETE")).status).toBe(404);
    expect((await call(`/api/campaigns/${a.body.id}/status`, B, "POST", { status: "active" })).status).toBe(404);
    expect((await DB.prepare("SELECT name, status, deleted_at FROM campaigns WHERE id = ?").bind(a.body.id).first<any>())).toEqual({ name: "owner_c", status: "draft", deleted_at: null });
    expect((await call(`/api/campaigns/${b.body.id}`, B)).status).toBe(200);

    const t = await call("/api/templates", OWNER, "POST", { kind: "final", name: "قالبي", body: "سري" });
    expect((await call("/api/templates", B)).body.some((x: any) => x.name === "قالبي")).toBe(false);
    expect((await call(`/api/templates/${t.body.id}`, B, "DELETE")).status).toBe(404);
    expect(await DB.prepare("SELECT 1 FROM templates WHERE id = ?").bind(t.body.id).first()).toBeTruthy();

    await call("/api/settings", B, "PUT", { global_user_hourly_limit: 3, timezone: "Asia/Riyadh" });
    expect((await call("/api/settings", OWNER)).body.settings.global_user_hourly_limit).toBe(10);
    expect((await call("/api/settings", B)).body.settings.global_user_hourly_limit).toBe(3);

    // undo lists are per customer
    expect((await call("/api/undo", B)).body.every((o: any) => !o.label.includes("owner_c"))).toBe(true);
  });

  it("a comment on B's Instagram account only triggers B's campaigns (and the reverse)", async () => {
    const a = await call("/api/campaigns", OWNER, "POST", campaign("owner_c"));
    const b = await call("/api/campaigns", B, "POST", campaign("b_c"));
    await call(`/api/campaigns/${a.body.id}/status`, OWNER, "POST", { status: "active" });
    await call(`/api/campaigns/${b.body.id}/status`, B, "POST", { status: "active" });
    const meta = new MockMeta();
    // comment on B's account
    const p = commentPayload({ text: "أبغى الكورس", commentId: uid("c"), time: Date.now() + 2000 });
    (p as any).entry[0].id = IG_B;
    await deliver(p, meta);
    expect(meta.sends()).toHaveLength(1);
    expect(meta.sends()[0].text).toContain("b_c");
    // comment on the owner's account
    await deliver(commentPayload({ text: "أبغى الكورس", commentId: uid("c"), from: "someone_else", time: Date.now() + 2000 }), meta);
    expect(meta.sends()[1].text).toContain("owner_c");
    // logs and inbox are per customer
    const ownerEvents = (await call("/api/logs/events?demo=0", OWNER)).body;
    const bEvents = (await call("/api/logs/events?demo=0", B)).body;
    expect(ownerEvents).toHaveLength(1);
    expect(bEvents).toHaveLength(1);
    expect(bEvents[0].id).not.toBe(ownerEvents[0].id);
    const flowA = (await flowsOf("someone_else"))[0];
    expect((await call(`/api/flows/${flowA.id}`, B)).status).toBe(404);
    expect((await call("/api/dashboard", B)).body.campaigns.active).toBe(1);
  });

  it("an Instagram account already used by one customer cannot be connected to another", async () => {
    const { accountAvailableTo } = await import("../src/worker/services/account");
    expect(await accountAvailableTo(DB, IG_ID, tenantB)).toBe(false); // the owner's account
    expect(await accountAvailableTo(DB, IG_B, 1)).toBe(false); // B's account
    expect(await accountAvailableTo(DB, IG_B, tenantB)).toBe(true); // reconnecting your own account
    expect(await accountAvailableTo(DB, "17841499999999999", tenantB)).toBe(true); // a new account
  });

  it("draws, designs and the inbox are per customer", async () => {
    const a = await call("/api/campaigns", OWNER, "POST", campaign("owner_c"));
    const now = Date.now();
    const d = await DB.prepare(
      `INSERT INTO draws (tenant_id, campaign_id, name, source_type, media_id, winners_count, exclude_own, excluded_accounts, entry_mode, created_at, updated_at)
       VALUES (1, ?, 'سحب المالك', 'media', 'm1', 1, 1, '[]', 'per_person', ?, ?) RETURNING id`,
    ).bind(a.body.id, now, now).first<{ id: number }>();
    expect((await call("/api/draws", B)).body).toEqual([]);
    expect((await call(`/api/draws/${d!.id}`, B)).status).toBe(404);
    expect((await call(`/api/draws/${d!.id}`, B, "DELETE")).status).toBe(404);
    expect((await call("/api/draws/clear", B, "POST", { confirm: "مسح" })).body.deleted).toBe(0);
    expect(await DB.prepare("SELECT 1 FROM draws WHERE id = ?").bind(d!.id).first()).toBeTruthy();
    const design = await call("/api/card-designs", OWNER, "POST", { name: "تصميمي", design: {} });
    if (design.status === 200) {
      expect((await call("/api/card-designs", B)).body).toEqual([]);
      expect((await call(`/api/card-designs/${design.body.id}`, B, "DELETE")).status).toBe(404);
    }
    const meta = new MockMeta();
    await call(`/api/campaigns/${a.body.id}/status`, OWNER, "POST", { status: "active" });
    await deliver(commentPayload({ text: "أبغى الكورس", commentId: uid("c"), time: Date.now() + 2000 }), meta);
    await DB.prepare("UPDATE participants SET last_message_at = ?").bind(Date.now()).run();
    const pid = (await DB.prepare("SELECT id FROM participants LIMIT 1").first<any>()).id;
    expect((await call("/api/inbox", OWNER)).body).toHaveLength(1);
    expect((await call("/api/inbox", B)).body).toHaveLength(0);
    expect((await call(`/api/inbox/${pid}`, B)).status).toBe(404);
    expect((await call(`/api/inbox/${pid}/send`, B, "POST", { text: "hi" })).status).toBe(404);
  });

  it("each customer's simulator uses its own demo account and only its campaigns", async () => {
    const a = await call("/api/campaigns", OWNER, "POST", campaign("owner_c"));
    const r = await call("/api/simulate", B, "POST", { campaign_id: a.body.id, event: "comment", text: "أبغى الكورس", participant: "x", reset: true });
    expect(r.body.ok).toBe(false);
    const b = await call("/api/campaigns", B, "POST", campaign("b_c"));
    const ok = await call("/api/simulate", B, "POST", { campaign_id: b.body.id, event: "comment", text: "أبغى الكورس", participant: "x", reset: true });
    expect(JSON.stringify(ok.body)).toContain("b_c");
    const demo = await DB.prepare("SELECT tenant_id FROM instagram_accounts WHERE is_demo = 1").all<any>();
    expect(demo.results.map((x: any) => x.tenant_id)).toEqual([tenantB]);
  });

  it("suspending a customer logs them out, blocks login and stops their automation", async () => {
    const b = await call("/api/campaigns", B, "POST", campaign("b_c"));
    await call(`/api/campaigns/${b.body.id}/status`, B, "POST", { status: "active" });
    expect((await call(`/api/owner/tenants/${tenantB}/status`, OWNER, "POST", { status: "suspended" })).status).toBe(200);
    expect((await call("/api/campaigns", B)).status).toBe(401);
    const r = await SELF.fetch(new Request(BASE + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "shop_b", password: "another-strong-password", client: "app" }) }));
    expect(r.status).toBe(403);
    const meta = new MockMeta();
    const p = commentPayload({ text: "أبغى الكورس", commentId: uid("c"), time: Date.now() + 2000 });
    (p as any).entry[0].id = IG_B;
    await deliver(p, meta);
    expect(meta.sends()).toHaveLength(0);
    expect((await DB.prepare("SELECT reason FROM webhook_events ORDER BY id DESC LIMIT 1").first<any>()).reason).toContain("customer_suspended");
    // the owner cannot be suspended
    expect((await call("/api/owner/tenants/1/status", OWNER, "POST", { status: "suspended" })).status).toBe(409);
  });

  it("customers cannot use the follow requirement; only the owner decides it per account", async () => {
    expect((await call("/api/account/follow-gate", B, "POST", { allowed: true })).status).toBe(403);
    const res = await call("/api/campaigns", B, "POST", { ...campaign("b_gate"), require_follow: true });
    expect((await DB.prepare("SELECT require_follow FROM campaigns WHERE id = ?").bind(res.body.id).first<any>()).require_follow).toBe(0);
    await call(`/api/owner/tenants/${tenantB}/follow-gate`, OWNER, "POST", { allowed: true });
    expect((await DB.prepare("SELECT follow_gate_allowed FROM instagram_accounts WHERE ig_user_id = ?").bind(IG_B).first<any>()).follow_gate_allowed).toBe(1);
  });

  it("data deletion only touches the caller's own data", async () => {
    const meta = new MockMeta();
    await call("/api/campaigns", OWNER, "POST", campaign("owner_c")).then((a) => call(`/api/campaigns/${a.body.id}/status`, OWNER, "POST", { status: "active" }));
    await deliver(commentPayload({ text: "أبغى الكورس", commentId: uid("c"), time: Date.now() + 2000 }), meta);
    const before = (await DB.prepare("SELECT COUNT(*) AS n FROM conversation_flows").first<any>()).n;
    expect(before).toBe(1);
    expect((await call("/api/data/delete", B, "POST", { scope: "all_personal", confirm: "DELETE" })).status).toBe(200);
    expect((await DB.prepare("SELECT COUNT(*) AS n FROM conversation_flows").first<any>()).n).toBe(1);
    expect((await DB.prepare("SELECT COUNT(*) AS n FROM participants").first<any>()).n).toBe(1);
  });
});
