import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DB, resetDb, seedAccount } from "./helpers";
import { vi, afterEach } from "vitest";

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

type Mail = { to: string[]; subject: string; text: string };
let mails: Mail[] = [];
const realFetch = globalThis.fetch;
function stubResend(ok = true) {
  mails = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://api.resend.com/emails") {
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer re_test_key");
      mails.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(ok ? { id: "m1" } : { message: "bad" }), { status: ok ? 200 : 422 });
    }
    return realFetch(input as any, init);
  });
}
afterEach(() => vi.unstubAllGlobals());
const codeOf = (m: Mail) => m.text.match(/(\d{6})/)![1];
const tokenOf = (m: Mail) => decodeURIComponent(m.text.match(/token=([^\s]+)/)![1]);

describe("account email and password recovery", () => {
  it("sign-up email → confirm code → forgot → one-time link → new password; sessions end", async () => {
    stubResend();
    const r = await call("/api/auth/register", {}, "POST", { name: "متجر", username: "shop_a", password: "another-strong-password", code: await code(), email: "Sara@Example.com" });
    expect(r.status).toBe(200);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toEqual(["sara@example.com"]);
    const h = await login("shop_a", "another-strong-password");
    expect((await call("/api/account/email", h)).body).toMatchObject({ email: "sara@example.com", verified: false, enabled: true });

    // not confirmed yet: no link is sent
    mails = [];
    expect((await call("/api/auth/forgot", {}, "POST", { login: "shop_a" })).status).toBe(200);
    expect(mails).toHaveLength(0);

    expect((await call("/api/account/email/verify", h, "POST", { code: "000000" })).status).toBe(422);
    stubResend();
    await call("/api/account/email", h, "POST", { email: "sara@example.com" });
    expect((await call("/api/account/email/verify", h, "POST", { code: codeOf(mails[0]) })).status).toBe(200);
    expect((await call("/api/account/email", h)).body.verified).toBe(true);

    // forgot by store name and by email: same answer; unknown accounts answer the same way
    stubResend();
    const a1 = await call("/api/auth/forgot", {}, "POST", { login: "SHOP_A" });
    const a2 = await call("/api/auth/forgot", {}, "POST", { login: "nobody_here" });
    expect(a1.body).toEqual(a2.body);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toEqual(["sara@example.com"]);
    expect(mails[0].text).toContain("https://hsn.example.workers.dev/#/reset?token=");
    const token = tokenOf(mails[0]);
    // the token itself is not stored
    expect(JSON.stringify((await DB.prepare("SELECT * FROM password_resets").all()).results)).not.toContain(token);

    expect((await call("/api/auth/reset", {}, "POST", { token, password: "short" })).status).toBe(422);
    expect((await call("/api/auth/reset", {}, "POST", { token, password: "a-brand-new-password-1" })).status).toBe(200);
    expect((await call("/api/auth/reset", {}, "POST", { token, password: "another-one-password" })).status).toBe(422); // once
    expect(mails.at(-1)!.subject).toContain("تم تغيير كلمة المرور");
    // old session ended, old password gone, new one works
    expect((await call("/api/account/email", h)).status).toBe(401);
    expect((await call("/api/auth/login", {}, "POST", { username: "shop_a", password: "another-strong-password", client: "app" })).status).toBe(401);
    await login("shop_a", "a-brand-new-password-1");
  });

  it("an expired link does not work; a confirmed email cannot be taken by another account", async () => {
    stubResend();
    await call("/api/auth/register", {}, "POST", { name: "متجر أ", username: "shop_a", password: "another-strong-password", code: await code() });
    await call("/api/auth/register", {}, "POST", { name: "متجر ب", username: "shop_b", password: "another-strong-password", code: await code() });
    const ha = await login("shop_a", "another-strong-password");
    const hb = await login("shop_b", "another-strong-password");
    await call("/api/account/email", ha, "POST", { email: "same@example.com" });
    await call("/api/account/email/verify", ha, "POST", { code: codeOf(mails.at(-1)!) });
    expect((await call("/api/account/email", hb, "POST", { email: "SAME@example.com" })).status).toBe(409);

    await call("/api/auth/forgot", {}, "POST", { login: "same@example.com" });
    const token = tokenOf(mails.at(-1)!);
    await DB.prepare("UPDATE password_resets SET expires_at = ?").bind(Date.now() - 1).run();
    expect((await call("/api/auth/reset", {}, "POST", { token, password: "a-brand-new-password-1" })).status).toBe(422);
  });
});
