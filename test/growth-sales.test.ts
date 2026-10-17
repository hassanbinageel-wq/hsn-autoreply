import { beforeEach, describe, expect, it } from "vitest";
import { DB, IG_ID, resetDb, seedAccount, TEST_ENV } from "./helpers";
import { completeSallaOAuth, handleSallaWebhook } from "../src/worker/services/salla";
import { bestTimes, postSales, weeklyReport, weeklyText } from "../src/worker/services/growth";

const DAY = 86_400_000;

function fakeSalla() {
  return (async (u: string) => {
    if (String(u).endsWith("/oauth2/token")) return new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 1209600 }));
    if (String(u).endsWith("/oauth2/user/info")) return new Response(JSON.stringify({ data: { merchant: { id: 9001, name: "متجر" } } }));
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
}
const order = (id: string, coupon: string | null, total: number) => ({
  event: "order.created",
  merchant: 9001,
  data: { id, status: { slug: "completed" }, amounts: { total: { amount: total, currency: "SAR" } }, coupon: coupon ? { code: coupon } : null, date: { date: new Date(Date.now() - DAY).toISOString() }, items: [] },
});

async function campaign(name: string, coupon: string | null, media: string[]) {
  const now = Date.now();
  const c = await DB.prepare("INSERT INTO campaigns (tenant_id, name, type, status, final_text, store_coupon, created_at, updated_at) VALUES (1, ?, 'comment', 'active', 'x', ?, ?, ?) RETURNING id").bind(name, coupon, now, now).first<any>();
  for (const m of media) await DB.prepare("INSERT INTO campaign_media (campaign_id, media_id) VALUES (?, ?)").bind(c.id, m).run();
  return c.id as number;
}

beforeEach(async () => {
  await resetDb();
  await seedAccount();
});

describe("growth: posts by sales, best time to post, weekly report", () => {
  it("credits orders to a post only when its campaign runs on that one post; several posts stay a group; per customer", async () => {
    await completeSallaOAuth(TEST_ENV, "c", 1, fakeSalla());
    const acc = await DB.prepare("SELECT id FROM instagram_accounts").first<any>();
    const now = Date.now();
    for (const m of ["reel1", "img2", "img3"]) {
      await DB.prepare("INSERT INTO media_cache (account_id, media_id, kind, media_type, media_product_type, caption, posted_at, fetched_at) VALUES (?, ?, 'media', 'VIDEO', 'REELS', ?, ?, ?)").bind(acc.id, m, `منشور ${m}`, now - 3 * DAY, now).run();
    }
    await campaign("ريل الجاكيت", "REEL18", ["reel1"]);
    await campaign("صور العبايات", "ABAYA", ["img2", "img3"]);
    await handleSallaWebhook(TEST_ENV, order("o1", "reel18", 100));
    await handleSallaWebhook(TEST_ENV, order("o2", "REEL18", 50));
    await handleSallaWebhook(TEST_ENV, order("o3", "ABAYA", 300));
    await handleSallaWebhook(TEST_ENV, order("o4", null, 999));
    const r = await postSales(DB, 1, { from: now - 7 * DAY, to: now + 60_000 });
    expect(r.posts[0]).toMatchObject({ media_id: "reel1", orders: 2, revenue: 150, kind: "reel", caption: "منشور reel1" });
    expect(r.posts.find((p) => p.media_id === "img2")).toBeUndefined(); // no single-post campaign, no activity
    expect(r.groups).toEqual([{ campaign: expect.objectContaining({ name: "صور العبايات" }), posts: 2, orders: 1, revenue: 300 }]);
    expect(await postSales(DB, 999, { from: now - 7 * DAY, to: now + 60_000 })).toMatchObject({ store: false, posts: [], groups: [] });
  });

  it("suggests nothing without enough data, then the audience's busiest hours (an hour before the peak)", async () => {
    const now = Date.UTC(2026, 9, 15, 12); // a Thursday
    expect((await bestTimes(DB, 1, 180, now)).source).toBe("none");
    // 30 comments on Thursdays at 21:00 Riyadh time (18:00 UTC)
    const thu = Date.UTC(2026, 9, 8, 18, 10);
    for (let i = 0; i < 30; i++) {
      await DB.prepare("INSERT INTO webhook_events (dedup_key, account_ig_id, event_type, payload, event_time, received_at, status) VALUES (?, ?, 'comment', '{}', ?, ?, 'processed')").bind(`k${i}`, IG_ID, thu + i * 1000, thu + i * 1000).run();
    }
    const b = await bestTimes(DB, 1, 180, now);
    expect(b.source).toBe("audience");
    expect(b.slots[0]).toMatchObject({ wd: 4, h: 20 });
    expect((await bestTimes(DB, 999, 180, now)).source).toBe("none");
  });

  it("builds the weekly report against the previous week and a Telegram text", async () => {
    await completeSallaOAuth(TEST_ENV, "c", 1, fakeSalla());
    await handleSallaWebhook(TEST_ENV, order("o1", null, 200));
    const r = await weeklyReport(DB, 1, 180);
    expect(r.store).toMatchObject({ orders: { now: 1, prev: 0 }, revenue: { now: 200, prev: 0 } });
    const text = weeklyText(r, "https://hsnreply.online/#/report");
    expect(text).toContain("تقريرك الأسبوعي");
    expect(text).toContain("المبيعات: 200 ر.س (جديد)");
    expect(text).toContain("https://hsnreply.online/#/report");
    expect((await weeklyReport(DB, 999, 180)).store).toBeNull();
  });
});
