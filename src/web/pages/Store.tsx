import { useMemo, useState } from "react";
import { api } from "../api";
import { Link } from "../App";
import { AreaChart } from "../components/Charts";
import { Icon } from "../components/Icon";
import { Alert, Card, InfoDot, PageHeader, Spinner, fmtDate, useAsync } from "../components/ui";
import { toCsv } from "../../shared/csv";
import { saveFile } from "../lib/save";

/** Store analytics: orders and revenue joined to campaigns (by discount code) and to products (by link). */
const DAY = 86_400_000;
const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const money = (n: number | null | undefined, cur = "SAR") => (typeof n === "number" ? `${n.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${cur === "SAR" ? "ر.س" : cur}` : "—");
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 1000) / 10}%` : "—");

export function StorePage() {
  const [days, setDays] = useState(30);
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
            <Tile label="الطلبات" value={fmt(t.orders)} info="الطلبات في الفترة بدون الملغية والمسترجعة. تنحسب من لحظة ربط المتجر (الطلبات الأقدم ما توصل)." sub={t.excluded ? `${t.excluded} ملغي/مسترجع مستبعد` : undefined} />
            <Tile label="المبيعات" value={money(t.revenue, cur)} info="مجموع قيمة الطلبات المحسوبة كما تعطيه سلة." />
            <Tile label="متوسط الطلب" value={money(t.aov, cur)} info="المبيعات ÷ عدد الطلبات." />
            <Tile label="من حملاتك (بالكود)" value={`${fmt(t.attributed_orders)} · ${money(t.attributed_revenue, cur)}`} info="طلبات استخدمت كود خصم حملة من حملاتك — هذي الطريقة الدقيقة للنسبة. الطلبات بدون كود ما تنحسب لأي حملة حتى لو جت من إنستقرام." sub={pct(t.attributed_orders, t.orders) + " من الطلبات"} />
          </div>

          <Card title="الطلبات والمبيعات يوميًا">
            {data.series.some((d: any) => d.orders) ? (
              <AreaChart labels={labels} series={[{ label: "طلبات", color: "#7c3aed", values: data.series.map((d: any) => d.orders) }]} />
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

          <Card
            title="المنتجات"
            action={<button className="btn btn-ghost min-h-9 text-xs" disabled={!data.products.length} onClick={() => csv("store-products.csv", ["المنتج", "طلبات", "قطع", "مبيعات", "حملات تروّج له", "ضغطات الحملات"], data.products.map((p: any) => ({ "المنتج": p.name ?? p.id, "طلبات": p.orders, "قطع": p.units, "مبيعات": p.revenue ?? "", "حملات تروّج له": p.campaigns.map((c: any) => c.name).join("، "), "ضغطات الحملات": p.clicks })))}>⬇️ CSV</button>}
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
                    </div>
                  </div>
                ))}
              </div>
            )}
            <p className="muted mt-2 text-xs">ضغطات الحملات اللي رابطها هذا المنتج تنعرض جنب طلباته للمقارنة فقط — مو كل طلب جا منها.</p>
          </Card>
        </>
      )}
    </div>
  );
}

function Tile({ label, value, info, sub }: { label: string; value: string; info: string; sub?: string }) {
  return (
    <div className="surface-2 rounded-2xl p-3">
      <div className="flex items-center justify-between gap-1"><span className="muted text-xs">{label}</span><InfoDot text={info} /></div>
      <div className="font-display mt-1 text-lg font-extrabold tabular-nums">{value}</div>
      {sub && <div className="muted text-[11px]">{sub}</div>}
    </div>
  );
}
