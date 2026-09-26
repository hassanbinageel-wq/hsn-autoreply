import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { signMetaBody, b64url } from "../src/worker/lib/crypto";
import { commentPayload, DB, deliver, following, messagePayload, MockMeta, notFollowing, resetDb, seedAccount, seedCampaign, TEST_ENV } from "./helpers";

const BASE = "https://hsn.example.workers.dev";
const SELF = (exports as any).default as { fetch: (r: Request | string, init?: RequestInit) => Promise<Response> };
const call = (path: string, init?: RequestInit) => SELF.fetch(new Request(BASE + path, init));
const json = (body: unknown, headers: Record<string, string> = {}, method = "POST"): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});

async function setupAndLogin(client: "web" | "app" = "web") {
  await call("/api/auth/setup", json({ setup_token: "test_setup_token_123456", username: "admin", password: "a-very-strong-password" }));
  const r = await call("/api/auth/login", json({ username: "admin", password: "a-very-strong-password", client }));
  const body = (await r.json()) as any;
  const cookie = (r.headers.get("Set-Cookie") ?? "").split(";")[0];
  return { r, body, cookie };
}

beforeEach(async () => {
  await resetDb();
});

describe("webhook endpoint", () => {
  it("GET verification echoes the challenge only with the right verify token", async () => {
    const ok = await call("/webhooks/instagram?hub.mode=subscribe&hub.verify_token=test_verify_token&hub.challenge=12345");
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("12345");
    const bad = await call("/webhooks/instagram?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=12345");
    expect(bad.status).toBe(403);
  });

  it("POST rejects a bad signature and stores nothing", async () => {
    await seedAccount();
    const body = JSON.stringify(commentPayload({ text: "كورس" }));
    const r = await call("/webhooks/instagram", { method: "POST", body, headers: { "X-Hub-Signature-256": await signMetaBody(body, "wrong") } });
    expect(r.status).toBe(401);
    const n = await DB.prepare("SELECT COUNT(*) AS n FROM webhook_events").first<any>();
    expect(n.n).toBe(0);
  });

  it("POST with a valid signature persists the event + job before answering 200", async () => {
    await seedAccount();
    await seedCampaign({});
    const body = JSON.stringify(commentPayload({ text: "كورس", commentId: "c_http" }));
    const sig = await signMetaBody(body, "test_app_secret");
    const r = await call("/webhooks/instagram", { method: "POST", body, headers: { "X-Hub-Signature-256": sig } });
    expect(r.status).toBe(200);
    const ev = await DB.prepare("SELECT * FROM webhook_events WHERE dedup_key = 'comment:c_http'").first<any>();
    expect(ev).toBeTruthy();
    const job = await DB.prepare("SELECT * FROM action_jobs WHERE dedup_key = 'evt:comment:c_http'").first<any>();
    expect(job).toBeTruthy();
    // duplicate delivery → still exactly one event row
    await call("/webhooks/instagram", { method: "POST", body, headers: { "X-Hub-Signature-256": sig } });
    const n = await DB.prepare("SELECT COUNT(*) AS n FROM webhook_events").first<any>();
    expect(n.n).toBe(1);
  });
});

describe("admin authentication", () => {
  it("allows one-time setup only with the setup token, then never again", async () => {
    const bad = await call("/api/auth/setup", json({ setup_token: "wrong_token_wrong_token", username: "admin", password: "a-very-strong-password" }));
    expect(bad.status).toBe(403);
    const ok = await call("/api/auth/setup", json({ setup_token: "test_setup_token_123456", username: "admin", password: "a-very-strong-password" }));
    expect(ok.status).toBe(200);
    const again = await call("/api/auth/setup", json({ setup_token: "test_setup_token_123456", username: "admin2", password: "a-very-strong-password" }));
    expect(again.status).toBe(409);
    const n = await DB.prepare("SELECT COUNT(*) AS n FROM admin_users").first<any>();
    expect(n.n).toBe(1);
  });

  it("rejects weak passwords at setup", async () => {
    const r = await call("/api/auth/setup", json({ setup_token: "test_setup_token_123456", username: "admin", password: "short" }));
    expect(r.status).toBe(422);
  });

  it("web session: HttpOnly Secure SameSite cookie, CSRF required for writes", async () => {
    const { r, body, cookie } = await setupAndLogin("web");
    const setCookie = r.headers.get("Set-Cookie")!;
    expect(setCookie).toMatch(/__Host-hsn_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(body.token).toBeUndefined();

    const get = await call("/api/campaigns", { headers: { Cookie: cookie } });
    expect(get.status).toBe(200);
    const noCsrf = await call("/api/automation", json({ enabled: false }, { Cookie: cookie }));
    expect(noCsrf.status).toBe(403);
    const crossOrigin = await call("/api/automation", json({ enabled: false }, { Cookie: cookie, "X-CSRF-Token": body.csrf_token, Origin: "https://evil.example" }));
    expect(crossOrigin.status).toBe(403);
    const ok = await call("/api/automation", json({ enabled: false }, { Cookie: cookie, "X-CSRF-Token": body.csrf_token }));
    expect(ok.status).toBe(200);
  });

  it("app session: bearer token, no cookie", async () => {
    const { r, body } = await setupAndLogin("app");
    expect(r.headers.get("Set-Cookie")).toBeNull();
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const ok = await call("/api/campaigns", { headers: { Authorization: `Bearer ${body.token}` } });
    expect(ok.status).toBe(200);
    const bad = await call("/api/campaigns", { headers: { Authorization: "Bearer nope" } });
    expect(bad.status).toBe(401);
    const stored = await DB.prepare("SELECT id FROM sessions").first<any>();
    expect(stored.id).not.toBe(body.token); // only the hash is stored
  });

  it("requires authentication for the management API", async () => {
    for (const p of ["/api/campaigns", "/api/account", "/api/settings", "/api/logs/events", "/api/dashboard"]) {
      expect((await call(p)).status).toBe(401);
    }
  });

  it("locks the account after repeated failures (brute force)", async () => {
    await setupAndLogin();
    let last: Response | null = null;
    for (let i = 0; i < 6; i++) last = await call("/api/auth/login", json({ username: "admin", password: "wrong-password!" }));
    expect([401, 429]).toContain(last!.status);
    const good = await call("/api/auth/login", json({ username: "admin", password: "a-very-strong-password" }));
    expect(good.status).toBe(429);
  });

  it("CORS is only granted to the Capacitor app origins", async () => {
    const pre = (origin: string) =>
      call("/api/campaigns", { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" } });
    expect((await pre("https://localhost")).headers.get("Access-Control-Allow-Origin")).toBe("https://localhost");
    expect((await pre("https://evil.example")).headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect((await pre("https://localhost")).headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });
});

describe("secrets never leave the server", () => {
  it("account endpoint does not expose token ciphertext", async () => {
    await seedAccount();
    const { body } = await setupAndLogin("app");
    const r = await call("/api/account", { headers: { Authorization: `Bearer ${body.token}` } });
    const text = await r.text();
    expect(text).not.toContain("token_ciphertext");
    expect(text).not.toContain("test_app_secret");
    expect(JSON.parse(text).account.has_token).toBe(true);
  });

  it("backup excludes tokens, sessions and personal data", async () => {
    await seedAccount();
    await seedCampaign({});
    const { body } = await setupAndLogin("app");
    const r = await call("/api/settings/backup", { headers: { Authorization: `Bearer ${body.token}` } });
    const text = await r.text();
    expect(text).not.toMatch(/token_ciphertext|password_hash|igsid|sessions/);
    expect(JSON.parse(text).campaigns).toHaveLength(1);
  });
});

describe("OAuth", () => {
  it("builds an Instagram Login URL with a one-time state; callback rejects unknown/reused state", async () => {
    const { body } = await setupAndLogin("app");
    const r = await call("/api/account/connect", json({ client: "app" }, { Authorization: `Bearer ${body.token}` }));
    const { url } = (await r.json()) as any;
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(u.searchParams.get("redirect_uri")).toBe(`${BASE}/oauth/instagram/callback`);
    expect(u.searchParams.get("scope")).toContain("instagram_business_manage_messages");
    const state = u.searchParams.get("state")!;
    const stored = await DB.prepare("SELECT state_hash FROM oauth_states").first<any>();
    expect(stored.state_hash).not.toBe(state);

    const forged = await call("/oauth/instagram/callback?state=forged&code=x");
    expect(forged.status).toBe(400);
    // user cancels → state consumed
    const cancelled = await call(`/oauth/instagram/callback?state=${state}&error=access_denied`);
    expect(cancelled.status).toBe(400);
    expect(await cancelled.text()).toContain("com.hsn.autoreply://oauth-done?status=error");
    const reused = await call(`/oauth/instagram/callback?state=${state}&code=x`);
    expect(reused.status).toBe(400);
    expect(await reused.text()).toContain("غير صالح");
  });
});

describe("account disconnect", () => {
  it("cancels pending jobs, open flows and wipes the token", async () => {
    const accId = await seedAccount();
    await seedCampaign({ require_follow: true });
    const { body } = await setupAndLogin("app");
    const now = Date.now();
    await DB.prepare("INSERT INTO action_jobs (account_id, kind, dedup_key, status, run_at, created_at, updated_at) VALUES (?, 'send_message', 'x1', 'pending', ?, ?, ?)").bind(accId, now + 60_000, now, now).run();
    const r = await call("/api/account/disconnect", json({ purge: true }, { Authorization: `Bearer ${body.token}` }));
    expect(r.status).toBe(200);
    const acc = await DB.prepare("SELECT status, token_ciphertext FROM instagram_accounts").first<any>();
    expect(acc.status).toBe("disconnected");
    expect(acc.token_ciphertext).toBeNull();
    const job = await DB.prepare("SELECT status FROM action_jobs WHERE dedup_key = 'x1'").first<any>();
    expect(job.status).toBe("cancelled");
  });
});

describe("Meta data deletion callback", () => {
  it("verifies signed_request and rejects forged ones", async () => {
    const payload = b64url(new TextEncoder().encode(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: "igsid_user_1", issued_at: 1 })));
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("test_app_secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))));
    const form = (sr: string) => ({ method: "POST", body: new URLSearchParams({ signed_request: sr }) });
    expect((await call("/meta/data-deletion", form(`${sig}.${payload}`))).status).toBe(200);
    expect((await call("/meta/data-deletion", form(`AAAA.${payload}`))).status).toBe(400);
  });
});

describe("demo simulation (no real sends)", () => {
  it("runs a full follow-gated scenario through the real pipeline with demo rows only", async () => {
    const id = await seedCampaign({ require_follow: true, status: "draft" });
    const { body } = await setupAndLogin("app");
    const H = { Authorization: `Bearer ${body.token}` };
    const sim = async (b: unknown) => (await (await call("/api/simulate", json(b, H))).json()) as any;

    let r = await sim({ campaign_id: id, event: "comment", text: "كورس", participant: "tester", reset: true, script: { follow: ["not_following", "following"] } });
    expect(r.ok).toBe(true);
    expect(r.flows[0].state).toBe("awaiting_user_interaction");
    const opening = r.jobs.find((j: any) => j.purpose === "opening");
    expect(opening.result.text).not.toContain("secret-course");

    r = await sim({ event: "message", text: "ابدأ", participant: "tester" });
    expect(r.flows[0].state).toBe("awaiting_follow");
    await DB.prepare("UPDATE conversation_flows SET last_verify_at = NULL").run();
    r = await sim({ event: "verify_button", participant: "tester" });
    expect(r.flows[0].state).toBe("content_sent");
    const content = r.jobs.find((j: any) => j.purpose === "content");
    expect(content.result.text).toContain("secret-course");

    const prod = await DB.prepare("SELECT COUNT(*) AS n FROM action_jobs WHERE is_demo = 0").first<any>();
    expect(prod.n).toBe(0);
  });
});

describe("campaign stats", () => {
  it("breaks results down per post: comments, people reached, new followers, deliveries", async () => {
    const { body } = await setupAndLogin("app");
    const auth = { headers: { Authorization: `Bearer ${body.token}` } };
    await seedAccount();
    const cid = await seedCampaign({ require_follow: true, scope: "selected", media_ids: ["media_A", "media_B"], verify_cooldown_seconds: 5 });
    const meta = new MockMeta();
    const clock = { t: Date.now() };
    // media_A: user 1 was already following → content right after "ابدأ"
    await deliver(commentPayload({ text: "كورس", mediaId: "media_A", from: "u1", time: clock.t }), meta, clock);
    meta.follow = [following()];
    clock.t += 1000;
    await deliver(messagePayload({ from: "u1", text: "ابدأ", time: clock.t }), meta, clock);
    // media_A: user 2 was not following, followed, verified → new follower + delivered
    await deliver(commentPayload({ text: "كورس", mediaId: "media_A", from: "u2", time: clock.t }), meta, clock);
    meta.follow = [notFollowing()];
    clock.t += 1000;
    await deliver(messagePayload({ from: "u2", text: "ابدأ", time: clock.t }), meta, clock);
    meta.follow = [following()];
    clock.t += 10_000;
    await deliver(messagePayload({ from: "u2", text: "تحقق", time: clock.t }), meta, clock);
    // media_A: a non-matching comment; media_B: one person who never replied
    await deliver(commentPayload({ text: "مرحبا", mediaId: "media_A", from: "u3", time: clock.t }), meta, clock);
    await deliver(commentPayload({ text: "كورس", mediaId: "media_B", from: "u4", time: clock.t }), meta, clock);

    const r = await call(`/api/campaigns/${cid}/stats`, auth);
    expect(r.status).toBe(200);
    const s = (await r.json()) as any;
    const a = s.media.find((m: any) => m.media_id === "media_A");
    const b = s.media.find((m: any) => m.media_id === "media_B");
    expect(a).toMatchObject({ comments_total: 3, comments_matched: 2, people: 2, reached: 2, already_following: 1, new_followers: 1, delivered: 2 });
    expect(b).toMatchObject({ comments_total: 1, comments_matched: 1, people: 1, reached: 1, delivered: 0, waiting: 1 });
    expect(s.totals).toMatchObject({ people: 3, delivered: 2, new_followers: 1, comments_total: 4 });
    const other = await call("/api/campaigns/999999/stats", auth);
    expect(other.status).toBe(404);
  });
});

describe("CSV export", () => {
  it("is formula-injection safe", async () => {
    await seedAccount();
    await DB.prepare("INSERT INTO webhook_events (dedup_key, account_ig_id, event_type, text, payload, event_time, received_at, status) VALUES ('x', '1', 'comment', '=cmd|calc', '{}', 1, 1, 'ignored')").run();
    const { body } = await setupAndLogin("app");
    const r = await call("/api/logs/export?type=events", { headers: { Authorization: `Bearer ${body.token}` } });
    const text = await r.text();
    expect(text).toContain(`"'=cmd|calc"`);
  });
});

describe("public pages", () => {
  it("serves privacy / data deletion pages", async () => {
    expect((await call("/privacy")).status).toBe(200);
    expect(await (await call("/data-deletion")).text()).toContain("حذف البيانات");
    void TEST_ENV;
  });
});
