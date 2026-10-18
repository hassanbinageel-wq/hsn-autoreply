import { all, first, getSetting, OWNER_TENANT, run } from "../lib/db";
import { getEntitlement, monthlyMessages } from "./plans";

/**
 * Owner tools around customers: a health board (who may be about to leave), subscription discount codes, and
 * referrals (a customer brings a customer; both get bonus days).
 */

const DAY = 86_400_000;

// ---- health ----------------------------------------------------------------------------------------------------

export async function customerHealth(db: D1Database, now = Date.now()) {
  const rows = await all<{ id: number; name: string; status: string; plan_id: string | null; plan_expires_at: number | null; created_at: number; last_seen: number | null; ig_status: string | null; active_campaigns: number; people_7d: number; open_support: number; usernames: string | null; ig_username: string | null; store_name: string | null }>(
    db,
    `SELECT t.id, t.name, t.status, t.plan_id, t.plan_expires_at, t.created_at,
            (SELECT GROUP_CONCAT(u.username, '، ') FROM admin_users u WHERE u.tenant_id = t.id) AS usernames,
            (SELECT a.username FROM instagram_accounts a WHERE a.tenant_id = t.id ORDER BY a.id DESC LIMIT 1) AS ig_username,
            (SELECT st.name FROM stores st WHERE st.tenant_id = t.id AND st.status != 'disconnected' ORDER BY st.id DESC LIMIT 1) AS store_name,
            (SELECT MAX(s.last_seen_at) FROM sessions s JOIN admin_users u ON u.id = s.user_id WHERE u.tenant_id = t.id) AS last_seen,
            (SELECT a.status FROM instagram_accounts a WHERE a.tenant_id = t.id ORDER BY a.id DESC LIMIT 1) AS ig_status,
            (SELECT COUNT(*) FROM campaigns c WHERE c.tenant_id = t.id AND c.status = 'active' AND c.deleted_at IS NULL) AS active_campaigns,
            (SELECT COUNT(DISTINCT f.participant_id) FROM conversation_flows f JOIN instagram_accounts a ON a.id = f.account_id
              WHERE a.tenant_id = t.id AND f.is_demo = 0 AND f.created_at >= ?) AS people_7d,
            (SELECT COUNT(*) FROM support_threads st WHERE st.tenant_id = t.id AND st.status = 'open' AND st.last_from = 'customer') AS open_support
       FROM tenants t WHERE t.is_owner = 0 ORDER BY t.id`,
    now - 7 * DAY,
  );
  const out = [];
  for (const r of rows) {
    const ent = await getEntitlement(db, r.id, now);
    const used = await monthlyMessages(db, r.id, now);
    const limit = ent.limits.monthly_messages;
    const daysLeft = r.plan_expires_at ? Math.ceil((r.plan_expires_at - now) / DAY) : null;
    const idle = r.last_seen ? Math.floor((now - r.last_seen) / DAY) : null;
    const reasons: string[] = [];
    let score = 0;
    if (r.status !== "active") reasons.push("موقوف");
    if (daysLeft !== null && daysLeft <= 0) (score += 3), reasons.push("انتهى اشتراكه");
    else if (daysLeft !== null && daysLeft <= 5) (score += 2), reasons.push(`ينتهي اشتراكه بعد ${daysLeft} يوم`);
    if (!r.ig_status || r.ig_status === "disconnected") (score += 2), reasons.push("إنستقرام غير مربوط");
    else if (r.ig_status !== "active") (score += 2), reasons.push("ربط إنستقرام يحتاج إعادة");
    if (idle === null || idle >= 14) (score += 2), reasons.push(idle === null ? "ما دخل التطبيق أبدًا" : `ما دخل من ${idle} يوم`);
    else if (idle >= 7) (score += 1), reasons.push(`ما دخل من ${idle} يوم`);
    if (r.active_campaigns === 0) (score += 1), reasons.push("ما عنده حملة شغّالة");
    else if (r.people_7d === 0) (score += 1), reasons.push("ما فيه تفاعل آخر 7 أيام");
    if (limit && used / limit >= 0.9) reasons.push(`استهلك ${Math.round((used / limit) * 100)}% من رسائله — فرصة ترقية`);
    if (r.open_support) reasons.push(`${r.open_support} رسالة دعم بانتظار ردك`);
    out.push({
      id: r.id,
      name: r.name,
      usernames: r.usernames,
      ig_username: r.ig_username,
      store_name: r.store_name,
      status: r.status,
      plan: ent.plan?.name ?? r.plan_id,
      days_left: daysLeft,
      last_seen: r.last_seen,
      ig_status: r.ig_status,
      active_campaigns: r.active_campaigns,
      people_7d: r.people_7d,
      messages: { used, limit },
      open_support: r.open_support,
      risk: r.status !== "active" ? "off" : score >= 3 ? "high" : score >= 1 ? "medium" : "good",
      reasons,
    });
  }
  const order = { high: 0, medium: 1, good: 2, off: 3 } as const;
  return out.sort((a, b) => order[a.risk as keyof typeof order] - order[b.risk as keyof typeof order] || (a.days_left ?? 999) - (b.days_left ?? 999));
}

// ---- subscription coupons -----------------------------------------------------------------------------------------

export type CouponRow = { id: number; code: string; percent: number; plan_ids: string | null; expires_at: number | null; max_uses: number | null; uses: number; active: number; note: string | null; created_at: number };

export const normCode = (c: string) => c.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 30);

/** A usable coupon (active, not expired, uses left) or null. */
export async function findCoupon(db: D1Database, code: string, now = Date.now()): Promise<CouponRow | null> {
  const c = await first<CouponRow>(db, "SELECT * FROM sub_coupons WHERE code = ?", normCode(code));
  if (!c || !c.active || (c.expires_at && c.expires_at < now) || (c.max_uses !== null && c.uses >= c.max_uses)) return null;
  return c;
}

export const publicCoupon = (c: CouponRow) => ({ code: c.code, percent: c.percent, plans: c.plan_ids ? (JSON.parse(c.plan_ids) as string[]) : null, expires_at: c.expires_at });

// ---- referrals ---------------------------------------------------------------------------------------------------

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** The customer's referral code (created on first use). */
export async function referralCode(db: D1Database, tenantId: number): Promise<string> {
  const t = await first<{ referral_code: string | null }>(db, "SELECT referral_code FROM tenants WHERE id = ?", tenantId);
  if (t?.referral_code) return t.referral_code;
  for (let i = 0; i < 5; i++) {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    const code = "R" + [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
    const r = await run(db, "UPDATE tenants SET referral_code = ? WHERE id = ? AND referral_code IS NULL AND NOT EXISTS (SELECT 1 FROM tenants WHERE referral_code = ?)", code, tenantId, code);
    if (r.meta.changes) return code;
    const again = await first<{ referral_code: string | null }>(db, "SELECT referral_code FROM tenants WHERE id = ?", tenantId);
    if (again?.referral_code) return again.referral_code;
  }
  throw new Error("referral code");
}

export const referralDays = (db: D1Database) => getSetting<number>(db, OWNER_TENANT, "referral_days", 7);

/**
 * A new customer signed up with a referral code: both get bonus days on an active plan, once.
 * Returns the referrer's id when it applied.
 */
export async function applyReferral(db: D1Database, newTenantId: number, code: string | null | undefined, now = Date.now()): Promise<number | null> {
  if (!code) return null;
  const days = await referralDays(db);
  const ref = await first<{ id: number }>(db, "SELECT id FROM tenants WHERE referral_code = ? AND status = 'active' AND id != ?", code.trim().toUpperCase(), newTenantId);
  if (!ref) return null;
  const set = await run(db, "UPDATE tenants SET referred_by = ?, referral_rewarded_at = ? WHERE id = ? AND referred_by IS NULL", ref.id, days > 0 ? now : null, newTenantId);
  if (!set.meta.changes || days <= 0) return set.meta.changes ? ref.id : null;
  const add = days * DAY;
  await run(db, "UPDATE tenants SET plan_expires_at = plan_expires_at + ? WHERE id IN (?, ?) AND plan_expires_at IS NOT NULL AND plan_expires_at > ?", add, ref.id, newTenantId, now);
  return ref.id;
}

export async function referralStats(db: D1Database, tenantId: number) {
  const days = await referralDays(db);
  const r = await first<{ n: number; rewarded: number }>(db, "SELECT COUNT(*) AS n, COUNT(referral_rewarded_at) AS rewarded FROM tenants WHERE referred_by = ?", tenantId);
  return { code: await referralCode(db, tenantId), days_per_referral: days, referred: r?.n ?? 0, rewarded: r?.rewarded ?? 0 };
}
