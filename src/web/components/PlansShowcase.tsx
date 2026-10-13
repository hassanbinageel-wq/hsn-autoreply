import { useState } from "react";
import { Icon } from "./Icon";
import { Tip, toast } from "./ui";
import { CURRENCIES, EVENT_LABELS, FEATURE_HINTS, FEATURE_LABELS, LIMIT_HINTS, PRICE_PERIODS, convertPrice, formatAmount, type ExchangeRates, type PlanLimits } from "../../shared/plans";

export interface Catalog {
  plans: Array<{ id: string; name: string; price_label: string | null; price_amount: number | null; price_currency: string; price_period: string; description: string | null; limits: PlanLimits }>;
  rates: ExchangeRates;
  payment_methods: Array<{ id: number; name: string; kind: "bank" | "exchange"; logo: string | null; accounts: Array<{ id: number; holder: string; number: string; currency: string | null; note: string | null }> }>;
  sales_contact: string | null;
}

const n = (v: number | null) => (v === null ? "غير محدود" : v.toLocaleString("en-US"));

/** Every point of a plan, each with a hover / tap explanation. */
export function Features({ limits }: { limits: PlanLimits }) {
  const row = (on: boolean, text: string, hint?: string) => (
    <li className="flex items-start gap-2">
      <span className={`mt-0.5 flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full ${on ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : "bg-[var(--border)] text-[var(--text-2)]"}`}>
        <Icon name={on ? "check" : "x"} size={11} />
      </span>
      <Tip text={hint}><span className={on ? "" : "muted line-through decoration-1"}>{text}</span></Tip>
    </li>
  );
  return (
    <ul className="space-y-2 text-sm">
      {row(true, limits.events.map((e) => EVENT_LABELS[e] ?? e).join(" · ") || "—", LIMIT_HINTS.events)}
      {row(true, `الحملات النشطة: ${n(limits.active_campaigns)}`, LIMIT_HINTS.active_campaigns)}
      {row(true, `الرسائل شهريًا: ${n(limits.monthly_messages)}`, LIMIT_HINTS.monthly_messages)}
      {row(limits.draws_per_month !== 0, `السحوبات: ${limits.draws_per_month === null ? "غير محدودة" : `${limits.draws_per_month} شهريًا`}`, LIMIT_HINTS.draws_per_month)}
      {Object.entries(FEATURE_LABELS).map(([k, label]) => <span key={k} className="contents">{row(!!(limits as any)[k], label, FEATURE_HINTS[k])}</span>)}
    </ul>
  );
}

/** "أرسل السند هنا" → WhatsApp / Instagram / any link the owner set. */
function contactKind(url: string): { icon: string; label: string } {
  if (/wa\.me|whatsapp/i.test(url)) return { icon: "whatsapp", label: "واتساب" };
  if (/instagram\.com|ig\.me/i.test(url)) return { icon: "instagram", label: "إنستقرام" };
  if (/t\.me|telegram/i.test(url)) return { icon: "telegram", label: "تيليجرام" };
  return { icon: "send", label: "التواصل" };
}

function copy(text: string) {
  navigator.clipboard?.writeText(text).then(() => toast("تم النسخ ✅"), () => toast(text));
}

export function PaymentMethods({ catalog }: { catalog: Catalog }) {
  if (!catalog.payment_methods.length && !catalog.sales_contact) return null;
  const contact = catalog.sales_contact ? contactKind(catalog.sales_contact) : null;
  return (
    <section id="payment" className="scroll-mt-6 space-y-4">
      <div className="text-center">
        <h2 className="font-display text-xl font-extrabold sm:text-2xl">طريقة الاشتراك</h2>
        <p className="muted mt-1 text-sm">ثلاث خطوات بسيطة ويوصلك كود التفعيل</p>
      </div>
      <ol className="grid gap-3 sm:grid-cols-3">
        {[
          ["1", "اختر الباقة", "واختر المدة اللي تناسبك"],
          ["2", "حوّل المبلغ", "لأحد الحسابات بالأسفل بالعملة اللي تناسبك"],
          ["3", "أرسل السند", "ويوصلك كود التفعيل لإنشاء حسابك"],
        ].map(([k, t, d]) => (
          <li key={k} className="card flex items-center gap-3 p-3.5">
            <span className="grad font-display flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-base font-extrabold text-white">{k}</span>
            <span className="leading-tight"><b className="block">{t}</b><span className="muted text-xs">{d}</span></span>
          </li>
        ))}
      </ol>
      {catalog.payment_methods.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2">
          {catalog.payment_methods.map((p) => (
            <div key={p.id} className="card overflow-hidden">
              <div className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-3">
                {p.logo ? (
                  <img src={p.logo} alt="" className="h-11 w-11 shrink-0 rounded-xl bg-white object-contain p-1 ring-1 ring-[var(--border)]" />
                ) : (
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-violet-500/10 text-violet-600 dark:text-violet-300"><Icon name="bank" size={22} /></span>
                )}
                <span className="min-w-0">
                  <b className="font-display block truncate">{p.name}</b>
                  <span className="muted text-xs">{p.kind === "exchange" ? "صرافة" : "بنك"} · {p.accounts.length} {p.accounts.length === 1 ? "حساب" : "حسابات"}</span>
                </span>
              </div>
              <ul className="divide-y divide-[var(--border)]">
                {p.accounts.map((a) => (
                  <li key={a.id} className="flex items-center gap-3 px-4 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5 text-xs">
                        {a.currency && <span className="chip bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">{CURRENCIES.find((c) => c.code === a.currency)?.name ?? a.currency}</span>}
                        <span className="muted truncate">{a.holder}</span>
                      </div>
                      <div className="font-mono mt-0.5 truncate text-[15px] font-bold tracking-wide" dir="ltr" style={{ textAlign: "right" }}>{a.number}</div>
                      {a.note && <div className="muted text-[11px]">{a.note}</div>}
                    </div>
                    <button type="button" className="btn btn-ghost min-h-9 shrink-0 px-2.5 text-xs" onClick={() => copy(a.number)} aria-label={`نسخ رقم الحساب ${a.number}`}><Icon name="copy" size={15} />نسخ</button>
                  </li>
                ))}
                {!p.accounts.length && <li className="muted px-4 py-3 text-sm">لا توجد حسابات بعد</li>}
              </ul>
            </div>
          ))}
        </div>
      )}
      {catalog.sales_contact && contact && (
        <a href={catalog.sales_contact} target="_blank" rel="noopener" className="flex items-center gap-3 rounded-2xl border-2 border-dashed border-emerald-500/50 bg-emerald-500/5 p-4 transition hover:bg-emerald-500/10">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-500 text-white"><Icon name={contact.icon} size={22} /></span>
          <span className="flex-1 leading-tight">
            <b className="font-display block text-base">حوّلت المبلغ؟ أرسل السند هنا</b>
            <span className="muted text-xs">اضغط وأرسل صورة السند عبر {contact.label} — يوصلك كود التفعيل بعد التأكد</span>
          </span>
          <Icon name="arrowL" size={20} className="text-emerald-600" />
        </a>
      )}
    </section>
  );
}

/** Plan cards with a currency switcher, prices converted with the owner's exchange rates. */
export function PlanCards({ catalog, currentPlanId, onChoose }: { catalog: Catalog; currentPlanId?: string | null; onChoose?: () => void }) {
  const first = catalog.plans.find((p) => p.price_amount !== null)?.price_currency ?? "SAR";
  const [cur, setCur] = useState(first);
  const featured = catalog.plans.length >= 3 ? catalog.plans[1].id : null;
  const anyPrice = catalog.plans.some((p) => p.price_amount !== null);
  return (
    <div className="space-y-4">
      {anyPrice && (
        <div className="flex justify-center">
          <div className="inline-flex flex-wrap justify-center gap-1 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-1" role="tablist" aria-label="العملة">
            {CURRENCIES.map((c) => (
              <button key={c.code} type="button" role="tab" aria-selected={cur === c.code} onClick={() => setCur(c.code)} className={`rounded-xl px-3 py-1.5 text-xs font-bold transition sm:text-sm ${cur === c.code ? "grad text-white shadow" : "muted hover:text-[var(--text)]"}`}>
                {c.name}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="grid items-stretch gap-4 md:grid-cols-3">
        {catalog.plans.map((p) => {
          const price = p.price_amount !== null ? convertPrice(p.price_amount, p.price_currency, cur, catalog.rates) : null;
          const isFeatured = p.id === featured;
          const isCurrent = p.id === currentPlanId;
          return (
            <div key={p.id} className={`card relative flex flex-col p-5 ${isFeatured ? "ring-2 ring-violet-500 md:-translate-y-1 md:shadow-xl md:shadow-violet-500/10" : ""}`}>
              {isFeatured && <span className="grad absolute -top-3 left-1/2 -translate-x-1/2 rounded-full px-3 py-1 text-[11px] font-extrabold text-white shadow">الأكثر طلبًا</span>}
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
                  </div>
                ) : (
                  <span className="font-display text-2xl font-extrabold text-violet-600 dark:text-violet-300">{p.price_label || "تواصل معنا"}</span>
                )}
              </div>
              <div className="mt-4 flex-1"><Features limits={p.limits} /></div>
              {onChoose && (
                <button type="button" onClick={onChoose} className={`btn mt-5 w-full ${isFeatured ? "btn-primary" : "btn-ghost"}`}>اشترك في {p.name}</button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function PlansShowcase({ catalog, currentPlanId }: { catalog: Catalog; currentPlanId?: string | null }) {
  const toPayment = () => document.getElementById("payment")?.scrollIntoView({ behavior: "smooth", block: "start" });
  const hasPayment = catalog.payment_methods.length > 0 || !!catalog.sales_contact;
  return (
    <div className="space-y-10">
      <PlanCards catalog={catalog} currentPlanId={currentPlanId} onChoose={hasPayment ? toPayment : undefined} />
      <PaymentMethods catalog={catalog} />
    </div>
  );
}
