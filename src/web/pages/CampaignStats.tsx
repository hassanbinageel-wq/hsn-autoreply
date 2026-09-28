import { useMemo, useRef, useState } from "react";
import { api } from "../api";
import { Link } from "../App";
import { Alert, Badge, Card, Empty, PageHeader, Spinner, Stat, fmtTime, useAsync } from "../components/ui";
import { toCsv } from "../../shared/csv";
import { saveFile } from "../lib/save";
import { AR_LABELS } from "../../shared/states";

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

function Metric({ label, value, tone, onClick }: { label: string; value: number | string; tone?: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      disabled={!onClick}
      onClick={onClick}
      title={onClick ? "عرض الأسماء" : undefined}
      className="surface-2 rounded-xl px-2 py-2 text-center enabled:hover:ring-1 enabled:hover:ring-[var(--color-brand-500)]"
    >
      <div className={`text-lg font-bold tabular-nums ${tone ?? ""}`}>{value}</div>
      <div className="muted text-[11px] leading-tight">{label}</div>
    </button>
  );
}

type Segment = "all" | "reached" | "delivered" | "clicked" | "new_follower" | "already_following" | "not_followed" | "waiting" | "no_start";

const SEGMENTS: Array<[Segment, string, (p: any) => boolean]> = [
  ["all", "كل من تفاعل", () => true],
  ["reached", "وصلتهم الرسالة", (p) => p.reached],
  ["delivered", "استلموا المحتوى", (p) => p.delivered],
  ["clicked", "ضغطوا الرابط", (p) => p.clicks > 0],
  ["new_follower", "متابعون جدد", (p) => p.new_follower],
  ["already_following", "متابعون أصلًا", (p) => p.already_following],
  ["not_followed", "لم يتابعوا", (p) => p.not_followed],
  ["waiting", "بالانتظار", (p) => p.waiting],
  ["no_start", "لم يضغطوا «ابدأ»", (p) => p.reached && !p.interacted && !p.delivered],
];

const TRIGGER: Record<string, string> = { comment: "💬 علّق", story_reply: "↩️ رد على ستوري", story_mention: "📣 منشن في ستوري" };

/** People behind the numbers: who they are, what they did, where they stopped. */
function PeopleList({ id, days, isComment, gated, mediaById, filter, setFilter }: {
  id: number; days: number; isComment: boolean; gated: boolean; mediaById: Map<string, any>;
  filter: { segment: Segment; media: string | null }; setFilter: (f: { segment: Segment; media: string | null }) => void;
}) {
  const [q, setQ] = useState("");
  const mediaQs = filter.media !== null ? `&media_id=${encodeURIComponent(filter.media)}` : "";
  const { data, loading, error } = useAsync(() => api<any>(`/api/campaigns/${id}/people?days=${days}${mediaQs}`), [id, days, filter.media]);
  const segments = SEGMENTS.filter(([k]) => gated || !["new_follower", "already_following", "not_followed", "no_start"].includes(k));
  const test = segments.find(([k]) => k === filter.segment)?.[2] ?? (() => true);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/^@/, "");
    return (data?.people ?? []).filter((p: any) => test(p) && (!needle || (p.username ?? "").toLowerCase().includes(needle) || p.interactions.some((i: any) => (i.text ?? "").toLowerCase().includes(needle))));
  }, [data, filter.segment, q]);
  const counts = useMemo(() => Object.fromEntries(segments.map(([k, , f]) => [k, (data?.people ?? []).filter(f).length])), [data]);

  const exportCsv = () => {
    const headers = ["الحساب", "رابط الحساب", "ماذا فعل", "النص", "المنشور", "وصلته الرسالة", "متابع جديد", "كان متابعًا", "استلم المحتوى", "ضغط الرابط", "الحالة", "آخر تحديث"];
    const yes = (v: boolean) => (v ? "نعم" : "لا");
    const rows = list.map((p: any) => ({
      "الحساب": p.username ?? "غير معروف",
      "رابط الحساب": p.username ? `https://www.instagram.com/${p.username}` : "",
      "ماذا فعل": TRIGGER[p.interactions[0]?.type] ?? "",
      "النص": p.interactions[0]?.text ?? "",
      "المنشور": mediaById.get(p.interactions[0]?.media_id ?? "")?.caption?.slice(0, 60) ?? p.interactions[0]?.media_id ?? "",
      "وصلته الرسالة": yes(p.reached),
      "متابع جديد": yes(p.new_follower),
      "كان متابعًا": yes(p.already_following),
      "استلم المحتوى": yes(p.delivered),
      "ضغط الرابط": p.clicks > 0 ? `نعم (${p.clicks})` : "لا",
      "الحالة": AR_LABELS[p.state] ?? p.state,
      "آخر تحديث": fmtTime(p.last_at),
    }));
    const blob = new Blob([toCsv(headers, rows)], { type: "text/csv;charset=utf-8" });
    saveFile(blob, `campaign-${id}-${filter.segment}.csv`).catch(() => undefined);
  };

  return (
    <Card
      title="الأشخاص"
      action={<button className="btn btn-ghost text-sm" disabled={!list.length} onClick={exportCsv}>⬇️ تصدير CSV</button>}
    >
      <div className="mb-3 flex flex-wrap gap-1.5">
        {segments.map(([k, label]) => (
          <button
            key={k}
            onClick={() => setFilter({ ...filter, segment: k })}
            className={`rounded-full px-3 py-1 text-xs font-semibold ${filter.segment === k ? "bg-brand-600 text-white" : "surface-2"}`}
          >
            {label} <span className="tabular-nums opacity-70">{counts[k] ?? 0}</span>
          </button>
        ))}
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input className="input max-w-xs" placeholder="بحث باسم الحساب أو نص التعليق…" value={q} onChange={(e) => setQ(e.target.value)} />
        {filter.media !== null && (
          <span className="surface-2 flex items-center gap-2 rounded-full px-3 py-1 text-xs">
            {isComment ? "منشور:" : "المصدر:"} {mediaById.get(filter.media)?.caption?.slice(0, 30) || filter.media || "بدون منشور"}
            <button aria-label="إزالة فلتر المنشور" onClick={() => setFilter({ ...filter, media: null })}>✕</button>
          </span>
        )}
      </div>
      {loading && !data ? (
        <Spinner />
      ) : error ? (
        <Alert tone="bad">{error}</Alert>
      ) : !list.length ? (
        <p className="muted py-6 text-center text-sm">لا يوجد أشخاص في هذا التصنيف.</p>
      ) : (
        <div className="divide-y divide-[var(--border)]">
          {list.slice(0, 500).map((p: any) => {
            const last = p.interactions[0];
            const m = last?.media_id ? mediaById.get(last.media_id) : null;
            return (
              <div key={p.participant_id} className="flex items-start gap-3 py-2.5">
                <div className="h-11 w-9 shrink-0 overflow-hidden rounded-md bg-gradient-to-br from-violet-700 via-fuchsia-600 to-orange-500">
                  {m?.thumbnail_url && <img src={m.thumbnail_url} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    {p.username ? (
                      <a href={`https://www.instagram.com/${p.username}`} target="_blank" rel="noreferrer" className="font-bold hover:underline" dir="ltr">@{p.username}</a>
                    ) : (
                      <span className="muted font-bold">حساب غير معروف</span>
                    )}
                    {p.clicks > 0 && <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[11px] text-sky-800 dark:bg-sky-900/40 dark:text-sky-300">🔗 ضغط الرابط{p.clicks > 1 ? ` ×${p.clicks}` : ""}</span>}
                    {p.delivered && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">استلم المحتوى</span>}
                    {p.new_follower && <span className="rounded-full bg-fuchsia-100 px-2 py-0.5 text-[11px] text-fuchsia-800 dark:bg-fuchsia-900/40 dark:text-fuchsia-300">متابع جديد</span>}
                    {p.already_following && <span className="surface-2 rounded-full px-2 py-0.5 text-[11px]">كان متابعًا</span>}
                    {p.not_followed && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">لم يتابع</span>}
                    {!p.delivered && <Badge value={p.state} />}
                  </div>
                  <div className="mt-0.5 text-sm">
                    <span className="muted">{TRIGGER[last?.type] ?? last?.type}</span>
                    {last?.text ? <>: «<span className="break-words">{last.text}</span>»</> : null}
                    {p.interactions.length > 1 && <span className="muted text-xs"> · تفاعل {p.interactions.length} مرات</span>}
                  </div>
                  <div className="muted text-xs">
                    {m?.caption ? `على: ${m.caption.slice(0, 50)}${m.caption.length > 50 ? "…" : ""} · ` : ""}
                    {p.delivered_at ? `استلم ${fmtTime(p.delivered_at)}` : `آخر تحديث ${fmtTime(p.last_at)}`}
                  </div>
                </div>
              </div>
            );
          })}
          {list.length > 500 && <p className="muted pt-2 text-center text-xs">يُعرض أول 500 — استخدم البحث أو التصدير للباقي.</p>}
        </div>
      )}
      <p className="muted mt-3 text-xs">الأسماء من بيانات إنستقرام الرسمية (اسم المستخدم المرفق مع التعليق أو من فحص المتابعة). قد يظهر «حساب غير معروف» لمن تفاعل عبر الستوري قبل هذا التحديث.</p>
    </Card>
  );
}

export function CampaignStatsPage({ id }: { id: number }) {
  const [days, setDays] = useState(0);
  const [filter, setFilter] = useState<{ segment: Segment; media: string | null }>({ segment: "all", media: null });
  const peopleRef = useRef<HTMLDivElement>(null);
  const show = (segment: Segment, media: string | null = null) => {
    setFilter({ segment, media });
    setTimeout(() => peopleRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };
  const { data: campaign } = useAsync(() => api<any>(`/api/campaigns/${id}`), [id]);
  const { data, loading, error } = useAsync(() => api<any>(`/api/campaigns/${id}/stats?days=${days}`), [id, days]);
  const gated = !!campaign?.require_follow;
  const isComment = campaign?.type === "comment";
  const t = data?.totals;
  const mediaById = useMemo(() => new Map<string, any>((data?.media ?? []).filter((m: any) => m.media).map((m: any) => [m.media_id, m.media])), [data]);

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
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-7">
            {isComment && <Stat label="التعليقات المستلمة" value={t.comments_total} hint={`${t.comments_matched} طابقت الكلمات`} />}
            <button className="text-right" onClick={() => show("all")}><Stat label="أشخاص تفاعلوا" value={t.people} hint={`${t.triggers} مرة تشغيل · اضغط لعرض الأسماء`} /></button>
            <button className="text-right" onClick={() => show("reached")}><Stat label="وصلتهم الرسالة" value={t.reached} hint={pct(t.reached, t.people)} tone="good" /></button>
            {gated && <button className="text-right" onClick={() => show("new_follower")}><Stat label="تابعوا بسبب الحملة" value={t.new_followers} hint="متابعون جدد" tone="good" /></button>}
            {gated && <button className="text-right" onClick={() => show("already_following")}><Stat label="كانوا متابعين أصلًا" value={t.already_following} /></button>}
            <button className="text-right" onClick={() => show("delivered")}><Stat label="استلموا المحتوى" value={t.delivered} hint={`تحويل ${pct(t.delivered, t.people)}`} tone="good" /></button>
            <button className="text-right" onClick={() => show("clicked")}><Stat label="ضغطوا الرابط" value={t.clicked} hint={`${pct(t.clicked, t.delivered)} ممن استلموا · ${t.clicks_total} ضغطة`} tone="good" /></button>
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
                    ["ضغطوا الرابط", t.clicked, "bg-teal-500"],
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
                    <Metric label="أشخاص" value={m.people} onClick={() => show("all", m.media_id ?? "")} />
                    <Metric label="وصلتهم الرسالة" value={m.reached} tone="text-sky-600 dark:text-sky-400" onClick={() => show("reached", m.media_id ?? "")} />
                    {gated && <Metric label="متابعون جدد" value={m.new_followers} tone="text-fuchsia-600 dark:text-fuchsia-400" onClick={() => show("new_follower", m.media_id ?? "")} />}
                    {gated && <Metric label="متابعون أصلًا" value={m.already_following} onClick={() => show("already_following", m.media_id ?? "")} />}
                    {gated && <Metric label="لم يتابعوا" value={m.not_followed} tone="text-amber-600 dark:text-amber-400" onClick={() => show("not_followed", m.media_id ?? "")} />}
                    <Metric label="استلموا المحتوى" value={m.delivered} tone="text-emerald-600 dark:text-emerald-400" onClick={() => show("delivered", m.media_id ?? "")} />
                    <Metric label="ضغطوا الرابط" value={m.clicked} tone="text-teal-600 dark:text-teal-400" onClick={() => show("clicked", m.media_id ?? "")} />
                    <Metric label="بالانتظار" value={m.waiting} onClick={() => show("waiting", m.media_id ?? "")} />
                  </div>
                </div>
              ))}
            </div>
          )}

          <div ref={peopleRef} className="scroll-mt-4">
            <PeopleList id={id} days={days} isComment={isComment} gated={gated} mediaById={mediaById} filter={filter} setFilter={setFilter} />
          </div>
        </>
      )}
    </div>
  );
}
