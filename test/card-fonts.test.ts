import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
/** A customer on the pro plan for 10 days (paying pro by card renews it; moving to another plan is an upgrade). */
async function register(username: string) {
  const code = (await call("/api/owner/codes", OWNER, "POST", { plan_id: "pro", days: 10, count: 1 })).body.codes[0];
  expect((await call("/api/auth/register", {}, "POST", { name: `متجر ${username}`, username, password: "another-strong-password", code })).status).toBe(200);
  const h = await login(username, "another-strong-password");
  const tid = (await DB.prepare("SELECT tenant_id FROM admin_users WHERE username = ?").bind(username).first<any>()).tenant_id as number;
  return { h, tid };
}
const b64 = (bytes: number[], pad = 0) => btoa(String.fromCharCode(...bytes, ...new Array(pad).fill(0)));
const WOFF2 = b64([0x77, 0x4f, 0x46, 0x32], 60); // "wOF2" + bytes

describe("card fonts: the customer's own fonts, private and limited", () => {
  it("uploads after confirming the license, serves it back, refuses non-fonts / big files / a 6th font, deletes", async () => {
    const { h } = await register("shop_a");
    expect((await call("/api/card-fonts", h, "POST", { name: "خطي", data: WOFF2 })).status).toBe(422); // no license confirmation
    const up = await call("/api/card-fonts", h, "POST", { name: "خطي", data: `data:font/woff2;base64,${WOFF2}`, licensed: true });
    expect(up.status).toBe(200);
    const id = up.body.font.id as string;
    expect((await call("/api/card-fonts", h)).body).toEqual([expect.objectContaining({ id, name: "خطي", size: 64 })]);
    const r = await SELF.fetch(new Request(`${BASE}/api/card-fonts/${id}`, { headers: h }));
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toBe("font/woff2");
    expect(new Uint8Array(await r.arrayBuffer()).slice(0, 4)).toEqual(new Uint8Array([0x77, 0x4f, 0x46, 0x32]));
    expect((await call("/api/card-fonts", h, "POST", { name: "صورة", data: b64([0x89, 0x50, 0x4e, 0x47], 20), licensed: true })).body.error.code).toBe("type");
    const big = btoa("wOF2" + "a".repeat(2 * 1024 * 1024));
    expect((await call("/api/card-fonts", h, "POST", { name: "كبير", data: big, licensed: true })).status).toBe(422);
    for (let i = 0; i < 4; i++) expect((await call("/api/card-fonts", h, "POST", { name: `خط ${i}`, data: WOFF2, licensed: true })).status).toBe(200);
    expect((await call("/api/card-fonts", h, "POST", { name: "سادس", data: WOFF2, licensed: true })).body.error.code).toBe("limit");
    expect((await call(`/api/card-fonts/${id}`, h, "DELETE")).status).toBe(200);
    expect((await SELF.fetch(new Request(`${BASE}/api/card-fonts/${id}`, { headers: h }))).status).toBe(404);
    expect((await call("/api/card-fonts", h)).body).toHaveLength(4);
  });

  it("isolation: another customer cannot read or delete the font", async () => {
    const a = await register("shop_a");
    const b = await register("shop_b");
    const id = (await call("/api/card-fonts", a.h, "POST", { name: "خط أ", data: WOFF2, licensed: true })).body.font.id;
    expect((await SELF.fetch(new Request(`${BASE}/api/card-fonts/${id}`, { headers: b.h }))).status).toBe(404);
    await call(`/api/card-fonts/${id}`, b.h, "DELETE");
    expect((await call("/api/card-fonts", a.h)).body).toHaveLength(1);
    expect((await call("/api/card-fonts", b.h)).body).toHaveLength(0);
  });

  it("a design keeps the template layout, the custom font and icons", async () => {
    const h = OWNER; // card designs need a plan with draws; the owner has every feature
    const design = { layout: "template", custom_font: "abc123", icons: [{ name: "trophy-fill", x: 0.2, y: 0.3, size: 0.1, color: "#ffcc00", opacity: 0.8 }] };
    const r = await call("/api/card-designs", h, "POST", { name: "قالب", design });
    expect(r.status).toBe(200);
    const saved = JSON.parse((await call("/api/card-designs", h)).body[0].design);
    expect(saved).toMatchObject(design);
    expect((await call("/api/card-designs", h, "POST", { name: "سيئ", design: { icons: [{ name: "<script>", x: 0, y: 0, size: 0.1, color: "#fff" }] } })).status).toBe(422);
  });
});
