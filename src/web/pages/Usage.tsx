import { api } from "../api";
import { useState } from "react";
import { Alert, Card, InfoDot, PageHeader, Spinner, fmtDate, fmtTime, useAsync } from "../components/ui";
import { Icon } from "../components/Icon";

/** Owner-only: how close the service is to Cloudflare's free limits. */
const fmtCount = (n: number) => n.toLocaleString("en-US");
const trim = (n: number, d: number) => String(Number(n.toFixed(d)));
function fmtBytes(b: number) {
  if (b < 1024 * 1024) return `${trim(b / 1024, 0)} كيلو`;
  if (b < 1024 ** 3) return `${trim(b / 1024 / 1024, 1)} ميجا`;
  return `${trim(b / 1024 ** 3, 2)} جيجا`;
}
const PERIOD: Record<string, string> = { day: "اليوم", month: "هذا الشهر", now: "الحين" };

export function UsagePage() {
  const [force, setForce] = useState(0);
  const { data, loading, reload } = useAsync(() => api<any>(`/api/owner/usage${force ? "?refresh=1" : ""}`), [force]);
  const worst = data ? Math.max(...data.meters.map((m: any) => m.pct)) : 0;
  return (
    <div className="space-y-5">
      <PageHeader
        title="الاستهلاك"
        subtitle="قرب الخدمة من حدود Cloudflare المجانية — لكل العملاء مع بعض."
        actions={<button className="btn btn-ghost" onClick={() => (force ? reload() : setForce(1))} disabled={loading}><Icon name="refresh" size={17} />{loading ? "…" : "تحديث"}</button>}
      />
      {!data ? <Spinner /> : (
        <>
          {worst >= 90 ? (
            <Alert tone="bad">وصلت لأكثر من 90% من أحد الحدود. فعّل خطة Workers Paid (5$ شهريًا) من لوحة Cloudflare قبل ما تتوقف الخدمة.</Alert>
          ) : worst >= 70 ? (
            <Alert tone="warn">تجاوزت 70% من أحد الحدود — راقبه، وفكّر في خطة Workers Paid (5$ شهريًا) إذا استمر.</Alert>
          ) : (
            <Alert tone="good">كل شي بعيد عن الحدود المجانية.</Alert>
          )}
          {data.cf_connected ? (
            data.cf_errors?.length ? (
              <Alert tone="warn">
                بعض الأرقام من Cloudflare ما وصلت ({data.cf_errors.length})، فظهرت تقديرية بدلها:
                <ul className="mt-1 list-disc pr-5 text-xs" dir="ltr" style={{ textAlign: "left" }}>{data.cf_errors.map((e: string) => <li key={e}>{e}</li>)}</ul>
              </Alert>
            ) : <p className="muted text-xs">✅ الأرقام مأخوذة من إحصاءات Cloudflare الرسمية (تتحدث كل 10 دقائق).</p>
          ) : (
            <Alert tone="info">الأرقام اليومية تقديرية. لأرقام دقيقة من Cloudflare: أضف توكن قراءة الإحصاءات في GitHub Secrets باسم <span dir="ltr">CF_ANALYTICS_TOKEN</span> (الخطوات في المحادثة / docs/DEPLOY.md).</Alert>
          )}
          {data.domain && <DomainCard d={data.domain} />}
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 md:grid-cols-2">
            {data.meters.map((m: any) => {
              const tone = m.pct >= 90 ? "bg-red-500" : m.pct >= 70 ? "bg-amber-500" : "bg-emerald-500";
              const show = (n: number) => (m.unit === "bytes" ? fmtBytes(n) : fmtCount(n));
              return (
                <Card key={m.key}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1 font-semibold">{m.label}<InfoDot text={m.note} /></div>
                      <div className="muted text-xs">{PERIOD[m.period]}{m.estimate ? " · تقديري" : " · دقيق"}</div>
                    </div>
                    <div className="font-display text-xl font-extrabold tabular-nums">{m.pct}%</div>
                  </div>
                  <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-[var(--border)]">
                    <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.max(m.pct, m.used > 0 ? 1 : 0)}%` }} />
                  </div>
                  <div className="muted mt-1.5 text-xs tabular-nums">{show(m.used)} من {show(m.limit)}</div>
                </Card>
              );
            })}
          </div>
          <Card title="معلومات">
            <ul className="muted list-disc space-y-1.5 pr-5 text-sm">
              <li>«دقيق» = من Cloudflare نفسه أو من سجلات النظام المؤكدة. «تقديري» = محسوب من اللي سجّله النظام، وغالبًا أعلى شوي من الحقيقي.</li>
              <li>الحدود اليومية تتصفّر 03:00 بتوقيت السعودية. إذا وصلت 100%، تتوقف الردود لين التصفير، وبعدها النظام يسترجع التعليقات الفائتة.</li>
              <li>يوصلك تنبيه (تيليجرام) إذا تجاوز أي حد 70% للمساحة أو 80% للحدود اليومية — من الإعدادات › التنبيهات.</li>
              <li>آخر تحديث: {fmtTime(data.generated_at)}</li>
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}

function DomainCard({ d }: { d: any }) {
  const left = d.expires_at ? Math.floor((d.expires_at - Date.now()) / 86_400_000) : null;
  const tone = left === null ? "" : left <= 7 ? "text-red-600 dark:text-red-400" : left <= 30 ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400";
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1 font-semibold">الدومين <span dir="ltr">{d.name}</span><InfoDot text="من سجل الدومين الرسمي (RDAP). إذا انتهى الدومين يتوقف الموقع والتطبيق والردود — يوصلك تنبيه قبلها بـ 30 يوم." /></div>
          <div className="muted text-xs">{d.registrar ? `المسجّل: ${d.registrar}` : ""}{d.registered_at ? ` · مسجّل من ${fmtDate(d.registered_at)}` : ""}</div>
        </div>
        {left !== null ? (
          <div className="text-left">
            <div className={`font-display text-xl font-extrabold tabular-nums ${tone}`}>{left} يوم</div>
            <div className="muted text-xs">ينتهي {fmtDate(d.expires_at)}</div>
          </div>
        ) : (
          <span className="muted max-w-full text-xs">{d.error ?? "التاريخ غير متاح"}</span>
        )}
      </div>
    </Card>
  );
}
