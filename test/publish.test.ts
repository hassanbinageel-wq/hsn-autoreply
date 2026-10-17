import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DB, IG_ID, resetDb, seedAccount, seedCampaign, TEST_ENV } from "./helpers";
import { PUBLISH_SCOPE, INSTAGRAM_SCOPES } from "../src/worker/meta/client";
import type { MetaResult } from "../src/worker/meta/types";
import { publishDue, signedMediaUrl, stepPost, validatePost, type PublishClient, type PublishDeps } from "../src/worker/services/publish";

const BASE = "https://hsn.example.workers.dev";
const SELF = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
const MIN = 60_000;
const ok = <T>(data: T): MetaResult<T> => ({ ok: true, httpStatus: 200, data });
const MEDIA: R2Bucket = TEST_ENV.MEDIA;

/** Scriptable publishing client. Records every call; never touches the network. */
class FakePublish implements PublishClient {
  calls: string[] = [];
  statuses: string[] = []; // returned in order by containerStatus (last one repeats)
  publishMode: "ok" | "uncertain" | "refused" = "ok";
  createMode: "ok" | "permission" = "ok";
  quota = { usage: 1, total: 50 };
  latest: Array<{ id: string; caption?: string; timestamp: string }> = [];
  private n = 0;
  async createContainer(_t: string, _ig: string, params: Record<string, string | boolean>) {
    this.calls.push(`create:${params.media_type ?? "IMAGE"}${params.is_carousel_item ? ":child" : ""}`);
    if (this.createMode === "permission") return { ok: false as const, error: { kind: "permission" as const, code: 10, message: "no permission" } };
    return ok({ id: `cont_${++this.n}` });
  }
  async containerStatus(_t: string, id: string) {
    this.calls.push(`status:${id}`);
    const s = this.statuses.length > 1 ? this.statuses.shift()! : this.statuses[0] ?? "FINISHED";
    return ok({ status_code: s });
  }
  async publishContainer(_t: string, _ig: string, id: string): Promise<MetaResult<{ id?: string }>> {
    this.calls.push(`publish:${id}`);
    if (this.publishMode === "uncertain") return { ok: false, error: { kind: "uncertain", message: "network: AbortError" } };
    if (this.publishMode === "refused") return { ok: false, error: { kind: "permanent", code: 100, message: "bad media" } };
    return ok({ id: "ig_media_1" });
  }
  async publishingLimit() {
    this.calls.push("quota");
    return ok({ data: [{ quota_usage: this.quota.usage, config: { quota_total: this.quota.total } }] });
  }
  async getMedia(_t: string, id: string) {
    this.calls.push(`get:${id}`);
    return ok({ id, permalink: `https://instagram.com/p/${id}/`, caption: "عرض", timestamp: new Date().toISOString(), media_type: "IMAGE" });
  }
  async listMedia() {
    this.calls.push("list");
    return ok({ data: this.latest });
  }
}

let accountId = 0;
beforeEach(async () => {
  await resetDb();
  accountId = await seedAccount();
  await DB.prepare("UPDATE instagram_accounts SET scopes = ? WHERE id = ?").bind(JSON.stringify([...INSTAGRAM_SCOPES, PUBLISH_SCOPE]), accountId).run();
});

function deps(client: FakePublish, now: number): PublishDeps {
  return { db: DB, client, env: TEST_ENV, now: () => now, token: async () => "tok", deleteObject: (k) => MEDIA.delete(k) };
}

async function seedPost(kind: "IMAGE" | "CAROUSEL" | "REELS" | "STORY", opts: { files?: Array<"jpg" | "mp4">; publishAt?: number; campaignId?: number; tenant?: number; status?: string } = {}) {
  const now = Date.now();
  const r = await DB.prepare(
    "INSERT INTO scheduled_posts (tenant_id, account_id, kind, caption, publish_at, status, campaign_id, created_at, updated_at) VALUES (?, ?, ?, 'عرض', ?, ?, ?, ?, ?) RETURNING id",
  )
    .bind(opts.tenant ?? 1, accountId, kind, opts.publishAt ?? now - MIN, opts.status ?? "scheduled", opts.campaignId ?? null, now, now)
    .first<{ id: number }>();
  const id = r!.id;
  for (const [i, f] of (opts.files ?? [kind === "REELS" ? "mp4" : "jpg"]).entries()) {
    const key = `t1-p${id}-file${i}.${f}`;
    await MEDIA.put(key, "x".repeat(10), { httpMetadata: { contentType: f === "jpg" ? "image/jpeg" : "video/mp4" } });
    await DB.prepare("INSERT INTO scheduled_media (post_id, position, role, r2_key, mime, size, created_at) VALUES (?, ?, 'item', ?, ?, 10, ?)")
      .bind(id, i, key, f === "jpg" ? "image/jpeg" : "video/mp4", now)
      .run();
  }
  return id;
}
const post = (id: number) => DB.prepare("SELECT * FROM scheduled_posts WHERE id = ?").bind(id).first<any>();
const step = async (client: FakePublish, id: number, now = Date.now()) => stepPost(deps(client, now), (await post(id))!, { left: 16 });

describe("scheduled publishing", () => {
  it("publishes an image once, stores the media, deletes the files, and starts the linked campaign", async () => {
    const cid = await seedCampaign({ scope: "selected", media_ids: ["other"] });
    await DB.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").bind(cid).run();
    const id = await seedPost("IMAGE", { campaignId: cid });
    const meta = new FakePublish();
    await step(meta, id);
    const p = await post(id);
    expect(p).toMatchObject({ status: "published", media_id: "ig_media_1", permalink: "https://instagram.com/p/ig_media_1/" });
    expect(meta.calls.filter((c) => c.startsWith("publish:"))).toEqual(["publish:cont_1"]);
    expect(meta.calls[0]).toBe("quota");
    // files removed from the bucket
    expect(await MEDIA.get(`t1-p${id}-file0.jpg`)).toBeNull();
    expect((await DB.prepare("SELECT deleted_at FROM scheduled_media WHERE post_id = ?").bind(id).first<any>()).deleted_at).toBeTruthy();
    // campaign linked to the new post and active from the publish request
    const c = await DB.prepare("SELECT status, activated_at FROM campaigns WHERE id = ?").bind(cid).first<any>();
    expect(c.status).toBe("active");
    expect(c.activated_at).toBe(p.publish_requested_at);
    expect(await DB.prepare("SELECT 1 FROM campaign_media WHERE campaign_id = ? AND media_id = 'ig_media_1'").bind(cid).first()).toBeTruthy();
    // a second run does nothing (already published)
    expect(await publishDue(deps(meta, Date.now()), { left: 16 })).toBe(0);
  });

  it("waits for a reel that is still processing (one step per minute)", async () => {
    const id = await seedPost("REELS");
    const meta = new FakePublish();
    meta.statuses = ["IN_PROGRESS", "FINISHED"];
    const t0 = Date.now();
    await step(meta, id, t0);
    expect(await post(id)).toMatchObject({ status: "publishing", container_id: "cont_1", next_attempt_at: t0 + MIN });
    expect(meta.calls.some((c) => c.startsWith("publish:"))).toBe(false);
    await step(meta, id, t0 + MIN);
    expect((await post(id)).status).toBe("published");
    expect(meta.calls.filter((c) => c.startsWith("create:"))).toEqual(["create:REELS"]);
  });

  it("never publishes twice after an uncertain answer: the container status decides", async () => {
    const id = await seedPost("IMAGE");
    const meta = new FakePublish();
    meta.publishMode = "uncertain";
    const t0 = Date.now();
    await step(meta, id, t0);
    expect((await post(id)).status).toBe("uncertain");
    // Meta did publish it: the check finds PUBLISHED and the post is completed from the latest media, no 2nd publish
    meta.statuses = ["PUBLISHED"];
    meta.latest = [{ id: "found_1", caption: "عرض", timestamp: new Date(t0 + 1000).toISOString() }];
    await step(meta, id, t0 + MIN);
    expect(await post(id)).toMatchObject({ status: "published", media_id: "found_1" });
    expect(meta.calls.filter((c) => c.startsWith("publish:")).length).toBe(1);
  });

  it("after an uncertain answer, a container still FINISHED was not published and is published once more", async () => {
    const id = await seedPost("IMAGE");
    const meta = new FakePublish();
    meta.publishMode = "uncertain";
    await step(meta, id);
    meta.publishMode = "ok";
    meta.statuses = ["FINISHED"];
    await step(meta, id, Date.now() + MIN);
    expect((await post(id)).status).toBe("published");
    expect(meta.calls.filter((c) => c.startsWith("publish:")).length).toBe(2);
  });

  it("publishes a carousel: children first (all FINISHED), then the parent", async () => {
    const id = await seedPost("CAROUSEL", { files: ["jpg", "mp4", "jpg"] });
    const meta = new FakePublish();
    await step(meta, id);
    expect(meta.calls.filter((c) => c.startsWith("create:"))).toEqual(["create:IMAGE:child", "create:VIDEO:child", "create:IMAGE:child", "create:CAROUSEL"]);
    expect(await post(id)).toMatchObject({ status: "published", children: JSON.stringify(["cont_1", "cont_2", "cont_3"]) });
  });

  it("waits when the 24h publishing quota is used up, and fails clearly without the permission", async () => {
    const id = await seedPost("IMAGE");
    const meta = new FakePublish();
    meta.quota = { usage: 50, total: 50 };
    await step(meta, id);
    expect(await post(id)).toMatchObject({ status: "publishing", container_id: null });
    expect(meta.calls).toEqual(["quota"]);

    const id2 = await seedPost("IMAGE");
    const meta2 = new FakePublish();
    meta2.createMode = "permission";
    await step(meta2, id2);
    expect((await post(id2)).status).toBe("failed");
    expect((await post(id2)).last_error).toContain("صلاحية النشر");
  });

  it("recreates an expired container and refuses to publish far too late", async () => {
    const id = await seedPost("IMAGE");
    const meta = new FakePublish();
    meta.statuses = ["EXPIRED", "FINISHED"];
    await step(meta, id);
    expect(await post(id)).toMatchObject({ container_id: null, status: "publishing" });
    await step(meta, id, Date.now() + MIN);
    expect((await post(id)).status).toBe("published");

    const late = await seedPost("IMAGE", { publishAt: Date.now() - 7 * 3_600_000 });
    const meta2 = new FakePublish();
    await step(meta2, late);
    expect((await post(late)).status).toBe("failed");
    expect(meta2.calls).toEqual([]);
  });

  it("validates posts like Meta does (JPEG, counts, sizes, time)", () => {
    const at = Date.now() + 10 * MIN;
    const jpg = { role: "item" as const, mime: "image/jpeg", size: 1000 };
    const mp4 = { role: "item" as const, mime: "video/mp4", size: 1000 };
    expect(validatePost({ kind: "IMAGE", caption: "x", publish_at: at }, [jpg])).toBeNull();
    expect(validatePost({ kind: "IMAGE", caption: "x", publish_at: at }, [{ ...jpg, mime: "image/png" }])).toContain("غير مدعوم");
    expect(validatePost({ kind: "CAROUSEL", caption: "x", publish_at: at }, [jpg])).toContain("من 2");
    expect(validatePost({ kind: "REELS", caption: "x", publish_at: at }, [jpg])).toContain("فيديو");
    expect(validatePost({ kind: "STORY", caption: null, publish_at: at }, [mp4])).toBeNull();
    expect(validatePost({ kind: "IMAGE", caption: "x", publish_at: Date.now() }, [jpg])).toContain("دقيقتين");
    expect(validatePost({ kind: "IMAGE", caption: "#a ".repeat(31), publish_at: at }, [jpg])).toContain("الهاشتاقات");
  });

  it("serves files to Meta only through valid, unexpired signed links", async () => {
    await MEDIA.put("t1-p9-abcdefgh.jpg", "jpegdata", { httpMetadata: { contentType: "image/jpeg" } });
    const good = await signedMediaUrl(TEST_ENV, "t1-p9-abcdefgh.jpg");
    const path = good.slice(good.indexOf("/m/"));
    const r = await SELF.fetch(new Request(BASE + path));
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toBe("image/jpeg");
    expect((await SELF.fetch(new Request(BASE + path.replace(/s=[0-9a-f]+/, "s=" + "0".repeat(40))))).status).toBe(404);
    const expired = await signedMediaUrl(TEST_ENV, "t1-p9-abcdefgh.jpg", Date.now() - 49 * 3_600_000);
    const r2 = await SELF.fetch(new Request(BASE + expired.slice(expired.indexOf("/m/"))));
    expect(r2.status).toBe(404);
  });

  it("isolates customers: another tenant cannot read, edit or cancel a post", async () => {
    const id = await seedPost("IMAGE", { status: "draft" });
    // setup owner + customer B through the API
    const call = async (p: string, h: Record<string, string> = {}, method = "GET", body?: unknown) => {
      const r = await SELF.fetch(new Request(BASE + p, { method, headers: { "Content-Type": "application/json", ...h }, body: body === undefined ? undefined : JSON.stringify(body) }));
      return { status: r.status, body: (await r.json().catch(() => null)) as any };
    };
    const login = async (u: string, pw: string) => ({ Authorization: `Bearer ${(await call("/api/auth/login", {}, "POST", { username: u, password: pw, client: "app" })).body.token}` });
    await call("/api/auth/setup", {}, "POST", { setup_token: "test_setup_token_123456", username: "admin", password: "a-very-strong-password" });
    const OWNER = await login("admin", "a-very-strong-password");
    const t = await call("/api/owner/tenants", OWNER, "POST", { name: "متجر ب", username: "shop_b", password: "another-strong-password" });
    await call(`/api/owner/tenants/${t.body.id}/plan`, OWNER, "POST", { plan_id: "max", days: 30 });
    await DB.prepare("UPDATE plans SET limits = json_set(limits, '$.scheduling', json('true')) WHERE id = 'max'").run();
    const B = await login("shop_b", "another-strong-password");
    expect((await call(`/api/schedule/${id}`, OWNER)).status).toBe(200);
    expect((await call(`/api/schedule/${id}`, B)).status).toBe(404);
    expect((await call(`/api/schedule/${id}`, B, "PATCH", { caption: "hacked" })).status).toBe(404);
    expect((await call(`/api/schedule/${id}/cancel`, B, "POST", {})).status).toBe(404);
    expect((await call(`/api/schedule/${id}`, B, "DELETE")).status).toBe(404);
    expect((await call("/api/schedule", B)).body.items).toEqual([]);
    const mid = (await DB.prepare("SELECT id FROM scheduled_media WHERE post_id = ?").bind(id).first<any>()).id;
    expect((await SELF.fetch(new Request(`${BASE}/api/schedule/media/${mid}`, { headers: B }))).status).toBe(404);
    expect((await post(id)).caption).toBe("عرض");
    void IG_ID;
  });
});
