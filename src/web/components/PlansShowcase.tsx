import { API_BASE } from "../platform";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { Field, Modal, Tip, toast } from "./ui";
import { CURRENCIES, EVENT_LABELS, FEATURE_HINTS, FEATURE_LABELS, LIMIT_HINTS, PRICE_PERIODS, convertPrice, formatAmount, orderFeatures, type ExchangeRates, type PlanLimits } from "../../shared/plans";

export interface Catalog {
  plans: Array<{ id: string; name: string; price_label: string | null; price_amount: number | null; price_currency: string; price_period: string; description: string | null; limits: PlanLimits }>;
  rates: ExchangeRates;
  featured?: { plan_id: string | null; label: string };
  feature_order?: string[];
  payment_methods: Array<{ id: number; name: string; kind: "bank" | "exchange" | "wallet"; logo: string | null; accounts: Array<{ id: number; holder: string; number: string; currency: string | null; note: string | null }> }>;
  sales_contact: string | null;
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
    return row(k, !!(limits as any)[k], FEATURE_LABELS[k], FEATURE_HINTS[k]);
  };
  const keys = orderFeatures(order);
  if (!hideMissing) return <ul className="space-y-2 text-sm">{keys.map(render)}</ul>;
  // Plan cards: what the plan includes; what it lacks folds into one line so plans compare at a glance.
  const included = (k: string) => (k === "draws_per_month" ? limits.draws_per_month !== 0 : k in LIMIT_HINTS || !!(limits as any)[k]);
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

/** "Send the receipt": pick the plan, fill name / Instagram / phone / location, then open WhatsApp with a ready message. */
function ReceiptModal({ catalog, cur, coupon, onClose }: { catalog: Catalog; cur: string; coupon: Coupon; onClose: () => void }) {
  const [plan, setPlan] = useState<Catalog["plans"][number] | null>(null);
  const [f, setF] = useState({ name: "", ig: "", phone: "", place: "" });
  const contact = catalog.sales_contact!;
  const kind = contactKind(contact);
  const send = () => {
    const ig = f.ig.trim().replace(/^@+/, "");
    const text = [
      "السلام عليكم 👋 حوّلت مبلغ الاشتراك في HSN AutoReply وهذا السند:",
      "",
      `الباقة: ${plan!.name}`,
      `السعر: ${priceText(plan!, cur, catalog.rates, coupon)}`,
      ...(off(coupon, plan!.id) ? [`كود الخصم: ${coupon!.code} (−${coupon!.percent}%)`] : []),
      `الاسم: ${f.name.trim()}`,
      `حساب إنستقرام: @${ig}`,
      `رقم الجوال: ${f.phone.trim()}`,
      `الدولة / المحافظة: ${f.place.trim()}`,
      "",
      "📎 (أرفقت صورة السند)",
    ].join("\n");
    if (off(coupon, plan!.id)) void fetch(API_BASE + "/api/public/coupon/use", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: coupon!.code }) }).catch(() => undefined);
    const wa = contact.match(/wa\.me\/(\+?\d+)/i) ?? contact.match(/phone=(\+?\d+)/i);
    if (wa) {
      window.open(`https://wa.me/${wa[1].replace("+", "")}?text=${encodeURIComponent(text)}`, "_blank", "noopener");
    } else {
      // Instagram / other links cannot be pre-filled: copy the message, then open the chat.
      navigator.clipboard?.writeText(text).catch(() => undefined);
      toast(`نسخنا الرسالة ✅ الصقها في ${kind.label} وأرفق صورة السند`);
      window.open(contact, "_blank", "noopener");
    }
    onClose();
  };
  const ok = f.name.trim().length >= 2 && f.ig.trim().replace(/^@+/, "").length >= 2 && f.phone.replace(/\D/g, "").length >= 7 && f.place.trim().length >= 2;
  return (
    <Modal open onClose={onClose} title={plan ? `بياناتك — باقة ${plan.name}` : "اختر الباقة اللي اشتركت فيها"}>
      {!plan ? (
        <div className="space-y-2.5">
          {catalog.plans.map((p) => (
            <button key={p.id} type="button" onClick={() => setPlan(p)} className="flex w-full items-center justify-between gap-3 rounded-2xl border border-[var(--border)] px-4 py-3.5 text-right transition hover:border-violet-400 hover:bg-violet-500/5">
              <b className="font-display text-base">{p.name}</b>
              <span className="font-display font-extrabold text-violet-600 dark:text-violet-300">{priceText(p, cur, catalog.rates, coupon)}</span>
            </button>
          ))}
          <p className="muted pt-1 text-center text-xs">السعر بالعملة المختارة في صفحة الباقات</p>
        </div>
      ) : (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (ok) send(); }}>
          <div className="flex items-center justify-between rounded-2xl bg-violet-500/10 px-3.5 py-2.5 text-sm">
            <span><b>{plan.name}</b> · {priceText(plan, cur, catalog.rates, coupon)}{off(coupon, plan.id) ? <span className="mr-1 text-xs text-emerald-600">(−{coupon!.percent}%)</span> : null}</span>
            <button type="button" className="text-xs font-bold text-violet-600 underline dark:text-violet-300" onClick={() => setPlan(null)}>تغيير</button>
          </div>
          <Field label="الاسم"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={80} required autoComplete="name" /></Field>
          <Field label="حسابك في إنستقرام"><input className="input" dir="ltr" value={f.ig} onChange={(e) => setF({ ...f, ig: e.target.value })} maxLength={40} placeholder="@username" required /></Field>
          <Field label="رقم الجوال"><input className="input" dir="ltr" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} maxLength={20} placeholder="+967 7xx xxx xxx" required autoComplete="tel" /></Field>
          <Field label="الدولة / المحافظة"><input className="input" value={f.place} onChange={(e) => setF({ ...f, place: e.target.value })} maxLength={60} placeholder="مثل: اليمن / حضرموت" required /></Field>
          <button className="btn btn-primary w-full" disabled={!ok}><Icon name={kind.icon} size={18} />إرسال عبر {kind.label}</button>
          <p className="muted text-center text-[11px]">بنفتح لك {kind.label} برسالة جاهزة فيها بياناتك — أرفق صورة السند وأرسلها. ما نحفظ هذه البيانات عندنا.</p>
        </form>
      )}
    </Modal>
  );
}

const KIND: Record<string, string> = { bank: "بنك", exchange: "صرافة", wallet: "محفظة" };
/** Arabic-friendly match: ignores case, diacritics and alef / ya / ta-marbuta variants. */
const norm = (v: string) => v.toLowerCase().replace(/[\u064B-\u0652\u0640]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").trim();

export function PaymentMethods({ catalog, cur, coupon = null }: { catalog: Catalog; cur: string; coupon?: Coupon }) {
  const [receipt, setReceipt] = useState(false);
  const [q, setQ] = useState("");
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
      {catalog.payment_methods.length >= 2 && (
        <div className="relative mx-auto max-w-md">
          <Icon name="search" size={18} className="muted absolute right-3.5 top-1/2 -translate-y-1/2" />
          <input className="input !pr-10" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="ابحث باسم البنك أو الصرافة أو المحفظة" aria-label="بحث في طرق الدفع" />
        </div>
      )}
      {catalog.payment_methods.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2">
          {catalog.payment_methods.filter((p) => !q.trim() || norm(`${p.name} ${KIND[p.kind] ?? ""}`).includes(norm(q))).map((p) => (
            <div key={p.id} className="card overflow-hidden">
              <div className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-3">
                {p.logo ? (
                  <img src={p.logo} alt="" className="h-11 w-11 shrink-0 rounded-xl bg-white object-contain p-1 ring-1 ring-[var(--border)]" />
                ) : (
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-violet-500/10 text-violet-600 dark:text-violet-300"><Icon name="bank" size={22} /></span>
                )}
                <span className="min-w-0">
                  <b className="font-display block truncate">{p.name}</b>
                  <span className="muted text-xs">{KIND[p.kind] ?? "بنك"} · {p.accounts.length} {p.accounts.length === 1 ? "حساب" : "حسابات"}</span>
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
      {q.trim() && !catalog.payment_methods.some((p) => norm(`${p.name} ${KIND[p.kind] ?? ""}`).includes(norm(q))) && (
        <p className="muted text-center text-sm">ما لقينا «{q}» — جرّب اسمًا آخر</p>
      )}
      {catalog.sales_contact && contact && (
        <button type="button" onClick={() => setReceipt(true)} className="flex w-full items-center gap-3 rounded-2xl border-2 border-dashed border-emerald-500/50 bg-emerald-500/5 p-4 text-right transition hover:bg-emerald-500/10">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-500 text-white"><Icon name={contact.icon} size={22} /></span>
          <span className="flex-1 leading-tight">
            <b className="font-display block text-base">حوّلت المبلغ؟ أرسل السند هنا</b>
            <span className="muted text-xs">اختر باقتك واكتب بياناتك — نجهّز لك رسالة {contact.label} جاهزة ترفق معها صورة السند</span>
          </span>
          <Icon name="arrowL" size={20} className="text-emerald-600" />
        </button>
      )}
      {receipt && catalog.sales_contact && <ReceiptModal catalog={catalog} cur={cur} coupon={coupon} onClose={() => setReceipt(false)} />}
    </section>
  );
}

/** The four currencies as a segmented switch. */
function CurrencySwitch({ cur, setCur }: { cur: string; setCur: (c: string) => void }) {
  return (
    <div className="flex justify-center">
      <div className="inline-flex flex-wrap justify-center gap-1 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-1" role="tablist" aria-label="العملة">
        {CURRENCIES.map((c) => (
          <button key={c.code} type="button" role="tab" aria-selected={cur === c.code} onClick={() => setCur(c.code)} className={`rounded-xl px-3 py-1.5 text-xs font-bold transition sm:text-sm ${cur === c.code ? "grad text-white shadow" : "muted hover:text-[var(--text)]"}`}>
            {c.name}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Plan cards, prices converted with the owner's exchange rates. On phones they are a swipeable carousel
 * (first plan shown first, an arrow and dots to move to the next); from md up a three-column grid.
 */
export function PlanCards({ catalog, cur, currentPlanId, onChoose, coupon = null }: { catalog: Catalog; cur: string; currentPlanId?: string | null; onChoose?: () => void; coupon?: Coupon }) {
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
                    {pct > 0 && before !== null && <span className="w-full text-xs"><s className="muted">{formatAmount(before, cur)}</s> <b className="text-emerald-600">خصم {pct}%</b></span>}
                  </div>
                ) : (
                  <span className="font-display text-2xl font-extrabold text-violet-600 dark:text-violet-300">{p.price_label || "تواصل معنا"}</span>
                )}
              </div>
              {onChoose && (
                <button type="button" onClick={onChoose} className={`btn mt-4 w-full ${isFeatured ? "btn-primary" : "btn-ghost"}`}>اشترك في {p.name}</button>
              )}
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

export function PlansShowcase({ catalog, currentPlanId }: { catalog: Catalog; currentPlanId?: string | null }) {
  const [cur, setCur] = useState(() => catalog.plans.find((p) => p.price_amount !== null)?.price_currency ?? "SAR");
  const [coupon, setCoupon] = useState<Coupon>(null);
  const toPayment = () => document.getElementById("payment")?.scrollIntoView({ behavior: "smooth", block: "start" });
  const hasPayment = catalog.payment_methods.length > 0 || !!catalog.sales_contact;
  const anyPrice = catalog.plans.some((p) => p.price_amount !== null);
  return (
    <div className="space-y-10">
      <div className="space-y-4">
        {anyPrice && <CurrencySwitch cur={cur} setCur={setCur} />}
        {anyPrice && <CouponBox coupon={coupon} setCoupon={setCoupon} />}
        <PlanCards catalog={catalog} cur={cur} currentPlanId={currentPlanId} onChoose={hasPayment ? toPayment : undefined} coupon={coupon} />
      </div>
      <PaymentMethods catalog={catalog} cur={cur} coupon={coupon} />
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
