import { all, first } from "../lib/db";
import { analyticsHeatmap, type AnalyticsFilter } from "./analytics";
import { normalizeUrl, NOT_COUNTED, storeAnalytics, summarize, type OrderRow, type Product } from "./store";

/**
 * Growth views built only from data this system already keeps (no new permissions):
 *  - posts ranked by sales: order (discount code) → campaign → post. Exact only when the campaign runs on one post;
 *    a campaign on several posts is shown as a group, never split by guess;
 *  - best time to post: when this customer's audience comments, and how their past posts did by posting hour;
 *  - the weekly report: the last 7 days against the 7 before.
 * Every query is scoped to the customer.
 */

const DAY = 86_400_000;
const ACC = "(SELECT id FROM instagram_accounts WHERE tenant_id = ?)";
const IG = "(SELECT ig_user_id FROM instagram_accounts WHERE tenant_id = ?)";

const isCounted = (o: { status: string | null }) => !NOT_COUNTED.includes((o.status ?? "").toLowerCase());

// ---- posts by sales ----------------------------------------------------------------------------------------------

export async function postSales(db: D1Database, t: number, f: { from: number; to: number }, opts: { storeOnly?: boolean } = {}) {
  const store = await first<{ id: number; default_cost_pct: number | null }>(
    db,
    "SELECT id, default_cost_pct FROM stores WHERE tenant_id = ? AND platform = 'salla' AND status != 'disconnected' ORDER BY id DESC LIMIT 1",
    t,
  );
  // Campaigns with a code and the posts they run on.
  const camps = await all<{ id: number; name: string; store_coupon: string | null; final_url: string | null }>(
    db,
    "SELECT id, name, store_coupon, final_url FROM campaigns WHERE tenant_id = ? AND deleted_at IS NULL",
    t,
  );
  const links = await all<{ campaign_id: number; media_id: string }>(
    db,
    "SELECT cm.campaign_id, cm.media_id FROM campaign_media cm JOIN campaigns c ON c.id = cm.campaign_id WHERE c.tenant_id = ? AND c.deleted_at IS NULL",
    t,
  );
  const postsOf = new Map<number, string[]>();
  for (const l of links) postsOf.set(l.campaign_id, [...(postsOf.get(l.campaign_id) ?? []), l.media_id]);

  // People, comments and clicks per post (precise: every flow knows the post it came from).
  const activity = await all<{ media_id: string; people: number; clickers: number; clicks: number }>(
    db,
    `SELECT f.source_media_id AS media_id, COUNT(DISTINCT f.participant_id) AS people,
            COUNT(DISTINCT CASE WHEN f.link_clicks > 0 THEN f.participant_id END) AS clickers, SUM(f.link_clicks) AS clicks
       FROM conversation_flows f WHERE f.account_id IN ${ACC} AND f.is_demo = 0 AND f.source_media_id IS NOT NULL AND f.created_at >= ? AND f.created_at < ?
      GROUP BY f.source_media_id`,
    t,
    f.from,
    f.to,
  );

  let orders: OrderRow[] = [];
  let productById = new Map<string, Product>();
  if (store) {
    orders = (
      await all<OrderRow>(
        db,
        `SELECT order_id, status, total, currency, coupon, items, ordered_at, discount, shipping, tax, payment_method, customer_hash, city FROM store_orders
          WHERE store_id = ? AND deleted = 0 AND coupon IS NOT NULL AND ordered_at >= ? AND ordered_at < ? LIMIT 20000`,
        store.id,
        f.from,
        f.to,
      )
    ).filter(isCounted);
    const products = await all<Product>(db, "SELECT product_id, name, url, image_url, price, status, cost, cost_manual FROM store_products WHERE store_id = ?", store.id);
    productById = new Map(products.map((p) => [p.product_id, p]));
  }

  type Row = { media_id: string; orders: number; revenue: number; profit: number | null; campaigns: Array<{ id: number; name: string }> };
  const perPost = new Map<string, Row>();
  const groups: Array<{ campaign: { id: number; name: string }; posts: number; orders: number; revenue: number }> = [];
  for (const c of camps) {
    const code = c.store_coupon?.trim().toUpperCase();
    if (!code) continue;
    const mine = orders.filter((o) => o.coupon === code);
    const posts = postsOf.get(c.id) ?? [];
    const money = summarize(mine, productById, store?.default_cost_pct ?? null);
    if (posts.length === 1) {
      const r = perPost.get(posts[0]) ?? { media_id: posts[0], orders: 0, revenue: 0, profit: null, campaigns: [] };
      r.orders += money.orders;
      r.revenue += money.revenue;
      if (money.profit !== null) r.profit = (r.profit ?? 0) + money.profit;
      r.campaigns.push({ id: c.id, name: c.name });
      perPost.set(posts[0], r);
    } else if (mine.length) {
      groups.push({ campaign: { id: c.id, name: c.name }, posts: posts.length, orders: money.orders, revenue: money.revenue });
    }
  }
  // Store-linked posts: run a campaign that has a discount code or links to one of the store's products.
  const productUrls = new Set([...productById.values()].map((p) => normalizeUrl(p.url)).filter(Boolean));
  const linkedPosts = new Map<string, Array<{ id: number; name: string }>>();
  for (const c of camps) {
    if (!c.store_coupon?.trim() && !(c.final_url && productUrls.has(normalizeUrl(c.final_url)))) continue;
    for (const m of postsOf.get(c.id) ?? []) linkedPosts.set(m, [...(linkedPosts.get(m) ?? []), { id: c.id, name: c.name }]);
  }
  const ids = opts.storeOnly
    ? [...linkedPosts.keys()]
    : [...new Set([...perPost.keys(), ...activity.map((a) => a.media_id)])];
  if (!ids.length) return { store: !!store, posts: [], groups };
  const q = ids.map(() => "?").join(",");
  const media = await all<{ media_id: string; caption: string | null; thumbnail_url: string | null; permalink: string | null; media_type: string | null; media_product_type: string | null; posted_at: number | null }>(
    db,
    `SELECT media_id, caption, thumbnail_url, permalink, media_type, media_product_type, posted_at FROM media_cache WHERE account_id IN ${ACC} AND media_id IN (${q})`,
    t,
    ...ids,
  );
  const ins = await all<{ media_id: string; views: number | null; reach: number | null }>(
    db,
    `SELECT mi.media_id, mi.views, mi.reach FROM media_insights mi
      WHERE mi.account_id IN ${ACC} AND mi.status = 'ok' AND mi.media_id IN (${q})
        AND mi.captured_at = (SELECT MAX(x.captured_at) FROM media_insights x WHERE x.account_id = mi.account_id AND x.media_id = mi.media_id AND x.status = 'ok')`,
    t,
    ...ids,
  );
  const posts = ids
    .map((id) => {
      const m = media.find((x) => x.media_id === id);
      const a = activity.find((x) => x.media_id === id);
      const s = perPost.get(id);
      const i = ins.find((x) => x.media_id === id);
      return {
        media_id: id,
        caption: m?.caption?.slice(0, 140) ?? null,
        thumbnail_url: m?.thumbnail_url ?? null,
        permalink: m?.permalink ?? null,
        kind: m?.media_product_type === "REELS" ? "reel" : m?.media_type === "CAROUSEL_ALBUM" ? "carousel" : m?.media_type === "VIDEO" ? "video" : "image",
        posted_at: m?.posted_at ?? null,
        views: i?.views ?? null,
        reach: i?.reach ?? null,
        people: a?.people ?? 0,
        clickers: a?.clickers ?? 0,
        clicks: a?.clicks ?? 0,
        orders: s ? s.orders : null,
        revenue: s ? s.revenue : null,
        profit: s?.profit ?? null,
        campaigns: s?.campaigns ?? linkedPosts.get(id) ?? [],
      };
    })
    .sort((a, b) => (b.revenue ?? -1) - (a.revenue ?? -1) || b.clickers - a.clickers || b.people - a.people)
    .slice(0, 50);
  return { store: !!store, posts, groups };
}

// ---- best time to post -------------------------------------------------------------------------------------------

/**
 * Best posting slots for this customer:
 *  - "posts": from their own posts' Instagram insights (interactions per post by posting weekday/hour), when there
 *    are enough posts with insights;
 *  - else "audience": the hours their audience comments most (from the comments this system received).
 * Nothing is suggested without enough data.
 */
export async function bestTimes(db: D1Database, t: number, tzOffsetMin: number, now = Date.now()) {
  const off = tzOffsetMin * 60_000;
  const heat = await analyticsHeatmap(db, t, { from: now - 60 * DAY, to: now, tzOffsetMin } as AnalyticsFilter, "comments");
  const posts = await all<{ posted_at: number; inter: number | null; reach: number | null }>(
    db,
    `SELECT mc.posted_at, mi.total_interactions AS inter, mi.reach FROM media_cache mc
       JOIN media_insights mi ON mi.account_id = mc.account_id AND mi.media_id = mc.media_id AND mi.status = 'ok'
        AND mi.captured_at = (SELECT MAX(x.captured_at) FROM media_insights x WHERE x.account_id = mi.account_id AND x.media_id = mi.media_id AND x.status = 'ok')
      WHERE mc.account_id IN ${ACC} AND mc.kind = 'media' AND mc.posted_at >= ? AND mc.posted_at < ?`,
    t,
    now - 120 * DAY,
    now - 2 * DAY, // a post needs a couple of days before its numbers mean something
  );
  const slot = (ms: number) => {
    const local = ms + off;
    return { wd: Math.floor(local / DAY + 4) % 7, h: Math.floor((local % DAY) / 3_600_000) };
  };
  // Posts grouped by weekday and a 3-hour block (single hours are too thin for most accounts).
  const blocks = new Map<string, { wd: number; h: number; n: number; sum: number }>();
  const scored = posts.filter((p) => (p.inter ?? null) !== null);
  for (const p of scored) {
    const s = slot(p.posted_at);
    const h = Math.floor(s.h / 3) * 3;
    const k = `${s.wd}:${h}`;
    const b = blocks.get(k) ?? { wd: s.wd, h, n: 0, sum: 0 };
    b.n++;
    b.sum += p.inter ?? 0;
    blocks.set(k, b);
  }
  const avgAll = scored.length ? scored.reduce((a, p) => a + (p.inter ?? 0), 0) / scored.length : 0;
  let source: "posts" | "audience" | "none" = "none";
  let slots: Array<{ wd: number; h: number; score: number; note: string }> = [];
  const ranked = [...blocks.values()].filter((b) => b.n >= 2).map((b) => ({ ...b, avg: b.sum / b.n })).sort((a, b) => b.avg - a.avg);
  if (scored.length >= 8 && ranked.length >= 2) {
    source = "posts";
    slots = ranked.slice(0, 3).map((b) => ({
      wd: b.wd,
      h: b.h + 1, // the middle of the 3-hour block
      score: avgAll ? b.avg / avgAll : 1,
      note: `${b.n} منشورات بهذا الوقت · تفاعل ${avgAll ? Math.round((b.avg / avgAll) * 100) : 100}% من متوسطك`,
    }));
  } else if (heat.total >= 30) {
    source = "audience";
    // Busiest weekday+hour cells, at most one per day, posting an hour before the peak.
    const cells: Array<{ wd: number; h: number; n: number }> = [];
    heat.grid.forEach((row: number[], wd: number) => row.forEach((n: number, h: number) => n > 0 && cells.push({ wd, h, n })));
    const used = new Set<number>();
    for (const c of cells.sort((a, b) => b.n - a.n)) {
      if (used.has(c.wd)) continue;
      used.add(c.wd);
      slots.push({ wd: c.wd, h: (c.h + 23) % 24, score: c.n / heat.total, note: `جمهورك يعلّق أكثر الساعة ${c.h}:00 — انشر قبلها بساعة` });
      if (slots.length === 3) break;
    }
  }
  return { source, slots, posts_with_insights: scored.length, comments: heat.total, grid: heat.grid };
}

// ---- weekly report -----------------------------------------------------------------------------------------------

export async function weeklyReport(db: D1Database, t: number, tzOffsetMin: number, now = Date.now()) {
  const from = now - 7 * DAY;
  const prevFrom = from - 7 * DAY;
  const flows = async (a: number, b: number) =>
    first<{ people: number; delivered: number; clicked: number }>(
      db,
      `SELECT COUNT(DISTINCT participant_id) AS people,
              COUNT(DISTINCT CASE WHEN state = 'content_sent' THEN participant_id END) AS delivered,
              COUNT(DISTINCT CASE WHEN link_clicks > 0 THEN participant_id END) AS clicked
         FROM conversation_flows WHERE account_id IN ${ACC} AND is_demo = 0 AND created_at >= ? AND created_at < ?`,
      t,
      a,
      b,
    );
  const comments = async (a: number, b: number) =>
    (await first<{ n: number }>(db, `SELECT COUNT(*) AS n FROM webhook_events WHERE account_ig_id IN ${IG} AND is_demo = 0 AND event_type = 'comment' AND received_at >= ? AND received_at < ?`, t, a, b))?.n ?? 0;
  const [now_, prev, cNow, cPrev] = await Promise.all([flows(from, now), flows(prevFrom, from), comments(from, now), comments(prevFrom, from)]);
  const topCampaign = await first<{ id: number; name: string; people: number; delivered: number }>(
    db,
    `SELECT c.id, c.name, COUNT(DISTINCT f.participant_id) AS people, COUNT(DISTINCT CASE WHEN f.state = 'content_sent' THEN f.participant_id END) AS delivered
       FROM conversation_flows f JOIN campaigns c ON c.id = f.campaign_id
      WHERE c.tenant_id = ? AND f.is_demo = 0 AND f.created_at >= ? GROUP BY c.id ORDER BY people DESC LIMIT 1`,
    t,
    from,
  );
  const sales = await postSales(db, t, { from, to: now });
  const topPost = sales.posts[0] ?? null;
  const store = await storeAnalytics(db, t, { from, to: now, tzOffsetMin });
  const s: any = store.store ? store : null;
  const bestSeller = s?.campaigns?.filter((c: any) => (c.orders ?? 0) > 0).sort((a: any, b: any) => (b.revenue ?? 0) - (a.revenue ?? 0))[0] ?? null;
  return {
    from,
    to: now,
    activity: {
      comments: { now: cNow, prev: cPrev },
      people: { now: now_?.people ?? 0, prev: prev?.people ?? 0 },
      delivered: { now: now_?.delivered ?? 0, prev: prev?.delivered ?? 0 },
      clicked: { now: now_?.clicked ?? 0, prev: prev?.clicked ?? 0 },
    },
    top_campaign: topCampaign ?? null,
    top_post: topPost,
    store: s
      ? {
          currency: s.totals.currency,
          orders: { now: s.totals.orders, prev: s.previous.orders },
          revenue: { now: s.totals.revenue, prev: s.previous.revenue },
          profit: { now: s.totals.profit, prev: s.previous.profit },
          from_campaigns: s.totals.attributed_revenue,
          best_campaign: bestSeller ? { id: bestSeller.id, name: bestSeller.name, orders: bestSeller.orders, revenue: bestSeller.revenue } : null,
        }
      : null,
  };
}

const change = (a: number, b: number) => (b === 0 ? (a > 0 ? " (جديد)" : "") : ` (${a >= b ? "▲" : "▼"} ${Math.abs(Math.round(((a - b) / b) * 100))}%)`);
const num = (n: number) => Math.round(n).toLocaleString("en-US");

/** The weekly report as a Telegram message. */
export function weeklyText(r: Awaited<ReturnType<typeof weeklyReport>>, link?: string): string {
  const a = r.activity;
  const lines = [
    "🗓️ تقريرك الأسبوعي — شيّك",
    "آخر 7 أيام مقارنة بالأسبوع اللي قبله",
    "",
    `💬 تعليقات: ${num(a.comments.now)}${change(a.comments.now, a.comments.prev)}`,
    `👥 تفاعلوا مع حملاتك: ${num(a.people.now)}${change(a.people.now, a.people.prev)}`,
    `✅ وصلهم المحتوى: ${num(a.delivered.now)}${change(a.delivered.now, a.delivered.prev)}`,
    `🔗 ضغطوا الرابط: ${num(a.clicked.now)}${change(a.clicked.now, a.clicked.prev)}`,
  ];
  if (r.store) {
    const cur = r.store.currency === "SAR" ? "ر.س" : r.store.currency;
    lines.push("", "🛍️ المتجر:", `• الطلبات: ${num(r.store.orders.now)}${change(r.store.orders.now, r.store.orders.prev)}`, `• المبيعات: ${num(r.store.revenue.now)} ${cur}${change(r.store.revenue.now, r.store.revenue.prev)}`);
    if (r.store.profit.now !== null) lines.push(`• الربح التقديري: ${num(r.store.profit.now)} ${cur}`);
    lines.push(`• من حملاتك (بالكود): ${num(r.store.from_campaigns)} ${cur}`);
    if (r.store.best_campaign) lines.push(`🏆 أكثر حملة بيعًا: ${r.store.best_campaign.name} — ${r.store.best_campaign.orders} طلب`);
  }
  if (r.top_campaign) lines.push("", `⭐ أنشط حملة: ${r.top_campaign.name} — ${r.top_campaign.people} شخص`);
  if (r.top_post) {
    const p = r.top_post;
    lines.push(`📌 أفضل منشور: ${(p.caption ?? "بدون وصف").replace(/\s+/g, " ").slice(0, 60)}${p.orders ? ` — ${p.orders} طلب` : ` — ${p.people} تفاعل`}`);
  }
  if (link) lines.push("", `التقرير الكامل: ${link}`);
  return lines.join("\n");
}
