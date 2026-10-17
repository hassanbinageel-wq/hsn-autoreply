import { useMemo, useState } from "react";
import { api } from "../api";
import { Link } from "../App";
import { AreaChart } from "../components/Charts";
import { Icon } from "../components/Icon";
import { Alert, Card, InfoDot, Modal, PageHeader, Spinner, fmtDate, toast, useAsync } from "../components/ui";
import { toCsv } from "../../shared/csv";
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
  const csv = (name: string, headers: string[], rows: any[]) => saveFile(new Blob([toCsv(headers, rows)], { type: "text/csv;charset=utf-8" }), name).catch(() => undefined);

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

          {data.costs.products > 0 && data.costs.with_cost === 0 && data.costs.default_pct === null && (
            <Alert tone="info">عشان نحسب <b>الربح</b>: أدخل تكلفة كل منتج أو نسبة تكلفة تقريبية من زر «تكاليف المنتجات». إذا كنت مدخل «سعر التكلفة» في منتجات سلة نجيبه تلقائيًا مع تحديث المنتجات.</Alert>
          )}

          <Card title="الطلبات والمبيعات يوميًا" action={<div className="seg" role="group" aria-label="المؤشر">{(["orders", "revenue"] as const).map((k) => <button key={k} type="button" aria-pressed={metric === k} className={metric === k ? "on" : ""} onClick={() => setMetric(k)}>{k === "orders" ? "طلبات" : "مبيعات"}</button>)}</div>}>
            {data.series.some((d: any) => d.orders) ? (
              <AreaChart labels={labels} series={[metric === "orders" ? { label: "طلبات", color: "#7c3aed", values: data.series.map((d: any) => d.orders) } : { label: "مبيعات", color: "#10b981", values: data.series.map((d: any) => Math.round(d.revenue)) }]} />
            ) : <p className="muted py-6 text-center text-sm">ما فيه طلبات في هذي الفترة بعد.</p>}
          </Card>

          <Card
            title="الحملات: من التعليق للطلب"
            action={<button className="btn btn-ghost min-h-9 text-xs" disabled={!data.campaigns.length} onClick={() => csv("store-campaigns.csv", ["الحملة", "كود الخصم", "المنتج", "استلموا المحتوى", "ضغطات", "طلبات بالكود", "مبيعات بالكود"], data.campaigns.map((c: any) => ({ "الحملة": c.name, "كود الخصم": c.coupon ?? "", "المنتج": c.product?.name ?? "", "استلموا المحتوى": c.delivered, "ضغطات": c.clicks, "طلبات بالكود": c.orders ?? "", "مبيعات بالكود": c.revenue ?? "" })))}>⬇️ CSV</button>}
          >
            {!data.campaigns.length ? (
              <p className="muted text-sm">ما فيه حملات مربوطة بالمتجر. في محرر الحملة ← خطوة «الرسالة»: اختر منتج من متجرك كرابط، وحط <b>كود خصم خاص بالحملة</b> عشان تنحسب طلباتها بدقة.</p>
            ) : (
              <div className="-mx-4 overflow-x-auto sm:-mx-5">
                <table className="w-full min-w-[680px] text-sm">
                  <thead><tr className="muted bg-[var(--surface-2)] text-right text-xs">
                    <th className="px-4 py-2 font-semibold">الحملة</th><th className="px-2 py-2 font-semibold">الكود</th><th className="px-2 py-2 font-semibold">استلموا</th>
                    <th className="px-2 py-2 font-semibold">ضغطات</th><th className="px-2 py-2 font-semibold">طلبات</th><th className="px-2 py-2 font-semibold">مبيعات</th><th className="px-2 py-2 font-semibold">تحويل</th>
                  </tr></thead>
                  <tbody>
                    {data.campaigns.map((c: any) => (
                      <tr key={c.id} className="border-t border-[var(--border)]">
                        <td className="px-4 py-2"><Link to={`/campaigns/${c.id}`} className="font-semibold hover:underline">{c.name}</Link>{c.product && <div className="muted text-[11px]">🛍️ {c.product.name}</div>}</td>
                        <td className="px-2 py-2 text-xs" dir="ltr">{c.coupon ?? <span className="muted">—</span>}</td>
                        <td className="px-2 py-2 tabular-nums">{fmt(c.delivered)}</td>
                        <td className="px-2 py-2 tabular-nums">{fmt(c.clicks)}</td>
                        <td className="px-2 py-2 tabular-nums font-semibold">{c.orders ?? <span className="muted" title="بدون كود خصم ما نقدر ننسب الطلبات للحملة">—</span>}</td>
                        <td className="px-2 py-2 tabular-nums">{c.revenue !== null ? money(c.revenue, cur) : "—"}</td>
                        <td className="px-2 py-2 tabular-nums">{c.orders !== null ? pct(c.orders, c.clicks) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted mt-2 text-xs">«تحويل» = طلبات بالكود ÷ ضغطات الرابط. «—» تعني الحملة ما عندها كود خصم، فما نقدر ننسب لها طلبات بدقة.</p>
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
            title="المنتجات"
            action={<div className="flex gap-2"><button className="btn btn-ghost min-h-9 text-xs" onClick={() => setCosts(true)}>💰 تكاليف المنتجات</button><button className="btn btn-ghost min-h-9 text-xs" disabled={!data.products.length} onClick={() => csv("store-products.csv", ["المنتج", "طلبات", "قطع", "مبيعات", "ربح تقديري", "حملات تروّج له", "ضغطات الحملات"], data.products.map((p: any) => ({ "المنتج": p.name ?? p.id, "طلبات": p.orders, "قطع": p.units, "مبيعات": p.revenue ?? "", "ربح تقديري": p.profit ?? "", "حملات تروّج له": p.campaigns.map((c: any) => c.name).join("، "), "ضغطات الحملات": p.clicks })))}>⬇️ CSV</button></div>}
          >
            {!data.products.length ? <p className="muted text-sm">ما فيه طلبات على منتجات في هذي الفترة. ({fmt(data.store.products)} منتج مجلوب من متجرك)</p> : (
              <div className="divide-y divide-[var(--border)]">
                {data.products.map((p: any) => (
                  <div key={p.id} className="flex items-center gap-3 py-2.5">
                    {p.image_url ? <img src={p.image_url} alt="" className="size-11 shrink-0 rounded-lg object-cover" loading="lazy" /> : <span className="surface-2 grid size-11 shrink-0 place-items-center rounded-lg">🛍️</span>}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold">{p.name ?? `منتج ${p.id}`}</div>
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
