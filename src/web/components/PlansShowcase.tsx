import { API_BASE } from "../platform";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { Field, Modal, Tip, toast } from "./ui";
import { CURRENCIES, EVENT_LABELS, FEATURE_HINTS, FEATURE_LABELS, LIMIT_HINTS, PRICE_PERIODS, convertPrice, formatAmount, orderFeatures, type ExchangeRates, type PlanLimits } from "../../shared/plans";

export interface Catalog {
  plans: Array<{ id: string; name: string; price_label: string | null; price_amount: number | null; price_before?: number | null; price_currency: string; price_period: string; description: string | null; limits: PlanLimits; card_price?: number | null }>;
  rates: ExchangeRates;
  featured?: { plan_id: string | null; label: string };
  feature_order?: string[];
  payment_methods: Array<{ id: number; name: string; kind: "bank" | "exchange" | "wallet"; logo: string | null; accounts: Array<{ id: number; holder: string; number: string; currency: string | null; note: string | null }> }>;
  sales_contact: string | null;
  card_button_label?: string;
}

const n = (v: number | null) => (v === null ? "غير محدود" : v.toLocaleString("en-US"));

/** Every point of a plan, each with a hover / tap explanation, in the order the owner set. */
export function Features({ limits, order, hideMissing = false }: { limits: PlanLimits; order?: string[]; hideMissing?: boolean }) {
  const row = (key: string, on: boolean, text: string, hint?: string) => (
    <li key={key} className="flex items-start gap-2">
      <span className={`mt-0.5 flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full ${on ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : "bg-[var(--border)] text-[var(--text-2)]"}`}>
        <Icon name={on ? "check" : "x"} size={11} />
      </span>
      <Tip text={hint}><span className={on ? "" : "muted line-through decoration-1"}>{text}</span></Tip>
    </li>
  );
  const render = (k: string) => {
    if (k === "events") return row(k, true, limits.events.map((e) => EVENT_LABELS[e] ?? e).join(" · ") || "—", LIMIT_HINTS.events);
    if (k === "active_campaigns") return row(k, true, `الحملات النشطة: ${n(limits.active_campaigns)}`, LIMIT_HINTS.active_campaigns);
    if (k === "monthly_messages") return row(k, true, `الرسائل شهريًا: ${n(limits.monthly_messages)}`, LIMIT_HINTS.monthly_messages);
    if (k === "draws_per_month") return row(k, limits.draws_per_month !== 0, `السحوبات: ${limits.draws_per_month === null ? "غير محدودة" : `${limits.draws_per_month} شهريًا`}`, LIMIT_HINTS.draws_per_month);
    if (k === "staff") return row(k, (limits.staff ?? 0) !== 0, `الموظفين: ${limits.staff === null ? "حتى 10" : limits.staff ? `${limits.staff} ${limits.staff === 1 ? "موظف" : "موظفين"}` : "بدون"}`, LIMIT_HINTS.staff);
    return row(k, !!(limits as any)[k], FEATURE_LABELS[k], FEATURE_HINTS[k]);
  };
  const keys = orderFeatures(order);
  if (!hideMissing) return <ul className="space-y-2 text-sm">{keys.map(render)}</ul>;
  // Plan cards: what the plan includes; what it lacks folds into one line so plans compare at a glance.
  const included = (k: string) => (k === "draws_per_month" ? limits.draws_per_month !== 0 : k === "staff" ? (limits.staff ?? 0) !== 0 : k in LIMIT_HINTS || !!(limits as any)[k]);
  const missing = keys.filter((k) => !included(k));
  return (
    <div className="text-sm">
      <ul className="space-y-2">{keys.filter(included).map(render)}</ul>
      {missing.length > 0 && (
        <details className="group mt-3">
          <summary className="muted inline-flex min-h-8 cursor-pointer list-none items-center gap-1.5 text-xs font-semibold [&::-webkit-details-marker]:hidden">
            <Icon name="chev" size={14} className="transition group-open:rotate-180" />
            {missing.length} {missing.length <= 10 ? "مزايا" : "ميزة"} في الباقات الأعلى
          </summary>
          <ul className="mt-2 space-y-2">{missing.map(render)}</ul>
        </details>
      )}
    </div>
  );
}

export type Coupon = { code: string; percent: number; plans: string[] | null } | null;

/** The coupon's discount for a plan (0 when it does not apply). */
const off = (c: Coupon, planId: string) => (c && (!c.plans || c.plans.includes(planId)) ? c.percent : 0);
const discounted = (v: number, pct: number) => (pct ? Math.round(v * (100 - pct)) / 100 : v);

const priceText = (p: Catalog["plans"][number], cur: string, rates: ExchangeRates, coupon: Coupon = null) => {
  if (p.price_amount === null) return p.price_label || "حسب الاتفاق";
  const raw = convertPrice(p.price_amount, p.price_currency, cur, rates);
  const v = raw === null ? null : discounted(raw, off(coupon, p.id));
  return v === null ? p.price_label ?? "" : `${formatAmount(v, cur)} / ${PRICE_PERIODS[p.price_period] ?? PRICE_PERIODS.month}`;
};

/**
 * Plan cards, prices converted with the owner's exchange rates. On phones they are a swipeable carousel
 * (first plan shown first, an arrow and dots to move to the next); from md up a three-column grid.
 */
export function PlanCards({ catalog, cur, currentPlanId, onChoose, onCardPay, coupon = null }: { catalog: Catalog; cur: string; currentPlanId?: string | null; onChoose?: () => void; onCardPay?: (planId: string) => void; coupon?: Coupon }) {
  const featured = catalog.featured ? catalog.featured.plan_id : catalog.plans.length >= 3 ? catalog.plans[1].id : null;
  const badge = catalog.featured?.label || "الأكثر طلبًا";
  const track = useRef<HTMLDivElement>(null);
  const cards = useRef<Array<HTMLDivElement | null>>([]);
  const [active, setActive] = useState(0);
  useEffect(() => {
    const root = track.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => entries.forEach((en) => en.isIntersecting && setActive(Number((en.target as HTMLElement).dataset.i))),
      { root, threshold: 0.6 },
    );
    cards.current.forEach((c) => c && io.observe(c));
    return () => io.disconnect();
  }, [catalog.plans.length]);
  const go = (i: number) => cards.current[Math.max(0, Math.min(catalog.plans.length - 1, i))]?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  const many = catalog.plans.length > 1;
  return (
    <div className="relative">
      <div ref={track} className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-smooth px-[8%] pb-2 pt-4 [scrollbar-width:none] sm:px-[18%] lg:mx-0 lg:grid lg:grid-cols-3 lg:items-stretch lg:gap-4 lg:overflow-visible lg:px-0 [&::-webkit-scrollbar]:hidden">
        {catalog.plans.map((p, i) => {
          const before = p.price_amount !== null ? convertPrice(p.price_amount, p.price_currency, cur, catalog.rates) : null;
          const pct = off(coupon, p.id);
          const price = before === null ? null : discounted(before, pct);
          // The owner's "price before" (struck through), or the price before the coupon.
          const old = pct > 0 ? before : p.price_before ? convertPrice(p.price_before, p.price_currency, cur, catalog.rates) : null;
          const isFeatured = p.id === featured;
          const isCurrent = p.id === currentPlanId;
          return (
            <div key={p.id} ref={(el) => { cards.current[i] = el; }} data-i={i} className={`card relative flex w-[84%] min-w-0 shrink-0 snap-center flex-col p-5 sm:w-[64%] lg:w-auto ${isFeatured ? "ring-2 ring-violet-500 lg:-translate-y-1 lg:shadow-xl lg:shadow-violet-500/10" : ""}`}>
              {isFeatured && <span className="grad absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full px-3 py-1 text-[11px] font-extrabold text-white shadow">{badge}</span>}
              <div className="flex items-start justify-between gap-2">
                <b className="font-display text-lg font-extrabold">{p.name}</b>
                {isCurrent && <span className="chip bg-violet-500/10 text-violet-700 dark:text-violet-200">باقتك</span>}
              </div>
              {p.description && <p className="muted mt-1 min-h-[2.5em] text-xs leading-relaxed">{p.description}</p>}
              <div className="mt-3 border-y border-[var(--border)] py-3">
                {price !== null ? (
                  <div className="flex flex-wrap items-baseline gap-1.5">
                    <span className={`font-display font-extrabold text-violet-600 dark:text-violet-300 ${cur.startsWith("YER") ? "text-2xl" : "text-3xl"}`}>{formatAmount(price, cur)}</span>
                    <span className="muted text-sm">/ {PRICE_PERIODS[p.price_period] ?? PRICE_PERIODS.month}</span>
                    {old !== null && price !== null && old > price && (
                      <span className="w-full text-xs"><s className="muted text-sm">{formatAmount(old, cur)}</s> <b className="text-emerald-600">خصم {pct > 0 ? pct : Math.round((1 - price / old) * 100)}%</b></span>
                    )}
                  </div>
                ) : (
                  <span className="font-display text-2xl font-extrabold text-violet-600 dark:text-violet-300">{p.price_label || "تواصل معنا"}</span>
                )}
              </div>
              {onCardPay && p.card_price ? (
                <>
                  <button type="button" onClick={() => onCardPay(p.id)} className={`btn mt-4 w-full ${isFeatured ? "btn-primary" : "btn-ghost"}`}>
                    {catalog.card_button_label || "اشترك الآن"}
                  </button>
                  <div className="muted mt-1 text-center text-[11px]">مدى · فيزا · ماستركارد · Apple Pay — تتفعّل فورًا</div>
                  {onChoose && <button type="button" onClick={onChoose} className="mt-1 w-full text-center text-xs font-semibold text-violet-700 underline dark:text-violet-300">أو تواصل معنا</button>}
                </>
              ) : onChoose ? (
                <button type="button" onClick={onChoose} className={`btn mt-4 w-full ${isFeatured ? "btn-primary" : "btn-ghost"}`}>اشترك في {p.name}</button>
              ) : null}
              <div className="mt-4 flex-1"><Features limits={p.limits} order={catalog.feature_order} hideMissing /></div>
            </div>
          );
        })}
      </div>
      {many && (
        <div className="mt-3 flex items-center justify-center gap-3 lg:hidden">
          <button type="button" aria-label="الباقة السابقة" disabled={active === 0} onClick={() => go(active - 1)} className="flex h-10 w-10 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] shadow-sm disabled:opacity-30">
            <Icon name="arrowL" size={18} className="rotate-180" />
          </button>
          <div className="flex gap-1.5" aria-hidden>
            {catalog.plans.map((p, i) => (
              <button key={p.id} type="button" tabIndex={-1} aria-label={`باقة ${p.name}`} onClick={() => go(i)} className="flex h-6 items-center px-0.5">
                <span className={`block h-2 rounded-full transition-all ${i === active ? "w-6 bg-violet-600" : "w-2 bg-[var(--border)]"}`} />
              </button>
            ))}
          </div>
          <button type="button" aria-label="الباقة التالية" disabled={active === catalog.plans.length - 1} onClick={() => go(active + 1)} className="grad flex h-10 w-10 items-center justify-center rounded-full text-white shadow disabled:opacity-30">
            <Icon name="arrowL" size={18} />
          </button>
        </div>
      )}
    </div>
  );
}

export function PlansShowcase({ catalog, currentPlanId, onCardPay }: { catalog: Catalog; currentPlanId?: string | null; onCardPay?: (planId: string) => void }) {
  // Prices are shown in Saudi riyals only (converted with the owner's rates when a plan is priced in another currency).
  const cur = "SAR";
  const [coupon, setCoupon] = useState<Coupon>(null);
  const contact = catalog.sales_contact;
  const anyPrice = catalog.plans.some((p) => p.price_amount !== null);
  return (
    <div className="space-y-4">
      {anyPrice && <CouponBox coupon={coupon} setCoupon={setCoupon} />}
      <PlanCards catalog={catalog} cur={cur} currentPlanId={currentPlanId} onChoose={contact ? () => window.open(contact, "_blank", "noopener") : undefined} onCardPay={onCardPay} coupon={coupon} />
    </div>
  );
}

/** «عندك كود خصم؟» — checks the code and shows the prices after the discount. */
function CouponBox({ coupon, setCoupon }: { coupon: Coupon; setCoupon: (c: Coupon) => void }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  if (coupon)
    return (
      <div className="mx-auto flex w-fit items-center gap-2 rounded-full bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-700 dark:text-emerald-300">
        ✅ كود <b dir="ltr">{coupon.code}</b>: خصم {coupon.percent}%{coupon.plans ? " على باقات محددة" : ""}
        <button type="button" className="text-xs underline" onClick={() => setCoupon(null)}>إزالة</button>
      </div>
    );
  if (!open) return <button type="button" className="mx-auto block text-sm font-semibold text-violet-700 underline dark:text-violet-300" onClick={() => setOpen(true)}>عندك كود خصم؟</button>;
  const apply = async () => {
    setBusy(true);
    try {
      const r = await fetch(`${API_BASE}/api/public/coupon?code=${encodeURIComponent(code)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error?.message ?? "كود الخصم غير صحيح أو منتهي");
      setCoupon({ code: j.code, percent: j.percent, plans: j.plans });
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto flex w-full max-w-sm gap-2">
      <input className="input" dir="ltr" placeholder="كود الخصم" value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, ""))} maxLength={30} onKeyDown={(e) => e.key === "Enter" && code.length >= 3 && apply()} />
      <button type="button" className="btn btn-primary shrink-0" disabled={busy || code.length < 3} onClick={apply}>{busy ? "…" : "تطبيق"}</button>
    </div>
  );
}
