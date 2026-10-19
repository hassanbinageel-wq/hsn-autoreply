import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
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


const PW = "staff-strong-password-1";
async function addStaff(holder: H, u: string, perms: string[]) {
  const r = await call("/api/staff", holder, "POST", { username: u, display_name: `موظف ${u}`, password: PW, perms });
  return r;
}

describe("staff logins with limited sections", () => {
  it("a customer adds a staff member who reaches only the chosen sections", async () => {
    const a = await register("shop_a");
    expect((await addStaff(a.h, "sara_inbox", ["inbox", "owner_support"])).status).toBe(200);
    const list = (await call("/api/staff", a.h)).body;
    expect(list.staff).toHaveLength(1);
    expect(list.staff[0].perms).toEqual(["inbox"]); // owner-panel sections are not for customers
    expect(list.available.some((p: any) => p.key === "owner_support")).toBe(false);

    const s = await login("sara_inbox", PW);
    const me = (await call("/api/auth/me", s)).body;
    expect(me).toMatchObject({ role: "staff", perms: ["inbox"], display_name: "موظف sara_inbox" });
    // allowed
    expect((await call("/api/inbox", s)).status).toBe(200);
    expect((await call("/api/dashboard", s)).status).toBe(200);
    expect((await call("/api/app-notifications", s)).status).toBe(200);
    expect((await call("/api/auth/totp", s)).status).toBe(200);
    // not allowed
    for (const [path, method] of [["/api/campaigns", "GET"], ["/api/settings", "PUT"], ["/api/staff", "GET"], ["/api/account/disconnect", "POST"], ["/api/subscription/redeem", "POST"], ["/api/schedule", "GET"], ["/api/owner/tenants", "GET"], ["/api/data/delete", "POST"]] as const) {
      const r = await call(path, s, method, method === "GET" ? undefined : {});
      expect(r.status, `${method} ${path}`).toBe(403);
    }
    expect((await call("/api/campaigns", s)).body.error.code).toBe("staff_forbidden");

    // the holder changes the sections: takes effect on the next request
    const id = list.staff[0].id;
    await call(`/api/staff/${id}`, a.h, "PUT", { perms: ["campaigns"] });
    expect((await call("/api/campaigns", s)).status).toBe(200);
    expect((await call("/api/inbox", s)).status).toBe(403);
    // switched off: signed out and cannot sign in
    await call(`/api/staff/${id}`, a.h, "PUT", { disabled: true });
    expect((await call("/api/campaigns", s)).status).toBe(401);
    expect((await call("/api/auth/login", {}, "POST", { username: "sara_inbox", password: PW, client: "app" })).status).toBe(403);
    await call(`/api/staff/${id}`, a.h, "PUT", { disabled: false });
    await login("sara_inbox", PW);
    // deleted
    expect((await call(`/api/staff/${id}`, a.h, "DELETE")).status).toBe(200);
    expect((await call("/api/auth/login", {}, "POST", { username: "sara_inbox", password: PW, client: "app" })).status).toBe(401);
  });

  it("staff of one customer never reach another customer, and a staff member cannot manage staff", async () => {
    const a = await register("shop_a");
    const b = await register("shop_b");
    await addStaff(a.h, "a_staff", ["inbox", "campaigns"]);
    const s = await login("a_staff", PW);
    const bStaff = await addStaff(b.h, "b_staff", ["inbox"]);
    expect(bStaff.status).toBe(200);
    const bId = (await call("/api/staff", b.h)).body.staff[0].id;
    expect((await call(`/api/staff/${bId}`, a.h, "PUT", { perms: ["campaigns"] })).status).toBe(404);
    expect((await call("/api/staff", s, "POST", { username: "x_staff", display_name: "اكس", password: PW, perms: ["inbox"] })).status).toBe(403);
    // the store's login names in the owner panel do not list staff
    const t = (await call("/api/owner/health", OWNER)).body.customers.find((x: any) => x.id === a.tid);
    expect(t.usernames).toBe("shop_a");
  });

  it("the service owner's staff see only the owner-panel sections given to them", async () => {
    await addStaff(OWNER, "support_agent", ["owner_support"]);
    const s = await login("support_agent", PW);
    expect((await call("/api/owner/support", s)).status).toBe(200);
    expect((await call("/api/owner/tenants", s)).status).toBe(403);
    expect((await call("/api/owner/codes", s, "POST", { plan_id: "basic", days: 30, count: 1 })).status).toBe(403);
    expect((await call("/api/owner/usage", s)).status).toBe(403);
    expect((await call("/api/owner/payment-providers", s)).status).toBe(403);
  });
});
