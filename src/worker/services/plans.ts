import { all, first, OWNER_TENANT, run } from "../lib/db";
import { sha256Hex } from "../lib/crypto";
import { CODE_ALPHABET, normalizeCode, OWNER_LIMITS, type PlanLimits } from "../../shared/plans";

export interface PlanRow {
  id: string;
  name: string;
  price_label: string | null;
  price_amount: number | null;
  price_currency: string;
  price_period: string;
  description: string | null;
  sort: number;
  limits: PlanLimits;
  active: number;
}

export interface Entitlement {
  owner: boolean;
  /** The subscription is valid now (the owner always is). */
  active: boolean;
  plan: { id: string; name: string } | null;
  limits: PlanLimits;
  expires_at: number | null;
  /** Why it is not active: no_plan | expired | suspended. */
  reason?: string;
}

/** Limits of an expired / missing plan: nothing runs. */
const NONE: PlanLimits = {
  active_campaigns: 0,
  monthly_messages: 0,
  events: [],
  public_reply: false,
  link_tracking: false,
  inbox_manual: false,
  telegram: false,
  recover: false,
  csv_export: false,
  draws_per_month: 0,
  draw_video: false,
  cards: false,
  simulator: false,
  campaign_stats: false,
  undo: false,
  scheduling: false,
  store: false,
};

export function parseLimits(raw: string): PlanLimits {
  try {
    return { ...NONE, ...(JSON.parse(raw) as Partial<PlanLimits>) };
  } catch {
    return { ...NONE };
  }
}

export async function listPlans(db: D1Database): Promise<PlanRow[]> {
  const rows = await all<any>(db, "SELECT * FROM plans ORDER BY sort, id");
  return rows.map((r) => ({ ...r, limits: parseLimits(r.limits) }));
}

export async function getEntitlement(db: D1Database, tenantId: number, now = Date.now()): Promise<Entitlement> {
  const t = await first<{ is_owner: number; status: string; plan_id: string | null; plan_expires_at: number | null }>(
    db,
    "SELECT is_owner, status, plan_id, plan_expires_at FROM tenants WHERE id = ?",
    tenantId,
  );
  if (!t) return { owner: false, active: false, plan: null, limits: NONE, expires_at: null, reason: "no_plan" };
  if (t.is_owner || tenantId === OWNER_TENANT) return { owner: true, active: true, plan: null, limits: OWNER_LIMITS, expires_at: null };
  const plan = t.plan_id ? await first<{ id: string; name: string; limits: string }>(db, "SELECT id, name, limits FROM plans WHERE id = ?", t.plan_id) : null;
  const base = { owner: false, plan: plan ? { id: plan.id, name: plan.name } : null, expires_at: t.plan_expires_at };
  if (t.status !== "active") return { ...base, active: false, limits: NONE, reason: "suspended" };
  if (!plan) return { ...base, active: false, limits: NONE, reason: "no_plan" };
  if (!t.plan_expires_at || t.plan_expires_at <= now) return { ...base, active: false, limits: NONE, reason: "expired" };
  return { ...base, active: true, limits: parseLimits(plan.limits) };
}

export const monthKey = (now = Date.now()) => new Date(now).toISOString().slice(0, 7);

export async function monthlyMessages(db: D1Database, tenantId: number, now = Date.now()): Promise<number> {
  return (await first<{ messages: number }>(db, "SELECT messages FROM usage_counters WHERE tenant_id = ? AND month = ?", tenantId, monthKey(now)))?.messages ?? 0;
}

/** One message (DM, private or public reply) accepted by Meta for a customer. */
export async function countMessage(db: D1Database, tenantId: number, now = Date.now()): Promise<void> {
  await run(
    db,
    "INSERT INTO usage_counters (tenant_id, month, messages) VALUES (?, ?, 1) ON CONFLICT(tenant_id, month) DO UPDATE SET messages = messages + 1",
    tenantId,
    monthKey(now),
  );
}

export async function drawsThisMonth(db: D1Database, tenantId: number, now = Date.now()): Promise<number> {
  const start = Date.parse(`${monthKey(now)}-01T00:00:00Z`);
  return (await first<{ n: number }>(db, "SELECT COUNT(*) AS n FROM draws WHERE tenant_id = ? AND created_at >= ?", tenantId, start))?.n ?? 0;
}

/** A new activation code, e.g. HSN-7KQ2-M9XA-TR4D (shown once; only its hash is stored). */
export function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const s = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  return `HSN-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

export const codeHash = (code: string) => sha256Hex(`hsn-code:${normalizeCode(code)}`);

export class RedeemError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/**
 * Redeems a code for a customer: the plan becomes the code's plan, and the time is added after the current
 * expiry when it is still valid (renewing early never loses days). One use per code, enforced atomically.
 */
export async function redeemCode(db: D1Database, tenantId: number, raw: string, now = Date.now()): Promise<{ plan_id: string; expires_at: number }> {
  const norm = normalizeCode(raw);
  if (norm.length !== 12) throw new RedeemError("invalid_code", "الكود غير صحيح — تأكد من كتابته كما وصلك");
  const hash = await codeHash(norm);
  const code = await first<{ id: number; plan_id: string; days: number; used_at: number | null; revoked_at: number | null }>(
    db,
    "SELECT id, plan_id, days, used_at, revoked_at FROM activation_codes WHERE code_hash = ?",
    hash,
  );
  if (!code) throw new RedeemError("invalid_code", "الكود غير صحيح — تأكد من كتابته كما وصلك");
  if (code.revoked_at) throw new RedeemError("revoked", "هذا الكود أُلغي — تواصل مع إدارة الخدمة");
  if (code.used_at) throw new RedeemError("used", "هذا الكود مستخدم مسبقًا");
  // Claim it atomically (two simultaneous redemptions cannot both succeed).
  const claimed = await run(
    db,
    `UPDATE activation_codes SET used_at = ?, used_by_tenant = ?,
            used_by_name = (SELECT name FROM tenants WHERE id = ?),
            used_by_username = (SELECT username FROM admin_users WHERE tenant_id = ? ORDER BY id LIMIT 1)
      WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL`,
    now, tenantId, tenantId, tenantId, code.id,
  );
  if (!claimed.meta.changes) throw new RedeemError("used", "هذا الكود مستخدم مسبقًا");
  const t = await first<{ plan_expires_at: number | null; plan_started_at: number | null }>(db, "SELECT plan_expires_at, plan_started_at FROM tenants WHERE id = ?", tenantId);
  const running = !!t?.plan_expires_at && t.plan_expires_at > now;
  const from = running ? t!.plan_expires_at! : now;
  const expires = from + code.days * 86_400_000;
  const started = running ? (t!.plan_started_at ?? now) : now;
  await run(db, "UPDATE tenants SET plan_id = ?, plan_expires_at = ?, plan_started_at = ?, expiry_notice_at = NULL, updated_at = ? WHERE id = ?", code.plan_id, expires, started, now, tenantId);
  return { plan_id: code.plan_id, expires_at: expires };
}

/** Removes a customer and everything that belongs to it (irreversible). Never the owner. */
export async function deleteTenantData(db: D1Database, tenantId: number): Promise<void> {
  if (tenantId === OWNER_TENANT) throw new Error("owner tenant cannot be deleted");
  const ACC = "(SELECT id FROM instagram_accounts WHERE tenant_id = ?)";
  const IG = "(SELECT ig_user_id FROM instagram_accounts WHERE tenant_id = ?)";
  const DRAWS = "(SELECT id FROM draws WHERE tenant_id = ?)";
  const PART = `(SELECT id FROM participants WHERE account_id IN ${ACC})`;
  const t = tenantId;
  await db.batch([
    // Keep who used each code (name and username) before the customer's rows disappear.
    db
      .prepare(
        `UPDATE activation_codes SET used_by_name = COALESCE(used_by_name, (SELECT name FROM tenants WHERE id = ?)),
                used_by_username = COALESCE(used_by_username, (SELECT username FROM admin_users WHERE tenant_id = ? ORDER BY id LIMIT 1))
          WHERE used_by_tenant = ?`,
      )
      .bind(t, t, t),
    db.prepare(`DELETE FROM draw_cards WHERE winner_id IN (SELECT id FROM draw_winners WHERE draw_id IN ${DRAWS})`).bind(t),
    db.prepare(`DELETE FROM draw_winners WHERE draw_id IN ${DRAWS}`).bind(t),
    db.prepare(`DELETE FROM draw_entries WHERE draw_id IN ${DRAWS}`).bind(t),
    db.prepare("DELETE FROM draws WHERE tenant_id = ?").bind(t),
    db.prepare("DELETE FROM card_designs WHERE tenant_id = ?").bind(t),
    db.prepare(`DELETE FROM action_attempts WHERE job_id IN (SELECT id FROM action_jobs WHERE account_id IN ${ACC})`).bind(t),
    db.prepare(`DELETE FROM action_jobs WHERE account_id IN ${ACC}`).bind(t),
    db.prepare(`DELETE FROM follow_checks WHERE participant_id IN ${PART}`).bind(t),
    db.prepare(`DELETE FROM messages WHERE participant_id IN ${PART}`).bind(t),
    db.prepare(`DELETE FROM conversation_flows WHERE account_id IN ${ACC}`).bind(t),
    db.prepare(`DELETE FROM participants WHERE account_id IN ${ACC}`).bind(t),
    db.prepare(`DELETE FROM webhook_events WHERE account_ig_id IN ${IG}`).bind(t),
    db.prepare(`DELETE FROM media_cache WHERE account_id IN ${ACC}`).bind(t),
    db.prepare("DELETE FROM campaign_keywords WHERE campaign_id IN (SELECT id FROM campaigns WHERE tenant_id = ?)").bind(t),
    db.prepare("DELETE FROM campaign_media WHERE campaign_id IN (SELECT id FROM campaigns WHERE tenant_id = ?)").bind(t),
    db.prepare("DELETE FROM campaigns WHERE tenant_id = ?").bind(t),
    db.prepare("DELETE FROM templates WHERE tenant_id = ?").bind(t),
    db.prepare("DELETE FROM undo_ops WHERE tenant_id = ?").bind(t),
    db.prepare("DELETE FROM audit_logs WHERE tenant_id = ?").bind(t),
    db.prepare("DELETE FROM usage_counters WHERE tenant_id = ?").bind(t),
    db.prepare("DELETE FROM app_settings WHERE substr(key, 1, ?) = ?").bind(`t${t}:`.length, `t${t}:`),
    db.prepare("DELETE FROM sessions WHERE user_id IN (SELECT id FROM admin_users WHERE tenant_id = ?)").bind(t),
    db.prepare("DELETE FROM oauth_states WHERE user_id IN (SELECT id FROM admin_users WHERE tenant_id = ?)").bind(t),
    db.prepare("DELETE FROM admin_users WHERE tenant_id = ?").bind(t),
    db.prepare("DELETE FROM instagram_accounts WHERE tenant_id = ?").bind(t),
    db.prepare("DELETE FROM store_oauth_states WHERE tenant_id = ?").bind(t),
    db.prepare("DELETE FROM saved_replies WHERE tenant_id = ?").bind(t),
    db.prepare("DELETE FROM stores WHERE tenant_id = ?").bind(t),
    db.prepare("UPDATE activation_codes SET used_by_tenant = NULL WHERE used_by_tenant = ?").bind(t),
    db.prepare("DELETE FROM tenants WHERE id = ?").bind(t),
  ]);
}
