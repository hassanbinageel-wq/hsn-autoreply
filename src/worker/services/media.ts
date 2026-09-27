import type { MediaItem } from "../meta/types";

/** Stores (or refreshes) one post/reel preview. Only a preview URL is kept; videos are never stored. */
export function cacheMediaStmt(db: D1Database, accountId: number, m: MediaItem, kind: "media" | "story", now: number): D1PreparedStatement {
  const posted = m.timestamp ? Date.parse(m.timestamp) : null;
  const preview = m.media_type === "VIDEO" ? m.thumbnail_url ?? null : m.thumbnail_url ?? m.media_url ?? null;
  return db
    .prepare(
      `INSERT INTO media_cache (account_id, media_id, kind, media_type, media_product_type, caption, permalink, thumbnail_url, posted_at, expires_at, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, media_id) DO UPDATE SET caption = excluded.caption, permalink = excluded.permalink,
         thumbnail_url = excluded.thumbnail_url, media_type = excluded.media_type, media_product_type = excluded.media_product_type,
         posted_at = COALESCE(excluded.posted_at, media_cache.posted_at), fetched_at = excluded.fetched_at`,
    )
    .bind(
      accountId,
      m.id,
      kind,
      m.media_type ?? null,
      m.media_product_type ?? null,
      m.caption ? m.caption.slice(0, 2000) : null,
      m.permalink ?? null,
      preview,
      Number.isFinite(posted) ? posted : null,
      kind === "story" && posted ? posted + 24 * 3_600_000 : null,
      now,
    );
}
