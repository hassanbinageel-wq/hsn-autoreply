import { useState } from "react";
import { api } from "../api";
import { saveFile } from "../lib/save";
import { REASONS } from "../pages/Logs";
import { Modal, Spinner, fmtTime, toast, useAsync } from "./ui";

/**
 * Owner panel: diagnosis of one customer — what blocks their replies, with the fix — and a downloadable
 * report (no tokens, message texts or follower names) to send to support / Claude.
 */
const LEVEL = {
  bad: { icon: "❌", cls: "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200" },
  warn: { icon: "⚠️", cls: "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200" },
  info: { icon: "ℹ️", cls: "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200" },
  ok: { icon: "✅", cls: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200" },
} as const;

const JOB_STATUS: Record<string, string> = { accepted: "نجح", failed: "فشل", uncertain: "غير مؤكد", pending: "بالانتظار", retry_scheduled: "إعادة محاولة", cancelled: "ملغي", processing: "قيد التنفيذ" };

/** A readable Markdown report with the full JSON at the end. */
function toMarkdown(d: any): string {
  const lines = [
    `# تشخيص عميل — ${d.customer.name} (#${d.customer.id})`,
    `أُنشئ: ${d.generated_at} · إصدار الخادم: ${d.app_version}`,
    "",
    `الخلاصة: ${d.summary.bad} مشكلة · ${d.summary.warn} تنبيه`,
    "",
    "## الفحوصات",
    ...d.checks.map((c: any) => `- ${LEVEL[c.level as keyof typeof LEVEL].icon} [${c.area}] ${c.title}${c.fix ? `\n  - الحل: ${c.fix}` : ""}`),
    "",
    "## البيانات الكاملة (JSON)",
    "```json",
    JSON.stringify(d, null, 2),
    "```",
  ];
  return lines.join("\n");
}

export function DiagnoseModal({ tenant, onClose }: { tenant: { id: number; name: string }; onClose: () => void }) {
  const { data, reload, loading, error } = useAsync(() => api<any>(`/api/owner/tenants/${tenant.id}/diagnose`), [tenant.id]);
  const [more, setMore] = useState(false);
  const download = async () => {
    const name = `hsn-diagnose-${tenant.id}-${new Date().toISOString().slice(0, 10)}.md`;
    try {
      await saveFile(new Blob([toMarkdown(data)], { type: "text/markdown;charset=utf-8" }), name, `تشخيص ${tenant.name}`);
    } catch (e: any) {
      toast(e.message, "bad");
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(toMarkdown(data));
      toast("تم نسخ التقرير");
    } catch {
      toast("ما قدرت أنسخ — استخدم التنزيل", "bad");
    }
  };
  return (
    <Modal open onClose={onClose} title={`🩺 تشخيص «${tenant.name}»`} center>
      {!data ? (
        error ? <p className="text-sm text-red-600">{error}</p> : <Spinner />
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <b className={data.summary.bad ? "text-rose-600" : data.summary.warn ? "text-amber-600" : "text-emerald-600"}>
              {data.summary.bad ? `${data.summary.bad} مشكلة تمنع الردود` : data.summary.warn ? `${data.summary.warn} تنبيه` : "كل شي سليم ✅"}
            </b>
            <span className="muted text-xs">· {fmtTime(Date.parse(data.generated_at))}</span>
          </div>
          <div className="max-h-[50vh] space-y-1.5 overflow-y-auto pe-1">
            {data.checks.map((c: any, i: number) => (
              <div key={i} className={`rounded-xl border px-3 py-2 text-sm ${LEVEL[c.level as keyof typeof LEVEL].cls}`}>
                <div>
                  <span className="me-1">{LEVEL[c.level as keyof typeof LEVEL].icon}</span>
                  <span className="text-[11px] font-bold opacity-70">{c.area} · </span>
                  {c.title}
                </div>
                {c.fix && <div className="mt-0.5 text-xs opacity-90">👈 {c.fix}</div>}
              </div>
            ))}
            {more && <Details d={data.details} />}
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary min-h-10 text-sm" onClick={download}>⬇️ تنزيل التقرير</button>
            <button className="btn btn-ghost min-h-10 text-sm" onClick={copy}>نسخ</button>
            <button className="btn btn-ghost min-h-10 text-sm" onClick={() => setMore(!more)}>{more ? "إخفاء التفاصيل" : "التفاصيل"}</button>
            <button className="btn btn-ghost min-h-10 text-sm" disabled={loading} onClick={reload}>{loading ? "…" : "إعادة الفحص"}</button>
          </div>
          <p className="muted text-[11px]">التقرير ما فيه توكنات ولا كلمات مرور ولا نصوص رسائل ولا أسماء المتابعين — أرقام وحالات وأخطاء بس. نزّله وأرسله لـ Claude لحل المشكلة.</p>
        </div>
      )}
    </Modal>
  );
}

function Details({ d }: { d: any }) {
  return (
    <div className="surface-2 space-y-3 rounded-2xl p-3 text-xs">
      <Section title="الأحداث آخر 7 أيام (تعليقات ورسائل)">
        {d.events_7d.length ? d.events_7d.map((e: any, i: number) => <Row key={i} k={e.status === "ignored" ? `تجاهل: ${REASONS[e.reason] ?? e.reason ?? "—"}` : e.status} v={e.n} />) : <span className="muted">لا شيء</span>}
      </Section>
      <Section title="الإرسال آخر 7 أيام">
        {d.jobs_7d.length ? d.jobs_7d.map((j: any) => <Row key={j.status} k={JOB_STATUS[j.status] ?? j.status} v={j.n} />) : <span className="muted">لا شيء</span>}
      </Section>
      {d.recent_failures.length > 0 && (
        <Section title="آخر الأخطاء">
          {d.recent_failures.map((f: any, i: number) => (
            <div key={i} className="border-b border-[var(--border)] py-1 last:border-0">
              <b>{f.kind}{f.purpose ? ` / ${f.purpose}` : ""}</b> · {JOB_STATUS[f.status] ?? f.status} · {fmtTime(Date.parse(f.updated_at))}
              {f.last_error && <div className="muted break-words" dir="ltr">{f.last_error}</div>}
            </div>
          ))}
        </Section>
      )}
      {d.sessions.length > 0 && (
        <Section title="الأجهزة">
          {d.sessions.map((s: any, i: number) => <Row key={i} k={`${s.kind === "device" ? "📱 التطبيق" : "🌐 الويب"}${s.device ? ` · ${s.device}` : ""}`} v={fmtTime(Date.parse(s.last_seen_at))} />)}
        </Section>
      )}
    </div>
  );
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div>
    <div className="mb-1 font-bold">{title}</div>
    {children}
  </div>
);
const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div className="flex justify-between gap-2 py-0.5">
    <span className="min-w-0 truncate">{k}</span>
    <b className="shrink-0">{v}</b>
  </div>
);
