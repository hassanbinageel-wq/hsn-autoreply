import type { Env } from "../env";
import { first } from "../lib/db";
import { cardPriceHalalas, PayError } from "./moyasar";
import { discounted, offerDiscount } from "./offers";
import { CYCLE_MS, monthlyMessages, parseLimits, PERIOD_DAYS, usageCycle } from "./plans";

const DAY = 86_400_000;

export interface UpgradeQuote {
  from_plan: string;
  to_plan: string;
  /** Card prices of one period, in halalas. */
  from_price: number;
  to_price: number;
  days_left: number;
  /** Messages sent in the current cycle, and the current plan's limit for a cycle (null = unlimited). */
  used_messages: number;
  messages_limit: number | null;
  /** What the higher plan costs for the days left. */
  new_value: number;
  /** What is left of the current plan: its days left, less the messages used beyond the time that has passed. */
  credit: number;
  /** new_value − credit, rounded up to whole riyals, at least 1 SAR (halalas); less a running offer's discount. */
  amount: number;
  /** The offer discount (%) on the higher plan that this customer has now, already taken off `amount`. */
  discount_pct: number;
  offer_id: number | null;
}

type PlanPrice = { id: string; name: string; active: number; sort: number; limits: string; card_price_halalas: number | null; price_amount: number | null; price_currency: string; price_period: string };
const PLAN_Q = "SELECT id, name, active, sort, limits, card_price_halalas, price_amount, price_currency, price_period FROM plans WHERE id = ?";

/**
 * The price to move a customer with an active plan to a more expensive one, keeping the expiry date (the days that
 * passed are not given back). The customer pays the higher plan for the days left, less what is left of the current
 * plan. What is left counts the usage too: if more of this cycle's messages were used than the time that passed,
 * the extra share is not credited. Example: 49 → 99 SAR a month, nothing used on day 0 → 50 SAR; 15 days left with
 * half the messages used → 49.5 − 24.5 = 25 SAR; 15 days left with all messages used → 49.5 − 0 = 50 SAR.
 */
export async function quoteUpgrade(env: Env, tenantId: number, toPlan: string, now = Date.now()): Promise<UpgradeQuote> {
  const t = await first<{ status: string; plan_id: string | null; plan_expires_at: number | null }>(env.DB, "SELECT status, plan_id, plan_expires_at FROM tenants WHERE id = ?", tenantId);
  if (!t || t.status !== "active" || !t.plan_id || !t.plan_expires_at || t.plan_expires_at <= now)
    throw new PayError("no_active_plan", "الترقية لمن عنده اشتراك فعّال — اشترك بالباقة مباشرة");
  if (t.plan_id === toPlan) throw new PayError("same_plan", "هذي باقتك الحالية");
  const from = await first<PlanPrice>(env.DB, PLAN_Q, t.plan_id);
  const to = await first<PlanPrice>(env.DB, PLAN_Q, toPlan);
  if (!to?.active) throw new PayError("not_found", "الباقة غير متاحة");
  const fromPrice = from ? cardPriceHalalas(from) : null;
  const toPrice = cardPriceHalalas(to);
  if (!fromPrice || !toPrice) throw new PayError("not_payable", "الترقية بالدفع تحتاج سعر بطاقة للباقتين — تواصل معنا");
  const fromPerDay = fromPrice / PERIOD_DAYS[from!.price_period];
  const toPerDay = toPrice / PERIOD_DAYS[to.price_period];
  if (toPerDay <= fromPerDay) throw new PayError("not_higher", "الترقية لباقة أعلى فقط — والتنزيل يكون بعد انتهاء اشتراكك");

  const leftDays = (t.plan_expires_at - now) / DAY;
  const used = await monthlyMessages(env.DB, tenantId, now);
  const limit = parseLimits(from!.limits).monthly_messages;
  // This cycle: share of time still ahead vs share of messages still unused; usage ahead of time is not credited.
  const cy = await usageCycle(env.DB, tenantId, now);
  const timeAhead = Math.max(0, Math.min(cy.end, t.plan_expires_at) - now) / CYCLE_MS;
  const unused = limit ? Math.max(0, 1 - used / limit) : 1;
  const overUse = Math.max(0, timeAhead - unused) * fromPerDay * (CYCLE_MS / DAY);
  const newValue = Math.round(toPerDay * leftDays);
  const credit = Math.max(0, Math.round(fromPerDay * leftDays - overUse));
  const full = Math.max(100, Math.ceil((newValue - credit) / 100) * 100);
  const off = await offerDiscount(env.DB, tenantId, to.id, now);
  const amount = off ? discounted(full, off.pct) : full;
  return {
    from_plan: t.plan_id,
    to_plan: to.id,
    from_price: fromPrice,
    to_price: toPrice,
    days_left: Math.ceil(leftDays),
    used_messages: used,
    messages_limit: limit,
    new_value: newValue,
    credit,
    amount,
    discount_pct: off?.pct ?? 0,
    offer_id: off?.offer_id ?? null,
  };
}

/**
 * Moving to another plan while the current one is active: only up, and only through an upgrade (the difference);
 * a lower plan waits until the subscription ends. Renewing the same plan is always fine. Null = allowed.
 */
export async function planChangeBlock(env: Env, tenantId: number, planId: string, now = Date.now()): Promise<{ code: string; message: string } | null> {
  const t = await first<{ plan_id: string | null; plan_expires_at: number | null }>(env.DB, "SELECT plan_id, plan_expires_at FROM tenants WHERE id = ?", tenantId);
  if (!t?.plan_id || t.plan_id === planId || !t.plan_expires_at || t.plan_expires_at <= now) return null;
  const cur = await first<{ sort: number; free: number }>(env.DB, "SELECT sort, free FROM plans WHERE id = ?", t.plan_id);
  // From the free plan any paid plan is bought directly (a fresh period, no difference to pay).
  if (cur?.free) return null;
  const next = await first<{ sort: number }>(env.DB, "SELECT sort FROM plans WHERE id = ?", planId);
  if (!cur || !next) return null;
  return next.sort < cur.sort
    ? { code: "downgrade", message: "ما تقدر تنزل لباقة أقل وانت مشترك — تقدر تختارها بعد ما ينتهي اشتراكك الحالي" }
    : { code: "use_upgrade", message: "للانتقال لباقة أعلى استخدم «ترقية الباقة» وادفع الفرق فقط" };
}
