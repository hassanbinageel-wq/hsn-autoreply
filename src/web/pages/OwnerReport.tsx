import { useState } from "react";
import { api } from "../api";
import { Icon } from "../components/Icon";
import { Card, toast } from "../components/ui";

/** The owner's payments report: a clean, printable page the browser saves as a PDF. */

type Group = { key: string | number; label: string; count: number; revenue: number };
type Report = {
  from: number; to: number; days: number; test_mode: boolean;
  total: { count: number; revenue: number; customers: number };
  by_kind: Group[]; by_plan: Group[]; by_pack: Group[]; by_offer: Group[]; without_offer: number; by_month: Group[]; by_customer: Group[];
  not_paid: Record<string, number>;
  payments: Array<{ id: number; at: number; customer: string; kind: string; what: string; amount: number; offer: string | null }>;
};

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const n = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 2 });
const date = (ms: number) => new Date(ms).toLocaleDateString("ar-SA-u-ca-gregory-nu-latn", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Riyadh" });
const STATUS: Record<string, string> = { initiated: "لم تكتمل", failed: "مرفوضة", expired: "انتهت مهلتها", canceled: "ملغاة", error: "خطأ", mismatch: "مبلغ غير مطابق", refunded: "مسترجعة", voided: "ملغاة" };

function table(title: string, rows: Group[], total: number, empty = "لا يوجد") {
  if (!rows.length) return `<section><h2>${esc(title)}</h2><p class="muted">${esc(empty)}</p></section>`;
  const max = Math.max(...rows.map((r) => r.revenue), 1);
  return `<section><h2>${esc(title)}</h2><table><thead><tr><th>البند</th><th>العمليات</th><th>الإيراد</th><th>النسبة</th><th class="bar-col"></th></tr></thead><tbody>${rows
    .map((r) => `<tr><td><b>${esc(r.label)}</b></td><td>${n(r.count)}</td><td>${n(r.revenue)} ر.س</td><td>${total ? Math.round((r.revenue / total) * 100) : 0}%</td><td class="bar-col"><span class="bar" style="width:${Math.max(2, (r.revenue / max) * 100)}%"></span></td></tr>`)
    .join("")}</tbody></table></section>`;
}

function reportHtml(r: Report, origin: string): string {
  const period = r.days ? `${date(r.from)} — ${date(r.to)}` : `كل الفترة حتى ${date(r.to)}`;
  const top = r.by_plan[0];
  const avg = r.total.count ? r.total.revenue / r.total.count : 0;
  const offerRevenue = r.by_offer.reduce((x, g) => x + g.revenue, 0);
  const notPaid = Object.entries(r.not_paid).filter(([, v]) => v > 0);
  const insights = [
    top ? `الباقة الأكثر مبيعًا: <b>${esc(top.label)}</b> — ${n(top.count)} عملية بإيراد ${n(top.revenue)} ر.س.` : null,
    r.by_offer.length ? `العروض جابت <b>${n(offerRevenue)} ر.س</b> (${r.total.revenue ? Math.round((offerRevenue / r.total.revenue) * 100) : 0}% من الإيراد) من ${n(r.by_offer.reduce((x, g) => x + g.count, 0))} عملية؛ أفضلها «${esc(r.by_offer[0].label)}».` : "ما فيه عمليات دفع استخدمت خصم عرض في هذي الفترة.",
    r.by_pack.length ? `حزم الرسائل الإضافية: ${n(r.by_pack.reduce((x, g) => x + g.count, 0))} عملية — الأكثر طلبًا ${esc(r.by_pack[0].label)}.` : null,
    `متوسط قيمة العملية <b>${n(avg)} ر.س</b>، ودفع ${n(r.total.customers)} عميل مختلف.`,
    notPaid.length ? `عمليات ما اكتملت: ${notPaid.map(([k, v]) => `${STATUS[k] ?? k} ${v}`).join("، ")}.` : null,
  ].filter(Boolean);
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>تقرير المدفوعات — شيّك</title><style>
@font-face{font-family:T;src:url(${origin}/fonts/thmanyahsans-Regular.woff2);font-weight:400}
@font-face{font-family:T;src:url(${origin}/fonts/thmanyahsans-Bold.woff2);font-weight:700}
@page{size:A4;margin:14mm 12mm}
*{box-sizing:border-box}body{font-family:T,system-ui,sans-serif;color:#1c1a2b;font-size:12px;line-height:1.6;margin:0}
header{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #7c3aed;padding-bottom:8px;margin-bottom:14px}
h1{font-size:22px;margin:0}h2{font-size:15px;margin:18px 0 6px}.muted{color:#6b6880}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.kpi{background:#f5f3ff;border:1px solid #ddd6fe;border-radius:10px;padding:10px;text-align:center}
.kpi b{display:block;font-size:20px}.kpi span{color:#6b6880;font-size:11px}
.box{background:#faf9ff;border:1px solid #eee;border-radius:10px;padding:8px 12px}.box li{margin:3px 0}
table{width:100%;border-collapse:collapse}th,td{padding:6px 8px;border-bottom:1px solid #eeeaf6;text-align:right;vertical-align:middle}th{background:#f1ecff;font-size:11px}
tr{break-inside:avoid}section{break-inside:avoid-page}.bar-col{width:22%}.bar{display:block;height:8px;border-radius:6px;background:linear-gradient(90deg,#7c3aed,#f97316)}
.tag{display:inline-block;background:#dcfce7;color:#166534;border-radius:6px;padding:0 6px;font-size:10.5px}
.test{background:#fef3c7;color:#92400e;border-radius:8px;padding:6px 10px;margin-bottom:10px}
</style></head><body>
<header><div><h1>تقرير المدفوعات</h1><div class="muted">شيّك Shayyek · ${esc(period)}</div></div><div class="muted">أُنشئ ${esc(date(Date.now()))}</div></header>
${r.test_mode ? `<div class="test">⚠️ بوابة الدفع في الوضع التجريبي — المبالغ تجريبية.</div>` : ""}
<div class="kpis"><div class="kpi"><b>${n(r.total.revenue)} ر.س</b><span>إجمالي الإيراد</span></div><div class="kpi"><b>${n(r.total.count)}</b><span>عمليات ناجحة</span></div><div class="kpi"><b>${n(r.total.customers)}</b><span>عملاء دفعوا</span></div><div class="kpi"><b>${n(avg)} ر.س</b><span>متوسط العملية</span></div></div>
<h2>أهم الملاحظات</h2><div class="box"><ul>${insights.map((x) => `<li>${x}</li>`).join("")}</ul></div>
${table("حسب نوع الدفع", r.by_kind, r.total.revenue)}
${table("الباقات الأكثر مبيعًا (اشتراك + ترقية)", r.by_plan, r.total.revenue)}
${table("حزم الرسائل الإضافية", r.by_pack, r.total.revenue)}
${table("العروض (دفعات استخدمت خصم العرض)", r.by_offer, r.total.revenue, "ما فيه دفعات بخصم عرض")}
${table("حسب الشهر", r.by_month, r.total.revenue)}
${table("أكثر العملاء دفعًا", r.by_customer, r.total.revenue)}
<section><h2>كل العمليات (${n(r.payments.length)})</h2>${r.payments.length ? `<table><thead><tr><th>#</th><th>التاريخ</th><th>العميل</th><th>البند</th><th>المبلغ</th><th>العرض</th></tr></thead><tbody>${r.payments
    .map((p) => `<tr><td>${p.id}</td><td>${esc(date(p.at))}</td><td>${esc(p.customer)}</td><td>${esc(p.what)}</td><td>${n(p.amount)} ر.س</td><td>${p.offer ? `<span class="tag">${esc(p.offer)}</span>` : "—"}</td></tr>`)
    .join("")}</tbody></table>` : `<p class="muted">ما فيه عمليات في هذي الفترة.</p>`}</section>
<p class="muted" style="margin-top:16px">المبالغ شاملة الضريبة كما دُفعت عبر بوابة الدفع. «العروض» = دفعات طُبّق عليها خصم عرض.</p>
<script>document.fonts.ready.then(function(){setTimeout(function(){window.print()},300)})</script>
</body></html>`;
}

export function PaymentsReportCard() {
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const make = async () => {
    // Open the window right away (inside the click) so the browser does not block it.
    const w = window.open("", "_blank");
    if (!w) return toast("المتصفح منع فتح نافذة التقرير — اسمح بالنوافذ المنبثقة لهذا الموقع", "bad");
    w.document.write(`<p dir="rtl" style="font-family:sans-serif;padding:20px">جاري تجهيز التقرير…</p>`);
    setBusy(true);
    try {
      const r = await api<Report>(`/api/owner/payments-report?days=${days}`);
      w.document.open();
      w.document.write(reportHtml(r, location.origin));
      w.document.close();
    } catch (e: any) {
      w.close();
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="📄 تقرير المدفوعات (PDF)">
      <p className="muted mb-3 text-sm">تقرير مرتب فيه الإيراد، والباقات الأكثر مبيعًا، والترقيات، وحزم الرسائل، والعروض اللي دفع منها العملاء، وأكثر العملاء دفعًا، وكل العمليات. يفتح في نافذة جديدة واختر «حفظ كـ PDF».</p>
      <div className="flex flex-wrap items-center gap-2">
        <select className="input !w-auto" value={days} onChange={(e) => setDays(+e.target.value)} aria-label="الفترة">
          <option value={7}>آخر 7 أيام</option>
          <option value={30}>آخر 30 يوم</option>
          <option value={90}>آخر 90 يوم</option>
          <option value={365}>آخر سنة</option>
          <option value={0}>كل الفترة</option>
        </select>
        <button className="btn btn-primary" disabled={busy} onClick={make}><Icon name="download" size={17} />{busy ? "…" : "إصدار التقرير"}</button>
      </div>
    </Card>
  );
}
