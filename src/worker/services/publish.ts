import type { Env } from "../env";
import type { AccountRow } from "../engine/context";
import { all, audit, first, getSetting, OWNER_TENANT, run } from "../lib/db";
import { hex, timingSafeEqual } from "../lib/crypto";
import { INSIGHTS_SCOPE, PUBLISH_SCOPE, type HttpMetaClient } from "../meta/client";
import type { MetaError, MetaResult } from "../meta/types";
import { getAccessToken, markNeedsReauth, metaClient } from "./account";
import { cacheMediaStmt } from "./media";
import { getEntitlement } from "./plans";
import { notify } from "./notify";
import { hasInsightsScope, wantsInsightsScope, type ScopeMode } from "./insights";

/**
 * Scheduled publishing through the official Content Publishing API (permission instagram_business_content_publish).
 *
 * Flow per post (one step per cron minute, so nothing waits inside a request):
 *   scheduled → (quota check) → create container(s) → wait until FINISHED → media_publish → published
 * Rules from Meta's documentation that this follows:
 *  - Meta fetches the file from a public URL: files stay in the private R2 bucket and are served on /m/* through
 *    signed links that expire; they are deleted once the post is live (or cancelled);
 *  - images must be JPEG; containers expire after 24h (recreated when that happens); video containers need
 *    status polling (IN_PROGRESS → FINISHED) before publishing; carousels publish a parent of 2–10 children;
 *  - accounts have a 24h publishing quota (checked through content_publishing_limit before starting);
 *  - Meta has no scheduling of its own, so the time is kept here.
 * Idempotency: container ids are saved as soon as they exist, and media_publish is never repeated blindly — after
 * an uncertain answer the container's status decides (PUBLISHED = done, FINISHED = it was not published).
 */

export type PublishClient = Pick<HttpMetaClient, "createContainer" | "containerStatus" | "publishContainer" | "publishingLimit" | "getMedia" | "listMedia">;
export type PostKind = "IMAGE" | "CAROUSEL" | "REELS" | "STORY";

export interface PostRow {
  id: number;
  tenant_id: number;
  account_id: number;
  kind: PostKind;
  caption: string | null;
  publish_at: number;
  status: string;
  share_to_feed: number;
  campaign_id: number | null;
  container_id: string | null;
  children: string | null;
  publish_requested_at: number | null;
  media_id: string | null;
  attempts: number;
  next_attempt_at: number | null;
}
export interface MediaRow {
  id: number;
  post_id: number;
  position: number;
  role: "item" | "cover";
  r2_key: string;
  mime: string;
  size: number;
}

const MIN = 60_000;
/** A post that is not live this long after its time is marked failed (nothing is published late by surprise). */
export const PUBLISH_DEADLINE_MS = 6 * 3_600_000;
const MAX_STEP_ERRORS = 4;
/** External requests the publisher may use per cron run (Workers Free: 50, shared with the queue). */
export const PUBLISH_BUDGET = 16;
export const LIMITS = {
  imageBytes: 8 * 1024 * 1024,
  // Meta: reels up to 300 MB; story and carousel videos up to 100 MB.
  videoBytes: 100 * 1024 * 1024,
  reelBytes: 300 * 1024 * 1024,
  // A Worker request body is capped at 100 MB on the Free plan: bigger files go up in parts (R2 multipart).
  singleUploadBytes: 95 * 1024 * 1024,
  partBytes: 50 * 1024 * 1024,
  captionChars: 2200,
  hashtags: 30,
  carouselMin: 2,
  carouselMax: 10,
  maxDaysAhead: 75,
};

// ---- who is asked for the permission (same pattern as insights) -------------------------------------------------

export async function publishScopeMode(db: D1Database): Promise<ScopeMode> {
  const m = await getSetting<string>(db, OWNER_TENANT, "publish_scope", "off");
  return m === "owner" || m === "all" ? m : "off";
}
export async function wantsPublishScope(db: D1Database, tenantId: number): Promise<boolean> {
  const mode = await publishScopeMode(db);
  return mode === "all" || (mode === "owner" && tenantId === OWNER_TENANT);
}
/** The optional permissions to request when this customer connects. */
export async function optionalScopes(db: D1Database, tenantId: number): Promise<string[]> {
  const out: string[] = [];
  if (await wantsInsightsScope(db, tenantId)) out.push(INSIGHTS_SCOPE);
  if (await wantsPublishScope(db, tenantId)) out.push(PUBLISH_SCOPE);
  return out;
}
export function hasPublishScope(scopes: string | null | undefined): boolean {
  try {
    const list = JSON.parse(scopes || "[]");
    return Array.isArray(list) && list.includes(PUBLISH_SCOPE);
  } catch {
    return false;
  }
}
export { hasInsightsScope };

// ---- signed links for Meta to fetch the files ---------------------------------------------------------------------

async function hmacKey(env: Env): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(env.TOKEN_ENC_KEY), (ch) => ch.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}
async function sign(env: Env, key: string, exp: number): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env), new TextEncoder().encode(`media:${key}:${exp}`));
  return hex(sig).slice(0, 40);
}
export async function signedMediaUrl(env: Env, key: string, now = Date.now(), ttlMs = 48 * 3_600_000): Promise<string> {
  const exp = Math.floor((now + ttlMs) / 1000);
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/m/${encodeURIComponent(key)}?e=${exp}&s=${await sign(env, key, exp)}`;
}
export async function verifyMediaUrl(env: Env, key: string, e: string | undefined, s: string | undefined, now = Date.now()): Promise<boolean> {
  const exp = Number(e);
  if (!s || !Number.isFinite(exp) || exp * 1000 < now) return false;
  return timingSafeEqual(await sign(env, key, exp), s);
}

// ---- validation ---------------------------------------------------------------------------------------------------

export const isImage = (mime: string) => mime === "image/jpeg";
export const isVideo = (mime: string) => mime === "video/mp4" || mime === "video/quicktime";

/** Arabic reason the post cannot be scheduled as it is, or null. */
export function validatePost(p: { kind: PostKind; caption: string | null; publish_at: number }, media: Array<Pick<MediaRow, "role" | "mime" | "size">>, now = Date.now()): string | null {
  const items = media.filter((m) => m.role === "item");
  const covers = media.filter((m) => m.role === "cover");
  const cap = p.caption ?? "";
  if (cap.length > LIMITS.captionChars) return `الوصف أطول من ${LIMITS.captionChars} حرف`;
  if ((cap.match(/#[^\s#]+/g) ?? []).length > LIMITS.hashtags) return `الهاشتاقات أكثر من ${LIMITS.hashtags}`;
  if (p.publish_at < now + 2 * MIN) return "وقت النشر لازم يكون بعد دقيقتين على الأقل";
  if (p.publish_at > now + LIMITS.maxDaysAhead * 86_400_000) return `أبعد وقت للجدولة ${LIMITS.maxDaysAhead} يوم`;
  for (const m of media) {
    if (!isImage(m.mime) && !isVideo(m.mime)) return "نوع ملف غير مدعوم (الصور JPEG والفيديو MP4)";
    if (isImage(m.mime) && m.size > LIMITS.imageBytes) return "الصورة أكبر من 8 ميجا";
    if (isVideo(m.mime) && m.size > (p.kind === "REELS" ? LIMITS.reelBytes : LIMITS.videoBytes)) return p.kind === "REELS" ? "فيديو الريل أكبر من 300 ميجا" : "الفيديو أكبر من 100 ميجا";
  }
  if (covers.length > 1 || covers.some((c) => !isImage(c.mime))) return "الغلاف صورة JPEG وحدة فقط";
  if (covers.length && p.kind !== "REELS") return "الغلاف للريل فقط";
  switch (p.kind) {
    case "IMAGE":
      return items.length === 1 && isImage(items[0].mime) ? null : "المنشور يحتاج صورة وحدة";
    case "CAROUSEL":
      return items.length >= LIMITS.carouselMin && items.length <= LIMITS.carouselMax ? null : `المنشور المتعدد من ${LIMITS.carouselMin} إلى ${LIMITS.carouselMax} ملفات`;
    case "REELS":
      return items.length === 1 && isVideo(items[0].mime) ? null : "الريل يحتاج فيديو واحد";
    case "STORY":
      return items.length === 1 ? null : "الستوري ملف واحد (صورة أو فيديو)";
  }
}

// ---- the publisher --------------------------------------------------------------------------------------------------

interface Budget {
  left: number;
}
const isLimitError = (e: MetaError) => e.subcode === 2207042 || /limit|maximum number of posts/i.test(e.message);

async function log(db: D1Database, postId: number, step: string, ok: boolean, detail?: string | null, now = Date.now()) {
  await run(db, "INSERT INTO publish_log (post_id, at, step, ok, detail) VALUES (?, ?, ?, ?, ?)", postId, now, step, ok ? 1 : 0, detail ? detail.slice(0, 400) : null);
}

export interface PublishDeps {
  db: D1Database;
  client: PublishClient;
  env: Env;
  now: () => number;
  token: (a: AccountRow) => Promise<string | null>;
  onAuthError?: (a: AccountRow, message: string) => Promise<void>;
  deleteObject?: (key: string) => Promise<void>;
}

/** Due posts, a few per run. */
export async function runPublisher(env: Env, onRequest?: () => void): Promise<number> {
  const deps: PublishDeps = {
    db: env.DB,
    client: metaClient(env, onRequest),
    env,
    now: () => Date.now(),
    token: (a) => getAccessToken(env, env.DB, a),
    onAuthError: async (a, m) => {
      await markNeedsReauth(env.DB, a, m);
      await notify(env, a.tenant_id, "reauth", "🔌 انقطع ربط حساب إنستقرام — النشر المجدول والردود متوقفة. أعد الربط من صفحة الربط.", onRequest);
    },
    deleteObject: env.MEDIA ? (k) => env.MEDIA!.delete(k) : undefined,
  };
  return publishDue(deps, { left: PUBLISH_BUDGET });
}

export async function publishDue(deps: PublishDeps, budget: Budget): Promise<number> {
  const now = deps.now();
  const due = await all<PostRow>(
    deps.db,
    `SELECT * FROM scheduled_posts WHERE status IN ('scheduled','publishing','uncertain') AND COALESCE(next_attempt_at, publish_at) <= ?
      ORDER BY publish_at LIMIT 3`,
    now,
  );
  let n = 0;
  for (const p of due) {
    if (budget.left <= 0) break;
    await stepPost(deps, p, budget);
    n++;
  }
  return n;
}

/** Advances one post by one step. Exported for tests. */
export async function stepPost(deps: PublishDeps, post: PostRow, budget: Budget): Promise<void> {
  const { db, client } = deps;
  const now = deps.now();
  const set = async (fields: Record<string, unknown>) => {
    const keys = Object.keys(fields);
    await run(db, `UPDATE scheduled_posts SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, ...keys.map((k) => fields[k]), now, post.id);
    Object.assign(post, fields);
  };
  const fail = async (reason: string) => {
    await set({ status: "failed", last_error: reason.slice(0, 400), next_attempt_at: null });
    await log(db, post.id, "failed", false, reason, now);
    await audit(db, post.tenant_id, "system", "schedule.failed", String(post.id), { reason: reason.slice(0, 200) });
  };
  const call = async <T>(fn: () => Promise<MetaResult<T>>) => {
    budget.left--;
    return fn();
  };
  /** Common handling of a failed Meta call. Returns true when the post was moved on (stop this step). */
  const onError = async (step: string, e: MetaError, account: AccountRow): Promise<void> => {
    await log(db, post.id, step, false, e.message, now);
    if (e.kind === "auth") {
      await deps.onAuthError?.(account, e.message);
      return fail("انقطع ربط الحساب — أعد الربط ثم أعد المحاولة");
    }
    if (e.kind === "permission") return fail("صلاحية النشر غير مفعّلة على الحساب — فعّلها وأعد الربط");
    if (e.kind === "rate_limited" || isLimitError(e)) return void (await set({ next_attempt_at: now + 30 * MIN, last_error: "Meta طلبت التمهل أو وصل حد النشر اليومي — نعيد المحاولة تلقائيًا" }));
    const attempts = post.attempts + 1;
    if (attempts >= MAX_STEP_ERRORS) return fail(`تعذّر ${step}: ${e.message}`);
    await set({ attempts, next_attempt_at: now + attempts * 2 * MIN, last_error: e.message });
  };

  // The account must still be the customer's, active, and allowed to publish.
  const account = await first<AccountRow & { scopes: string | null }>(
    db,
    "SELECT * FROM instagram_accounts WHERE id = ? AND tenant_id = ? AND is_demo = 0",
    post.account_id,
    post.tenant_id,
  );
  if (!account || account.status !== "active") return fail("الحساب غير مربوط أو يحتاج إعادة ربط");
  if (!hasPublishScope(account.scopes)) return fail("صلاحية النشر غير مفعّلة على الحساب — فعّلها وأعد الربط");
  if (!post.publish_requested_at && now > post.publish_at + PUBLISH_DEADLINE_MS) return fail("فات وقت النشر بأكثر من 6 ساعات بدون ما يكتمل — ما نشرناه متأخر");
  const token = await deps.token(account);
  if (!token) return fail("تعذّر قراءة تفويض الحساب — أعد الربط");
  const ig = account.ig_user_id;

  // Claim the post (one worker at a time) and check the 24h quota before creating anything.
  if (post.status === "scheduled") {
    const claimed = await run(db, "UPDATE scheduled_posts SET status = 'publishing', updated_at = ? WHERE id = ? AND status = 'scheduled'", now, post.id);
    if (!claimed.meta.changes) return;
    post.status = "publishing";
    await log(db, post.id, "start", true, null, now);
    const q = await call(() => client.publishingLimit(token, ig));
    if (q.ok) {
      const d = q.data.data?.[0];
      if (d?.quota_usage !== undefined && d.config?.quota_total !== undefined && d.quota_usage >= d.config.quota_total) {
        await set({ next_attempt_at: now + 30 * MIN, last_error: `وصل حد النشر عبر الواجهة (${d.quota_usage}/${d.config.quota_total} خلال 24 ساعة) — نعيد المحاولة تلقائيًا` });
        await log(db, post.id, "quota", false, `${d.quota_usage}/${d.config.quota_total}`, now);
        return;
      }
    } else if (q.error.kind === "auth" || q.error.kind === "permission") return onError("التحقق من حد النشر", q.error, account);
  }

  // After media_publish was called: the container's status decides, never a second blind publish.
  if (post.publish_requested_at && !post.media_id && post.container_id) {
    const st = await call(() => client.containerStatus(token, post.container_id!));
    if (!st.ok) return onError("التحقق من نتيجة النشر", st.error, account);
    const code = st.data.status_code;
    if (code === "PUBLISHED") {
      await log(db, post.id, "verify", true, "PUBLISHED", now);
      return finalize(deps, post, account, token, null, budget);
    }
    if (code === "FINISHED") {
      await log(db, post.id, "verify", true, "FINISHED — لم يُنشر، نعيد النشر", now);
      await set({ publish_requested_at: null, status: "publishing" });
    } else if (code === "IN_PROGRESS") {
      return void (await set({ next_attempt_at: now + MIN }));
    } else {
      return fail(`Meta رفضت المنشور (${code ?? "غير معروف"}${st.data.status ? `: ${st.data.status}` : ""})`);
    }
  }

  const media = await all<MediaRow>(db, "SELECT * FROM scheduled_media WHERE post_id = ? AND deleted_at IS NULL ORDER BY role DESC, position", post.id);
  const items = media.filter((m) => m.role === "item");
  const cover = media.find((m) => m.role === "cover");
  if (!items.length && !post.container_id) return fail("ملفات المنشور غير موجودة");
  const url = (m: MediaRow) => signedMediaUrl(deps.env, m.r2_key, now);

  // 1) Containers.
  if (!post.container_id) {
    if (post.kind === "CAROUSEL") {
      const children: string[] = JSON.parse(post.children || "[]");
      for (let i = children.length; i < items.length; i++) {
        if (budget.left <= 0) return void (await set({ next_attempt_at: now + MIN }));
        const m = items[i];
        const params: Record<string, string | boolean> = isVideo(m.mime) ? { media_type: "VIDEO", video_url: await url(m), is_carousel_item: true } : { image_url: await url(m), is_carousel_item: true };
        const r = await call(() => client.createContainer(token, ig, params));
        if (!r.ok || !r.data.id) return onError(`تجهيز الملف ${i + 1}`, r.ok ? { kind: "permanent", message: "no container id" } : r.error, account);
        children.push(r.data.id);
        await set({ children: JSON.stringify(children) });
      }
      // Every child must be FINISHED before the parent is created.
      for (const cid of children) {
        if (budget.left <= 1) return void (await set({ next_attempt_at: now + MIN }));
        const st = await call(() => client.containerStatus(token, cid));
        if (!st.ok) return onError("التحقق من ملفات المنشور", st.error, account);
        if (st.data.status_code === "IN_PROGRESS") return void (await set({ next_attempt_at: now + MIN }));
        if (st.data.status_code === "EXPIRED") {
          await log(db, post.id, "expired", false, "انتهت صلاحية التجهيز — نعيده", now);
          return void (await set({ children: null, next_attempt_at: now }));
        }
        if (st.data.status_code !== "FINISHED") return fail(`Meta رفضت أحد الملفات (${st.data.status_code ?? "?"}${st.data.status ? `: ${st.data.status}` : ""})`);
      }
      const r = await call(() => client.createContainer(token, ig, { media_type: "CAROUSEL", children: children.join(","), ...(post.caption ? { caption: post.caption } : {}) }));
      if (!r.ok || !r.data.id) return onError("تجهيز المنشور المتعدد", r.ok ? { kind: "permanent", message: "no container id" } : r.error, account);
      await set({ container_id: r.data.id });
    } else {
      const m = items[0];
      let params: Record<string, string | boolean>;
      if (post.kind === "IMAGE") params = { image_url: await url(m), ...(post.caption ? { caption: post.caption } : {}) };
      else if (post.kind === "REELS")
        params = { media_type: "REELS", video_url: await url(m), share_to_feed: !!post.share_to_feed, ...(post.caption ? { caption: post.caption } : {}), ...(cover ? { cover_url: await url(cover) } : {}) };
      else params = isVideo(m.mime) ? { media_type: "STORIES", video_url: await url(m) } : { media_type: "STORIES", image_url: await url(m) };
      const r = await call(() => client.createContainer(token, ig, params));
      if (!r.ok || !r.data.id) return onError("تجهيز المنشور", r.ok ? { kind: "permanent", message: "no container id" } : r.error, account);
      await set({ container_id: r.data.id });
    }
    await log(db, post.id, "container", true, post.container_id, now);
    if (budget.left <= 1) return void (await set({ next_attempt_at: now + MIN }));
  }

  // 2) Wait for the container.
  const st = await call(() => client.containerStatus(token, post.container_id!));
  if (!st.ok) return onError("التحقق من جاهزية المنشور", st.error, account);
  const code = st.data.status_code;
  if (code === "IN_PROGRESS") return void (await set({ next_attempt_at: now + MIN }));
  if (code === "EXPIRED") {
    await log(db, post.id, "expired", false, "انتهت صلاحية التجهيز — نعيده", now);
    return void (await set({ container_id: null, children: null, next_attempt_at: now }));
  }
  if (code === "PUBLISHED") return finalize(deps, post, account, token, null, budget);
  if (code !== "FINISHED") return fail(`Meta رفضت المنشور (${code ?? "غير معروف"}${st.data.status ? `: ${st.data.status}` : ""})`);
  if (budget.left <= 0) return void (await set({ next_attempt_at: now + MIN }));

  // 3) Publish — the request time is saved first, so an uncertain answer is verified instead of repeated.
  await set({ publish_requested_at: now });
  const pub = await call(() => client.publishContainer(token, ig, post.container_id!));
  if (pub.ok && pub.data.id) return finalize(deps, post, account, token, pub.data.id, budget);
  if (!pub.ok && pub.error.kind === "uncertain") {
    await log(db, post.id, "publish", false, "نتيجة غير مؤكدة — نتحقق من Meta", now);
    return void (await set({ status: "uncertain", next_attempt_at: now + MIN }));
  }
  // A clear refusal: nothing was published, so publishing may be tried again.
  await set({ publish_requested_at: null });
  return onError("النشر", pub.ok ? { kind: "permanent", message: "no media id" } : pub.error, account);
}

/** The post is live: store it, delete its files, and start the linked campaign on it. */
async function finalize(deps: PublishDeps, post: PostRow, account: AccountRow, token: string, mediaId: string | null, budget: Budget): Promise<void> {
  const { db, client } = deps;
  const now = deps.now();
  // Without the id (uncertain path), find the post among the latest media by its publish time.
  if (!mediaId && budget.left > 0) {
    budget.left--;
    const list = await client.listMedia(token);
    if (list.ok) {
      const since = (post.publish_requested_at ?? post.publish_at) - 5 * MIN;
      const hit = (list.data.data ?? []).find((m) => m.timestamp && Date.parse(m.timestamp) >= since && (post.kind === "STORY" || (m.caption ?? "") === (post.caption ?? "")));
      mediaId = hit?.id ?? null;
    }
  }
  let permalink: string | null = null;
  if (mediaId && budget.left > 0) {
    budget.left--;
    const m = await client.getMedia(token, mediaId);
    if (m.ok) {
      permalink = m.data.permalink ?? null;
      await db.batch([cacheMediaStmt(db, account.id, m.data, post.kind === "STORY" ? "story" : "media", now)]);
    }
  }
  await run(
    db,
    "UPDATE scheduled_posts SET status = 'published', media_id = ?, permalink = ?, published_at = ?, next_attempt_at = NULL, last_error = NULL, updated_at = ? WHERE id = ?",
    mediaId,
    permalink,
    now,
    now,
    post.id,
  );
  post.status = "published";
  post.media_id = mediaId;
  await log(db, post.id, "published", true, mediaId ?? "نُشر (ما قدرنا نقرأ رقم المنشور)", now);
  await audit(db, post.tenant_id, "system", "schedule.published", String(post.id), { media_id: mediaId });
  await removeFiles(deps, post.id);
  if (post.campaign_id && mediaId) await startCampaign(deps, post, mediaId);
  else if (post.campaign_id) await log(db, post.id, "campaign", false, "ما عرفنا رقم المنشور، فما ربطنا الحملة تلقائيًا — اربطها يدويًا", now);
}

export async function removeFiles(deps: Pick<PublishDeps, "db" | "deleteObject" | "now">, postId: number): Promise<void> {
  const files = await all<{ id: number; r2_key: string }>(deps.db, "SELECT id, r2_key FROM scheduled_media WHERE post_id = ? AND deleted_at IS NULL", postId);
  for (const f of files) {
    try {
      await deps.deleteObject?.(f.r2_key);
      await run(deps.db, "UPDATE scheduled_media SET deleted_at = ? WHERE id = ?", deps.now(), f.id);
    } catch {
      /* kept for the daily cleanup */
    }
  }
}

/**
 * Links the campaign to the new post and turns it on (activation time = when publishing was requested, so comments
 * from the first seconds count). Comments that arrived before the link are processed again for this campaign.
 */
async function startCampaign(deps: PublishDeps, post: PostRow, mediaId: string): Promise<void> {
  const { db } = deps;
  const now = deps.now();
  const c = await first<{ id: number; status: string; type: string; scope: string; name: string }>(
    db,
    "SELECT id, status, type, scope, name FROM campaigns WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL",
    post.campaign_id,
    post.tenant_id,
  );
  if (!c) return log(db, post.id, "campaign", false, "الحملة المربوطة محذوفة", now);
  if (c.scope === "selected") await run(db, "INSERT OR IGNORE INTO campaign_media (campaign_id, media_id) VALUES (?, ?)", c.id, mediaId);
  const startAt = post.publish_requested_at ?? now;
  if (c.status !== "active") {
    const e = await getEntitlement(db, post.tenant_id, now);
    const active = await first<{ n: number }>(db, "SELECT COUNT(*) AS n FROM campaigns WHERE tenant_id = ? AND status = 'active' AND deleted_at IS NULL AND id != ?", post.tenant_id, c.id);
    if (!e.active || !e.limits.events.includes(c.type as any) || (e.limits.active_campaigns !== null && (active?.n ?? 0) >= e.limits.active_campaigns)) {
      return log(db, post.id, "campaign", false, `ربطنا المنشور بالحملة «${c.name}» بس ما شغّلناها: باقتك ما تسمح بحملة نشطة إضافية`, now);
    }
    await run(db, "UPDATE campaigns SET status = 'active', activated_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?", startAt, now, c.id, post.tenant_id);
  }
  // Early comments (between publishing and this link) are processed again for this campaign only.
  await run(
    db,
    `INSERT OR IGNORE INTO action_jobs (account_id, kind, event_id, dedup_key, payload, is_demo, status, attempts, max_attempts, run_at, created_at, updated_at)
     SELECT NULL, 'process_event', e.id, 'evt:' || e.dedup_key || ':post' || ?, ?, 0, 'pending', 0, 5, ?, ?, ?
       FROM webhook_events e
      WHERE e.media_id = ? AND e.flow_id IS NULL AND e.is_demo = 0 AND e.event_time >= ?
        AND e.account_ig_id IN (SELECT ig_user_id FROM instagram_accounts WHERE tenant_id = ?)`,
    post.id,
    JSON.stringify({ forcedCampaignId: c.id }),
    now,
    now,
    now,
    mediaId,
    startAt - MIN,
    post.tenant_id,
  );
  await log(db, post.id, "campaign", true, `بدأت الحملة «${c.name}» على المنشور`, now);
}

/** Daily: files of posts that ended (published / failed / cancelled) and stray uploads are removed. */
export async function cleanupScheduledFiles(env: Env, now = Date.now()): Promise<void> {
  if (!env.MEDIA) return;
  const rows = await all<{ id: number; r2_key: string }>(
    env.DB,
    `SELECT m.id, m.r2_key FROM scheduled_media m JOIN scheduled_posts p ON p.id = m.post_id
      WHERE m.deleted_at IS NULL AND ((p.status IN ('published','failed','cancelled') AND p.updated_at < ?) OR (p.status = 'draft' AND p.updated_at < ?))
      LIMIT 200`,
    now - 86_400_000,
    now - 7 * 86_400_000,
  );
  for (const r of rows) {
    await env.MEDIA.delete(r.r2_key).catch(() => undefined);
    await run(env.DB, "UPDATE scheduled_media SET deleted_at = ? WHERE id = ?", now, r.id);
  }
}
