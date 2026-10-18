import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DB, resetDb, seedAccount } from "./helpers";
import { cleanError } from "../src/worker/services/diagnose";

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

const bell = async (h: H) => (await call("/api/app-notifications", h)).body.items as any[];
describe("owner diagnosis of a customer", () => {
  it("explains what blocks replies, without secrets, owner only", async () => {
    const a = await register("shop_a");
    let r = await call(`/api/owner/tenants/${a.tid}/diagnose`, OWNER);
    expect(r.status).toBe(200);
    expect(r.body.checks[0]).toMatchObject({ level: "bad", area: "إنستقرام" });
    expect(r.body.checks.some((c: any) => c.title.includes("ما ربط أي حساب"))).toBe(true);

    // give the customer an account needing re-auth, a campaign with no post selected, a failed send
    const now = Date.now();
    await DB.prepare("UPDATE instagram_accounts SET tenant_id = ?, status = 'needs_reauth', webhook_status = 'subscribed', last_webhook_at = ?, scopes = ?").bind(a.tid, now - DAY, JSON.stringify(["instagram_business_basic", "instagram_business_manage_messages", "instagram_business_manage_comments"])).run();
    const acc = await DB.prepare("SELECT id FROM instagram_accounts").first<any>();
    await DB.prepare("INSERT INTO campaigns (tenant_id, account_id, name, type, status, scope, match_all, final_text, created_at, updated_at) VALUES (?, ?, 'ريل', 'comment', 'active', 'selected', 1, 'x', ?, ?)").bind(a.tid, acc.id, now, now).run();
    const secret = "EAAG" + "x".repeat(60);
    await DB.prepare("INSERT INTO action_jobs (account_id, kind, dedup_key, status, run_at, last_error, created_at, updated_at) VALUES (?, 'send_dm', 'd1', 'failed', ?, ?, ?, ?)").bind(acc.id, now, `Meta 400 token ${secret} invalid`, now, now).run();
    r = await call(`/api/owner/tenants/${a.tid}/diagnose`, OWNER);
    const titles = r.body.checks.map((c: any) => c.title).join("\n");
    expect(titles).toContain("يحتاج إعادة ربط");
    expect(titles).toContain("ما اختار أي منشور");
    expect(titles).toContain("إرسال فشل");
    expect(r.body.summary.bad).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(r.body)).not.toContain(secret);
    expect(r.body.details.recent_failures[0].last_error).toContain("[…]");
    expect(JSON.stringify(r.body)).not.toMatch(/token_ciphertext|csrf/);

    // customers cannot run it; the owner's own tenant is not a customer
    expect((await call(`/api/owner/tenants/${a.tid}/diagnose`, a.h)).status).toBe(403);
    expect((await call(`/api/owner/tenants/1/diagnose`, OWNER)).status).toBe(404);
  });

  it("cleans long opaque strings from errors", () => {
    expect(cleanError("bad " + "a".repeat(40) + " end")).toBe("bad […] end");
    expect(cleanError(null)).toBeNull();
  });
});
