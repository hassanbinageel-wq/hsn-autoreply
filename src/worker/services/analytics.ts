import { all, first } from "../lib/db";

/**
 * Analytics from what this system itself recorded (webhook events, automation flows, message jobs, link clicks,
 * follow checks). Instagram's own metrics (views, reach, likes, saves…) need the insights permission and are not
 * part of this module.
 *
 * Rules kept throughout:
 *  - events and people are counted separately: COUNT(*) is "events", COUNT(DISTINCT person) is "people";
 *  - a person's follow status is only "following"/"not following" from a successful check — failures, missing
 *    consent or no check at all are "unknown", never "not following";
 *  - every query is scoped to the customer's own accounts / campaigns (tenant isolation).
 */

export type EventType = "comment" | "story_reply" | "story_mention";
export interface AnalyticsFilter {
  from: number;
  to: number;
  campaignId?: number;
  mediaId?: string;
  type?: EventType;
  /** Minutes east of UTC for day buckets and the heatmap (the customer's time zone). */
  tzOffsetMin: number;
}

const IG = "(SELECT ig_user_id FROM instagram_accounts WHERE tenant_id = ?)";
const ACC = "(SELECT id FROM instagram_accounts WHERE tenant_id = ?)";
const TYPES: EventType[] = ["comment", "story_reply", "story_mention"];

/** Rough OS family of a link visitor from the browser's User-Agent (approximate by nature). */
export function osFamily(ua: string | null | undefined): "android" | "ios" | "other" | "unknown" {
  if (!ua) return "unknown";
  if (/android/i.test(ua)) return "android";
  if (/iphone|ipad|ipod|ios|cfnetwork/i.test(ua)) return "ios";
  if (/windows|macintosh|mac os x|linux|cros/i.test(ua)) return "other";
  return "unknown";
}

/** Offset (minutes east of UTC) of an IANA zone right now. */
export function tzOffsetMinutes(tz: string, at = Date.now()): number {
  try {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
        .formatToParts(new Date(at))
        .map((x) => [x.type, x.value]),
    );
    return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(at / 60_000) * 60_000) / 60_000);
  } catch {
    return 0;
  }
}

// ---- shared WHERE fragments -------------------------------------------------------------------------------------

function eventsWhere(t: number, f: AnalyticsFilter) {
  const types = f.type ? [f.type] : TYPES;
  const sql = [
    `e.account_ig_id IN ${IG}`,
    "e.is_demo = 0",
    `e.event_type IN (${types.map(() => "?").join(",")})`,
    "e.event_time >= ? AND e.event_time < ?",
    // the account's own comments (its replies under people's comments) are not audience activity
    "COALESCE(e.reason, '') <> 'own_account'",
  ];
  const args: unknown[] = [t, ...types, f.from, f.to];
  if (f.campaignId) {
    sql.push("e.campaign_id = ?");
    args.push(f.campaignId);
  }
  if (f.mediaId) {
    sql.push("e.media_id = ?");
    args.push(f.mediaId);
  }
  return { sql: sql.join(" AND "), args };
}

/** Flows of the customer's campaigns; `timeCol` is the flow column the period applies to. */
function flowsWhere(t: number, f: AnalyticsFilter, timeCol = "f.created_at") {
  const sql = ["c.tenant_id = ?", "f.is_demo = 0", `${timeCol} >= ? AND ${timeCol} < ?`];
  const args: unknown[] = [t, f.from, f.to];
  if (f.campaignId) {
    sql.push("c.id = ?");
    args.push(f.campaignId);
  }
  if (f.mediaId) {
    sql.push("f.source_media_id = ?");
    args.push(f.mediaId);
  }
  if (f.type) {
    sql.push("c.type = ?");
    args.push(f.type);
  }
  return { sql: sql.join(" AND "), args };
}

const day = (col: string, off: number) => `CAST((${col} + ${off * 60_000}) / 86400000 AS INTEGER)`;

// ---- overview ---------------------------------------------------------------------------------------------------

export async function analyticsOverview(db: D1Database, t: number, f: AnalyticsFilter) {
  const ew = eventsWhere(t, f);
  const fw = flowsWhere(t, f);
  const dw = flowsWhere(t, f, "f.content_delivered_at");
  const jw = flowsWhere(t, f, "j.created_at");
  const kw = flowsWhere(t, f, "k.clicked_at");
  const off = f.tzOffsetMin;
  const [ev, fl, dl, jobs, pub, clicks, sEv, sDl, sCl] = await Promise.all([
    first<{ events: number; people: number }>(db, `SELECT COUNT(*) AS events, COUNT(DISTINCT e.sender_id) AS people FROM webhook_events e WHERE ${ew.sql}`, ...ew.args),
    first<{ flows: number; people: number }>(
      db,
      `SELECT COUNT(*) AS flows, COUNT(DISTINCT f.participant_id) AS people FROM conversation_flows f JOIN campaigns c ON c.id = f.campaign_id WHERE ${fw.sql}`,
      ...fw.args,
    ),
    first<{ people: number }>(
      db,
      `SELECT COUNT(DISTINCT f.participant_id) AS people FROM conversation_flows f JOIN campaigns c ON c.id = f.campaign_id WHERE ${dw.sql} AND f.state = 'content_sent'`,
      ...dw.args,
    ),
    all<{ status: string; n: number }>(
      db,
      `SELECT j.status, COUNT(*) AS n FROM action_jobs j JOIN conversation_flows f ON f.id = j.flow_id JOIN campaigns c ON c.id = f.campaign_id
        WHERE ${jw.sql} AND j.kind = 'send_message' GROUP BY j.status`,
      ...jw.args,
    ),
    first<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM action_jobs j JOIN conversation_flows f ON f.id = j.flow_id JOIN campaigns c ON c.id = f.campaign_id
        WHERE ${jw.sql} AND j.kind = 'public_reply' AND j.status = 'accepted'`,
      ...jw.args,
    ),
    first<{ clicks: number; people: number }>(
      db,
      `SELECT COUNT(*) AS clicks, COUNT(DISTINCT f.participant_id) AS people FROM link_clicks k JOIN conversation_flows f ON f.id = k.flow_id JOIN campaigns c ON c.id = f.campaign_id
        WHERE ${kw.sql}`,
      ...kw.args,
    ),
    all<{ d: number; events: number; people: number }>(
      db,
      `SELECT ${day("e.event_time", off)} AS d, COUNT(*) AS events, COUNT(DISTINCT e.sender_id) AS people FROM webhook_events e WHERE ${ew.sql} GROUP BY d`,
      ...ew.args,
    ),
    all<{ d: number; people: number }>(
      db,
      `SELECT ${day("f.content_delivered_at", off)} AS d, COUNT(DISTINCT f.participant_id) AS people FROM conversation_flows f JOIN campaigns c ON c.id = f.campaign_id
        WHERE ${dw.sql} AND f.state = 'content_sent' GROUP BY d`,
      ...dw.args,
    ),
    all<{ d: number; clicks: number }>(
      db,
      `SELECT ${day("k.clicked_at", off)} AS d, COUNT(*) AS clicks FROM link_clicks k JOIN conversation_flows f ON f.id = k.flow_id JOIN campaigns c ON c.id = f.campaign_id
        WHERE ${kw.sql} GROUP BY d`,
      ...kw.args,
    ),
  ]);
  const by = (s: string) => jobs.find((j) => j.status === s)?.n ?? 0;
  const messages = {
    accepted: by("accepted"),
    failed: by("failed"),
    uncertain: by("uncertain"),
    pending: by("pending") + by("retry_scheduled") + by("processing"),
    cancelled: by("cancelled"),
  };
  // Daily series over the whole period (days with nothing are zeros, not gaps).
  const d0 = Math.floor((f.from + off * 60_000) / 86_400_000);
  const d1 = Math.floor((f.to - 1 + off * 60_000) / 86_400_000);
  const series = [];
  for (let d = d0; d <= d1 && series.length < 400; d++) {
    const e = sEv.find((r) => r.d === d);
    series.push({ day: d, events: e?.events ?? 0, people: e?.people ?? 0, delivered: sDl.find((r) => r.d === d)?.people ?? 0, clicks: sCl.find((r) => r.d === d)?.clicks ?? 0 });
  }
  return {
    events: { total: ev?.events ?? 0, people: ev?.people ?? 0 },
    flows: { total: fl?.flows ?? 0, people: fl?.people ?? 0 },
    delivered_people: dl?.people ?? 0,
    messages: { ...messages, attempted: messages.accepted + messages.failed + messages.uncertain },
    public_replies: pub?.n ?? 0,
    clicks: { total: clicks?.clicks ?? 0, people: clicks?.people ?? 0 },
    series,
  };
}

// ---- per campaign / per post ------------------------------------------------------------------------------------

export async function analyticsByCampaign(db: D1Database, t: number, f: AnalyticsFilter) {
  const fw = flowsWhere(t, { ...f, campaignId: undefined });
  const ew = eventsWhere(t, { ...f, campaignId: undefined });
  const kw = flowsWhere(t, { ...f, campaignId: undefined }, "k.clicked_at");
  const jw = flowsWhere(t, { ...f, campaignId: undefined }, "j.created_at");
  const [flows, events, clicks, jobs, campaigns] = await Promise.all([
    all<{ id: number; people: number; delivered: number }>(
      db,
      `SELECT c.id, COUNT(DISTINCT f.participant_id) AS people, COUNT(DISTINCT CASE WHEN f.state = 'content_sent' THEN f.participant_id END) AS delivered
         FROM conversation_flows f JOIN campaigns c ON c.id = f.campaign_id WHERE ${fw.sql} GROUP BY c.id`,
      ...fw.args,
    ),
    all<{ id: number; events: number }>(db, `SELECT e.campaign_id AS id, COUNT(*) AS events FROM webhook_events e WHERE ${ew.sql} AND e.campaign_id IS NOT NULL GROUP BY e.campaign_id`, ...ew.args),
    all<{ id: number; clicks: number; people: number }>(
      db,
      `SELECT c.id, COUNT(*) AS clicks, COUNT(DISTINCT f.participant_id) AS people FROM link_clicks k JOIN conversation_flows f ON f.id = k.flow_id JOIN campaigns c ON c.id = f.campaign_id
        WHERE ${kw.sql} GROUP BY c.id`,
      ...kw.args,
    ),
    all<{ id: number; accepted: number; failed: number }>(
      db,
      `SELECT c.id, SUM(j.status = 'accepted') AS accepted, SUM(j.status = 'failed') AS failed FROM action_jobs j JOIN conversation_flows f ON f.id = j.flow_id JOIN campaigns c ON c.id = f.campaign_id
        WHERE ${jw.sql} AND j.kind = 'send_message' GROUP BY c.id`,
      ...jw.args,
    ),
    all<{ id: number; name: string; type: string; status: string }>(db, "SELECT id, name, type, status FROM campaigns WHERE tenant_id = ? AND deleted_at IS NULL", t),
  ]);
  return campaigns
    .filter((c) => !f.type || c.type === f.type)
    .map((c) => ({
      ...c,
      matched_events: events.find((r) => r.id === c.id)?.events ?? 0,
      people: flows.find((r) => r.id === c.id)?.people ?? 0,
      delivered: flows.find((r) => r.id === c.id)?.delivered ?? 0,
      messages_ok: jobs.find((r) => r.id === c.id)?.accepted ?? 0,
      messages_failed: jobs.find((r) => r.id === c.id)?.failed ?? 0,
      clicks: clicks.find((r) => r.id === c.id)?.clicks ?? 0,
      click_people: clicks.find((r) => r.id === c.id)?.people ?? 0,
    }))
    .filter((c) => c.people || c.matched_events || c.status === "active")
    .sort((a, b) => b.people - a.people || b.matched_events - a.matched_events);
}

export async function analyticsByPost(db: D1Database, t: number, f: AnalyticsFilter) {
  const ew = eventsWhere(t, { ...f, mediaId: undefined });
  const fw = flowsWhere(t, { ...f, mediaId: undefined });
  const kw = flowsWhere(t, { ...f, mediaId: undefined }, "k.clicked_at");
  const [events, flows, clicks] = await Promise.all([
    all<{ media_id: string; events: number; people: number }>(
      db,
      `SELECT e.media_id, COUNT(*) AS events, COUNT(DISTINCT e.sender_id) AS people FROM webhook_events e WHERE ${ew.sql} AND e.media_id IS NOT NULL GROUP BY e.media_id`,
      ...ew.args,
    ),
    all<{ media_id: string; people: number; delivered: number; campaigns: string }>(
      db,
      `SELECT f.source_media_id AS media_id, COUNT(DISTINCT f.participant_id) AS people,
              COUNT(DISTINCT CASE WHEN f.state = 'content_sent' THEN f.participant_id END) AS delivered,
              GROUP_CONCAT(DISTINCT c.id) AS campaigns
         FROM conversation_flows f JOIN campaigns c ON c.id = f.campaign_id WHERE ${fw.sql} AND f.source_media_id IS NOT NULL GROUP BY f.source_media_id`,
      ...fw.args,
    ),
    all<{ media_id: string; clicks: number }>(
      db,
      `SELECT f.source_media_id AS media_id, COUNT(*) AS clicks FROM link_clicks k JOIN conversation_flows f ON f.id = k.flow_id JOIN campaigns c ON c.id = f.campaign_id
        WHERE ${kw.sql} AND f.source_media_id IS NOT NULL GROUP BY f.source_media_id`,
      ...kw.args,
    ),
  ]);
  const ids = [...new Set([...events.map((r) => r.media_id), ...flows.map((r) => r.media_id)])].slice(0, 200);
  if (!ids.length) return [];
  const q = ids.map(() => "?").join(",");
  const [meta, links] = await Promise.all([
    all<{ media_id: string; caption: string | null; permalink: string | null; thumbnail_url: string | null; media_product_type: string | null; media_type: string | null; kind: string; posted_at: number | null }>(
      db,
      `SELECT media_id, caption, permalink, thumbnail_url, media_product_type, media_type, kind, posted_at FROM media_cache WHERE account_id IN ${ACC} AND media_id IN (${q})`,
      t,
      ...ids,
    ),
    // Campaigns linked to each post by its real Instagram id (selected posts), plus those that answered on it.
    all<{ media_id: string; id: number; name: string }>(
      db,
      `SELECT cm.media_id, c.id, c.name FROM campaign_media cm JOIN campaigns c ON c.id = cm.campaign_id WHERE c.tenant_id = ? AND c.deleted_at IS NULL AND cm.media_id IN (${q})`,
      t,
      ...ids,
    ),
  ]);
  const names = new Map((await all<{ id: number; name: string }>(db, "SELECT id, name FROM campaigns WHERE tenant_id = ?", t)).map((c) => [c.id, c.name]));
  return ids
    .map((id) => {
      const m = meta.find((x) => x.media_id === id);
      const fl = flows.find((x) => x.media_id === id);
      const camp = new Map<number, string>();
      for (const l of links.filter((x) => x.media_id === id)) camp.set(l.id, l.name);
      for (const cid of (fl?.campaigns ?? "").split(",").filter(Boolean)) camp.set(Number(cid), names.get(Number(cid)) ?? `#${cid}`);
      return {
        media_id: id,
        caption: m?.caption ?? null,
        permalink: m?.permalink ?? null,
        thumbnail_url: m?.thumbnail_url ?? null,
        content_type: m ? (m.kind === "story" ? "STORY" : m.media_product_type === "REELS" ? "REELS" : m.media_type === "CAROUSEL_ALBUM" ? "CAROUSEL" : "POST") : null,
        posted_at: m?.posted_at ?? null,
        campaigns: [...camp].map(([cid, name]) => ({ id: cid, name })),
        comments: events.find((x) => x.media_id === id)?.events ?? 0,
        commenters: events.find((x) => x.media_id === id)?.people ?? 0,
        people: fl?.people ?? 0,
        delivered: fl?.delivered ?? 0,
        clicks: clicks.find((x) => x.media_id === id)?.clicks ?? 0,
      };
    })
    .sort((a, b) => b.comments - a.comments || b.people - a.people);
}

// ---- heatmap & devices ------------------------------------------------------------------------------------------

export type HeatKind = "comments" | "messages" | "clicks";

/** 7 × 24 counts (row 0 = Sunday) of real recorded events, in the customer's time zone. */
export async function analyticsHeatmap(db: D1Database, t: number, f: AnalyticsFilter, kind: HeatKind) {
  const off = f.tzOffsetMin * 60_000;
  const cell = (col: string) => `CAST(((${col} + ${off}) / 86400000 + 4) % 7 AS INTEGER) AS wd, CAST(((${col} + ${off}) % 86400000) / 3600000 AS INTEGER) AS h`;
  let rows: Array<{ wd: number; h: number; n: number }>;
  if (kind === "comments") {
    const w = eventsWhere(t, f);
    rows = await all(db, `SELECT ${cell("e.event_time")}, COUNT(*) AS n FROM webhook_events e WHERE ${w.sql} GROUP BY wd, h`, ...w.args);
  } else if (kind === "messages") {
    const w = flowsWhere(t, f, "j.updated_at");
    rows = await all(
      db,
      `SELECT ${cell("j.updated_at")}, COUNT(*) AS n FROM action_jobs j JOIN conversation_flows f ON f.id = j.flow_id JOIN campaigns c ON c.id = f.campaign_id
        WHERE ${w.sql} AND j.kind = 'send_message' AND j.status = 'accepted' GROUP BY wd, h`,
      ...w.args,
    );
  } else {
    const w = flowsWhere(t, f, "k.clicked_at");
    rows = await all(
      db,
      `SELECT ${cell("k.clicked_at")}, COUNT(*) AS n FROM link_clicks k JOIN conversation_flows f ON f.id = k.flow_id JOIN campaigns c ON c.id = f.campaign_id WHERE ${w.sql} GROUP BY wd, h`,
      ...w.args,
    );
  }
  const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  let total = 0;
  for (const r of rows) {
    if (r.wd >= 0 && r.wd < 7 && r.h >= 0 && r.h < 24) {
      grid[r.wd][r.h] += r.n;
      total += r.n;
    }
  }
  // Suggestion only when there is enough to say something: the 3 busiest hours (weekdays combined).
  const byHour = Array.from({ length: 24 }, (_, h) => grid.reduce((a, row) => a + row[h], 0));
  const top = total >= 30 ? byHour.map((n, h) => ({ h, n })).sort((a, b) => b.n - a.n).slice(0, 3).filter((x) => x.n > 0) : [];
  return { kind, grid, total, top_hours: top };
}

export async function analyticsDevices(db: D1Database, t: number, f: AnalyticsFilter) {
  const w = flowsWhere(t, f, "k.clicked_at");
  const rows = await all<{ os: string; clicks: number; people: number }>(
    db,
    `SELECT k.os, COUNT(*) AS clicks, COUNT(DISTINCT f.participant_id) AS people FROM link_clicks k JOIN conversation_flows f ON f.id = k.flow_id JOIN campaigns c ON c.id = f.campaign_id
      WHERE ${w.sql} GROUP BY k.os`,
    ...w.args,
  );
  const out: Record<string, { clicks: number; people: number }> = {};
  for (const os of ["android", "ios", "other", "unknown"]) out[os] = { clicks: rows.find((r) => r.os === os)?.clicks ?? 0, people: rows.find((r) => r.os === os)?.people ?? 0 };
  return out;
}

// ---- follow status & retention ----------------------------------------------------------------------------------

/**
 * People who entered a flow in the period: their follow status at participation (first successful check in that
 * flow) and their latest successful check. No successful check = "unknown".
 */
export async function analyticsFollow(db: D1Database, t: number, f: AnalyticsFilter) {
  const w = flowsWhere(t, f);
  const rows = await all<{ participant_id: number; at_join: string | null; latest: string | null }>(
    db,
    `SELECT f.participant_id,
            (SELECT fc.result FROM follow_checks fc JOIN conversation_flows f2 ON f2.id = fc.flow_id
              WHERE f2.participant_id = f.participant_id AND f2.campaign_id = f.campaign_id AND fc.is_demo = 0 AND fc.result IN ('following','not_following')
              ORDER BY fc.checked_at LIMIT 1) AS at_join,
            (SELECT fc.result FROM follow_checks fc WHERE fc.participant_id = f.participant_id AND fc.is_demo = 0 AND fc.result IN ('following','not_following')
              ORDER BY fc.checked_at DESC LIMIT 1) AS latest
       FROM conversation_flows f JOIN campaigns c ON c.id = f.campaign_id WHERE ${w.sql} GROUP BY f.participant_id`,
    ...w.args,
  );
  const count = (k: "at_join" | "latest") => ({
    following: rows.filter((r) => r[k] === "following").length,
    not_following: rows.filter((r) => r[k] === "not_following").length,
    unknown: rows.filter((r) => !r[k]).length,
  });
  return { people: rows.length, at_participation: count("at_join"), latest: count("latest") };
}

/**
 * Retention: people who received the content while a successful check said "following", compared with their latest
 * successful check after delivery. Only a later successful "not_following" counts as "no longer following at the
 * last check"; no later successful check = not re-checked (unknown).
 */
export async function analyticsRetention(db: D1Database, t: number, f: AnalyticsFilter) {
  const w = flowsWhere(t, f, "f.content_delivered_at");
  const rows = await all<{
    participant_id: number;
    username: string | null;
    campaign: string;
    delivered_at: number;
    before: string | null;
    after: string | null;
    after_at: number | null;
  }>(
    db,
    `SELECT f.participant_id, p.username, c.name AS campaign, f.content_delivered_at AS delivered_at,
            (SELECT fc.result FROM follow_checks fc WHERE fc.participant_id = f.participant_id AND fc.is_demo = 0 AND fc.result IN ('following','not_following')
               AND fc.checked_at <= f.content_delivered_at + 60000 ORDER BY fc.checked_at DESC LIMIT 1) AS before,
            (SELECT fc.result FROM follow_checks fc WHERE fc.participant_id = f.participant_id AND fc.is_demo = 0 AND fc.result IN ('following','not_following')
               AND fc.checked_at > f.content_delivered_at + 60000 ORDER BY fc.checked_at DESC LIMIT 1) AS after,
            (SELECT MAX(fc.checked_at) FROM follow_checks fc WHERE fc.participant_id = f.participant_id AND fc.is_demo = 0 AND fc.result IN ('following','not_following')
               AND fc.checked_at > f.content_delivered_at + 60000) AS after_at
       FROM conversation_flows f JOIN campaigns c ON c.id = f.campaign_id JOIN participants p ON p.id = f.participant_id
      WHERE ${w.sql} AND f.state = 'content_sent'
      ORDER BY f.content_delivered_at DESC LIMIT 2000`,
    ...w.args,
  );
  // One row per person (their most recent delivery in the period).
  const seen = new Set<number>();
  const cohort = rows.filter((r) => r.before === "following" && !seen.has(r.participant_id) && seen.add(r.participant_id));
  const items = cohort.map((r) => ({
    username: r.username,
    campaign: r.campaign,
    delivered_at: r.delivered_at,
    status_at_delivery: "following" as const,
    last_status: (r.after as "following" | "not_following" | null) ?? "unknown",
    last_checked_at: r.after_at,
  }));
  const rechecked = items.filter((i) => i.last_status !== "unknown");
  return {
    cohort: items.length,
    rechecked: rechecked.length,
    still_following: rechecked.filter((i) => i.last_status === "following").length,
    no_longer_following: rechecked.filter((i) => i.last_status === "not_following").length,
    unknown: items.length - rechecked.length,
    items: items.slice(0, 500),
  };
}
