import { api } from "../api";
import { Link } from "../App";
import { Icon } from "../components/Icon";
import { Alert, Card, InfoDot, PageHeader, Spinner, Toggle, fmtDate, toast, useAsync } from "../components/ui";
import { useState } from "react";
import { isNative } from "../platform";
import { saveFile } from "../lib/save";

/** The weekly report: last 7 days against the 7 before. Printable (the browser's "Save as PDF") and shareable. */
const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const money = (n: number | null | undefined, cur = "SAR") => (typeof n === "number" ? `${fmt(n)} ${cur === "SAR" ? "ر.س" : cur}` : "—");

function Delta({ now, prev }: { now: number | null; prev: number | null }) {
  if (now == null || prev == null) return null;
  if (prev === 0) return now > 0 ? <span className="rounded-full bg-emerald-500/15 px-1.5 text-[11px] font-bold text-emerald-700 dark:text-emerald-300">جديد</span> : null;
  const d = Math.round(((now - prev) / Math.abs(prev)) * 100);
  return (
    <span className={`rounded-full px-1.5 text-[11px] font-bold tabular-nums ${d >= 0 ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-rose-500/15 text-rose-700 dark:text-rose-300"}`}>
      {d >= 0 ? "▲" : "▼"} {Math.abs(d)}%
    </span>
  );
}

function Metric({ label, now, prev, f = fmt }: { label: string; now: number | null; prev: number | null; f?: (n: number) => string }) {
  return (
    <div className="surface-2 rounded-2xl p-3">
      <div className="muted text-xs">{label}</div>
      <div className="font-display mt-1 text-xl font-extrabold tabular-nums">{now == null ? "—" : f(now)}</div>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <Delta now={now} prev={prev} />
        {prev != null && <span className="muted">قبله: {f(prev)}</span>}
      </div>
    </div>
  );
}

export function ReportPage() {
  const { data, error } = useAsync(() => api<any>("/api/growth/weekly"), []);
  const [busy, setBusy] = useState(false);
  const download = async () => {
    const el = document.getElementById("print-root");
    if (!el || !data) return;
    setBusy(true);
    try {
      const { elementToPdf } = await import("../lib/elementPdf");
      const day = new Date(data.to).toISOString().slice(0, 10);
      await saveFile(await elementToPdf(el), `HSN-weekly-report-${day}.pdf`, "التقرير الأسبوعي");
    } catch (e: any) {
      toast(e?.message || "تعذر إنشاء ملف PDF", "bad");
    } finally {
      setBusy(false);
    }
  };
  const a = data?.activity;
  const s = data?.store;
  const cur = s?.currency ?? "SAR";
  return (
    <div className="space-y-5" id="print-root">
      <PageHeader
        title="التقرير الأسبوعي"
        subtitle={data ? `${fmtDate(data.from)} — ${fmtDate(data.to)} · مقارنة بالأسبوع اللي قبله` : "آخر 7 أيام مقارنة بالأسبوع اللي قبله"}
        actions={
          <div className="no-print flex flex-wrap gap-2">
            <button className="btn btn-primary" disabled={busy || !data} onClick={download}><Icon name="download" size={17} />{busy ? "جاري التجهيز…" : "تحميل PDF"}</button>
            {!isNative && <button className="btn btn-ghost" disabled={!data} onClick={() => window.print()}>🖨️ طباعة</button>}
          </div>
        }
      />
      {error ? <Alert tone="bad">{error}</Alert> : !data ? <Spinner /> : (
        <>
          <Card title="التفاعل">
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              <Metric label="تعليقات" now={a.comments.now} prev={a.comments.prev} />
              <Metric label="تفاعلوا مع حملاتك" now={a.people.now} prev={a.people.prev} />
              <Metric label="وصلهم المحتوى" now={a.delivered.now} prev={a.delivered.prev} />
              <Metric label="ضغطوا الرابط" now={a.clicked.now} prev={a.clicked.prev} />
            </div>
          </Card>

          {s && (
            <Card title="المتجر">
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                <Metric label="الطلبات" now={s.orders.now} prev={s.orders.prev} />
                <Metric label="المبيعات" now={s.revenue.now} prev={s.revenue.prev} f={(n) => money(n, cur)} />
                <Metric label="الربح التقديري" now={s.profit.now} prev={s.profit.prev} f={(n) => money(n, cur)} />
                <div className="surface-2 rounded-2xl p-3">
                  <div className="muted flex items-center gap-1 text-xs">من حملاتك (بالكود)<InfoDot text="طلبات استخدمت كود خصم حملة من حملاتك." /></div>
                  <div className="font-display mt-1 text-xl font-extrabold tabular-nums">{money(s.from_campaigns, cur)}</div>
                </div>
              </div>
            </Card>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="🏆 أبرز الأسبوع">
              <ul className="space-y-3 text-sm">
                {s?.best_campaign && (
                  <li><span className="muted text-xs">أكثر حملة بيعًا</span><div className="font-semibold">{s.best_campaign.name} — {fmt(s.best_campaign.orders)} طلب · {money(s.best_campaign.revenue, cur)}</div></li>
                )}
                {data.top_campaign && (
                  <li><span className="muted text-xs">أنشط حملة</span><div className="font-semibold">{data.top_campaign.name} — {fmt(data.top_campaign.people)} شخص تفاعلوا · {fmt(data.top_campaign.delivered)} وصلهم المحتوى</div></li>
                )}
                {!s?.best_campaign && !data.top_campaign && <li className="muted">ما فيه نشاط على الحملات هذا الأسبوع.</li>}
              </ul>
            </Card>
            <Card title="📌 أفضل منشور">
              {data.top_post ? (
                <div className="flex gap-3">
                  {data.top_post.thumbnail_url ? <img src={data.top_post.thumbnail_url} alt="" className="size-20 shrink-0 rounded-xl object-cover" /> : <span className="surface-2 grid size-20 shrink-0 place-items-center rounded-xl text-2xl">🖼️</span>}
                  <div className="min-w-0 text-sm">
                    <p className="line-clamp-2">{data.top_post.caption ?? "بدون وصف"}</p>
                    <div className="muted mt-1 text-xs">
                      {data.top_post.orders ? `${fmt(data.top_post.orders)} طلب · ${money(data.top_post.revenue, cur)} · ` : ""}
                      {fmt(data.top_post.people)} تفاعل · {fmt(data.top_post.clickers)} ضغطوا
                    </div>
                    {data.top_post.permalink && <a href={data.top_post.permalink} target="_blank" rel="noreferrer" className="no-print mt-1 inline-block text-xs font-semibold text-[var(--primary)]">افتح في إنستقرام ↗</a>}
                  </div>
                </div>
              ) : <p className="muted text-sm">ما فيه تفاعل على المنشورات هذا الأسبوع.</p>}
            </Card>
          </div>
          <WeeklyTelegram />
        </>
      )}
    </div>
  );
}

/** On/off for the Saturday Telegram copy of this report, right here (same setting as in Settings › Notifications). */
function WeeklyTelegram() {
  const { data, reload } = useAsync(() => api<any>("/api/notifications").catch(() => null), []);
  const [busy, setBusy] = useState(false);
  if (!data) return null;
  const s = data.settings;
  const ready = !!s?.enabled && !!s?.chat_id;
  return (
    <div className="card no-print p-4">
      {ready ? (
        <Toggle
          checked={s.weekly_report !== false}
          disabled={busy}
          onChange={async (v) => {
            setBusy(true);
            try {
              await api("/api/notifications", { method: "PUT", body: { weekly_report: v } });
              toast(v ? "بيوصلك التقرير كل سبت على تيليجرام" : "تم إيقاف إرسال التقرير الأسبوعي");
              reload();
            } catch (e: any) {
              toast(e.message, "bad");
            } finally {
              setBusy(false);
            }
          }}
          label="إرسال هذا التقرير كل سبت على تيليجرام"
          description={`يوصلك الساعة ${String(s.report_hour).padStart(2, "0")}:00 مع رابط التقرير الكامل.`}
        />
      ) : (
        <p className="muted text-sm">تبغى يوصلك هذا التقرير كل سبت على تيليجرام؟ فعّل إشعارات تيليجرام من <Link to="/settings" className="font-semibold text-[var(--primary)]">الإعدادات</Link>.</p>
      )}
    </div>
  );
}
