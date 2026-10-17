import { useMemo, useState } from "react";
import { api } from "../api";
import { Link } from "../App";
import { AreaChart } from "../components/Charts";
import { Icon } from "../components/Icon";
import { Alert, Card, InfoDot, Modal, PageHeader, Spinner, fmtDate, toast, useAsync } from "../components/ui";
import { saveFile } from "../lib/save";

/** Store analytics: orders and revenue joined to campaigns (by discount code) and to products (by link). */
const DAY = 86_400_000;
const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const money = (n: number | null | undefined, cur = "SAR") => (typeof n === "number" ? `${n.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${cur === "SAR" ? "ر.س" : cur}` : "—");
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 1000) / 10}%` : "—");
/** Change against the previous period of the same length. */
const delta = (now: number | null | undefined, before: number | null | undefined) => {
  if (now == null || before == null) return null;
  if (before === 0) return now > 0 ? { text: "جديد", up: true } : null;
  const d = Math.round(((now - before) / Math.abs(before)) * 100);
  return { text: `${d > 0 ? "+" : ""}${d}%`, up: d >= 0 };
};
const PAY_AR: Record<string, string> = {
  bank: "تحويل بنكي", cod: "الدفع عند الاستلام", credit_card: "بطاقة ائتمانية", mada: "مدى", apple_pay: "Apple Pay", stc_pay: "STC Pay",
  tabby: "تابي", tamara: "تمارا", paypal: "PayPal", wallet: "المحفظة", free: "مجاني", waiting: "لم يُحدَّد بعد (بانتظار الدفع)",
};
const STATUS_AR: Record<string, string> = {
  payment_pending: "بانتظار الدفع", under_review: "بانتظار المراجعة", in_progress: "قيد التنفيذ", completed: "تم التنفيذ", delivering: "جاري التوصيل",
  delivered: "تم التوصيل", shipped: "تم الشحن", canceled: "ملغي", cancelled: "ملغي", refunded: "مسترجع", restored: "مسترجع", restoring: "قيد الاسترجاع",
};

export function StorePage() {
  const [days, setDays] = useState(30);
  const [metric, setMetric] = useState<"orders" | "revenue">("orders");
  const [costs, setCosts] = useState(false);
  const [openCampaign, setOpenCampaign] = useState<number | null>(null);
  const [off, setOff] = useState(180);
  const range = useMemo(() => {
    const now = Date.now();
    const start = Math.floor((now + off * 60_000) / DAY) * DAY - off * 60_000 - (days - 1) * DAY;
    return { from: start, to: now };
  }, [days, off]);
  const { data, loading, reload } = useAsync(
    () => api<any>(`/api/store/analytics?from=${range.from}&to=${range.to}`).then((d) => (d?.filter?.tz_offset_min !== undefined && d.filter.tz_offset_min !== off && setOff(d.filter.tz_offset_min), d)),
    [range.from, range.to],
  );
  const t = data?.totals;
  const cur = t?.currency ?? "SAR";
  const labels = (data?.series ?? []).map((d: any) => new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-latn", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(d.day * DAY + 12 * 3_600_000)));
  const period = `${data?.store?.name ?? "متجر سلة"} · ${fmtDate(range.from)} — ${fmtDate(range.to)}`;

  return (
    <div className="space-y-5">
      <PageHeader
        title="تحليل المتجر"
        subtitle="الطلبات والمبيعات من متجرك، مربوطة بحملاتك ومنتجاتك."
        actions={<button className="btn btn-ghost" onClick={reload} disabled={loading}><Icon name="refresh" size={17} />{loading ? "…" : "تحديث"}</button>}
      />
      {!data ? <Spinner /> : !data.store ? (
        <Card>
          <p className="text-sm">ما فيه متجر مربوط. اربط متجرك في سلة من <Link to="/connection" className="font-semibold text-[var(--primary)]">صفحة الربط</Link> عشان تشوف الطلبات والمبيعات لكل حملة ومنتج.</p>
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="seg" role="group" aria-label="الفترة">
              {[7, 30, 90].map((d) => <button key={d} type="button" aria-pressed={days === d} className={days === d ? "on" : ""} onClick={() => setDays(d)}>{d === 7 ? "آخر 7 أيام" : d === 30 ? "آخر 30 يومًا" : "آخر 90 يومًا"}</button>)}
            </div>
            <span className="muted text-xs">{data.store.name ?? "متجر سلة"} · {fmtDate(range.from)} — {fmtDate(range.to)}</span>
          </div>
          {data.store.status !== "active" && <Alert tone="warn">تفويض المتجر يحتاج إعادة ربط — الطلبات الجديدة ما توصل لين تعيد الربط من صفحة الربط.</Alert>}

          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <Tile big label="المبيعات" value={money(t.revenue, cur)} d={delta(t.revenue, data.previous.revenue)} info="مجموع قيمة الطلبات (شامل الشحن والضريبة وبعد الخصم) بدون الملغية والمسترجعة. المقارنة مع الفترة السابقة بنفس الطول." />
            <Tile big label="الربح التقديري" value={t.profit === null ? "—" : money(t.profit, cur)} d={delta(t.profit, data.previous.profit)} tone={t.profit !== null && t.profit < 0 ? "bad" : "good"}
              info="صافي المبيعات (الإجمالي − الشحن − الضريبة) ناقص تكلفة المنتجات. ينحسب فقط على الطلبات اللي كل منتجاتها لها تكلفة معروفة — أدخل التكاليف من «تكاليف المنتجات»."
              sub={t.profit === null ? "أدخل تكلفة منتجاتك عشان يظهر" : `هامش ${t.margin !== null ? Math.round(t.margin * 100) + "%" : "—"}${t.profit_orders < t.orders ? ` · على ${fmt(t.profit_orders)} من ${fmt(t.orders)} طلب` : ""}`} />
            <Tile big label="الطلبات" value={fmt(t.orders)} d={delta(t.orders, data.previous.orders)} info="الطلبات في الفترة بدون الملغية والمسترجعة. تنحسب من لحظة ربط المتجر (الطلبات الأقدم ما توصل)." sub={t.excluded ? `${t.excluded} ملغي/مسترجع مستبعد` : undefined} />
            <Tile big label="متوسط الطلب" value={money(t.aov, cur)} d={delta(t.aov, data.previous.aov)} info="المبيعات ÷ عدد الطلبات." />
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Tile label="صافي المبيعات" value={money(t.net, cur)} info="الإجمالي ناقص الشحن والضريبة — هذا اللي يدخل لك من بيع المنتجات." />
            <Tile label="من حملاتك (بالكود)" value={money(t.attributed_revenue, cur)} sub={`${fmt(t.attributed_orders)} طلب · ${pct(t.attributed_orders, t.orders)}`} info="طلبات استخدمت كود خصم حملة من حملاتك — هذي الطريقة الدقيقة للنسبة. الطلبات بدون كود ما تنحسب لأي حملة حتى لو جت من إنستقرام." />
            <Tile label="الخصومات" value={money(t.discount, cur)} sub={t.revenue ? `${pct(t.discount, t.revenue + t.discount)} من قيمة السلة` : undefined} info="مجموع الخصومات والكوبونات اللي انطبقت على الطلبات." />
            <Tile label="الشحن المحصّل" value={money(t.shipping, cur)} info="رسوم الشحن اللي دفعها العملاء. ما تنحسب في الربح لأنها تروح لشركة الشحن." />
            <Tile label="القطع المباعة" value={fmt(t.units)} sub={t.orders ? `${(t.units / t.orders).toFixed(1)} قطعة لكل طلب` : undefined} info="عدد القطع في الطلبات المحسوبة." />
            <Tile label="العملاء" value={fmt(data.customers.known)} sub={data.customers.known ? `${fmt(data.customers.new)} جديد · ${fmt(data.customers.returning)} متكرر` : undefined} info="عملاء مميّزين في الفترة. «جديد» = أول طلب له من وقت ربط المتجر كان في هذي الفترة. ما نحفظ اسم العميل — بس رمز مشفّر يميّزه." />
          </div>

          <Card
            id="store-campaigns"
            title={<span className="flex items-center gap-1.5">الحملات المربوطة بالمتجر <InfoDot text="الحملات اللي لها كود خصم أو رابط منتج من متجرك. اضغط على أي حملة عشان تشوف مسار البيع: من التعليق لين الطلب." /></span>}
            action={<PdfButton target="store-campaigns" title="الحملات المربوطة بالمتجر" subtitle={period} disabled={!data.campaigns.length} />}
          >
            {!data.campaigns.length ? (
              <p className="muted text-sm">ما فيه حملات مربوطة بالمتجر. في محرر الحملة ← خطوة «الرسالة»: اختر منتج من متجرك كرابط، وحط <b>كود خصم خاص بالحملة</b> عشان تنحسب طلباتها بدقة.</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {data.campaigns.map((c: any) => (
                  <button key={c.id} type="button" onClick={() => setOpenCampaign(c.id)} className="surface-2 group rounded-2xl border border-transparent p-3 text-right transition hover:border-violet-500/40 focus-visible:border-violet-500">
                    <div className="flex items-center gap-3">
                      {c.product?.image_url ? <img src={c.product.image_url} alt="" className="size-12 shrink-0 rounded-xl object-cover" loading="lazy" /> : <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-[var(--surface)] text-xl">🎯</span>}
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-semibold">{c.name}</div>
                        <div className="muted flex flex-wrap items-center gap-1.5 text-[11px]">
                          {c.coupon ? <span className="chip bg-[var(--surface)] font-mono" dir="ltr">{c.coupon}</span> : <span className="text-amber-600">بدون كود خصم</span>}
                          {c.product && <span className="truncate">🛍️ {c.product.name}</span>}
                        </div>
                      </div>
                      <Icon name="chev" size={16} className="no-print muted -rotate-90 transition group-hover:-translate-x-0.5" />
                    </div>
                    <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                      <Mini label="طلبات" value={c.orders === null ? "—" : fmt(c.orders)} />
                      <Mini label="مبيعات" value={c.revenue === null ? "—" : money(c.revenue, cur)} />
                      <Mini label="ربح" value={c.profit === null ? "—" : money(c.profit, cur)} tone={c.profit !== null ? (c.profit < 0 ? "bad" : "good") : undefined} />
                    </div>
                    <div className="muted mt-2 text-[11px]">{fmt(c.delivered)} استلموا · {fmt(c.clickers)} ضغطوا{c.orders !== null ? ` · تحويل ${pct(c.orders, c.clickers)}` : ""}</div>
                    {c.stock && <div className="mt-1.5 text-[11px] font-semibold text-rose-600">📦 المنتج نفد من المخزون · {c.stock.paused ? "الحملة موقوفة لين يرجع" : c.stock.action === "waitlist" ? "ترد بقائمة الانتظار" : "الحملة مستمرة"}</div>}
                    {c.shared_coupon && <div className="mt-1 text-[11px] text-amber-600">⚠️ نفس الكود مستخدم في حملة ثانية — الأرقام مشتركة بينهم</div>}
                  </button>
                ))}
              </div>
            )}
            {data.unlinked?.length > 0 && (
              <details className="no-print mt-3">
                <summary className="muted cursor-pointer text-xs">حملات غير مربوطة بالمتجر ({data.unlinked.length}) — ما نقدر نحسب لها مبيعات</summary>
                <ul className="mt-2 divide-y divide-[var(--border)]">
                  {data.unlinked.map((c: any) => (
                    <li key={c.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                      <span className="truncate">{c.name}</span>
                      <Link to={`/campaigns/${c.id}`} className="btn btn-ghost min-h-8 shrink-0 px-3 text-xs">اربطها بكود خصم</Link>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </Card>

          <PostsBySales range={range} cur={cur} />

          {data.costs.products > 0 && data.costs.with_cost === 0 && data.costs.default_pct === null && (
            <Alert tone="info">عشان نحسب <b>الربح</b>: أدخل تكلفة كل منتج أو نسبة تكلفة تقريبية من زر «تكاليف المنتجات». إذا كنت مدخل «سعر التكلفة» في منتجات سلة نجيبه تلقائيًا مع تحديث المنتجات.</Alert>
          )}

          <Card title="الطلبات والمبيعات يوميًا" action={<div className="seg" role="group" aria-label="المؤشر">{(["orders", "revenue"] as const).map((k) => <button key={k} type="button" aria-pressed={metric === k} className={metric === k ? "on" : ""} onClick={() => setMetric(k)}>{k === "orders" ? "طلبات" : "مبيعات"}</button>)}</div>}>
            {data.series.some((d: any) => d.orders) ? (
              <AreaChart labels={labels} series={[metric === "orders" ? { label: "طلبات", color: "#7c3aed", values: data.series.map((d: any) => d.orders) } : { label: "مبيعات", color: "#10b981", values: data.series.map((d: any) => Math.round(d.revenue)) }]} />
            ) : <p className="muted py-6 text-center text-sm">ما فيه طلبات في هذي الفترة بعد.</p>}
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="طرق الدفع"><Bars rows={data.payment_methods.map((r: any) => ({ label: PAY_AR[r.key] ?? r.key, value: r.orders, sub: money(r.revenue, cur) }))} empty="ما وصلت طريقة الدفع مع الطلبات بعد." /></Card>
            <Card title="أكثر المدن طلبًا"><Bars rows={data.cities.map((r: any) => ({ label: r.key, value: r.orders, sub: money(r.revenue, cur) }))} empty="ما وصلت المدينة مع الطلبات بعد." /></Card>
            <Card title="أكواد الخصم">
              {!data.coupons.length ? <p className="muted text-sm">ما فيه طلبات بكود خصم في هذي الفترة.</p> : (
                <div className="divide-y divide-[var(--border)]">
                  {data.coupons.map((c: any) => (
                    <div key={c.code} className="flex items-center gap-3 py-2 text-sm">
                      <span className="chip surface-2 font-mono text-xs" dir="ltr">{c.code}</span>
                      <span className="muted min-w-0 flex-1 truncate text-xs">{c.campaign ? <Link to={`/campaigns/${c.campaign.id}`} className="hover:underline">حملة: {c.campaign.name}</Link> : "مو مربوط بحملة"}</span>
                      <span className="tabular-nums font-semibold">{fmt(c.orders)} طلب</span>
                      <span className="muted w-24 text-left text-xs tabular-nums">{money(c.revenue, cur)}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
            <Card title="حالات الطلبات"><Bars rows={data.statuses.map((r: any) => ({ label: STATUS_AR[r.key] ?? r.key, value: r.orders }))} empty="ما فيه طلبات." /></Card>
          </div>

          <Card
            id="store-products"
            title="المنتجات"
            action={<div className="flex gap-2"><button className="btn btn-ghost min-h-9 text-xs" onClick={() => setCosts(true)}>💰 تكاليف المنتجات</button><PdfButton target="store-products" title="المنتجات" subtitle={period} disabled={!data.products.length} /></div>}
          >
            {!data.products.length ? <p className="muted text-sm">ما فيه طلبات على منتجات في هذي الفترة. ({fmt(data.store.products)} منتج مجلوب من متجرك)</p> : (
              <div className="divide-y divide-[var(--border)]">
                {data.products.map((p: any) => (
                  <div key={p.id} className="flex items-center gap-3 py-2.5">
                    {p.image_url ? <img src={p.image_url} alt="" className="size-11 shrink-0 rounded-lg object-cover" loading="lazy" /> : <span className="surface-2 grid size-11 shrink-0 place-items-center rounded-lg">🛍️</span>}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold">{p.name ?? `منتج ${p.id}`}{p.out_of_stock && <span className="chip mr-1.5 bg-rose-100 !py-0 text-[10.5px] text-rose-700 dark:bg-rose-900/40 dark:text-rose-300">نفد</span>}</div>
                      <div className="muted text-xs">{p.campaigns.length ? `حملات: ${p.campaigns.map((c: any) => c.name).join("، ")} · ${fmt(p.clicks)} ضغطة` : "ما فيه حملة تروّج له"}</div>
                    </div>
                    <div className="text-left text-sm">
                      <div className="font-semibold tabular-nums">{fmt(p.orders)} طلب</div>
                      <div className="muted text-xs tabular-nums">{fmt(p.units)} قطعة{p.revenue ? ` · ${money(p.revenue, cur)}` : ""}</div>
                      {p.profit !== null && <div className={`text-xs font-semibold tabular-nums ${p.profit < 0 ? "text-rose-600" : "text-emerald-600"}`}>ربح {money(p.profit, cur)}</div>}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <p className="muted mt-2 text-xs">ضغطات الحملات اللي رابطها هذا المنتج تنعرض جنب طلباته للمقارنة فقط — مو كل طلب جا منها.</p>
          </Card>
        </>
      )}
      {openCampaign !== null && <CampaignStore id={openCampaign} range={range} onClose={() => setOpenCampaign(null)} />}
      {costs && <CostsEditor cur={cur} onClose={(saved) => { setCosts(false); if (saved) reload(); }} />}
    </div>
  );
}

function Tile({ label, value, info, sub, d, big, tone }: { label: string; value: string; info: string; sub?: string; d?: { text: string; up: boolean } | null; big?: boolean; tone?: "good" | "bad" }) {
  return (
    <div className={`rounded-2xl p-3 ${big ? "card" : "surface-2"}`}>
      <div className="flex items-center justify-between gap-1"><span className="muted text-xs">{label}</span><InfoDot text={info} /></div>
      <div className={`font-display mt-1 font-extrabold tabular-nums ${big ? "text-xl" : "text-base"} ${tone === "bad" ? "text-rose-600" : tone === "good" && value !== "—" ? "text-emerald-600 dark:text-emerald-400" : ""}`}>{value}</div>
      <div className="flex flex-wrap items-center gap-1.5">
        {d && <span className={`rounded-full px-1.5 text-[11px] font-bold tabular-nums ${d.up ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-rose-500/15 text-rose-700 dark:text-rose-300"}`} title="مقارنة بالفترة السابقة">{d.up ? "▲" : "▼"} {d.text}</span>}
        {sub && <span className="muted text-[11px]">{sub}</span>}
      </div>
    </div>
  );
}

/** Horizontal bars for a small breakdown (payment methods, cities, statuses). */
function Bars({ rows, empty }: { rows: Array<{ label: string; value: number; sub?: string }>; empty: string }) {
  if (!rows.length) return <p className="muted text-sm">{empty}</p>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  const total = rows.reduce((a, r) => a + r.value, 0);
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.label}>
          <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
            <span className="truncate font-semibold">{r.label}</span>
            <span className="muted shrink-0 text-xs tabular-nums">{fmt(r.value)} طلب · {pct(r.value, total)}{r.sub ? ` · ${r.sub}` : ""}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-[var(--surface-2)]"><div className="grad h-full rounded-full" style={{ width: `${Math.max(3, (r.value / max) * 100)}%` }} /></div>
        </li>
      ))}
    </ul>
  );
}

/** Unit cost per product (overrides Salla's cost price) and a default cost % for the rest. */
function CostsEditor({ cur, onClose }: { cur: string; onClose: (saved: boolean) => void }) {
  const { data } = useAsync(() => api<any>("/api/store/costs"), []);
  const [pctV, setPct] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const items = Object.entries(edits).map(([product_id, v]) => ({ product_id, cost: v.trim() === "" ? null : Number(v) }));
      if (items.some((i) => i.cost !== null && !(i.cost >= 0))) throw new Error("التكلفة لازم تكون رقم");
      const body: any = { items };
      if (pctV !== null) body.default_pct = pctV.trim() === "" ? null : Number(pctV);
      if (body.default_pct != null && !(body.default_pct >= 0 && body.default_pct <= 100)) throw new Error("النسبة بين 0 و 100");
      await api("/api/store/costs", { method: "PUT", body });
      toast("تم حفظ التكاليف");
      onClose(true);
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  const items = (data?.items ?? []).filter((p: any) => !q || (p.name ?? "").includes(q));
  return (
    <Modal open onClose={() => onClose(false)} title="تكاليف المنتجات" center>
      {!data ? <Spinner /> : (
        <div className="space-y-4">
          <p className="muted text-xs leading-relaxed">التكلفة = اللي يكلفك المنتج الواحد (شراء/تصنيع). نستخدمها لحساب الربح بس، وما تنرسل لأي مكان. الترتيب: التكلفة اللي تكتبها هنا ← «سعر التكلفة» من سلة ← النسبة التقريبية.</p>
          <label className="block">
            <span className="text-sm font-semibold">نسبة تكلفة تقريبية للمنتجات بدون تكلفة</span>
            <div className="mt-1 flex items-center gap-2">
              <input className="input !w-28" inputMode="decimal" placeholder="مثلًا 40" value={pctV ?? (data.default_pct ?? "")} onChange={(e) => setPct(e.target.value)} />
              <span className="muted text-sm">% من سعر البيع</span>
            </div>
          </label>
          <input className="input" placeholder="ابحث عن منتج…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="max-h-[45vh] divide-y divide-[var(--border)] overflow-y-auto">
            {items.map((p: any) => (
              <div key={p.product_id} className="flex items-center gap-3 py-2">
                {p.image_url ? <img src={p.image_url} alt="" className="size-10 shrink-0 rounded-lg object-cover" loading="lazy" /> : <span className="surface-2 grid size-10 shrink-0 place-items-center rounded-lg">🛍️</span>}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{p.name ?? p.product_id}</div>
                  <div className="muted text-[11px]">السعر {money(p.price, cur)}{p.cost != null ? ` · تكلفة سلة ${money(p.cost, cur)}` : ""}</div>
                </div>
                <input className="input !w-24 text-sm" inputMode="decimal" aria-label={`تكلفة ${p.name ?? ""}`} placeholder={p.cost != null ? String(p.cost) : "التكلفة"}
                  value={edits[p.product_id] ?? (p.cost_manual ?? "")} onChange={(e) => setEdits({ ...edits, [p.product_id]: e.target.value })} />
              </div>
            ))}
            {!items.length && <p className="muted py-4 text-center text-sm">ما فيه منتجات — حدّث المنتجات من صفحة الربط.</p>}
          </div>
          <div className="flex justify-end gap-2">
            <button className="btn btn-ghost" onClick={() => onClose(false)}>إلغاء</button>
            <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? "…" : "حفظ"}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Mini({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-xl bg-[var(--surface)] px-1.5 py-1.5">
      <div className="muted text-[10px]">{label}</div>
      <div className={`truncate text-sm font-bold tabular-nums ${tone === "bad" ? "text-rose-600" : tone === "good" ? "text-emerald-600 dark:text-emerald-400" : ""}`}>{value}</div>
    </div>
  );
}

const ORDERED_INFO =
  "تنحسب هنا الطلبات اللي استخدمت كود خصم الحملة فقط — هذي الطريقة الوحيدة اللي نقدر نتأكد فيها إن الطلب جا من الحملة. الشخص اللي ضغط الرابط واشترى بدون ما يكتب الكود ما يظهر هنا، فنسبة الشراء الحقيقية ممكن تكون أعلى شوي من المعروض.";

/** One campaign in the store: the sales funnel, money, daily orders and its orders, against the customer's averages. */
function CampaignStore({ id, range, onClose }: { id: number; range: { from: number; to: number }; onClose: () => void }) {
  const { data, error } = useAsync(() => api<any>(`/api/store/campaigns/${id}?from=${range.from}&to=${range.to}`), [id, range.from, range.to]);
  const cur = data?.totals?.currency ?? "SAR";
  const f = data?.funnel;
  const steps = f
    ? [
        { key: "triggered", label: "علّقوا / تفاعلوا", value: f.triggered, info: "أشخاص مختلفين شغّلوا الحملة (تعليق أو رد على ستوري) في الفترة." },
        { key: "delivered", label: "وصلتهم الرسالة", value: f.delivered, info: "أشخاص وصلتهم الرسالة الأخيرة اللي فيها الرابط والكود." },
        { key: "clickers", label: "ضغطوا الرابط", value: f.clickers, info: "أشخاص مختلفين ضغطوا الرابط في الرسالة (مرة أو أكثر)." },
        { key: "orders", label: "طلبوا بالكود", value: f.orders, info: ORDERED_INFO },
      ]
    : [];
  const max = Math.max(1, ...steps.map((s) => s.value ?? 0));
  // Where people stop, in plain words.
  const hint = (() => {
    if (!f || !data.campaign.coupon) return null;
    if (f.triggered >= 10 && f.delivered / f.triggered < 0.7) return { t: "كثير ممن تفاعلوا ما وصلتهم الرسالة", d: "راجع سجل الحملة: ممكن حساباتهم مقفلة للرسائل أو انتهت مهلة الرد عند ميتا." };
    if (f.delivered >= 10 && f.clickers / f.delivered < 0.15) return { t: "الرسالة توصل لكن قليل يضغطون الرابط", d: "جرّب رسالة أقصر، وحط العرض والسعر في أولها، وخلّ الرابط واضح." };
    if (f.clickers >= 10 && (f.orders ?? 0) / f.clickers < 0.03) return { t: "الناس تضغط وتدخل المتجر لكن قليل يشترون", d: "غالبًا السبب في صفحة المنتج أو السعر أو الشحن أو المخزون — أو إنهم يشترون بدون ما يكتبون الكود. ذكّرهم بالكود في الرسالة." };
    return null;
  })();
  const rate = (a: number | null, b: number) => (a === null || !b ? null : a / b);
  const cmp = (v: number | null, avg: number | null) => {
    if (v === null || avg === null || data.averages.campaigns < 2) return null;
    return { text: `متوسط حملاتك ${Math.round(avg * 1000) / 10}%`, up: v >= avg };
  };
  const labels = (data?.series ?? []).map((d: any) => new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-latn", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(d.day * DAY + 12 * 3_600_000)));
  return (
    <Modal open onClose={onClose} title={data?.campaign?.name ?? "الحملة في المتجر"} center>
      {error ? <Alert tone="bad">{error}</Alert> : !data ? <Spinner /> : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            {data.product?.image_url ? <img src={data.product.image_url} alt="" className="size-14 rounded-xl object-cover" /> : <span className="surface-2 grid size-14 place-items-center rounded-xl text-2xl">🎯</span>}
            <div className="min-w-0 flex-1 text-sm">
              <div className="font-semibold">{data.product?.name ?? "بدون منتج مربوط"}</div>
              <div className="muted text-xs">{data.campaign.coupon ? <>الكود <span className="font-mono" dir="ltr">{data.campaign.coupon}</span></> : "بدون كود خصم"} · {fmtDate(range.from)} — {fmtDate(range.to)}</div>
            </div>
            <Link to={`/campaigns/${id}/stats`} className="btn btn-ghost min-h-9 text-xs" onClick={onClose}>إحصائيات الحملة الكاملة</Link>
          </div>
          {!data.campaign.coupon && <Alert tone="warn">الحملة ما لها كود خصم، فنعرض المسار لين «ضغطوا الرابط» بس. أضف كود من محرر الحملة عشان تنحسب الطلبات.</Alert>}
          {data.campaign.stock_out_at && (
            <Alert tone="warn">
              📦 المنتج نفد من المخزون من {fmtDate(data.campaign.stock_out_at)} — {data.campaign.stock_paused ? "الحملة موقوفة مؤقتًا وترجع تشتغل لحالها لما يتوفر." : data.campaign.stock_action === "waitlist" ? "الحملة ترد إن المنتج خلص وتسجّل من يكتب «بلغني»." : "الحملة مستمرة ترسل الرابط (غيّر الخيار من محرر الحملة)."}
            </Alert>
          )}
          {(data.waitlist.waiting + data.waitlist.sent + data.waitlist.window_closed + data.waitlist.failed > 0) && (
            <section aria-label="قائمة الانتظار">
              <h3 className="mb-2 flex items-center gap-1.5 text-sm font-bold">🔔 طلبوا التنبيه لما يرجع <InfoDot text="أشخاص كتبوا «بلغني» بعد ما وصلهم إن المنتج خلص. لما يرجع نرسل لهم رسالة واحدة — بس للي كتب لنا خلال آخر 24 ساعة (قاعدة إنستقرام). الباقين ما نقدر نراسلهم، بس تقدر تنشر ستوري إن المنتج رجع." /></h3>
              <div className="grid grid-cols-3 gap-2 text-center">
                <Mini label="بالانتظار" value={fmt(data.waitlist.waiting)} />
                <Mini label="وصلهم التنبيه" value={fmt(data.waitlist.sent)} tone="good" />
                <Mini label="فاتت الـ24 ساعة" value={fmt(data.waitlist.window_closed + data.waitlist.failed)} />
              </div>
            </section>
          )}
          {data.campaign.shared_coupon && <Alert tone="warn">نفس الكود مستخدم في حملة ثانية — الطلبات تنحسب للحملتين ولا نقدر نفرّقها. الأفضل كود خاص لكل حملة.</Alert>}

          <section aria-label="مسار البيع">
            <h3 className="mb-2 flex items-center gap-1.5 text-sm font-bold">مسار البيع <InfoDot text="كل خطوة: كم شخص وصلها، ونسبتهم من الخطوة اللي قبلها. المكان اللي ينزل فيه العدد كثير هو وين تخسر الناس." /></h3>
            <ol className="space-y-2.5">
              {steps.map((s, i) => {
                const prev = i ? steps[i - 1].value : null;
                const r = i && s.value !== null && prev ? s.value / prev : null;
                const c = i === 2 ? cmp(rate(f.clickers, f.delivered), data.averages.click_rate) : i === 3 ? cmp(rate(f.orders, f.clickers), data.averages.order_rate) : null;
                return (
                  <li key={s.key}>
                    <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
                      <span className="flex items-center gap-1 font-semibold">{s.label}<InfoDot text={s.info} /></span>
                      <span className="tabular-nums">
                        <b>{s.value === null ? "—" : fmt(s.value)}</b>
                        {r !== null && <span className="muted text-xs"> · {Math.round(r * 1000) / 10}% من اللي قبلها</span>}
                      </span>
                    </div>
                    <div className="h-3 overflow-hidden rounded-full bg-[var(--surface-2)]"><div className="grad h-full rounded-full" style={{ width: `${s.value ? Math.max(2, (s.value / max) * 100) : 0}%` }} /></div>
                    {c && <div className={`mt-0.5 text-[11px] ${c.up ? "text-emerald-600" : "text-rose-600"}`}>{c.up ? "▲ أعلى من" : "▼ أقل من"} {c.text}</div>}
                  </li>
                );
              })}
            </ol>
            {hint && <div className="mt-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm"><b>💡 {hint.t}</b><p className="muted mt-0.5 text-xs">{hint.d}</p></div>}
          </section>

          {data.campaign.coupon && (
            <div className="grid grid-cols-2 gap-2">
              <Tile label="المبيعات" value={money(data.totals.revenue, cur)} info="مجموع طلبات الحملة (بالكود) بدون الملغية والمسترجعة." sub={data.totals.excluded ? `${data.totals.excluded} ملغي/مسترجع مستبعد` : undefined} />
              <Tile label="الربح التقديري" value={data.totals.profit === null ? "—" : money(data.totals.profit, cur)} tone={data.totals.profit !== null && data.totals.profit < 0 ? "bad" : "good"} info="صافي مبيعات الحملة ناقص تكلفة المنتجات — يظهر لما تكون التكلفة معروفة." sub={data.totals.margin !== null ? `هامش ${Math.round(data.totals.margin * 100)}%` : undefined} />
              <Tile label="متوسط الطلب" value={money(data.totals.aov, cur)} info="مبيعات الحملة ÷ طلباتها، مقارنة بمتوسط طلب المتجر كله." sub={data.averages.aov ? `متوسط المتجر ${money(data.averages.aov, cur)}` : undefined} />
              <Tile label="القطع" value={fmt(data.totals.units)} info="عدد القطع في طلبات الحملة." />
            </div>
          )}

          {data.series.some((d: any) => d.orders) && (
            <div>
              <h3 className="mb-1 text-sm font-bold">طلبات الحملة يوميًا</h3>
              <AreaChart height={160} labels={labels} series={[{ label: "طلبات", color: "#7c3aed", values: data.series.map((d: any) => d.orders) }]} />
            </div>
          )}

          {data.orders.length > 0 && (
            <div>
              <h3 className="mb-1 text-sm font-bold">طلبات الحملة <span className="muted text-xs font-normal">(بدون بيانات العملاء)</span></h3>
              <div className="max-h-56 divide-y divide-[var(--border)] overflow-y-auto">
                {data.orders.map((o: any) => (
                  <div key={o.reference} className={`flex items-center gap-3 py-2 text-sm ${o.counted ? "" : "opacity-60"}`}>
                    <span className="font-mono text-xs" dir="ltr">#{o.reference}</span>
                    <span className="muted min-w-0 flex-1 truncate text-xs">{STATUS_AR[(o.status ?? "").toLowerCase()] ?? o.status ?? ""} · {o.units} قطعة</span>
                    <span className="muted text-xs">{fmtDate(o.ordered_at)}</span>
                    <span className="w-20 text-left font-semibold tabular-nums">{money(o.total, cur)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

const KIND_AR: Record<string, string> = { reel: "ريل", carousel: "ألبوم", video: "فيديو", image: "صورة" };

/** Posts ranked by the orders they brought: order (code) → campaign → post, exact only for one-post campaigns. */
function PostsBySales({ range, cur }: { range: { from: number; to: number }; cur: string }) {
  const { data } = useAsync(() => api<any>(`/api/growth/posts?from=${range.from}&to=${range.to}&store_only=1`).catch(() => null), [range.from, range.to]);
  if (!data) return null;
  if (!data.posts.length && !data.groups.length)
    return (
      <Card title="المنشورات حسب المبيعات">
        <p className="muted text-sm">ما فيه منشورات عليها حملة مربوطة بالمتجر. اربط حملة المنشور بكود خصم أو رابط منتج من متجرك عشان يظهر هنا وتنحسب طلباته.</p>
      </Card>
    );
  return (
    <Card id="store-posts" action={<PdfButton target="store-posts" title="المنشورات حسب المبيعات" subtitle={`${fmtDate(range.from)} — ${fmtDate(range.to)}`} />} title={<span className="flex items-center gap-1.5">المنشورات حسب المبيعات <InfoDot text="المنشورات اللي عليها حملة مربوطة بالمتجر (فيها كود خصم أو رابط منتج من متجرك). الطلب ينحسب للمنشور لما يستخدم كود حملته. الطلبات تنحسب للمنشور بدقة لما تكون حملته على منشور واحد بس؛ الحملة اللي على أكثر من منشور تنعرض تحت كمجموعة لأننا ما نقدر نعرف أي منشور منها باع. التفاعل والضغطات لكل منشور دقيقة دائمًا." /></span>}>
      <div className="-mx-4 overflow-x-auto sm:-mx-5">
        <table className="w-full min-w-[640px] text-sm">
          <thead><tr className="muted bg-[var(--surface-2)] text-right text-xs">
            <th className="px-4 py-2 font-semibold">المنشور</th><th className="px-2 py-2 font-semibold">مشاهدات</th><th className="px-2 py-2 font-semibold">تفاعلوا</th>
            <th className="px-2 py-2 font-semibold">ضغطوا</th><th className="px-2 py-2 font-semibold">طلبات</th><th className="px-2 py-2 font-semibold">مبيعات</th><th className="px-2 py-2 font-semibold">ربح</th>
          </tr></thead>
          <tbody>
            {data.posts.map((p: any, i: number) => (
              <tr key={p.media_id} className="border-t border-[var(--border)]">
                <td className="px-4 py-2">
                  <div className="flex items-center gap-2.5">
                    <span className="muted w-4 text-xs tabular-nums">{i + 1}</span>
                    {p.thumbnail_url ? <img src={p.thumbnail_url} alt="" className="size-11 shrink-0 rounded-lg object-cover" loading="lazy" /> : <span className="surface-2 grid size-11 shrink-0 place-items-center rounded-lg">🖼️</span>}
                    <div className="min-w-0 max-w-[16rem]">
                      <div className="truncate text-xs">{p.caption ?? "بدون وصف"}</div>
                      <div className="muted text-[11px]">{KIND_AR[p.kind] ?? ""}{p.campaigns.length ? ` · ${p.campaigns.map((c: any) => c.name).join("، ")}` : ""}</div>
                    </div>
                  </div>
                </td>
                <td className="px-2 py-2 tabular-nums">{p.views != null ? fmt(p.views) : <span className="muted">—</span>}</td>
                <td className="px-2 py-2 tabular-nums">{fmt(p.people)}</td>
                <td className="px-2 py-2 tabular-nums">{fmt(p.clickers)}</td>
                <td className="px-2 py-2 font-semibold tabular-nums">{p.orders ?? <span className="muted" title="ما فيه حملة بكود على هذا المنشور لوحده">—</span>}</td>
                <td className="px-2 py-2 tabular-nums">{p.revenue != null ? money(p.revenue, cur) : "—"}</td>
                <td className={`px-2 py-2 tabular-nums ${p.profit != null ? (p.profit < 0 ? "text-rose-600" : "text-emerald-600") : ""}`}>{p.profit != null ? money(p.profit, cur) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.groups.length > 0 && (
        <div className="mt-3 space-y-1">
          <div className="muted text-xs">حملات على أكثر من منشور (ما نقدر نقسّم طلباتها على المنشورات):</div>
          {data.groups.map((g: any) => (
            <div key={g.campaign.id} className="surface-2 flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-sm">
              <span className="truncate">{g.campaign.name} <span className="muted text-xs">· {g.posts} منشورات</span></span>
              <span className="tabular-nums"><b>{fmt(g.orders)}</b> طلب · {money(g.revenue, cur)}</span>
            </div>
          ))}
          <p className="muted text-[11px]">💡 تبغى تعرف أي منشور باع أكثر؟ خلّ لكل منشور حملة بكود خاص فيه.</p>
        </div>
      )}
    </Card>
  );
}

/** Downloads one section of the page as a tidy PDF (title + period on top), in place of a CSV sheet. */
function PdfButton({ target, title, subtitle, disabled }: { target: string; title: string; subtitle: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="btn btn-ghost no-print min-h-9 text-xs"
      disabled={disabled || busy}
      onClick={async () => {
        const el = document.getElementById(target);
        if (!el) return;
        setBusy(true);
        try {
          const { elementToPdf } = await import("../lib/elementPdf");
          await saveFile(await elementToPdf(el, { title, subtitle }), `HSN-${target}-${new Date().toISOString().slice(0, 10)}.pdf`, title);
        } catch (e: any) {
          toast(e?.message || "تعذر إنشاء ملف PDF", "bad");
        } finally {
          setBusy(false);
        }
      }}
    >
      <Icon name="download" size={14} />{busy ? "…" : "PDF"}
    </button>
  );
}
