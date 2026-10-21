import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DB, TEST_ENV, resetDb, seedAccount } from "./helpers";
import { cleanupSupportFiles } from "../src/worker/services/support";

const BASE = "https://hsn.example.workers.dev";
const SELF = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
type H = Record<string, string>;
const DAY = 86_400_000;

async function call(path: string, h: H = {}, method = "GET", body?: unknown) {
  const r = await SELF.fetch(new Request(BASE + path, { method, headers: { "Content-Type": "application/json", ...h }, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}
async function upload(path: string, h: H, mime: string, bytes: number) {
  const r = await SELF.fetch(new Request(BASE + path, { method: "PUT", headers: { ...h, "Content-Type": mime, "Content-Length": String(bytes) }, body: new Uint8Array(bytes) }));
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
async function customer(username: string) {
  const code = (await call("/api/owner/codes", OWNER, "POST", { plan_id: "basic", days: 10, count: 1 })).body.codes[0];
  expect((await call("/api/auth/register", {}, "POST", { name: `متجر ${username}`, username, password: "another-strong-password", code })).status).toBe(200);
  return login(username, "another-strong-password");
}
const bell = (tid: number, kind: string) => DB.prepare("SELECT title FROM app_notifications WHERE tenant_id = ? AND kind = ? ORDER BY id").bind(tid, kind).all<any>().then((r) => r.results.map((x) => x.title as string));
const tidOf = async (username: string) => (await DB.prepare("SELECT tenant_id FROM admin_users WHERE username = ?").bind(username).first<any>()).tenant_id as number;

describe("support center: tickets", () => {
  it("a ticket has a number, a type and a state that follows the conversation; both sides are told", async () => {
    const A = await customer("shop_a");
    const r = await call("/api/support", A, "POST", { category: "tech", subject: "الحملة ما ترد", body: "من أمس ما ترد على التعليقات" });
    expect(r.status).toBe(200);
    expect(r.body.number).toBe(1000 + r.body.id);
    const id = r.body.id;
    expect((await bell(1, "support")).at(-1)).toContain(`رقم ${r.body.number}`);

    let t = (await call(`/api/support/${id}`, A)).body.thread;
    expect(t).toMatchObject({ category: "tech", state: "new" });
    // owner replies → waiting for the customer
    expect((await call(`/api/owner/support/${id}/reply`, OWNER, "POST", { body: "جرّب إعادة الربط" })).status).toBe(200);
    t = (await call(`/api/support/${id}`, A)).body.thread;
    expect(t.state).toBe("waiting");
    const a = await tidOf("shop_a");
    expect((await bell(a, "support_reply")).at(-1)).toContain("بانتظار ردك");
    // customer answers → in progress
    await call(`/api/support/${id}/reply`, A, "POST", { body: "سويتها وما زالت" });
    expect((await call(`/api/support/${id}`, A)).body.thread.state).toBe("in_progress");
    // owner sets priority and resolves → the customer is told; a later customer message reopens it
    expect((await call(`/api/owner/support/${id}/meta`, OWNER, "POST", { priority: "urgent", state: "resolved" })).status).toBe(200);
    const row = await DB.prepare("SELECT state, status, priority, closed_at FROM support_threads WHERE id = ?").bind(id).first<any>();
    expect(row).toMatchObject({ state: "resolved", status: "closed", priority: "urgent" });
    expect(row.closed_at).toBeGreaterThan(0);
    expect((await bell(a, "support_reply")).at(-1)).toContain("تم حل طلبك");
    await call(`/api/support/${id}/reply`, A, "POST", { body: "رجعت المشكلة" });
    const again = await DB.prepare("SELECT state, status, closed_at FROM support_threads WHERE id = ?").bind(id).first<any>();
    expect(again).toMatchObject({ state: "in_progress", status: "open", closed_at: null });
    // the customer never sees the priority
    expect((await call("/api/support", A)).body[0].priority).toBeUndefined();
    expect((await call("/api/owner/support", OWNER)).body[0]).toMatchObject({ id, priority: "urgent", category: "tech" });
  });

  it("attachments: an image up to 5 MB or a video up to 25 MB, on the customer's own new message", async () => {
    const A = await customer("shop_a");
    const r = (await call("/api/support", A, "POST", { category: "question", subject: "صورة الخطأ", body: "مرفقة" })).body;
    const path = `/api/support/${r.id}/messages/${r.message_id}/attachment`;
    expect((await upload(path, A, "application/pdf", 100)).status).toBe(422);
    expect((await upload(path, A, "image/png", 5 * 1024 * 1024 + 1)).status).toBe(422);
    expect((await upload(path, A, "image/png", 2048)).status).toBe(200);
    expect((await upload(path, A, "image/png", 2048)).status).toBe(409); // one file per message
    const msg = (await call(`/api/support/${r.id}`, A)).body.messages[0];
    expect(msg).toMatchObject({ has_att: 1, att_mime: "image/png", att_size: 2048 });
    const file = await SELF.fetch(new Request(`${BASE}/api/support/attachment/${r.message_id}`, { headers: A }));
    expect(file.status).toBe(200);
    expect(file.headers.get("Content-Type")).toBe("image/png");
    expect((await SELF.fetch(new Request(`${BASE}/api/owner/support/attachment/${r.message_id}`, { headers: OWNER }))).status).toBe(200);
    // a video on a reply: 25 MB max
    const rep = (await call(`/api/support/${r.id}/reply`, A, "POST", { body: "وهذا فيديو" })).body;
    expect((await upload(`/api/support/${r.id}/messages/${rep.message_id}/attachment`, A, "video/mp4", 25 * 1024 * 1024 + 1)).status).toBe(422);
    expect((await upload(`/api/support/${r.id}/messages/${rep.message_id}/attachment`, A, "video/mp4", 4096)).status).toBe(200);
    // the owner's message cannot carry a customer upload
    const o = (await call(`/api/owner/support/${r.id}/reply`, OWNER, "POST", { body: "تمام" })).body;
    expect((await upload(`/api/support/${r.id}/messages/${o.message_id}/attachment`, A, "image/png", 10)).status).toBe(404);
  });

  it("files are removed 30 days after the ticket is resolved, not before", async () => {
    const A = await customer("shop_a");
    const r = (await call("/api/support", A, "POST", { category: "tech", subject: "مشكلة", body: "صورة" })).body;
    await upload(`/api/support/${r.id}/messages/${r.message_id}/attachment`, A, "image/jpeg", 1000);
    const key = (await DB.prepare("SELECT att_key FROM support_messages WHERE id = ?").bind(r.message_id).first<any>()).att_key as string;
    expect(await TEST_ENV.MEDIA.get(key)).not.toBeNull();
    expect(await cleanupSupportFiles(TEST_ENV)).toBe(0); // still open
    await call(`/api/owner/support/${r.id}/meta`, OWNER, "POST", { state: "resolved" });
    expect(await cleanupSupportFiles(TEST_ENV, Date.now() + 29 * DAY)).toBe(0);
    expect(await cleanupSupportFiles(TEST_ENV, Date.now() + 31 * DAY)).toBe(1);
    expect(await TEST_ENV.MEDIA.get(key)).toBeNull();
    const msg = (await call(`/api/support/${r.id}`, A)).body.messages[0];
    expect(msg).toMatchObject({ has_att: 0, att_removed: 1 });
    expect((await SELF.fetch(new Request(`${BASE}/api/support/attachment/${r.message_id}`, { headers: A }))).status).toBe(404);
  });

  it("tenant isolation: another customer cannot read, answer, attach to or download a ticket", async () => {
    const A = await customer("shop_a");
    const B = await customer("shop_b");
    const r = (await call("/api/support", A, "POST", { category: "billing", subject: "فاتورة", body: "سر" })).body;
    await upload(`/api/support/${r.id}/messages/${r.message_id}/attachment`, A, "image/png", 100);
    expect((await call(`/api/support/${r.id}`, B)).status).toBe(404);
    expect((await call(`/api/support/${r.id}/reply`, B, "POST", { body: "دخيل" })).status).toBe(404);
    expect((await call("/api/support", B)).body).toHaveLength(0);
    const rb = (await call("/api/support", B, "POST", { category: "tech", subject: "طلبي", body: "x" })).body;
    // B's own ticket id with A's message id, and A's ticket with B's token
    expect((await upload(`/api/support/${rb.id}/messages/${r.message_id}/attachment`, B, "image/png", 10)).status).toBe(404);
    expect((await upload(`/api/support/${r.id}/messages/${r.message_id}/attachment`, B, "image/png", 10)).status).toBe(404);
    expect((await SELF.fetch(new Request(`${BASE}/api/support/attachment/${r.message_id}`, { headers: B }))).status).toBe(404);
    // customers cannot reach the owner's support routes
    expect((await call("/api/owner/support", B)).status).toBe(403);
    expect((await call(`/api/owner/support/${r.id}/meta`, B, "POST", { state: "resolved" })).status).toBe(403);
  });
});

describe("support center: FAQ, canned replies, response time, incident banner", () => {
  it("the owner manages the FAQ (video links from YouTube / Instagram only); the widget shows the active ones", async () => {
    const ok = await call("/api/owner/support-faq", OWNER, "POST", { question: "كيف أربط حسابي؟", answer: "من صفحة الربط", video_url: "https://www.youtube.com/watch?v=abc" });
    expect(ok.status).toBe(200);
    await call("/api/owner/support-faq", OWNER, "POST", { question: "سؤال مخفي", answer: "x", active: false });
    expect((await call("/api/owner/support-faq", OWNER, "POST", { question: "رابط غريب", answer: "x", video_url: "https://evil.example/v" })).status).toBe(422);
    expect((await call("/api/owner/support-faq", OWNER, "POST", { question: "ريل", answer: "x", video_url: "https://www.instagram.com/reel/xyz/" })).status).toBe(200);
    let pub = (await call("/api/public/support")).body;
    expect(pub.faq.map((f: any) => f.question)).toEqual(["كيف أربط حسابي؟", "ريل"]);
    expect(pub.response_time).toContain("24 ساعة");
    expect(pub.incident).toBeNull();
    expect((await call(`/api/owner/support-faq/${ok.body.id}`, OWNER, "DELETE")).status).toBe(200);
    // response time + incident
    expect((await call("/api/owner/support-settings", OWNER, "PUT", { response_time: "نرد خلال ساعتين", incident: { active: true, text: "بطء مؤقت في إنستقرام", tone: "warn" } })).status).toBe(200);
    pub = (await call("/api/public/support")).body;
    expect(pub.faq).toHaveLength(1);
    expect(pub.response_time).toBe("نرد خلال ساعتين");
    expect(pub.incident).toMatchObject({ text: "بطء مؤقت في إنستقرام", tone: "warn" });
    await call("/api/owner/support-settings", OWNER, "PUT", { incident: { active: false, text: "", tone: "info" } });
    expect((await call("/api/public/support")).body.incident).toBeNull();
    expect((await call("/api/owner/support-settings", OWNER, "PUT", { incident: { active: true, text: "", tone: "info" } })).status).toBe(422);
  });

  it("canned replies are the owner's only", async () => {
    const A = await customer("shop_a");
    const r = await call("/api/owner/support-canned", OWNER, "POST", { title: "إعادة الربط", body: "افتح صفحة الربط واضغط إعادة الاتصال" });
    expect(r.status).toBe(200);
    expect((await call("/api/owner/support-canned", OWNER)).body).toHaveLength(1);
    expect((await call("/api/owner/support-canned", A)).status).toBe(403);
    expect((await call("/api/owner/support-faq", A, "POST", { question: "اختراق؟", answer: "x" })).status).toBe(403);
  });
});

const PASTED = `**البداية والربط**

**س: كيف أربط حساب إنستقرام؟**
ج: افتح صفحة «الربط» واضغط «ربط عبر Instagram».
فيديو: https://youtu.be/abc123

**س: هل لازم يكون حسابي احترافي؟**
ج: نعم، الحساب لازم يكون احترافي.

---

**الحملات والردود**

**س: ليش الحملة ما ترد على التعليقات؟**
ج: تأكد من هالنقاط:
1) الحملة شغّالة.
2) التعليق فيه كلمة تشغيل.

---

**أسئلة يناسبها فيديو:** الربط والحملة.`;

describe("FAQ sections and import from text", () => {
  it("parses sections, multi-line answers and video links; notes after «---» are left out", async () => {
    const { parseFaqText } = await import("../src/shared/support");
    const r = parseFaqText(PASTED);
    expect(r.sections.map((s) => [s.title, s.items.length])).toEqual([["البداية والربط", 2], ["الحملات والردود", 1]]);
    expect(r.sections[0].items[0]).toMatchObject({ question: "كيف أربط حساب إنستقرام؟", video_url: "https://youtu.be/abc123" });
    expect(r.sections[1].items[0].answer).toBe("تأكد من هالنقاط:\n1) الحملة شغّالة.\n2) التعليق فيه كلمة تشغيل.");
    expect(r.ignored.join(" ")).toContain("أسئلة يناسبها فيديو");
  });

  it("imports once (no duplicates), into sections the widget shows in order; sections can be renamed, reordered and deleted", async () => {
    const first = await call("/api/owner/support-faq/import", OWNER, "POST", { text: PASTED });
    expect(first.body).toMatchObject({ added: 3, updated: 0 });
    expect((await call("/api/owner/support-faq/import", OWNER, "POST", { text: PASTED })).body).toMatchObject({ added: 0, updated: 3 });
    expect((await call("/api/owner/support-faq/import", OWNER, "POST", { text: "كلام بدون أسئلة" })).status).toBe(422);
    let pub = (await call("/api/public/support")).body;
    expect(pub.sections.map((s: any) => s.title)).toEqual(["البداية والربط", "الحملات والردود"]);
    const [s1, s2] = pub.sections;
    expect(pub.faq.filter((f: any) => f.section_id === s1.id)).toHaveLength(2);
    expect(pub.faq.find((f: any) => f.question.startsWith("كيف أربط")).video_url).toBe("https://youtu.be/abc123");
    // reorder + rename + move a question + delete a section (its questions stay, without a section)
    await call("/api/owner/support-faq-sections/order", OWNER, "PUT", { ids: [s2.id, s1.id] });
    await call(`/api/owner/support-faq-sections/${s2.id}`, OWNER, "PUT", { title: "الحملات" });
    const q = pub.faq.find((f: any) => f.section_id === s1.id);
    expect((await call(`/api/owner/support-faq/${q.id}/move`, OWNER, "POST", { section_id: s2.id })).status).toBe(200);
    expect((await call(`/api/owner/support-faq/${q.id}/move`, OWNER, "POST", { section_id: 99999 })).status).toBe(422);
    pub = (await call("/api/public/support")).body;
    expect(pub.sections.map((s: any) => s.title)).toEqual(["الحملات", "البداية والربط"]);
    expect(pub.faq.find((f: any) => f.id === q.id).section_id).toBe(s2.id);
    await call(`/api/owner/support-faq-sections/${s1.id}`, OWNER, "DELETE");
    pub = (await call("/api/public/support")).body;
    expect(pub.sections).toHaveLength(1);
    expect(pub.faq).toHaveLength(3);
    expect(pub.faq.filter((f: any) => f.section_id === null)).toHaveLength(1);
    // the owner list has both
    const own = (await call("/api/owner/support-faq", OWNER)).body;
    expect(own.sections).toHaveLength(1);
    expect(own.items).toHaveLength(3);
  });

  it("questions added one by one before move into the pasted sections (no duplicates); the emptied section goes away", async () => {
    const gen = (await call("/api/owner/support-faq-sections", OWNER, "POST", { title: "عام" })).body.id;
    await call("/api/owner/support-faq", OWNER, "POST", { question: "كيف أربط حساب إنستقرام ؟", answer: "قديم", section_id: gen });
    expect((await call("/api/owner/support-faq/import", OWNER, "POST", { text: PASTED })).body).toMatchObject({ added: 2, updated: 1 });
    const own = (await call("/api/owner/support-faq", OWNER)).body;
    expect(own.items).toHaveLength(3);
    expect(own.sections.map((s: any) => s.title)).toEqual(["البداية والربط", "الحملات والردود"]);
    expect(own.items.find((i: any) => i.question.startsWith("كيف أربط")).answer).toContain("ربط عبر Instagram");
  });

  it("customers cannot manage sections or import", async () => {
    const A = await customer("shop_a");
    expect((await call("/api/owner/support-faq/import", A, "POST", { text: PASTED })).status).toBe(403);
    expect((await call("/api/owner/support-faq-sections", A, "POST", { title: "x" })).status).toBe(403);
  });
});
