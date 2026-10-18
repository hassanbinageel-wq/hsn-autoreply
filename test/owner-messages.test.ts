import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DB, resetDb, seedAccount } from "./helpers";
import { DEFAULT_MESSAGE_TEMPLATES, fillMessage } from "../src/shared/messageTemplates";

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

describe("owner messages: permanent receipts, placeholders, templates", () => {
  it("keeps read / opened / removed after the customer deletes the message, per customer only", async () => {
    const a = await register("shop_a");
    const b = await register("shop_b");
    const r = await call(`/api/owner/tenants/${a.tid}/message`, OWNER, "POST", { title: "تجديد يا {الاسم}", body: "باقي {الأيام_المتبقية} يوم على {الباقة}", link: "/subscription", days: 30 });
    expect(r.status).toBe(200);
    const [n] = await bell(a.h);
    expect(n.title).toBe("✉️ تجديد يا متجر shop_a");
    expect(n.body).toMatch(/^باقي (29|30) يوم على /);
    expect(n.body).not.toContain("{");
    expect(await bell(b.h)).toHaveLength(0);
    // b cannot touch a's notification (nor its receipt)
    await call(`/api/app-notifications/${n.id}/click`, b.h, "POST", {});
    await call(`/api/app-notifications/${n.id}`, b.h, "DELETE");
    let [m] = (await call("/api/owner/messages", OWNER)).body;
    expect(m).toMatchObject({ copies: 1, read: 0, clicked: 0, deleted: 0 });
    // a opens the link, then deletes it
    await call(`/api/app-notifications/${n.id}/click`, a.h, "POST", {});
    await call(`/api/app-notifications/${n.id}`, a.h, "DELETE");
    expect(await bell(a.h)).toHaveLength(0);
    [m] = (await call("/api/owner/messages", OWNER)).body;
    expect(m).toMatchObject({ copies: 1, read: 1, clicked: 1, deleted: 1 });
    const [w] = (await call(`/api/owner/messages/${m.id}`, OWNER)).body;
    expect(w).toMatchObject({ tenant_id: a.tid, on_bell: 0 });
    expect(w.clicked_at).toBeGreaterThan(0);
    expect(w.deleted_at).toBeGreaterThan(0);
    // a reminder brings it back to the bell; what happened before is kept
    await call(`/api/owner/messages/${m.id}/remind`, OWNER, "POST", {});
    const [w2] = (await call(`/api/owner/messages/${m.id}`, OWNER)).body;
    expect(w2).toMatchObject({ on_bell: 1, deleted_at: null, clicked_at: w.clicked_at, read_at: w.read_at });
    expect((await bell(a.h))[0].title).toContain("🔔 تذكير: ");
  });

  it("a notice fills the name per customer; «clear read» and «mark all read» are recorded", async () => {
    const a = await register("shop_a");
    const b = await register("shop_b");
    expect((await call("/api/owner/broadcast", OWNER, "POST", { title: "هلا {الاسم}", days: 7 })).body.sent).toBe(2);
    expect((await bell(a.h))[0].title).toBe("هلا متجر shop_a");
    expect((await bell(b.h))[0].title).toBe("هلا متجر shop_b");
    await call("/api/app-notifications/read", a.h, "POST", {});
    await call("/api/app-notifications", a.h, "DELETE");
    const [m] = (await call("/api/owner/messages", OWNER)).body;
    expect(m).toMatchObject({ copies: 2, read: 1, clicked: 0, deleted: 1 });
    // the expiry cleanup removes the copies, never the record
    await DB.prepare("DELETE FROM app_notifications").run();
    expect((await call("/api/owner/messages", OWNER)).body[0]).toMatchObject({ copies: 2, read: 1 });
    // deleting the message removes its record too
    await call(`/api/owner/messages/${m.id}`, OWNER, "DELETE");
    expect((await DB.prepare("SELECT COUNT(*) AS n FROM owner_message_receipts").first<any>()).n).toBe(0);
  });

  it("templates: defaults, owner edits, customers cannot read or change them", async () => {
    const a = await register("shop_a");
    let r = await call("/api/owner/message-templates", OWNER);
    expect(r.body.templates.private.length).toBe(DEFAULT_MESSAGE_TEMPLATES.private.length);
    const edited = { notice: [{ label: "تجربة", title: "عنوان تجربة", body: "", link: "/", days: 3 }], private: DEFAULT_MESSAGE_TEMPLATES.private.slice(0, 1) };
    expect((await call("/api/owner/message-templates", OWNER, "PUT", edited)).status).toBe(200);
    r = await call("/api/owner/message-templates", OWNER);
    expect(r.body.templates).toEqual(edited);
    expect((await call("/api/owner/message-templates", a.h)).status).toBe(403);
    expect((await call("/api/owner/message-templates", a.h, "PUT", edited)).status).toBe(403);
    expect((await call("/api/owner/message-templates", OWNER, "PUT", { notice: [{ label: "x", title: "عنوان", body: "", link: "https://evil.example", days: 3 }], private: [] })).status).toBe(422);
  });

  it("fills placeholders", () => {
    const now = Date.UTC(2026, 9, 18);
    const t = fillMessage("{الاسم} · {الباقة} · {الأيام_المتبقية} · {تاريخ_الانتهاء}", { name: "سارة", plan: "الأساسية", expiresAt: now + 5 * DAY }, now);
    expect(t).toMatch(/^سارة · الأساسية · 5 · 23 أكتوبر 2026/);
    expect(fillMessage("{الباقة} {الأيام_المتبقية}", { name: "x", plan: null, expiresAt: null }, now)).toBe("— —");
  });
});
