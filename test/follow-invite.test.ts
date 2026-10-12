import { beforeEach, describe, expect, it } from "vitest";
import { commentPayload, DB, deliver, flowsOf, MockMeta, notFollowing, resetDb, seedAccount, seedCampaign, uid } from "./helpers";
import { claimsFollowRequired } from "../src/shared/template";

const SECRET = "https://example.com/secret-course";

beforeEach(async () => {
  await resetDb();
});

describe("optional follow invitation (Meta Spam policy)", () => {
  it("sends the content right away with the invitation line and a «تابعنا» button — no follow check", async () => {
    await seedAccount({ followGate: false });
    const id = await seedCampaign({ keywords: [{ keyword: "كورس" }] });
    await DB.prepare("UPDATE campaigns SET follow_invite = 1, follow_invite_text = 'ونسعد بمتابعتك' WHERE id = ?").bind(id).run();
    const meta = new MockMeta();
    await deliver(commentPayload({ text: "أبغى الكورس", commentId: uid("c") }), meta);
    const sends = meta.sends();
    expect(sends).toHaveLength(1);
    expect(sends[0].kind).toBe("private_reply");
    expect(sends[0].text).toContain(SECRET);
    expect(sends[0].text).toContain("ونسعد بمتابعتك");
    expect(sends[0].msg?.accountButton).toEqual({ title: "👤 تابعنا", url: "https://www.instagram.com/hsn_shop" });
    expect(sends[0].msg?.linkButton?.url).toBeTruthy();
    expect(meta.calls.some((c) => c.kind === "follow_check")).toBe(false);
    expect((await flowsOf())[0].state).toBe("content_sent");
  });

  it("a campaign that requires a follow delivers to everyone when the account is not allowed to use the requirement", async () => {
    await seedAccount({ followGate: false });
    await seedCampaign({ keywords: [{ keyword: "كورس" }], require_follow: true });
    const meta = new MockMeta();
    meta.follow = [notFollowing()];
    await deliver(commentPayload({ text: "كورس", commentId: uid("c") }), meta);
    expect(meta.calls.some((c) => c.kind === "follow_check")).toBe(false);
    expect(meta.sends()[0].text).toContain(SECRET);
    expect((await flowsOf())[0].state).toBe("content_sent");
  });

  it("flows waiting under the old requirement get the content when the requirement is switched off", async () => {
    await seedAccount();
    await seedCampaign({ keywords: [{ keyword: "كورس" }], require_follow: true });
    const meta = new MockMeta();
    meta.follow = [notFollowing(), notFollowing()];
    await deliver(commentPayload({ text: "كورس", commentId: uid("c") }), meta);
    expect((await flowsOf())[0].state).toBe("awaiting_follow");
    expect(meta.sends().some((s) => s.text?.includes(SECRET))).toBe(false);
    // The owner turns the requirement off for this account; the person then writes back.
    await DB.prepare("UPDATE instagram_accounts SET follow_gate_allowed = 0").run();
    const f = (await flowsOf())[0];
    const { messagePayload } = await import("./helpers");
    await deliver(messagePayload({ text: "تابعت" }), meta);
    expect(meta.sends().some((s) => s.text?.includes(SECRET))).toBe(true);
    expect((await DB.prepare("SELECT state FROM conversation_flows WHERE id = ?").bind(f.id).first<any>()).state).toBe("content_sent");
  });

  it("flags invitation wording that makes the follow a condition", () => {
    expect(claimsFollowRequired("تابع حسابنا عشان يوصلك الرابط")).toBe(true);
    expect(claimsFollowRequired("المتابعة شرط للحصول على الملف")).toBe(true);
    expect(claimsFollowRequired("لازم تتابع")).toBe(true);
    expect(claimsFollowRequired("ونسعد بمتابعتك لحسابنا 💜")).toBe(false);
    expect(claimsFollowRequired("تابعنا لو حاب يوصلك جديدنا")).toBe(false); // an invitation with a reason, not a condition
  });
});

describe("follow requirement is owner-controlled", () => {
  it("saving a campaign with the requirement keeps it only on an allowed account", async () => {
    const { exports } = await import("cloudflare:workers");
    const SELF = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
    const B = "https://hsn.example.workers.dev";
    const post = (path: string, body: unknown, h: Record<string, string> = {}) =>
      SELF.fetch(new Request(B + path, { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify(body) }));
    await seedAccount({ followGate: false });
    await post("/api/auth/setup", { setup_token: "test_setup_token_123456", username: "admin", password: "a-very-strong-password" });
    const r = await post("/api/auth/login", { username: "admin", password: "a-very-strong-password", client: "web" });
    const b = (await r.json()) as any;
    const H = { Cookie: (r.headers.get("Set-Cookie") ?? "").split(";")[0], "X-CSRF-Token": b.csrf_token };
    const camp = { name: "x", type: "comment", final_text: "تفضل", keywords: [{ keyword: "كورس", kind: "include", match_type: "contains" }], require_follow: true };
    const res = (await (await post("/api/campaigns", camp, H)).json()) as any;
    expect(res.warnings.join(" ")).toContain("غير مسموح");
    expect((await DB.prepare("SELECT require_follow FROM campaigns WHERE id = ?").bind(res.id).first<any>()).require_follow).toBe(0);
    // The owner allows it from the panel → the requirement is kept.
    await post("/api/account/follow-gate", { allowed: true }, H);
    const res2 = (await (await post("/api/campaigns", camp, H)).json()) as any;
    expect((await DB.prepare("SELECT require_follow FROM campaigns WHERE id = ?").bind(res2.id).first<any>()).require_follow).toBe(1);
  });
});
