import { useState } from "react";
import { api } from "../api";
import { Icon } from "../components/Icon";
import { askConfirm, askText } from "../components/Confirm";
import { Card, Field, toast } from "../components/ui";

/** The owner's payments report: a clean, printable page the browser saves as a PDF. */

type Group = { key: string | number; label: string; count: number; revenue: number };
type Report = {
  from: number; to: number; days: number; ranged: boolean; test_mode: boolean;
  fees: { fee_pct: number; fee_fixed: number; vat_pct: number };
  total: { count: number; revenue: number; customers: number; vat: number; fee: number; net: number };
  by_kind: Group[]; by_plan: Group[]; by_pack: Group[]; by_offer: Group[]; without_offer: number; by_month: Group[]; by_customer: Group[];
  not_paid: Record<string, number>;
  payments: Array<{ id: number; at: number; customer: string; kind: string; what: string; amount: number; offer: string | null; vat: number; fee: number; net: number }>;
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

function reportHtml(r: Report, origin: string, print = true): string {
  const period = r.from ? `${date(r.from)} — ${date(r.to)}` : `كل الفترة حتى ${date(r.to)}`;
  const f = r.fees;
  const costs = f.fee_pct > 0 || f.fee_fixed > 0 || f.vat_pct > 0;
  const feeRule = [f.fee_pct ? `${n(f.fee_pct)}%` : "", f.fee_fixed ? `${n(f.fee_fixed)} ر.س لكل عملية` : ""].filter(Boolean).join(" + ") || "0";
  const top = r.by_plan[0];
  const avg = r.total.count ? r.total.revenue / r.total.count : 0;
  const offerRevenue = r.by_offer.reduce((x, g) => x + g.revenue, 0);
  const notPaid = Object.entries(r.not_paid).filter(([, v]) => v > 0);
  const insights = [
    top ? `الباقة الأكثر مبيعًا: <b>${esc(top.label)}</b> — ${n(top.count)} عملية بإيراد ${n(top.revenue)} ر.س.` : null,
    r.by_offer.length ? `العروض جابت <b>${n(offerRevenue)} ر.س</b> (${r.total.revenue ? Math.round((offerRevenue / r.total.revenue) * 100) : 0}% من الإيراد) من ${n(r.by_offer.reduce((x, g) => x + g.count, 0))} عملية؛ أفضلها «${esc(r.by_offer[0].label)}».` : "ما فيه عمليات دفع استخدمت خصم عرض في هذي الفترة.",
    r.by_pack.length ? `حزم الرسائل الإضافية: ${n(r.by_pack.reduce((x, g) => x + g.count, 0))} عملية — الأكثر طلبًا ${esc(r.by_pack[0].label)}.` : null,
    costs ? `من إجمالي ${n(r.total.revenue)} ر.س: ضريبة القيمة المضافة ${n(r.total.vat)} ر.س، وعمولة ميسّر ${n(r.total.fee)} ر.س، والصافي لك <b>${n(r.total.net)} ر.س</b> (${r.total.revenue ? Math.round((r.total.net / r.total.revenue) * 100) : 0}%).` : null,
    `متوسط قيمة العملية <b>${n(avg)} ر.س</b>، ودفع ${n(r.total.customers)} عميل مختلف.`,
    notPaid.length ? `عمليات ما اكتملت: ${notPaid.map(([k, v]) => `${STATUS[k] ?? k} ${v}`).join("، ")}.` : null,
  ].filter(Boolean);
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>تقرير المدفوعات — شيّك</title><style>
${print ? `@font-face{font-family:T;src:url(${origin}/fonts/thmanyahsans-Regular.woff2);font-weight:400}
@font-face{font-family:T;src:url(${origin}/fonts/thmanyahsans-Bold.woff2);font-weight:700}` : ""}
@page{size:A4;margin:14mm 12mm}
*{box-sizing:border-box}body{font-family:T,system-ui,sans-serif;color:#1c1a2b;font-size:12px;line-height:1.6;margin:0}
header{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #7c3aed;padding-bottom:8px;margin-bottom:14px}header .muted{white-space:nowrap}
h1{font-size:22px;margin:0}h2{font-size:15px;margin:18px 0 6px}.muted{color:#6b6880}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.kpi{background:#f5f3ff;border:1px solid #ddd6fe;border-radius:10px;padding:10px;text-align:center}
.kpi b{display:block;font-size:20px}.kpi.net{background:#dcfce7;border-color:#86efac}.kpi span{color:#6b6880;font-size:11px}
.box{background:#faf9ff;border:1px solid #eee;border-radius:10px;padding:8px 12px}.box li{margin:3px 0}
table{width:100%;border-collapse:collapse}th,td{padding:6px 8px;border-bottom:1px solid #eeeaf6;text-align:right;vertical-align:middle}th{background:#f1ecff;font-size:11px}
tr{break-inside:avoid}section{break-inside:avoid-page}.bar-col{width:22%}.bar{display:block;height:8px;border-radius:6px;background:linear-gradient(90deg,#7c3aed,#f97316)}
.tag{display:inline-block;background:#dcfce7;color:#166534;border-radius:6px;padding:0 6px;font-size:10.5px}
.test{background:#fef3c7;color:#92400e;border-radius:8px;padding:6px 10px;margin-bottom:10px}
</style></head><body>
<header><div><h1>تقرير المدفوعات</h1><div class="muted">شيّك Shayyek · ${esc(period)}</div></div><div class="muted">أُنشئ ${esc(date(Date.now()))}</div></header>
${r.test_mode ? `<div class="test">⚠️ بوابة الدفع في الوضع التجريبي — المبالغ تجريبية.</div>` : ""}
<div class="kpis"><div class="kpi"><b>${n(r.total.revenue)} ر.س</b><span>إجمالي الإيراد</span></div><div class="kpi"><b>${n(r.total.count)}</b><span>عمليات ناجحة</span></div><div class="kpi"><b>${n(r.total.customers)}</b><span>عملاء دفعوا</span></div><div class="kpi"><b>${n(avg)} ر.س</b><span>متوسط العملية</span></div></div>
${costs ? `<h2>الدخل والخصومات</h2><div class="kpis"><div class="kpi"><b>${n(r.total.revenue)} ر.س</b><span>الدخل (شامل الضريبة)</span></div><div class="kpi"><b>${n(r.total.fee)} ر.س</b><span>عمولة ميسّر (${esc(feeRule)})</span></div><div class="kpi"><b>${n(r.total.vat)} ر.س</b><span>الضريبة (${n(f.vat_pct)}%)</span></div><div class="kpi net"><b>${n(r.total.net)} ر.س</b><span>الصافي</span></div></div>` : ""}
<h2>أهم الملاحظات</h2><div class="box"><ul>${insights.map((x) => `<li>${x}</li>`).join("")}</ul></div>
${table("حسب نوع الدفع", r.by_kind, r.total.revenue)}
${table("الباقات الأكثر مبيعًا (اشتراك + ترقية)", r.by_plan, r.total.revenue)}
${table("حزم الرسائل الإضافية", r.by_pack, r.total.revenue)}
${table("العروض (دفعات استخدمت خصم العرض)", r.by_offer, r.total.revenue, "ما فيه دفعات بخصم عرض")}
${table("حسب الشهر", r.by_month, r.total.revenue)}
${table("أكثر العملاء دفعًا", r.by_customer, r.total.revenue)}
<section><h2>كل العمليات (${n(r.payments.length)})</h2>${r.payments.length ? `<table><thead><tr><th>#</th><th>التاريخ</th><th>العميل</th><th>البند</th><th>المبلغ</th>${costs ? "<th>العمولة</th><th>الضريبة</th><th>الصافي</th>" : ""}<th>العرض</th></tr></thead><tbody>${r.payments
    .map((p) => `<tr><td>${p.id}</td><td>${esc(date(p.at))}</td><td>${esc(p.customer)}</td><td>${esc(p.what)}</td><td>${n(p.amount)} ر.س</td>${costs ? `<td>${n(p.fee)}</td><td>${n(p.vat)}</td><td><b>${n(p.net)}</b></td>` : ""}<td>${p.offer ? `<span class="tag">${esc(p.offer)}</span>` : "—"}</td></tr>`)
    .join("")}</tbody></table>` : `<p class="muted">ما فيه عمليات في هذي الفترة.</p>`}</section>
<p class="muted" style="margin-top:16px">المبالغ شاملة الضريبة كما دُفعت عبر بوابة الدفع. ${costs ? `الضريبة محسوبة من داخل المبلغ (المبلغ × ${n(f.vat_pct)} ÷ ${n(100 + f.vat_pct)})، والعمولة حسب النسبة اللي أدخلتها — راجع الأرقام الفعلية في كشف ميسّر. ` : ""}«العروض» = دفعات طُبّق عليها خصم عرض.</p>
${print ? `<script>document.fonts.ready.then(function(){setTimeout(function(){window.print()},300)})</script>` : ""}
</body></html>`;
}

/**
 * Draws the report page off screen and saves it as a PDF file (A4 pages, as images so the Arabic text keeps its
 * shape). The PDF tools load only when the button is pressed.
 */
async function downloadPdf(r: Report): Promise<void> {
  const [{ jsPDF }, { default: html2canvas }] = await Promise.all([import("jspdf"), import("html2canvas")]);
  // The page is drawn by the browser itself (SVG foreignObject) so Arabic words join and space correctly. That
  // drawing cannot load web fonts, so the file uses the system font — and the page is measured in the same font,
  // so the page breaks fall exactly between rows.
  const W = 794; // A4 width in CSS pixels at 96 dpi
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = `position:fixed;left:-${W * 3}px;top:0;width:${W}px;height:1123px;border:0;visibility:hidden`;
  document.body.appendChild(frame);
  try {
    await new Promise<void>((res) => {
      frame.onload = () => res();
      frame.srcdoc = reportHtml(r, location.origin, false).replace("<body>", `<body style="width:${W}px;padding:34px 30px;background:#fff">`);
    });
    const doc = frame.contentDocument!;
    await doc.fonts.ready;
    // Where a page may end: before a section, a summary box, or a table row (never inside one). A page that
    // starts inside a table repeats that table's header row.
    const top = (el: Element) => el.getBoundingClientRect().top;
    const cuts = new Map<number, { headTop: number; headH: number } | null>();
    doc.querySelectorAll("section, h2, .kpis, .box, body > p").forEach((el) => cuts.set(Math.floor(top(el)), null));
    doc.querySelectorAll("table").forEach((t) => {
      const head = t.querySelector("thead");
      const hr = head?.getBoundingClientRect();
      t.querySelectorAll("tbody tr").forEach((tr, i) => {
        if (i > 0) cuts.set(Math.floor(top(tr)), hr ? { headTop: hr.top, headH: hr.height } : null);
      });
    });
    const totalH = Math.ceil(doc.body.scrollHeight);
    const canvas = await html2canvas(doc.body, { scale: 2, backgroundColor: "#ffffff", width: W, windowWidth: W, height: totalH, windowHeight: totalH, logging: false, foreignObjectRendering: true });
    const S = canvas.width / W; // canvas pixels per CSS pixel
    const pdf = new jsPDF({ unit: "pt", format: "a4", compress: true });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const k = pageW / W; // PDF points per CSS pixel
    const margin = 26; // pt, top and bottom of every page after the first
    const points = [...cuts.keys()].sort((x, y) => x - y);
    let start = 0;
    for (let page = 0; start < totalH - 2; page++) {
      const head = page > 0 ? cuts.get(start) ?? null : null;
      const room = (pageH - (page ? margin * 2 : margin)) / k - (head ? head.headH : 0);
      const limit = start + room;
      const end = totalH <= limit ? totalH : points.filter((y) => y > start + 40 && y <= limit).pop() ?? Math.floor(limit);
      const part = document.createElement("canvas");
      const headPx = head ? Math.round(head.headH * S) : 0;
      part.width = canvas.width;
      part.height = headPx + Math.round((end - start) * S);
      const ctx = part.getContext("2d")!;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, part.width, part.height);
      if (head) ctx.drawImage(canvas, 0, Math.round(head.headTop * S), canvas.width, headPx, 0, 0, canvas.width, headPx);
      ctx.drawImage(canvas, 0, Math.round(start * S), canvas.width, part.height - headPx, 0, headPx, canvas.width, part.height - headPx);
      if (page) pdf.addPage();
      pdf.addImage(part.toDataURL("image/jpeg", 0.92), "JPEG", 0, page ? margin : 0, pageW, part.height / S * k);
      pdf.setFontSize(8);
      pdf.setTextColor(150);
      pdf.text(`${page + 1}`, pageW / 2, pageH - 10, { align: "center" });
      start = end;
    }
    const day = new Date().toISOString().slice(0, 10);
    pdf.save(`shayyek-payments-${r.from ? new Date(r.from + 3 * 3_600_000).toISOString().slice(0, 10) + "_" + new Date(r.to + 3 * 3_600_000).toISOString().slice(0, 10) : "all"}-${day}.pdf`);
  } finally {
    frame.remove();
  }
}

const FEES_KEY = "shayyek.report.fees";
const loadFees = () => {
  try {
    const v = JSON.parse(localStorage.getItem(FEES_KEY) || "null");
    if (v && typeof v === "object") return { fee_pct: String(v.fee_pct ?? ""), fee_fixed: String(v.fee_fixed ?? ""), vat_pct: String(v.vat_pct ?? "15") };
  } catch {}
  return { fee_pct: "", fee_fixed: "", vat_pct: "15" };
};
const today = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);

export function PaymentsReportCard({ onDeleted }: { onDeleted?: () => void } = {}) {
  const [days, setDays] = useState<number | "range">(30);
  const [from, setFrom] = useState(() => today().slice(0, 8) + "01");
  const [to, setTo] = useState(today);
  const [fees, setFees] = useState(loadFees);
  const [busy, setBusy] = useState(false);
  const query = () => {
    try {
      localStorage.setItem(FEES_KEY, JSON.stringify(fees));
    } catch {}
    const q = new URLSearchParams(days === "range" ? { from, to } : { days: String(days) });
    for (const [k, v] of Object.entries(fees)) if (v !== "") q.set(k, String(Number(v) || 0));
    return `/api/owner/payments-report?${q}`;
  };
  const download = async () => {
    if (days === "range" && from > to) return toast("تاريخ البداية بعد تاريخ النهاية", "bad");
    setBusy(true);
    try {
      await downloadPdf(await api<Report>(query()));
      toast("تنزّل التقرير");
    } catch (e: any) {
      toast(e.message || "تعذّر تجهيز الملف", "bad");
    } finally {
      setBusy(false);
    }
  };
  const make = async () => {
    if (days === "range" && from > to) return toast("تاريخ البداية بعد تاريخ النهاية", "bad");
    // Open the window right away (inside the click) so the browser does not block it.
    const w = window.open("", "_blank");
    if (!w) return toast("المتصفح منع فتح نافذة التقرير — اسمح بالنوافذ المنبثقة لهذا الموقع", "bad");
    w.document.write(`<p dir="rtl" style="font-family:sans-serif;padding:20px">جاري تجهيز التقرير…</p>`);
    setBusy(true);
    try {
      const r = await api<Report>(query());
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
  const wipe = async () => {
    const sure = await askConfirm({
      title: "حذف سجل الدفع كامل؟",
      message: "تنحذف كل عمليات الدفع المسجلة هنا (الناجحة وغيرها) ويصير التقرير وإحصائيات تحويل العروض فاضية. اشتراكات العملاء ورسائلهم ما تتأثر، والعمليات تبقى محفوظة في لوحة ميسّر. ما يمكن التراجع — نزّل التقرير قبل إذا تحتاجه.",
      confirmLabel: "متابعة",
      danger: true,
    });
    if (!sure) return;
    const password = await askText({ title: "تأكيد بكلمة المرور", message: "اكتب كلمة مرور حسابك لحذف سجل الدفع.", label: "كلمة المرور", confirmLabel: "احذف السجل", danger: true, secret: true });
    if (!password) return;
    setBusy(true);
    try {
      const r = await api<{ deleted: number }>("/api/owner/payments/delete-all", { method: "POST", body: { password } });
      toast(`انحذف سجل الدفع (${r.deleted.toLocaleString("en-US")} عملية)`);
      onDeleted?.();
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  const setFee = (k: keyof typeof fees) => (e: React.ChangeEvent<HTMLInputElement>) => setFees({ ...fees, [k]: e.target.value });
  return (
    <Card title="📄 تقرير المدفوعات (PDF)">
      <p className="muted mb-3 text-sm">تقرير مرتب فيه الدخل، وعمولة ميسّر، والضريبة، والصافي، والباقات الأكثر مبيعًا، والترقيات، وحزم الرسائل، والعروض، وأكثر العملاء دفعًا، وكل العمليات. «تنزيل PDF» يحفظ الملف على جهازك، و«عرض وطباعة» يفتحه في نافذة.</p>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <select className="input !w-auto" value={days} onChange={(e) => setDays(e.target.value === "range" ? "range" : +e.target.value)} aria-label="الفترة">
            <option value={7}>آخر 7 أيام</option>
            <option value={30}>آخر 30 يوم</option>
            <option value={90}>آخر 90 يوم</option>
            <option value={365}>آخر سنة</option>
            <option value={0}>كل الفترة</option>
            <option value="range">من تاريخ — إلى تاريخ</option>
          </select>
          {days === "range" && (
            <>
              <label className="flex items-center gap-1 text-sm">من <input className="input !w-auto" type="date" dir="ltr" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
              <label className="flex items-center gap-1 text-sm">إلى <input className="input !w-auto" type="date" dir="ltr" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
            </>
          )}
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Field label="عمولة ميسّر (%)" hint="نسبة من كل عملية — فارغ = بدون">
            <input className="input" type="number" min={0} max={50} step="any" dir="ltr" value={fees.fee_pct} onChange={setFee("fee_pct")} placeholder="مثل 2.75" />
          </Field>
          <Field label="عمولة ثابتة لكل عملية (ر.س)" hint="إن وُجدت — فارغ = بدون">
            <input className="input" type="number" min={0} max={100} step="any" dir="ltr" value={fees.fee_fixed} onChange={setFee("fee_fixed")} placeholder="مثل 1" />
          </Field>
          <Field label="ضريبة القيمة المضافة (%)" hint="محسوبة من داخل المبلغ (الأسعار شاملة)">
            <input className="input" type="number" min={0} max={50} step="any" dir="ltr" value={fees.vat_pct} onChange={setFee("vat_pct")} placeholder="15" />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn btn-primary" disabled={busy} onClick={download}><Icon name="download" size={17} />{busy ? "…" : "تنزيل PDF"}</button>
          <button className="btn btn-ghost" disabled={busy} onClick={make}>عرض وطباعة</button>
          <button className="btn btn-ghost ms-auto text-red-600" disabled={busy} onClick={wipe}>🗑️ حذف سجل الدفع</button>
        </div>
      </div>
    </Card>
  );
}
