import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DB, resetDb, seedAccount } from "./helpers";
import { base32Encode, totpAt, totpStep, verifyTotp } from "../src/worker/lib/totp";

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
const code = async (secret: string, offset = 0) => totpAt(secret, totpStep() + offset);
async function loginWith(totp?: string) {
  return call("/api/auth/login", {}, "POST", { username: "admin", password: "a-very-strong-password", client: "app", totp });
}

describe("two-step login (owner)", () => {
  it("matches the RFC 6238 test vectors", async () => {
    const secret = base32Encode(new TextEncoder().encode("12345678901234567890"));
    expect(secret).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(await totpAt(secret, Math.floor(59 / 30))).toBe("287082");
    expect(await totpAt(secret, Math.floor(1111111109 / 30))).toBe("081804");
    expect(await verifyTotp(secret, "081 804", 1111111109_000)).toBe(Math.floor(1111111109 / 30));
    expect(await verifyTotp(secret, "081804", 1111111109_000, Math.floor(1111111109 / 30))).toBeNull();
  });

  it("setup → confirm → login needs the code; codes are single-use; recovery codes work once; off again", async () => {
    expect((await call("/api/auth/totp", OWNER)).body).toMatchObject({ available: true, enabled: false });
    const setup = await call("/api/auth/totp/setup", OWNER, "POST", {});
    expect(setup.body.uri).toContain("otpauth://totp/");
    const secret = setup.body.secret as string;
    // not on until confirmed
    expect((await loginWith()).status).toBe(200);
    expect((await call("/api/auth/totp/enable", OWNER, "POST", { code: "000000" })).status).toBe(422);
    const en = await call("/api/auth/totp/enable", OWNER, "POST", { code: await code(secret) });
    expect(en.status).toBe(200);
    expect(en.body.recovery_codes).toHaveLength(8);
    // the secret is stored encrypted only
    const row = await DB.prepare("SELECT * FROM admin_users WHERE username = 'admin'").first<any>();
    expect(JSON.stringify(row)).not.toContain(secret);

    expect((await loginWith()).body.error.code).toBe("totp_required");
    expect((await loginWith("123456")).body.error.code).toBe("invalid_totp");
    const next = await code(secret, 1);
    expect((await loginWith(next)).status).toBe(200);
    expect((await loginWith(next)).body.error.code).toBe("invalid_totp"); // same code again
    // recovery code: once
    const rc = en.body.recovery_codes[0] as string;
    expect((await loginWith(rc.toLowerCase())).status).toBe(200);
    expect((await loginWith(rc)).status).toBe(401);
    expect((await call("/api/auth/totp", OWNER)).body.recovery_left).toBe(7);

    // turning it off needs the password and a code
    expect((await call("/api/auth/totp/disable", OWNER, "POST", { password: "wrong-password", code: en.body.recovery_codes[1] })).status).toBe(422);
    expect((await call("/api/auth/totp/disable", OWNER, "POST", { password: "a-very-strong-password", code: en.body.recovery_codes[1] })).status).toBe(200);
    expect((await loginWith()).status).toBe(200);
  });

  it("is not offered to customers", async () => {
    await call("/api/owner/codes", OWNER, "POST", { plan_id: "basic", days: 30, count: 1 }).then(async (r) => {
      await call("/api/auth/register", {}, "POST", { name: "متجر", username: "shop_a", password: "another-strong-password", code: r.body.codes[0] });
    });
    const h = await login("shop_a", "another-strong-password");
    expect((await call("/api/auth/totp", h)).body.available).toBe(false);
    expect((await call("/api/auth/totp/setup", h, "POST", {})).status).toBe(403);
  });
});
