import { api } from "../api";
import { Alert, Card, InfoDot, PageHeader, Spinner, fmtTime, useAsync } from "../components/ui";
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
  const { data, loading, reload } = useAsync(() => api<{ meters: any[]; generated_at: number }>("/api/owner/usage"), []);
  const worst = data ? Math.max(...data.meters.map((m) => m.pct)) : 0;
  return (
    <div className="space-y-5">
      <PageHeader
        title="الاستهلاك"
        subtitle="قرب الخدمة من حدود Cloudflare المجانية — لكل العملاء مع بعض."
        actions={<button className="btn btn-ghost" onClick={reload} disabled={loading}><Icon name="refresh" size={17} />{loading ? "…" : "تحديث"}</button>}
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
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 md:grid-cols-2">
            {data.meters.map((m) => {
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
              <li>الأرقام «التقديرية» محسوبة من اللي سجّله النظام، وغالبًا أعلى شوي من الحقيقي. الأرقام الدقيقة في لوحة Cloudflare (Workers و D1 و R2).</li>
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
