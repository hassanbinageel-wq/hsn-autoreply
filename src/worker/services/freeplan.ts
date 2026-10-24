import type { Env } from "../env";
import { all, audit, first, run } from "../lib/db";
import { sha256Hex } from "../lib/crypto";
import { isDisposable } from "../lib/disposable";
import { emailEnabled } from "./email";
import { addAppNotification } from "./notify";

/**
 * Keeping the free plan for real first-time customers. The replies come from the connected Instagram account, so
 * that is what the free plan is tied to: one free plan per Instagram account, ever, whichever customer account it
 * is connected to. On top of that: a confirmed, non-throw-away email, and at most a few new free accounts from one
 * network per week.
 */

/** New free accounts allowed from one network in a week (a customer renewing their own free plan does not count). */
export const FREE_PER_NETWORK_WEEK = 3;
const WEEK = 7 * 86_400_000;

export type FreeRefusal = { code: string; message: string };

async function ipHash(env: Env, ip: string): Promise<string> {
  return (await sha256Hex(`free:${ip}:${env.PASSWORD_PEPPER}`)).slice(0, 32);
}

async function connectedAccount(db: D1Database, tenantId: number) {
  return first<{ ig_user_id: string; username: string | null }>(
    db,
    "SELECT ig_user_id, username FROM instagram_accounts WHERE tenant_id = ? AND is_demo = 0 AND status != 'disconnected' ORDER BY id DESC LIMIT 1",
    tenantId,
  );
}

/** The customer who first used the free plan with this Instagram account, when it is someone else. */
async function claimedElsewhere(db: D1Database, igUserId: string, tenantId: number): Promise<number | null> {
  const c = await first<{ tenant_id: number }>(db, "SELECT tenant_id FROM free_claims WHERE ig_user_id = ?", igUserId);
  return c && c.tenant_id !== tenantId ? c.tenant_id : null;
}

/** Checks before the free plan starts for a customer; null = allowed. */
export async function freePlanRefusal(env: Env, tenantId: number, userId: number, ip: string, now = Date.now()): Promise<FreeRefusal | null> {
  if (emailEnabled(env)) {
    const u = await first<{ email: string | null; email_verified_at: number | null }>(env.DB, "SELECT email, email_verified_at FROM admin_users WHERE id = ?", userId);
    if (!u?.email || !u.email_verified_at) return { code: "email_required", message: "أكّد إيميلك أولًا (من هنا أو من «الإعدادات») وبعدها فعّل الباقة المجانية" };
    if (await isDisposable(env.DB, u.email)) return { code: "email_disposable", message: "النظام يرفض الإيميلات المؤقتة" };
  }
  const acc = await connectedAccount(env.DB, tenantId);
  if (acc && (await claimedElsewhere(env.DB, acc.ig_user_id, tenantId)) !== null) {
    return { code: "free_used_ig", message: `حساب إنستقرام ${acc.username ? `@${acc.username} ` : ""}استخدم الباقة المجانية من قبل — تقدر تشترك بباقة مدفوعة` };
  }
  const renewing = await first(env.DB, "SELECT 1 FROM free_activations WHERE tenant_id = ? LIMIT 1", tenantId);
  if (!renewing) return networkRefusal(env, ip, tenantId, now);
  return null;
}

/** The weekly cap on new free accounts from one network (tenantId: the customer asking, 0 at sign-up). */
export async function networkRefusal(env: Env, ip: string, tenantId = 0, now = Date.now()): Promise<FreeRefusal | null> {
  const n = await first<{ n: number }>(
    env.DB,
    "SELECT COUNT(DISTINCT tenant_id) AS n FROM free_activations WHERE ip_hash = ? AND at > ? AND tenant_id != ?",
    await ipHash(env, ip), now - WEEK, tenantId,
  );
  return (n?.n ?? 0) >= FREE_PER_NETWORK_WEEK ? { code: "free_network_limit", message: "تفعّلت باقات مجانية كثيرة من نفس الشبكة هذا الأسبوع — حاول لاحقًا أو اشترك بباقة مدفوعة" } : null;
}

/** Records a free-plan start: the network (hashed) and, when an Instagram account is connected, its claim. */
export async function recordFreeStart(env: Env, tenantId: number, ip: string, now = Date.now()): Promise<void> {
  await run(env.DB, "INSERT INTO free_activations (tenant_id, ip_hash, at) VALUES (?, ?, ?)", tenantId, await ipHash(env, ip), now);
  const acc = await connectedAccount(env.DB, tenantId);
  if (acc) await run(env.DB, "INSERT OR IGNORE INTO free_claims (ig_user_id, tenant_id, username, claimed_at) VALUES (?, ?, ?, ?)", acc.ig_user_id, tenantId, acc.username, now);
}

/**
 * After an Instagram account is connected: a customer on the free plan claims it for that account — unless the
 * account already used the free plan with another customer, in which case the free plan ends now (the customer can
 * still subscribe to a paid plan) and the owner sees the account flagged.
 */
export async function checkFreeOnConnect(env: Env, tenantId: number, igUserId: string, username: string | null, now = Date.now()): Promise<"none" | "claimed" | "ended"> {
  const t = await first<{ plan_expires_at: number | null; free: number | null }>(
    env.DB,
    "SELECT t.plan_expires_at, p.free FROM tenants t LEFT JOIN plans p ON p.id = t.plan_id WHERE t.id = ? AND t.is_owner = 0",
    tenantId,
  );
  if (!t?.free || !t.plan_expires_at || t.plan_expires_at <= now) return "none";
  const first_ = await claimedElsewhere(env.DB, igUserId, tenantId);
  if (first_ === null) {
    await run(env.DB, "INSERT OR IGNORE INTO free_claims (ig_user_id, tenant_id, username, claimed_at) VALUES (?, ?, ?, ?)", igUserId, tenantId, username, now);
    return "claimed";
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE tenants SET plan_expires_at = ?, updated_at = ? WHERE id = ?").bind(now, now, tenantId),
    env.DB.prepare("INSERT INTO free_blocks (tenant_id, ig_user_id, username, first_tenant_id, at) VALUES (?, ?, ?, ?, ?)").bind(tenantId, igUserId, username, first_, now),
  ]);
  await audit(env.DB, tenantId, "system", "free_plan.ended_duplicate_ig", igUserId, { first_tenant_id: first_ });
  await addAppNotification(
    env.DB, tenantId, "plan",
    `انتهت الباقة المجانية\nحساب إنستقرام ${username ? `@${username} ` : ""}استخدم الباقة المجانية من قبل، والباقة المجانية مرة وحدة لكل حساب إنستقرام. تقدر تشترك بباقة مدفوعة من «اشتراكي».`,
    now, "/subscription",
  ).catch(() => undefined);
  return "ended";
}

/** For the owner's customer list: customers whose Instagram account already used the free plan with someone else. */
export async function duplicateIgFlags(db: D1Database): Promise<Map<number, { username: string | null; first_tenant_id: number; first_name: string | null; blocked: number }>> {
  const rows = await all<{ tenant_id: number; username: string | null; first_tenant_id: number; first_name: string | null; blocked: number }>(
    db,
    `SELECT a.tenant_id, a.username, fc.tenant_id AS first_tenant_id, ft.name AS first_name,
            (SELECT COUNT(*) FROM free_blocks b WHERE b.tenant_id = a.tenant_id) AS blocked
       FROM instagram_accounts a JOIN free_claims fc ON fc.ig_user_id = a.ig_user_id
       LEFT JOIN tenants ft ON ft.id = fc.tenant_id
      WHERE a.is_demo = 0 AND fc.tenant_id != a.tenant_id`,
  );
  return new Map(rows.map((r) => [r.tenant_id, r]));
}
