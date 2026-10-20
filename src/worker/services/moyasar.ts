import type { Env } from "../env";
import { audit, first, OWNER_TENANT, run } from "../lib/db";
import { sanitize } from "../meta/client";
import { notify } from "./notify";
import { extendPlan, PERIOD_DAYS } from "./plans";

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
  const plan = await first<{ id: string; name: string; active: number; card_price_halalas: number | null; price_period: string }>(
    env.DB,
    "SELECT id, name, active, card_price_halalas, price_period FROM plans WHERE id = ?",
    planId,
  );
  const days = plan ? PERIOD_DAYS[plan.price_period] : undefined;
  if (!plan || !plan.active || !plan.card_price_halalas || plan.card_price_halalas < 100 || !days) throw new PayError("not_payable", "هذي الباقة ما تندفع بالبطاقة — استخدم طرق الدفع الأخرى");
  const amount = plan.card_price_halalas;
  const row = await run(
    env.DB,
    "INSERT INTO card_payments (tenant_id, plan_id, days, amount, currency, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'SAR', ?, ?, ?)",
    tenantId, plan.id, days, amount, actor, now, now,
  );
  const id = Number(row.meta.last_row_id);
  const base = env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  // The customer comes back to the domain they paid from (their session cookie lives there).
  const site = (siteOrigin || base).replace(/\/+$/, "");
  try {
    const inv = await moyasar(env, "/invoices", {
      method: "POST",
      body: {
        amount,
        currency: "SAR",
        description: `HSN AutoReply — ${plan.name} (${days} يوم)`,
        callback_url: `${base}/webhooks/moyasar`,
        success_url: `${site}/#/subscription?paid=${id}`,
        back_url: `${site}/#/subscription`,
        expired_at: new Date(now + 2 * 3_600_000).toISOString(),
        metadata: { payment_id: String(id), tenant_id: String(tenantId), plan_id: plan.id },
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

const FINAL = ["failed", "canceled", "expired", "voided", "refunded"];

/**
 * Re-reads an invoice from Moyasar and applies it: a paid invoice with the exact amount activates the plan once
 * (the status change is atomic, so a callback and a status check arriving together cannot both extend it).
 */
export async function syncInvoice(env: Env, invoiceId: string, now = Date.now()): Promise<string> {
  const pay = await first<{ id: number; tenant_id: number; plan_id: string; days: number; amount: number; currency: string; status: string }>(
    env.DB,
    "SELECT id, tenant_id, plan_id, days, amount, currency, status FROM card_payments WHERE invoice_id = ?",
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
    const r = await extendPlan(env.DB, pay.tenant_id, pay.plan_id, pay.days, now);
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
