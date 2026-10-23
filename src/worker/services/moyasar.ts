import type { Env } from "../env";
import { audit, first, OWNER_TENANT, run } from "../lib/db";
import { sanitize } from "../meta/client";
import { notify } from "./notify";
import { extendPlan, PERIOD_DAYS } from "./plans";
import { withSchedulingNotice } from "./publish";
import { applyTopup } from "./topups";

/**
 * Card payments (Mada / Visa / Mastercard / Apple Pay) through Moyasar's hosted invoice page, at a fixed SAR price
 * per plan. Docs: https://docs.moyasar.com/api/invoices/01-create-invoice (amount in halalas, minimum 100;
 * Basic auth with the secret key as the user name). Off until the MOYASAR_SECRET_KEY secret is set.
 *
 * The callback from Moyasar is never trusted by itself: the invoice is always fetched again with the secret key,
 * and only a "paid" invoice with the exact amount and currency activates the plan, once.
 */

const API = "https://api.moyasar.com/v1";

export const cardEnabled = (env: Env) => !!env.MOYASAR_SECRET_KEY;
export const isTestKey = (env: Env) => !!env.MOYASAR_SECRET_KEY?.startsWith("sk_test_");

/**
 * The card price of a plan in halalas, or null when it cannot be paid by card: the owner's fixed card price,
 * else the plan's own price when it is in SAR; 0 means the owner switched card payment off for the plan.
 * Needs a period (month / quarter / year) and Moyasar's minimum of 1 SAR.
 */
export function cardPriceHalalas(p: { card_price_halalas: number | null; price_amount: number | null; price_currency: string; price_period: string }): number | null {
  if (!PERIOD_DAYS[p.price_period]) return null;
  const v = p.card_price_halalas ?? (p.price_currency === "SAR" && p.price_amount ? Math.round(p.price_amount * 100) : null);
  return v && v >= 100 ? v : null;
}

export type Invoice = { id: string; status: string; amount: number; currency: string; url?: string; metadata?: Record<string, string> | null };

export class PayError extends Error {
  constructor(public code: string, message: string, public status = 422) {
    super(message);
  }
}

async function moyasar(env: Env, path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<Invoice> {
  const r = await fetch(API + path, {
    method: init.method,
    headers: { Authorization: `Basic ${btoa(`${env.MOYASAR_SECRET_KEY}:`)}`, "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await r.text().catch(() => "");
  if (!r.ok) throw new PayError("gateway", sanitize(`moyasar ${r.status}: ${text.slice(0, 200)}`), 502);
  return JSON.parse(text) as Invoice;
}

/** Creates an invoice for one period of a plan and returns the payment page the customer is sent to. */
export async function startCardPayment(env: Env, tenantId: number, planId: string, actor: string, siteOrigin?: string, now = Date.now()): Promise<{ id: number; url: string }> {
  if (!cardEnabled(env)) throw new PayError("card_off", "الدفع بالبطاقة غير متاح حاليًا — استخدم طرق الدفع الأخرى", 409);
  const plan = await payablePlan(env, planId);
  if (!plan) throw new PayError("not_payable", "هذي الباقة ما تندفع بالبطاقة — استخدم طرق الدفع الأخرى");
  return createInvoice(env, { tenantId, planId: plan.id, days: plan.days, amount: plan.amount, description: `شيّك — ${plan.name} (${plan.days} يوم)`, actor, siteOrigin }, now);
}

/** Opens a Moyasar invoice for an amount (a plan period, or an upgrade difference when `upgradeId` is set). */
export async function createInvoice(
  env: Env,
  o: { tenantId: number; planId: string; days: number; amount: number; description: string; actor: string; siteOrigin?: string; upgradeId?: number; topup?: { packId: number; messages: number } },
  now = Date.now(),
): Promise<{ id: number; url: string }> {
  if (!cardEnabled(env)) throw new PayError("card_off", "الدفع بالبطاقة غير متاح حاليًا — استخدم طرق الدفع الأخرى", 409);
  if (o.amount < 100) throw new PayError("too_small", "أقل مبلغ للدفع بالبطاقة 1 ر.س");
  const row = await run(
    env.DB,
    "INSERT INTO card_payments (tenant_id, plan_id, days, amount, currency, created_by, upgrade_id, topup_pack_id, topup_messages, created_at, updated_at) VALUES (?, ?, ?, ?, 'SAR', ?, ?, ?, ?, ?, ?)",
    o.tenantId, o.planId, o.days, o.amount, o.actor, o.upgradeId ?? null, o.topup?.packId ?? null, o.topup?.messages ?? null, now, now,
  );
  const id = Number(row.meta.last_row_id);
  const base = env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  // The customer comes back to the domain they paid from (their session cookie lives there).
  const site = (o.siteOrigin || base).replace(/\/+$/, "");
  try {
    const inv = await moyasar(env, "/invoices", {
      method: "POST",
      body: {
        amount: o.amount,
        currency: "SAR",
        description: o.description,
        callback_url: `${base}/webhooks/moyasar`,
        success_url: `${site}/#/subscription?paid=${id}`,
        back_url: `${site}/#/subscription`,
        expired_at: new Date(now + 2 * 3_600_000).toISOString(),
        metadata: { payment_id: String(id), tenant_id: String(o.tenantId), plan_id: o.planId, ...(o.upgradeId ? { upgrade_id: String(o.upgradeId) } : {}), ...(o.topup ? { topup_messages: String(o.topup.messages) } : {}) },
      },
    });
    if (!inv.id || !inv.url) throw new PayError("gateway", "ردّ بوابة الدفع ناقص", 502);
    await run(env.DB, "UPDATE card_payments SET invoice_id = ?, updated_at = ? WHERE id = ?", inv.id, now, id);
    return { id, url: inv.url };
  } catch (e) {
    await run(env.DB, "UPDATE card_payments SET status = 'error', updated_at = ? WHERE id = ?", now, id);
    console.error("moyasar create", sanitize(String((e as Error)?.message ?? e)));
    if (e instanceof PayError && e.code !== "gateway") throw e;
    throw new PayError("gateway", "تعذر فتح صفحة الدفع الحين — جرّب بعد شوي", 502);
  }
}

/** An active plan that can be paid by card now, with its price and the days it buys. */
export async function payablePlan(env: Env, planId: string): Promise<{ id: string; name: string; amount: number; days: number } | null> {
  if (!cardEnabled(env)) return null;
  const p = await first<{ id: string; name: string; active: number; card_price_halalas: number | null; price_amount: number | null; price_currency: string; price_period: string }>(
    env.DB,
    "SELECT id, name, active, card_price_halalas, price_amount, price_currency, price_period FROM plans WHERE id = ?",
    planId,
  );
  const amount = p?.active ? cardPriceHalalas(p) : null;
  return p && amount ? { id: p.id, name: p.name, amount, days: PERIOD_DAYS[p.price_period] } : null;
}

const FINAL = ["failed", "canceled", "expired", "voided", "refunded"];

/**
 * Re-reads an invoice from Moyasar and applies it: a paid invoice with the exact amount activates the plan once
 * (the status change is atomic, so a callback and a status check arriving together cannot both extend it).
 */
export async function syncInvoice(env: Env, invoiceId: string, now = Date.now()): Promise<string> {
  const pay = await first<{ id: number; tenant_id: number; plan_id: string; days: number; amount: number; currency: string; status: string; upgrade_id: number | null; topup_pack_id: number | null; topup_messages: number | null }>(
    env.DB,
    "SELECT id, tenant_id, plan_id, days, amount, currency, status, upgrade_id, topup_pack_id, topup_messages FROM card_payments WHERE invoice_id = ?",
    invoiceId,
  );
  if (!pay) return "unknown";
  if (pay.status === "paid") return "paid";
  const inv = await moyasar(env, `/invoices/${encodeURIComponent(invoiceId)}`, { method: "GET" });
  if (inv.id !== invoiceId) return "mismatch";
  if (inv.status === "paid") {
    if (inv.amount !== pay.amount || inv.currency !== pay.currency) {
      await run(env.DB, "UPDATE card_payments SET status = 'mismatch', updated_at = ? WHERE id = ?", now, pay.id);
      await notify(env, OWNER_TENANT, "plan", `⚠️ دفعة بالبطاقة رقم ${pay.id} مبلغها ما يطابق الفاتورة — ما فعّلنا شي. راجعها في لوحة ميسّر.`);
      return "mismatch";
    }
    const claimed = await run(env.DB, "UPDATE card_payments SET status = 'paid', paid_at = ?, updated_at = ? WHERE id = ? AND status != 'paid'", now, now, pay.id);
    if (!claimed.meta.changes) return "paid";
    if (pay.upgrade_id) {
      await applyUpgrade(env, pay.upgrade_id, `payment:${pay.id}`, now, { id: pay.id, amount: pay.amount });
      return "paid";
    }
    if (pay.topup_messages) {
      await applyTopup(env, { tenantId: pay.tenant_id, messages: pay.topup_messages, packId: pay.topup_pack_id, paymentId: pay.id, amount: pay.amount }, now);
      return "paid";
    }
    const r = await withSchedulingNotice(env, pay.tenant_id, () => extendPlan(env.DB, pay.tenant_id, pay.plan_id, pay.days, now));
    const t = await first<{ name: string }>(env.DB, "SELECT name FROM tenants WHERE id = ?", pay.tenant_id);
    const plan = await first<{ name: string }>(env.DB, "SELECT name FROM plans WHERE id = ?", pay.plan_id);
    const sar = (pay.amount / 100).toLocaleString("en-US");
    await audit(env.DB, pay.tenant_id, "moyasar", "subscription.card_paid", pay.plan_id, { payment: pay.id, amount: pay.amount, expires_at: r.expires_at });
    await notify(env, pay.tenant_id, "plan", `✅ وصلنا دفعك (${sar} ر.س) وتفعّلت باقة «${plan?.name ?? pay.plan_id}» ${pay.days} يوم. شكرًا لك 💜`, undefined, { link: "/subscription" });
    await notify(env, OWNER_TENANT, "plan", `💳 دفع بالبطاقة: «${t?.name ?? pay.tenant_id}» دفع ${sar} ر.س — باقة «${plan?.name ?? pay.plan_id}» ${pay.days} يوم${isTestKey(env) ? " (تجريبي)" : ""}`);
    return "paid";
  }
  if (FINAL.includes(inv.status) && inv.status !== pay.status) await run(env.DB, "UPDATE card_payments SET status = ?, updated_at = ? WHERE id = ? AND status != 'paid'", inv.status, now, pay.id);
  return inv.status;
}

/**
 * Moves the customer of an approved (or just paid) upgrade to the new plan, keeping the expiry date, once.
 * `payment` = the card payment of the difference (honoured even if the request was cancelled or rejected while the
 * payment page was open — the customer paid); none when the owner approved it for free.
 */
export async function applyUpgrade(env: Env, upgradeId: number, actor: string, now = Date.now(), payment?: { id: number; amount: number }): Promise<boolean> {
  const paymentId = payment?.id;
  const u = await first<{ id: number; tenant_id: number; from_plan: string; to_plan: string; amount: number | null }>(
    env.DB,
    "SELECT id, tenant_id, from_plan, to_plan, amount FROM plan_upgrades WHERE id = ?",
    upgradeId,
  );
  if (!u) return false;
  const done = await run(
    env.DB,
    `UPDATE plan_upgrades SET status = ?, payment_id = ?, amount = COALESCE(?, amount), updated_at = ? WHERE id = ? AND status IN (${paymentId ? "'approved', 'pending', 'canceled', 'rejected'" : "'approved', 'pending'"})`,
    paymentId ? "paid" : "done", paymentId ?? null, payment?.amount ?? null, now, u.id,
  );
  if (!done.meta.changes) return false;
  await withSchedulingNotice(env, u.tenant_id, () => run(env.DB, "UPDATE tenants SET plan_id = ?, updated_at = ? WHERE id = ?", u.to_plan, now, u.tenant_id));
  const t = await first<{ name: string; plan_expires_at: number | null }>(env.DB, "SELECT name, plan_expires_at FROM tenants WHERE id = ?", u.tenant_id);
  const to = await first<{ name: string }>(env.DB, "SELECT name FROM plans WHERE id = ?", u.to_plan);
  const paid = payment?.amount ?? u.amount ?? 0;
  const sar = (paid / 100).toLocaleString("en-US");
  await audit(env.DB, u.tenant_id, actor, "subscription.upgraded", u.to_plan, { upgrade: u.id, from: u.from_plan, amount: paid, payment: paymentId ?? null });
  await notify(env, u.tenant_id, "plan", `⬆️ تمت ترقية باقتك إلى «${to?.name ?? u.to_plan}»${paymentId ? ` (دفعت الفرق ${sar} ر.س)` : ""} — تاريخ الانتهاء نفسه وحدود الباقة الجديدة تشتغل من الحين.`, undefined, { link: "/subscription" });
  if (paymentId)
    await notify(env, OWNER_TENANT, "plan", `💳 دفع فرق ترقية: «${t?.name ?? u.tenant_id}» دفع ${sar} ر.س وترقّى إلى «${to?.name ?? u.to_plan}»${isTestKey(env) ? " (تجريبي)" : ""}`, undefined, { link: "/owner?tab=payments" });
  if (!t?.plan_expires_at || t.plan_expires_at <= now)
    await notify(env, OWNER_TENANT, "plan", `⚠️ ترقية رقم ${u.id}: اشتراك «${t?.name ?? u.tenant_id}» منتهي — تغيّرت الباقة لكن ما في أيام. راجعه من صفحة العملاء.`);
  return true;
}
