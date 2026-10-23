import { all, first, run } from "../lib/db";
import type { Offer } from "../../shared/promos";

/**
 * Offers: a side box with a countdown that the owner shows to every customer or to chosen ones, for a time window.
 * A customer only ever sees offers addressed to all customers or listing their own tenant id.
 */

type OfferRow = Offer & { audience: string; tenant_ids: string | null; active: number; views: number; clicks: number; created_at: number; updated_at: number };

const visibleTo = (o: OfferRow, tenantId: number) => o.audience === "all" || (o.tenant_ids ? (JSON.parse(o.tenant_ids) as number[]).includes(tenantId) : false);

/** Offers running now for one customer, the soonest to end first. */
export async function offersFor(db: D1Database, tenantId: number, now = Date.now()): Promise<Offer[]> {
  const rows = await all<OfferRow>(db, "SELECT * FROM offers WHERE active = 1 AND ends_at > ? AND (starts_at IS NULL OR starts_at <= ?) ORDER BY ends_at", now, now);
  return rows.filter((o) => visibleTo(o, tenantId)).map(({ id, title, body, cta, link, theme, icon, starts_at, ends_at }) => ({ id, title, body, cta, link, theme, icon, starts_at, ends_at }));
}

/** Counts a click on an offer the customer can see; false when it is not theirs or not running. */
export async function clickOffer(db: D1Database, tenantId: number, id: number, now = Date.now()): Promise<boolean> {
  const o = await first<OfferRow>(db, "SELECT * FROM offers WHERE id = ? AND active = 1 AND ends_at > ?", id, now);
  if (!o || !visibleTo(o, tenantId)) return false;
  await run(db, "UPDATE offers SET clicks = clicks + 1 WHERE id = ?", id);
  return true;
}

export async function listOffers(db: D1Database) {
  const rows = await all<OfferRow>(db, "SELECT * FROM offers ORDER BY id DESC LIMIT 100");
  return rows.map((o) => ({ ...o, active: !!o.active, tenant_ids: o.tenant_ids ? (JSON.parse(o.tenant_ids) as number[]) : [] }));
}
