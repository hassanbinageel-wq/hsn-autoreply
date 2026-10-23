import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DB, MockMeta, deliver, messagePayload, resetDb, seedAccount } from "./helpers";
import { HttpMetaClient } from "../src/worker/meta/client";
import { menuProblem, type DmMenu } from "../src/shared/menu";

const BASE = "https://hsn.example.workers.dev";
const SELF = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
type H = Record<string, string>;
async function call(path: string, h: H = {}, method = "GET", body?: unknown) {
  const r = await SELF.fetch(new Request(BASE + path, { method, headers: { "Content-Type": "application/json", ...h }, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}
async function login(username: string, password: string): Promise<H> {
  const r = await call("/api/auth/login", {}, "POST", { username, password, client: "app" });
  if (!r.body?.token) throw new Error(`login failed: ${JSON.stringify(r.body)}`);
  return { Authorization: `Bearer ${r.body.token}` };
}

const MENU: DmMenu = {
  enabled: true,
  trigger: "daily",
  pause_hours: 12,
  root: {
    key: "root0001",
    label: "",
    text: "أهلًا 👋 اختر:",
    link: null,
    style: "buttons",
    children: [
      { key: "price001", label: "التسعيرة العادية", text: "السعر 210 وتدفعي 110", link: { title: "رابط المنحة", url: "https://example.com/p" }, style: "buttons", children: [] },
      { key: "north001", label: "سعر المناطق الشمالية", text: "اختر المنطقة:", link: null, style: "quick", children: [
        { key: "tabuk001", label: "تبوك", text: "تبوك: 25 ريال", link: null, style: "buttons", children: [] },
      ] },
      { key: "areas001", label: "مناطق التغطية", text: "تريم – الفرع الرئيسي", link: null, style: "buttons", children: [] },
    ],
  },
};
const setMenu = (m: DmMenu, tenant = 1) =>
  DB.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(tenant === 1 ? "dm_menu" : `t${tenant}:dm_menu`, JSON.stringify(m)).run();
const usage = async () => (await DB.prepare("SELECT COALESCE(SUM(messages), 0) AS n FROM usage_counters WHERE tenant_id = 1").first<any>()).n as number;

beforeEach(async () => {
  await resetDb();
  await seedAccount();
});

describe("DM menu: someone writes → menu; taps an option → its reply", () => {
  it("sends the menu with its options, the reply of a tapped option (with a sub-menu), counts every message, and logs taps", async () => {
    await setMenu(MENU);
    const meta = new MockMeta();
    await deliver(messagePayload({ text: "السلام عليكم" }), meta);
    const sends = meta.calls.filter((c) => c.kind === "dm");
    expect(sends).toHaveLength(1);
    expect(sends[0].msg!.text).toBe("أهلًا 👋 اختر:");
    expect(sends[0].msg!.menu).toMatchObject({ style: "buttons", options: [{ title: "التسعيرة العادية", payload: "hsn:menu:price001" }, { title: "سعر المناطق الشمالية" }, { title: "مناطق التغطية" }] });
    expect(await usage()).toBe(1);

    // a tap (button template = postback) on the option with a link
    await deliver(messagePayload({ postback: "hsn:menu:price001" }), meta);
    let last = meta.calls.filter((c) => c.kind === "dm").at(-1)!;
    expect(last.msg!.text).toBe("السعر 210 وتدفعي 110");
    expect(last.msg!.menu).toMatchObject({ options: [], link: { url: "https://example.com/p" } });
    // a sub-menu shown as quick replies, then its option
    await deliver(messagePayload({ postback: "hsn:menu:north001" }), meta);
    last = meta.calls.filter((c) => c.kind === "dm").at(-1)!;
    expect(last.msg!.menu).toMatchObject({ style: "quick", options: [{ title: "تبوك", payload: "hsn:menu:tabuk001" }] });
    await deliver(messagePayload({ quickReply: "hsn:menu:tabuk001", text: "تبوك" }), meta);
    expect(meta.calls.filter((c) => c.kind === "dm").at(-1)!.msg!.text).toBe("تبوك: 25 ريال");
    expect(await usage()).toBe(4);
    const taps = (await DB.prepare("SELECT node_key, taps FROM dm_menu_taps WHERE tenant_id = 1 ORDER BY node_key").all<any>()).results;
    expect(taps.map((t) => [t.node_key, t.taps])).toEqual([["north001", 1], ["price001", 1], ["tabuk001", 1]]);
    // shown in the inbox as the account's message
    const out = (await DB.prepare("SELECT source, kind, text FROM messages WHERE direction = 'out' ORDER BY id").all<any>()).results;
    expect(out[0]).toMatchObject({ source: "bot", kind: "menu" });
    expect(out[0].text).toContain("• مناطق التغطية");
  });

  it("trigger rules: once a day by default, first message only, or every message; quiet after a manual reply; off = nothing", async () => {
    await setMenu(MENU);
    const meta = new MockMeta();
    const dms = () => meta.calls.filter((c) => c.kind === "dm").length;
    await deliver(messagePayload({ text: "مرحبا" }), meta);
    await deliver(messagePayload({ text: "موجودين؟" }), meta);
    expect(dms()).toBe(1); // daily
    await setMenu({ ...MENU, trigger: "every" });
    await deliver(messagePayload({ text: "طيب" }), meta);
    expect(dms()).toBe(2);
    // the account replied by hand → the menu stays quiet for this person
    const p = await DB.prepare("SELECT id, account_id FROM participants WHERE igsid = 'igsid_user_1'").first<any>();
    await DB.prepare("INSERT INTO messages (account_id, participant_id, direction, source, kind, text, created_at) VALUES (?, ?, 'out', 'manual', 'message', 'أهلين', ?)").bind(p.account_id, p.id, Date.now()).run();
    await deliver(messagePayload({ text: "تمام" }), meta);
    expect(dms()).toBe(2);
    // first-only: another person gets it once
    await setMenu({ ...MENU, trigger: "first" });
    await deliver(messagePayload({ from: "igsid_user_2", text: "هلا" }), meta);
    await deliver(messagePayload({ from: "igsid_user_2", text: "هلا مرة ثانية" }), meta);
    expect(dms()).toBe(3);
    // switched off: nothing, and old buttons do nothing
    await setMenu({ ...MENU, enabled: false });
    await deliver(messagePayload({ from: "igsid_user_3", text: "هلا" }), meta);
    await deliver(messagePayload({ from: "igsid_user_3", postback: "hsn:menu:price001" }), meta);
    expect(dms()).toBe(3);
  });

  it("a removed option is ignored; Instagram's own button template is built with the link first (≤ 3 buttons)", async () => {
    await setMenu(MENU);
    const meta = new MockMeta();
    await deliver(messagePayload({ postback: "hsn:menu:gone0001" }), meta);
    expect(meta.calls.filter((c) => c.kind === "dm")).toHaveLength(0);

    const calls: any[] = [];
    const f = async (_u: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init!.body)));
      return new Response(JSON.stringify({ message_id: "m1" }), { status: 200 });
    };
    const http = new HttpMetaClient({ apiVersion: "v26.0", appId: "1", appSecret: "s", fetch: f as any });
    await http.sendMessage("t", "ig1", "u1", { text: "اختر", menu: { style: "buttons", options: [{ title: "أ", payload: "hsn:menu:aaaa" }, { title: "ب", payload: "hsn:menu:bbbb" }], link: { title: "الموقع", url: "https://x.example" } } });
    const b = calls[0].message.attachment.payload;
    expect(b.template_type).toBe("button");
    expect(b.buttons.map((x: any) => x.type)).toEqual(["web_url", "postback", "postback"]);
    await http.sendMessage("t", "ig1", "u1", { text: "اختر", menu: { style: "quick", options: [{ title: "أ", payload: "hsn:menu:aaaa" }], link: { title: "الموقع", url: "https://x.example" } } });
    expect(calls[1].message.quick_replies).toEqual([{ content_type: "text", title: "أ", payload: "hsn:menu:aaaa" }]);
    expect(calls[1].message.text).toContain("https://x.example");
  });
});

describe("DM menu: settings API", () => {
  let OWNER: H;
  beforeEach(async () => {
    await call("/api/auth/setup", {}, "POST", { setup_token: "test_setup_token_123456", username: "admin", password: "a-very-strong-password" });
    OWNER = await login("admin", "a-very-strong-password");
  });
  async function customer(username: string) {
    const code = (await call("/api/owner/codes", OWNER, "POST", { plan_id: "basic", days: 10, count: 1 })).body.codes[0];
    expect((await call("/api/auth/register", {}, "POST", { name: `متجر ${username}`, username, password: "another-strong-password", code })).status).toBe(200);
    return login(username, "another-strong-password");
  }

  it("keyword trigger: only messages with one of the words get the menu (every time, ignoring diacritics/alef)", async () => {
    await setMenu({ ...MENU, trigger: "keywords", keywords: ["السعر", "التغطية"] });
    const meta = new MockMeta();
    const dms = () => meta.calls.filter((c) => c.kind === "dm").length;
    await deliver(messagePayload({ text: "مرحبا" }), meta);
    expect(dms()).toBe(0);
    await deliver(messagePayload({ text: "كم السِّعر لو سمحت؟" }), meta);
    expect(dms()).toBe(1);
    expect(meta.calls.filter((c) => c.kind === "dm").at(-1)!.msg!.text).toBe("أهلًا 👋 اختر:");
    await deliver(messagePayload({ text: "وين مناطق التغطيه والتغطية" }), meta);
    expect(dms()).toBe(2);
  });

  it("saving through the API: keywords are checked, ice breakers and the persistent menu are cleared", async () => {
    await call("/api/auth/setup", {}, "POST", { setup_token: "test_setup_token_123456", username: "admin", password: "a-very-strong-password" });
    const h = await login("admin", "a-very-strong-password");
    expect((await call("/api/dm-menu", h, "PUT", { ...MENU, trigger: "keywords", keywords: [] })).body.error.message).toContain("كلمة");
    const r = await call("/api/dm-menu", h, "PUT", { ...MENU, trigger: "keywords", keywords: ["السعر", ""], ice_breakers: [{ question: "س؟", key: "price001" }], persistent: [{ title: "المناطق", key: "areas001" }] });
    expect(r.status).toBe(200);
    const saved = (await call("/api/dm-menu", h)).body.menu;
    expect(saved).toMatchObject({ trigger: "keywords", keywords: ["السعر"], ice_breakers: [], persistent: [] });
  });

  it("checks the limits (3 buttons with a link counting as one, 20-char titles, https links, depth)", () => {
    expect(menuProblem(MENU.root)).toBeNull();
    const four = { ...MENU.root, children: [...MENU.root.children, { ...MENU.root.children[2], key: "extra001" }] };
    expect(menuProblem(four)).toContain("الحد 3");
    expect(menuProblem({ ...four, style: "quick" })).toBeNull();
    expect(menuProblem({ ...MENU.root, link: { title: "رابط", url: "https://a.b" } })).toContain("الحد 2");
    expect(menuProblem({ ...MENU.root, children: [{ ...MENU.root.children[0], link: { title: "رابط", url: "http://a.b" } }] })).toContain("https://");
    const deep = (d: number): any => ({ key: `k${d}aaaa`, label: "خيار", text: "نص", link: null, style: "quick", children: d ? [deep(d - 1)] : [] });
    expect(menuProblem({ ...MENU.root, children: [deep(4)] })).toBeNull();
    expect(menuProblem({ ...MENU.root, children: [deep(5)] })).toContain("مستويات");
  });

  it("a plan without the menu can build it but not switch it on; each customer sees only their own menu and taps", async () => {
    const A = await customer("shop_a");
    const B = await customer("shop_b");
    let r = await call("/api/dm-menu", A);
    expect(r.body).toMatchObject({ available: false, menu: { enabled: false } });
    expect((await call("/api/dm-menu", A, "PUT", { ...MENU, enabled: false })).status).toBe(200);
    expect((await call("/api/dm-menu", A, "PUT", MENU)).status).toBe(403);
    // the owner adds the menu to the plan → it can be switched on
    await DB.prepare("UPDATE plans SET limits = json_set(limits, '$.dm_menu', json('true')) WHERE id = 'basic'").run();
    expect((await call("/api/dm-menu", A, "PUT", MENU)).status).toBe(200);
    r = await call("/api/dm-menu", A);
    expect(r.body).toMatchObject({ available: true, menu: { enabled: true, root: { key: "root0001" } } });
    // isolation: B still has the empty default
    const rb = await call("/api/dm-menu", B);
    expect(rb.body.menu.enabled).toBe(false);
    expect(rb.body.menu.root.key).not.toBe("root0001");
    expect((await call("/api/dm-menu", A, "PUT", { ...MENU, root: { ...MENU.root, text: "" } })).status).toBe(422);
  });
});

describe("DM menu: ice breakers and persistent menu on the Instagram account", () => {
  it("sets them with menu payloads, skips unchanged, removes them when switched off; taps open the option", async () => {
    const { syncMenuProfile } = await import("../src/worker/services/menuProfile");
    const { TEST_ENV } = await import("./helpers");
    const calls: Array<{ op: string; body: any }> = [];
    const deps = {
      token: async () => "tok",
      client: {
        setMessengerProfile: async (_t: string, _ig: string, body: any) => (calls.push({ op: "set", body }), { ok: true as const, data: { success: true }, httpStatus: 200 }),
        deleteMessengerProfile: async (_t: string, _ig: string, fields: any) => (calls.push({ op: "delete", body: fields }), { ok: true as const, data: { success: true }, httpStatus: 200 }),
      },
    };
    const m: DmMenu = { ...MENU, ice_breakers: [{ question: "كم سعر التوصيل؟", key: "price001" }], persistent: [{ title: "المناطق", key: "areas001" }, { title: "الموقع", url: "https://example.com" }] };
    let r = await syncMenuProfile(TEST_ENV, 1, m, deps as any);
    expect(r[0].ok).toBe(true);
    expect(calls[0].op).toBe("set");
    expect(calls[0].body.ice_breakers).toEqual([{ locale: "default", call_to_actions: [{ question: "كم سعر التوصيل؟", payload: "hsn:menu:price001" }] }]);
    expect(calls[0].body.persistent_menu[0].call_to_actions).toEqual([{ type: "postback", title: "المناطق", payload: "hsn:menu:areas001" }, { type: "web_url", title: "الموقع", url: "https://example.com" }]);
    // unchanged → no call
    r = await syncMenuProfile(TEST_ENV, 1, m, deps as any);
    expect(r[0].skipped).toBe(true);
    expect(calls).toHaveLength(1);
    // only ice breakers left → set ice, delete the menu; then switched off → delete both
    await syncMenuProfile(TEST_ENV, 1, { ...m, persistent: [] }, deps as any);
    expect(calls.slice(1).map((c) => c.op)).toEqual(["set", "delete"]);
    expect(calls[2].body).toEqual(["persistent_menu"]);
    // each part has its own switch: the automatic menu off keeps the ice breakers; switching them off removes them
    const before = calls.length;
    await syncMenuProfile(TEST_ENV, 1, { ...m, persistent: [], enabled: false }, deps as any);
    expect(calls.length).toBe(before);
    await syncMenuProfile(TEST_ENV, 1, { ...m, ice_enabled: false, persistent_enabled: false }, deps as any);
    expect(calls.at(-1)).toEqual({ op: "delete", body: ["ice_breakers", "persistent_menu"] });
    // an ice breaker tap is a postback with the option's payload → its reply, even with the automatic menu off
    await setMenu({ ...m, enabled: false });
    const meta = new MockMeta();
    await deliver(messagePayload({ postback: "hsn:menu:price001" }), meta);
    expect(meta.calls.filter((c) => c.kind === "dm").at(-1)!.msg!.text).toBe("السعر 210 وتدفعي 110");
  });

  it("checks the extras: 4 questions, linked to existing options, https links", async () => {
    const { extrasProblem } = await import("../src/shared/menu");
    expect(extrasProblem({ root: MENU.root, ice_breakers: [{ question: "س", key: "gone0001" }] })).toContain("محذوف");
    expect(extrasProblem({ root: MENU.root, ice_breakers: Array.from({ length: 5 }, () => ({ question: "س", key: "price001" })) })).toContain("الحد 4");
    expect(extrasProblem({ root: MENU.root, persistent: [{ title: "رابط", url: "http://x" }] })).toContain("https://");
    expect(extrasProblem({ root: MENU.root, persistent: [{ title: "المناطق", key: "areas001" }] })).toBeNull();
  });
});

describe("inbox: labels the merchant types", () => {
  it("sets a typed label, filters by it, counts it; another customer cannot touch the conversation", async () => {
    await call("/api/auth/setup", {}, "POST", { setup_token: "test_setup_token_123456", username: "admin", password: "a-very-strong-password" });
    const OWNER = await login("admin", "a-very-strong-password");
    await deliver(messagePayload({ text: "مرحبا" }), new MockMeta());
    const p = await DB.prepare("SELECT id FROM participants WHERE igsid = 'igsid_user_1'").first<any>();
    expect((await call(`/api/inbox/${p.id}/label`, OWNER, "PUT", { label: "عميل مهم" })).status).toBe(200);
    expect((await call(`/api/inbox?label=${encodeURIComponent("عميل مهم")}`, OWNER)).body.map((r: any) => r.id)).toEqual([p.id]);
    expect((await call("/api/inbox?label=order", OWNER)).body).toHaveLength(0);
    expect((await call("/api/inbox-labels", OWNER)).body).toContainEqual({ label: "عميل مهم", n: 1 });
    expect((await call(`/api/inbox/${p.id}/label`, OWNER, "PUT", { label: "x".repeat(25) })).status).toBe(422);
    const code = (await call("/api/owner/codes", OWNER, "POST", { plan_id: "basic", days: 10, count: 1 })).body.codes[0];
    await call("/api/auth/register", {}, "POST", { name: "متجر ب", username: "shop_b", password: "another-strong-password", code });
    const B = await login("shop_b", "another-strong-password");
    expect((await call(`/api/inbox/${p.id}/label`, B, "PUT", { label: "دخيل" })).status).toBe(404);
  });
});
