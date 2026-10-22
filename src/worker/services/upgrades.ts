import type { Env } from "../env";
import { first } from "../lib/db";
import { cardPriceHalalas, PayError } from "./moyasar";
import { monthlyMessages, PERIOD_DAYS } from "./plans";

const DAY = 86_400_000;

export interface UpgradeQuote {
  from_plan: string;
  to_plan: string;
  /** Card prices of one period, in halalas. */
  from_price: number;
  to_price: number;
  period_days: number;
  days_left: number;
  /** Messages sent in the current cycle. */
  used_messages: number;
  /** The whole difference for the remaining period(s) — fair when nothing was used yet. */
  full: number;
  /** The difference for the days left only. */
  prorated: number;
  /** `full` when nothing was used in this cycle, else `prorated`; rounded up to whole riyals, at least 1 SAR. */
  suggested: number;
}

type PlanPrice = { id: string; name: string; active: number; card_price_halalas: number | null; price_amount: number | null; price_currency: string; price_period: string };

/** The price difference to move a customer with an active plan to a more expensive one, keeping the expiry date. */
export async function quoteUpgrade(env: Env, tenantId: number, toPlan: string, now = Date.now()): Promise<UpgradeQuote> {
  const t = await first<{ status: string; plan_id: string | null; plan_expires_at: number | null }>(env.DB, "SELECT status, plan_id, plan_expires_at FROM tenants WHERE id = ?", tenantId);
  if (!t || t.status !== "active" || !t.plan_id || !t.plan_expires_at || t.plan_expires_at <= now)
    throw new PayError("no_active_plan", "الترقية لمن عنده اشتراك فعّال — اشترك بالباقة مباشرة");
  if (t.plan_id === toPlan) throw new PayError("same_plan", "هذي باقتك الحالية");
  const q = "SELECT id, name, active, card_price_halalas, price_amount, price_currency, price_period FROM plans WHERE id = ?";
  const from = await first<PlanPrice>(env.DB, q, t.plan_id);
  const to = await first<PlanPrice>(env.DB, q, toPlan);
  if (!to?.active) throw new PayError("not_found", "الباقة غير متاحة");
  const fromPrice = from ? cardPriceHalalas(from) : null;
  const toPrice = cardPriceHalalas(to);
  if (!fromPrice || !toPrice) throw new PayError("not_payable", "الترقية بالدفع تحتاج سعر بطاقة للباقتين — تواصل معنا");
  const fromDays = PERIOD_DAYS[from!.price_period];
  const toDays = PERIOD_DAYS[to.price_period];
  const perDay = toPrice / toDays - fromPrice / fromDays;
  if (perDay <= 0) throw new PayError("not_higher", "الترقية لباقة أعلى سعرًا فقط");
  const leftDays = (t.plan_expires_at - now) / DAY;
  const daysLeft = Math.ceil(leftDays);
  const full = Math.round(perDay * Math.ceil(leftDays / toDays) * toDays);
  const prorated = Math.round(perDay * leftDays);
  const used = await monthlyMessages(env.DB, tenantId, now);
  const riyals = (h: number) => Math.max(100, Math.ceil(h / 100) * 100);
  return {
    from_plan: t.plan_id,
    to_plan: to.id,
    from_price: fromPrice,
    to_price: toPrice,
    period_days: toDays,
    days_left: daysLeft,
    used_messages: used,
    full,
    prorated,
    suggested: riyals(used === 0 ? full : prorated),
  };
}
