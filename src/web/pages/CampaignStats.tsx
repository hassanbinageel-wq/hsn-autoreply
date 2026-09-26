import { useState } from "react";
import { api } from "../api";
import { Link } from "../App";
import { Alert, Card, Empty, PageHeader, Spinner, Stat, fmtTime, useAsync } from "../components/ui";

const PERIODS: Array<[number, string]> = [
  [1, "اليوم"],
  [7, "7 أيام"],
  [30, "30 يومًا"],
  [0, "الكل"],
];

const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");

/** Horizontal funnel bar: how many of the people who triggered the campaign reached each step. */
function Funnel({ steps, base }: { steps: Array<[string, number, string]>; base: number }) {
  return (
    <div className="space-y-2">
      {steps.map(([label, n, color]) => (
        <div key={label}>
          <div className="mb-1 flex justify-between text-sm">
            <span>{label}</span>
            <span className="tabular-nums">
              <b>{n}</b> <span className="muted">({pct(n, base)})</span>
            </span>
          </div>
          <div className="surface-2 h-2.5 overflow-hidden rounded-full">
            <div className={`h-full rounded-full ${color}`} style={{ width: base > 0 ? `${Math.min(100, (n / base) * 100)}%` : "0%" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: number | string; tone?: string }) {
  return (
    <div className="surface-2 rounded-xl px-2 py-2 text-center">
      <div className={`text-lg font-bold tabular-nums ${tone ?? ""}`}>{value}</div>
      <div className="muted text-[11px] leading-tight">{label}</div>
    </div>
  );
}

export function CampaignStatsPage({ id }: { id: number }) {
  const [days, setDays] = useState(0);
  const { data: campaign } = useAsync(() => api<any>(`/api/campaigns/${id}`), [id]);
  const { data, loading, error } = useAsync(() => api<any>(`/api/campaigns/${id}/stats?days=${days}`), [id, days]);
  const gated = !!campaign?.require_follow;
  const isComment = campaign?.type === "comment";
  const t = data?.totals;

  return (
    <div className="space-y-4">
      <PageHeader
        title={`إحصائيات: ${campaign?.name ?? "…"}`}
        subtitle="أرقام حقيقية من الإنتاج فقط (بدون المحاكاة). «وصلتهم الرسالة» = قبلت Meta إرسالها، وليس بالضرورة أنها قُرئت."
        actions={
          <>
            <Link to={`/campaigns/${id}`} className="btn btn-ghost">✏️ تعديل الحملة</Link>
            <Link to="/campaigns" className="btn btn-ghost">→ الحملات</Link>
          </>
        }
      />
      <div className="surface-2 inline-flex rounded-full p-1 text-sm" role="tablist">
        {PERIODS.map(([d, label]) => (
          <button key={d} role="tab" aria-selected={days === d} onClick={() => setDays(d)} className={`rounded-full px-4 py-1.5 font-semibold ${days === d ? "bg-[var(--surface)] shadow" : "muted"}`}>
            {label}
          </button>
        ))}
      </div>

      {loading && !data ? (
        <Spinner />
      ) : error ? (
        <Alert tone="bad">{error}</Alert>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {isComment && <Stat label="التعليقات المستلمة" value={t.comments_total} hint={`${t.comments_matched} طابقت الكلمات`} />}
            <Stat label="أشخاص تفاعلوا" value={t.people} hint={`${t.triggers} مرة تشغيل`} />
            <Stat label="وصلتهم الرسالة" value={t.reached} hint={pct(t.reached, t.people)} tone="good" />
            {gated && <Stat label="تابعوا بسبب الحملة" value={t.new_followers} hint="متابعون جدد" tone="good" />}
            {gated && <Stat label="كانوا متابعين أصلًا" value={t.already_following} />}
            <Stat label="استلموا المحتوى" value={t.delivered} hint={`تحويل ${pct(t.delivered, t.people)}`} tone="good" />
          </div>

          {t.people > 0 && (
            <div className="grid gap-4 lg:grid-cols-2">
              <Card title="مسار الأشخاص">
                <Funnel
                  base={t.people}
                  steps={[
                    ["تفاعلوا مع الحملة", t.people, "bg-violet-500"],
                    ["وصلتهم رسالة خاصة", t.reached, "bg-sky-500"],
                    ...(gated ? ([["ضغطوا «ابدأ» / تحقّقوا", t.interacted, "bg-indigo-500"], ["تابعوا الحساب (جدد)", t.new_followers, "bg-fuchsia-500"]] as Array<[string, number, string]>) : []),
                    ["استلموا المحتوى", t.delivered, "bg-emerald-500"],
                  ]}
                />
              </Card>
              <Card title="أين توقف الباقون؟">
                <ul className="space-y-2 text-sm">
                  <li className="flex justify-between"><span>⏳ ما زالوا في منتصف الخطوات</span><b className="tabular-nums">{t.waiting}</b></li>
                  {gated && <li className="flex justify-between"><span>🚫 طُلبت منهم المتابعة ولم يتابعوا</span><b className="tabular-nums">{t.not_followed}</b></li>}
                  {gated && <li className="flex justify-between"><span>🤐 وصلتهم الرسالة ولم يضغطوا «ابدأ»</span><b className="tabular-nums">{Math.max(0, t.reached - t.interacted)}</b></li>}
                  <li className="flex justify-between"><span>⌛ انتهت مهلتهم أو فشل الإرسال</span><b className="tabular-nums">{t.dropped}</b></li>
                  {isComment && <li className="flex justify-between"><span>💬 ردود عامة نُشرت تحت التعليقات</span><b className="tabular-nums">{t.public_replies}</b></li>}
                  {t.last_at && <li className="muted flex justify-between text-xs"><span>آخر تفاعل</span><span>{fmtTime(t.last_at)}</span></li>}
                </ul>
              </Card>
            </div>
          )}

          <h2 className="pt-2 text-lg font-bold">{isComment ? "حسب كل منشور / ريل" : "حسب المصدر"}</h2>
          {!data.media.length ? (
            <Empty title="لا توجد بيانات بعد">ستظهر الأرقام هنا بعد أول تفاعل حقيقي مع الحملة.</Empty>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {data.media.map((m: any) => (
                <div key={m.media_id ?? "none"} className="card overflow-hidden p-0">
                  <div className="flex gap-3 p-3">
                    <div className="h-24 w-20 shrink-0 overflow-hidden rounded-lg bg-gradient-to-br from-violet-700 via-fuchsia-600 to-orange-500">
                      {m.media?.thumbnail_url ? (
                        <img src={m.media.thumbnail_url} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full items-center justify-center text-2xl">{isComment ? "🎬" : "↩️"}</div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="line-clamp-2 text-sm font-semibold">
                        {m.media?.caption || (m.media_id ? (isComment ? "منشور بدون وصف" : "ستوري") : "بدون منشور محدد")}
                      </div>
                      <div className="muted mt-1 text-xs">
                        {m.media?.media_product_type === "REELS" ? "ريل" : m.media ? "منشور" : ""}
                        {m.media?.posted_at ? ` · ${fmtTime(m.media.posted_at)}` : ""}
                      </div>
                      <div className="mt-1 text-xs">
                        تحويل: <b>{pct(m.delivered, m.people)}</b>
                        {m.last_at ? <span className="muted"> · آخر تفاعل {fmtTime(m.last_at)}</span> : null}
                      </div>
                      {m.media?.permalink && (
                        <a href={m.media.permalink} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-brand-600 underline">فتح في إنستقرام ↗</a>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-1.5 border-t border-[var(--border)] p-2">
                    {isComment && <Metric label="تعليقات" value={m.comments_total} />}
                    {isComment && <Metric label="طابقت" value={m.comments_matched} />}
                    <Metric label="أشخاص" value={m.people} />
                    <Metric label="وصلتهم الرسالة" value={m.reached} tone="text-sky-600 dark:text-sky-400" />
                    {gated && <Metric label="متابعون جدد" value={m.new_followers} tone="text-fuchsia-600 dark:text-fuchsia-400" />}
                    {gated && <Metric label="متابعون أصلًا" value={m.already_following} />}
                    {gated && <Metric label="لم يتابعوا" value={m.not_followed} tone="text-amber-600 dark:text-amber-400" />}
                    <Metric label="استلموا المحتوى" value={m.delivered} tone="text-emerald-600 dark:text-emerald-400" />
                    <Metric label="بالانتظار" value={m.waiting} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
