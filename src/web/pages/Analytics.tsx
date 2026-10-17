import { useMemo, useState } from "react";
import { api } from "../api";
import { Link } from "../App";
import { AreaChart } from "../components/Charts";
import { DateTimeField } from "../components/DateTimeField";
import { Icon } from "../components/Icon";
import { Alert, Card, InfoDot, PageHeader, Spinner, Stat, Toggle, fmtDate, fmtTime, toast, useAsync } from "../components/ui";
import { askConfirm } from "../components/Confirm";
import { toCsv } from "../../shared/csv";
import { saveFile } from "../lib/save";

const DAY = 86_400_000;
type Period = "today" | "7" | "30" | "custom";
const WEEKDAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const TYPE_LABEL: Record<string, string> = { POST: "منشور", REELS: "ريل", CAROUSEL: "متعدد", STORY: "ستوري" };
const fmt = (n: number) => n.toLocaleString("en-US");
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");

/** Start of "today" in the customer's time zone (offset in minutes east of UTC). */
function startOfDay(ms: number, off: number) {
  return Math.floor((ms + off * 60_000) / DAY) * DAY - off * 60_000;
}

function download(name: string, headers: string[], rows: Array<Record<string, unknown>>) {
  saveFile(new Blob([toCsv(headers, rows)], { type: "text/csv;charset=utf-8" }), name).catch(() => undefined);
}

export function AnalyticsPage() {
  const [period, setPeriod] = useState<Period>("7");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const [campaign, setCampaign] = useState("");
  const [media, setMedia] = useState("");
  const [type, setType] = useState("");
  const [heat, setHeat] = useState<"comments" | "messages" | "clicks">("comments");
  // The server sends the customer's time-zone offset back; until the first answer, assume Riyadh / Aden (+3).
  const [off, setOff] = useState(180);
  const range = useMemo(() => {
    const now = Date.now();
    if (period === "today") return { from: startOfDay(now, off), to: now };
    if (period === "custom" && custom.from && custom.to) {
      const a = Date.parse(`${custom.from}T00:00:00Z`) - off * 60_000;
      const b = Date.parse(`${custom.to}T00:00:00Z`) - off * 60_000 + DAY;
      if (b > a) return { from: a, to: Math.min(b, now) };
    }
    const days = period === "30" ? 30 : 7;
    return { from: startOfDay(now, off) - (days - 1) * DAY, to: now };
  }, [period, custom, off]);
  const qs = new URLSearchParams({ from: String(range.from), to: String(range.to), heat, ...(campaign ? { campaign_id: campaign } : {}), ...(media ? { media_id: media } : {}), ...(type ? { type } : {}) });
  const { data, loading, error, reload } = useAsync(
    () =>
      api<any>(`/api/analytics?${qs}`).then((d) => {
        if (d?.filter?.tz_offset_min !== undefined && d.filter.tz_offset_min !== off) setOff(d.filter.tz_offset_min);
        return d;
      }),
    [qs.toString()],
  );
  const periodLabel = `${fmtDate(range.from)} — ${fmtDate(range.to)}`;
  const o = data?.overview;
  const labels = useMemo(
    () => (o?.series ?? []).map((d: any) => new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-latn", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(d.day * DAY + 12 * 3_600_000))),
    [o],
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="التحليلات"
        subtitle="أداء حملاتك ومنشوراتك من البيانات اللي سجّلها النظام فعليًا. إحصاءات إنستقرام نفسها (المشاهدات والوصول والإعجابات) تحتاج صلاحية إضافية."
        actions={<button className="btn btn-ghost" onClick={reload} disabled={loading}><Icon name="refresh" size={17} />{loading ? "…" : "تحديث"}</button>}
      />

      {/* Filters */}
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          {/* Four choices that wrap into two rows on phones instead of scrolling sideways. */}
          <div className="seg grid w-full grid-cols-2 !overflow-visible sm:inline-flex sm:w-auto" role="group" aria-label="الفترة">
            {([["today", "اليوم"], ["7", "آخر 7 أيام"], ["30", "آخر 30 يومًا"], ["custom", "فترة مخصصة"]] as const).map(([k, l]) => (
              <button key={k} type="button" aria-pressed={period === k} className={`text-center ${period === k ? "on" : ""}`} onClick={() => setPeriod(k)}>{l}</button>
            ))}
          </div>
          <select className="input !w-auto max-w-full" aria-label="الحملة" value={campaign} onChange={(e) => setCampaign(e.target.value)}>
            <option value="">كل الحملات</option>
            {(data?.campaigns ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select className="input !w-auto max-w-full" aria-label="المنشور" value={media} onChange={(e) => setMedia(e.target.value)}>
            <option value="">كل المنشورات</option>
            {(data?.posts ?? []).map((p: any) => <option key={p.media_id} value={p.media_id}>{(p.caption || p.media_id).slice(0, 40)}</option>)}
          </select>
          <select className="input !w-auto" aria-label="نوع التفاعل" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">كل أنواع التفاعل</option>
            <option value="comment">تعليقات</option>
            <option value="story_reply">ردود ستوري</option>
            <option value="story_mention">منشن ستوري</option>
          </select>
        </div>
        {period === "custom" && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div><div className="mb-1 text-sm font-semibold">من</div><DateTimeField dateOnly label="بداية الفترة" emptyLabel="اختر تاريخ البداية" value={custom.from} onChange={(v) => setCustom((c) => ({ ...c, from: v }))} /></div>
            <div><div className="mb-1 text-sm font-semibold">إلى</div><DateTimeField dateOnly label="نهاية الفترة" emptyLabel="اختر تاريخ النهاية" value={custom.to} onChange={(v) => setCustom((c) => ({ ...c, to: v }))} /></div>
          </div>
        )}
        <p className="muted mt-3 text-xs">
          الفترة: {periodLabel}
          {data && <> · آخر تحديث {fmtTime(data.generated_at)} · بيانات النظام لحظية (تتحدث مع كل تعليق ورسالة ونقرة)</>}
        </p>
      </Card>

      {loading && !data ? (
        <Spinner />
      ) : error ? (
        <Alert tone="bad">{error}</Alert>
      ) : data ? (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="تعليقات وتفاعلات" value={fmt(o.events.total)} hint={`من ${fmt(o.events.people)} حساب مختلف`} icon={<Icon name="msg" size={18} />} info="عدد الأحداث (كل تعليق أو رد ستوري أو منشن مرة). الرقم الصغير تحته هو عدد الحسابات المختلفة اللي سوّتها — الشخص اللي علّق 3 مرات ينحسب حساب واحد. ردودك أنت ما تنحسب." />
            <Stat label="دخلوا مسار الحملة" value={fmt(o.flows.people)} hint={`${fmt(o.flows.total)} مسار`} accent="sky" icon={<Icon name="users" size={18} />} info="عدد الأشخاص المختلفين اللي بدأ لهم النظام مسار أتمتة (طابق تعليقهم حملة). المسار قد يتكرر لنفس الشخص في حملات مختلفة." />
            <Stat label="استلموا المحتوى" value={fmt(o.delivered_people)} hint={`${pct(o.delivered_people, o.flows.people)} ممن دخلوا`} accent="green" tone="good" icon={<Icon name="check" size={18} />} info="أشخاص مختلفون وصلتهم الرسالة الأخيرة (الرابط أو المحتوى) خلال الفترة." />
            <Stat label="نقرات على الرابط" value={fmt(o.clicks.total)} hint={`من ${fmt(o.clicks.people)} شخص`} accent="orange" icon={<Icon name="click" size={18} />} info="عدد مرات الضغط على رابط الحملة المتتبَّع (مع المكرر)، والرقم تحته عدد الأشخاص المختلفين. معاينات الروابط الآلية ما تنحسب. السجل التفصيلي للنقرات بدأ من هذا الإصدار." />
          </div>

          <Card title="الرسائل الخاصة">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Mini label="أُرسلت (محاولات)" value={o.messages.attempted} info="كل رسالة حاول النظام إرسالها في الفترة: الناجحة + الفاشلة + غير المؤكدة." />
              <Mini label="نجحت" value={o.messages.accepted} tone="text-emerald-600 dark:text-emerald-400" info="قبلتها Meta. القبول ما يعني إن الشخص قرأها — Meta ما ترسل وقت القراءة هنا." />
              <Mini label="فشلت" value={o.messages.failed} tone="text-red-600 dark:text-red-400" info="رفضتها Meta نهائيًا (مثل انتهاء نافذة الرد أو حظر)." />
              <Mini label="غير مؤكدة" value={o.messages.uncertain} tone="text-amber-600 dark:text-amber-400" info="انقطع الاتصال أثناء الإرسال فما نعرف هل وصلت. تقدر تراجعها من «السجل»." />
              <Mini label="ردود عامة نُشرت" value={o.public_replies} info="ردود تحت التعليقات قبلتها Meta." />
            </div>
          </Card>

          <Card title="مسار الأيام" action={<span className="muted text-xs">تعليقات (أحداث) · أشخاص علّقوا · استلموا المحتوى · نقرات</span>}>
            {o.series.length ? (
              <AreaChart
                labels={labels}
                series={[
                  { label: "تعليقات", color: "#7c3aed", values: o.series.map((d: any) => d.events) },
                  { label: "أشخاص علّقوا", color: "#0ea5e9", values: o.series.map((d: any) => d.people) },
                  { label: "استلموا المحتوى", color: "#10b981", values: o.series.map((d: any) => d.delivered) },
                  { label: "نقرات", color: "#f97316", values: o.series.map((d: any) => d.clicks) },
                ]}
              />
            ) : (
              <p className="muted py-6 text-center text-sm">لا توجد بيانات في هذه الفترة.</p>
            )}
            <p className="muted mt-2 text-xs">«أشخاص علّقوا» محسوب لكل يوم لحاله — نفس الشخص في يومين ينحسب في كل يوم، فمجموع الأيام ما يساوي عدد الأشخاص الكلي.</p>
          </Card>

          <InstagramMetricsCard />

          {/* Campaigns */}
          <Card
            title="الحملات"
            action={
              <button className="btn btn-ghost text-sm" disabled={!data.campaigns.length} onClick={() =>
                download(`campaigns-${new Date(range.from).toISOString().slice(0, 10)}_${new Date(range.to).toISOString().slice(0, 10)}.csv`,
                  ["الحملة", "الفترة", "تعليقات طابقت (أحداث)", "دخلوا المسار (أشخاص)", "استلموا المحتوى (أشخاص)", "رسائل نجحت", "رسائل فشلت", "نقرات (مرات)", "ضغطوا الرابط (أشخاص)"],
                  data.campaigns.map((c: any) => ({ "الحملة": c.name, "الفترة": periodLabel, "تعليقات طابقت (أحداث)": c.matched_events, "دخلوا المسار (أشخاص)": c.people, "استلموا المحتوى (أشخاص)": c.delivered, "رسائل نجحت": c.messages_ok, "رسائل فشلت": c.messages_failed, "نقرات (مرات)": c.clicks, "ضغطوا الرابط (أشخاص)": c.click_people })))
              }>⬇️ CSV</button>
            }
          >
            {!data.campaigns.length ? (
              <p className="muted py-4 text-center text-sm">لا توجد حملات بنشاط في هذه الفترة.</p>
            ) : (
              <div className="-mx-4 overflow-x-auto sm:-mx-5">
                <table className="w-full min-w-[640px] text-sm">
                  <thead><tr className="muted bg-[var(--surface-2)] text-right text-xs">
                    <th className="px-4 py-2.5 font-semibold">الحملة</th><th className="px-3 py-2.5 font-semibold">تعليقات طابقت</th><th className="px-3 py-2.5 font-semibold">دخلوا المسار</th>
                    <th className="px-3 py-2.5 font-semibold">استلموا</th><th className="px-3 py-2.5 font-semibold">رسائل نجحت / فشلت</th><th className="px-3 py-2.5 font-semibold">نقرات</th><th className="px-3 py-2.5" />
                  </tr></thead>
                  <tbody>
                    {data.campaigns.map((c: any) => (
                      <tr key={c.id} className="border-t border-[var(--border)]">
                        <td className="px-4 py-2.5 font-bold">{c.name}</td>
                        <td className="px-3 py-2.5 tabular-nums">{fmt(c.matched_events)}</td>
                        <td className="px-3 py-2.5 tabular-nums">{fmt(c.people)}</td>
                        <td className="px-3 py-2.5 tabular-nums">{fmt(c.delivered)} <span className="muted text-xs">({pct(c.delivered, c.people)})</span></td>
                        <td className="px-3 py-2.5 tabular-nums">{fmt(c.messages_ok)} / <span className={c.messages_failed ? "text-red-600" : ""}>{fmt(c.messages_failed)}</span></td>
                        <td className="px-3 py-2.5 tabular-nums">{fmt(c.clicks)} <span className="muted text-xs">({fmt(c.click_people)} شخص)</span></td>
                        <td className="px-3 py-2.5"><Link to={`/campaigns/${c.id}/stats`} className="btn btn-ghost min-h-9 px-3 text-xs">التفاصيل</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* Posts */}
          <Card
            title="المنشورات والريلز والستوري"
            action={
              <button className="btn btn-ghost text-sm" disabled={!data.posts.length} onClick={() =>
                download(`posts-${new Date(range.from).toISOString().slice(0, 10)}_${new Date(range.to).toISOString().slice(0, 10)}.csv`,
                  ["المنشور", "النوع", "تاريخ النشر", "الرابط", "الحملات", "الفترة", "تعليقات (أحداث)", "حسابات علّقت", "دخلوا المسار (أشخاص)", "استلموا المحتوى", "نقرات"],
                  data.posts.map((p: any) => ({ "المنشور": p.caption ?? p.media_id, "النوع": TYPE_LABEL[p.content_type] ?? "", "تاريخ النشر": p.posted_at ? fmtDate(p.posted_at) : "", "الرابط": p.permalink ?? "", "الحملات": p.campaigns.map((c: any) => c.name).join(" | "), "الفترة": periodLabel, "تعليقات (أحداث)": p.comments, "حسابات علّقت": p.commenters, "دخلوا المسار (أشخاص)": p.people, "استلموا المحتوى": p.delivered, "نقرات": p.clicks })))
              }>⬇️ CSV</button>
            }
          >
            {!data.posts.length ? (
              <p className="muted py-4 text-center text-sm">لا توجد منشورات بتفاعل مسجّل في هذه الفترة.</p>
            ) : (
              <div className="divide-y divide-[var(--border)]">
                {data.posts.map((p: any) => (
                  <div key={p.media_id} className="flex flex-wrap items-start gap-3 py-3">
                    <div className="h-16 w-12 shrink-0 overflow-hidden rounded-lg bg-gradient-to-br from-violet-700 via-fuchsia-600 to-orange-500">
                      {p.thumbnail_url && <img src={p.thumbnail_url} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" />}
                    </div>
                    <div className="min-w-0 flex-1 basis-56">
                      <div className="line-clamp-1 text-sm font-semibold">{p.caption || (p.content_type ? `${TYPE_LABEL[p.content_type]} بدون وصف` : "منشور غير محفوظ في القائمة")}</div>
                      <div className="muted mt-0.5 flex flex-wrap gap-x-2 text-xs">
                        {p.content_type && <span className="chip surface-2">{TYPE_LABEL[p.content_type]}</span>}
                        {p.posted_at && <span>نُشر {fmtDate(p.posted_at)}</span>}
                        {p.permalink && <a href={p.permalink} target="_blank" rel="noreferrer" className="text-violet-600 underline dark:text-violet-300">فتح في إنستقرام ↗</a>}
                      </div>
                      <div className="mt-1 text-xs">
                        {p.campaigns.length ? <>الحملات: {p.campaigns.map((c: any) => c.name).join("، ")}</> : <span className="muted">غير مرتبط بحملة محددة</span>}
                        {p.campaigns.length > 1 && <span className="muted"> · المنشور مشترك بين حملات: التعليقات أدناه للمنشور كله، ونتائج الأتمتة مقسومة على أحداث كل حملة</span>}
                      </div>
                    </div>
                    <div className="grid w-full grid-cols-5 gap-1.5 text-center sm:w-auto">
                      <Cell label="تعليقات" value={p.comments} />
                      <Cell label="حسابات" value={p.commenters} />
                      <Cell label="بالمسار" value={p.people} />
                      <Cell label="استلموا" value={p.delivered} />
                      <Cell label="نقرات" value={p.clicks} />
                    </div>
                    <button className="btn btn-ghost min-h-9 px-3 text-xs" onClick={() => { setMedia(p.media_id); window.scrollTo({ top: 0, behavior: "smooth" }); }}>عرض هذا المنشور فقط</button>
                  </div>
                ))}
              </div>
            )}
            <p className="muted mt-2 text-xs">الأرقام هنا خلال الفترة المحددة فقط، ومن تفاعلات وصلت للنظام. إجمالي أداء المنشور منذ نشره (مشاهدات، وصول…) يظهر بعد تفعيل صلاحية الإحصاءات.</p>
          </Card>

          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <Heatmap data={data.heatmap} kind={heat} setKind={setHeat} />
            <Devices d={data.devices} />
          </div>

          <FollowCard f={data.follow} />
          <RetentionCard r={data.retention} recheck={data.recheck} onChanged={reload} periodLabel={periodLabel} />
          <AudienceCard />
        </>
      ) : null}
    </div>
  );
}

function Mini({ label, value, tone = "", info }: { label: string; value: number; tone?: string; info?: string }) {
  return (
    <div className="surface-2 rounded-xl p-3">
      <div className="flex items-center justify-between gap-1"><span className="muted text-xs">{label}</span>{info && <InfoDot text={info} />}</div>
      <div className={`font-display mt-1 text-xl font-extrabold tabular-nums ${tone}`}>{fmt(value)}</div>
    </div>
  );
}

function Cell({ label, value }: { label: string; value: number }) {
  return (
    <div className="surface-2 min-w-[3.4rem] rounded-lg px-1.5 py-1">
      <div className="font-display text-sm font-extrabold tabular-nums">{fmt(value)}</div>
      <div className="muted text-[10px]">{label}</div>
    </div>
  );
}

function StatusPill({ kind }: { kind: "permission" | "soon" }) {
  return kind === "permission" ? (
    <span className="chip bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">صلاحية ناقصة</span>
  ) : (
    <span className="chip surface-2 muted">قريبًا</span>
  );
}

/** Instagram's own numbers: honest "not available" until the insights permission is granted. */
function InstagramMetricsCard() {
  const items = ["إجمالي المشاهدات", "الوصول (حسابات فريدة)", "الإعجابات", "المشاركات", "الحفظ", "الحسابات المتفاعلة"];
  return (
    <Card title="إحصاءات إنستقرام" action={<StatusPill kind="permission" />}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {items.map((l) => (
          <div key={l} className="surface-2 rounded-xl p-3 text-center">
            <div className="font-display text-lg font-extrabold text-[var(--muted)]">—</div>
            <div className="muted text-xs">{l}</div>
          </div>
        ))}
      </div>
      <p className="muted mt-3 text-sm">
        هذي الأرقام تجي من إنستقرام نفسه وتحتاج صلاحية <span dir="ltr">instagram_business_manage_insights</span>. «—» تعني غير متاحة، مو صفر. بعد موافقتك نضيف الصلاحية وتعيد ربط حسابك، فتظهر هنا وفي جدول المنشورات.
      </p>
    </Card>
  );
}

function AudienceCard() {
  return (
    <Card title="الجمهور (الجنس، العمر، الدول، متابع / غير متابع)" action={<StatusPill kind="permission" />}>
      <p className="muted text-sm">
        إنستقرام يعطي هذي البيانات <b>على مستوى الحساب كله فقط</b> (أعلى 45 قيمة، وبشرط 100 متابع أو أكثر)، وما يقدر النظام ينسبها لحملة أو لأشخاص محددين. تظهر هنا بعد صلاحية الإحصاءات، مع توضيح الجمهور اللي تمثله
        (المتابعون أو اللي وصلهم المحتوى). ما نستنتج الجنس أو العمر من الاسم أو الصورة.
      </p>
    </Card>
  );
}

function Heatmap({ data, kind, setKind }: { data: any; kind: string; setKind: (k: any) => void }) {
  const max = Math.max(1, ...data.grid.flat());
  const desc: Record<string, string> = {
    comments: "وقت كتابة التعليق أو الرد حسب Meta (وقت الحدث نفسه، مو وقت وصوله للنظام).",
    messages: "وقت قبول Meta للرسالة الخاصة (مو وقت قراءتها — ما يوصلنا دليل قراءة).",
    clicks: "وقت ضغط الرابط المتتبَّع.",
  };
  const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? "ص" : "م"}`;
  return (
    <Card
      title="أوقات النشاط"
      action={
        <div className="seg" role="group" aria-label="نوع النشاط">
          {([["comments", "التعليقات"], ["messages", "الرسائل"], ["clicks", "النقرات"]] as const).map(([k, l]) => (
            <button key={k} type="button" aria-pressed={kind === k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>{l}</button>
          ))}
        </div>
      }
    >
      <p className="muted mb-2 text-xs">{desc[kind]} المجموع: {fmt(data.total)}.</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-separate border-spacing-0.5 text-[10px]">
          <thead><tr><th />{Array.from({ length: 24 }, (_, h) => <th key={h} className="muted font-normal">{h % 3 === 0 ? hourLabel(h) : ""}</th>)}</tr></thead>
          <tbody>
            {data.grid.map((row: number[], wd: number) => (
              <tr key={wd}>
                <th className="muted whitespace-nowrap pl-1 text-right font-normal">{WEEKDAYS[wd]}</th>
                {row.map((n, h) => (
                  <td key={h} title={`${WEEKDAYS[wd]} ${hourLabel(h)}: ${n}`} className="h-5 rounded" style={{ background: n ? `rgba(124,58,237,${0.12 + 0.88 * (n / max)})` : "var(--surface-2)" }} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-sm">
        {data.top_hours.length ? (
          <>أنشط الأوقات: <b>{data.top_hours.map((x: any) => hourLabel(x.h)).join("، ")}</b> — جرّب تنشر قبلها بساعة. هذا اقتراح من نشاط مسجّل، مو من أوقات مشاهدة المنشورات.</>
        ) : (
          <span className="muted">البيانات ما تكفي لاقتراح وقت نشر (نحتاج 30 حدث على الأقل في الفترة).</span>
        )}
      </p>
    </Card>
  );
}

function Devices({ d }: { d: Record<string, { clicks: number; people: number }> }) {
  const rows: Array<[string, string, string]> = [["android", "Android", "#10b981"], ["ios", "iOS", "#0ea5e9"], ["other", "أخرى (كمبيوتر…)", "#a78bfa"], ["unknown", "غير معروف", "#9ca3af"]];
  const total = rows.reduce((a, [k]) => a + d[k].clicks, 0);
  return (
    <Card title="أجهزة زوار رابط الحملة" action={<InfoDot text="تقدير من معلومات المتصفح عند الضغط على رابط الحملة فقط. ما يمثل أجهزة كل مشاهدي المنشور — إنستقرام ما يوفر هذا للمنشورات العادية." />}>
      {!total ? (
        <p className="muted py-6 text-center text-sm">ما فيه نقرات مسجّلة في هذه الفترة.</p>
      ) : (
        <div className="space-y-2.5">
          {rows.map(([k, l, c]) => (
            <div key={k}>
              <div className="flex justify-between text-sm"><span>{l}</span><span className="tabular-nums">{fmt(d[k].clicks)} <span className="muted text-xs">({pct(d[k].clicks, total)})</span></span></div>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-[var(--surface-2)]"><div className="h-full rounded-full" style={{ width: `${(d[k].clicks / total) * 100}%`, background: c }} /></div>
            </div>
          ))}
          <p className="muted text-xs">النسب من {fmt(total)} نقرة.</p>
        </div>
      )}
    </Card>
  );
}

function FollowCard({ f }: { f: any }) {
  const Bar = ({ title, v }: { title: string; v: any }) => {
    const parts: Array<[string, number, string]> = [["يتابع الحساب", v.following, "#10b981"], ["لا يتابع الحساب", v.not_following, "#f59e0b"], ["غير معروف / تعذر التحقق", v.unknown, "#9ca3af"]];
    return (
      <div>
        <div className="mb-1.5 text-sm font-semibold">{title}</div>
        <div className="flex h-3 overflow-hidden rounded-full bg-[var(--surface-2)]">
          {parts.map(([l, n, c]) => n > 0 && <div key={l} title={`${l}: ${n}`} style={{ width: `${(n / Math.max(1, f.people)) * 100}%`, background: c }} />)}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {parts.map(([l, n, c]) => <span key={l} className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: c }} />{l}: <b className="tabular-nums">{fmt(n)}</b> ({pct(n, f.people)})</span>)}
        </div>
      </div>
    );
  };
  return (
    <Card title="حالة المتابعة للمشاركين" action={<InfoDot text="من الحقل الرسمي is_user_follow_business، ويعمل فقط لمن راسل حسابك أو ضغط «ابدأ» (موافقة إنستقرام). مجرد التعليق ما يسمح بالاستعلام. فشل التحقق يظهر «غير معروف» وما ينحسب «لا يتابع»." />}>
      {!f.people ? (
        <p className="muted py-4 text-center text-sm">ما فيه مشاركون في هذه الفترة.</p>
      ) : (
        <div className="space-y-4">
          <Bar title="وقت المشاركة (أول تحقق ناجح في الحملة)" v={f.at_participation} />
          <Bar title="آخر حالة تم التحقق منها" v={f.latest} />
          <p className="muted text-xs">النسب من {fmt(f.people)} شخص دخلوا مسار حملة في الفترة.</p>
        </div>
      )}
    </Card>
  );
}

function RetentionCard({ r, recheck, onChanged, periodLabel }: { r: any; recheck: { enabled: boolean; days: number }; onChanged: () => void; periodLabel: string }) {
  const [days, setDays] = useState(recheck.days);
  const save = async (enabled: boolean) => {
    if (enabled && !(await askConfirm({
      title: "تشغيل إعادة التحقق من المتابعة؟",
      message: "النظام يعيد قراءة حالة المتابعة عبر واجهة Meta الرسمية للأشخاص اللي استلموا المحتوى، مرة كل عدد الأيام اللي تحدده، وبحد 3 أشخاص بالساعة.\n\nتنبيه: تتبّع إلغاء المتابعة بقراءات متكررة منطقة رمادية في سياسات Meta (البيانات مخصصة لخدمة المحادثة). القرار والمسؤولية عليك، وتقدر توقفه في أي وقت.",
      confirmLabel: "أفهم — شغّل",
    }))) return;
    try {
      await api("/api/analytics/recheck", { method: "PUT", body: { enabled, days } });
      toast(enabled ? "تم تشغيل إعادة التحقق" : "تم إيقاف إعادة التحقق");
      onChanged();
    } catch (e: any) {
      toast(e.message, "bad");
    }
  };
  const label: Record<string, string> = { following: "يتابع", not_following: "لم يعد يتابع عند آخر تحقق", unknown: "لم يُعَد التحقق بعد" };
  return (
    <Card
      title="الاحتفاظ بالمتابعين"
      action={
        <button className="btn btn-ghost text-sm" disabled={!r.items.length} onClick={() =>
          download("retention.csv", ["الحساب", "الحملة", "وقت استلام المحتوى", "الحالة وقت الاستلام", "آخر حالة", "وقت آخر تحقق", "الفترة"],
            r.items.map((i: any) => ({ "الحساب": i.username ?? "", "الحملة": i.campaign, "وقت استلام المحتوى": fmtTime(i.delivered_at), "الحالة وقت الاستلام": "يتابع", "آخر حالة": label[i.last_status], "وقت آخر تحقق": i.last_checked_at ? fmtTime(i.last_checked_at) : "", "الفترة": periodLabel })))
        }>⬇️ CSV</button>
      }
    >
      <p className="muted text-sm">
        الأشخاص اللي كانوا متابعين وقت استلام المحتوى (حسب تحقق ناجح)، ومقارنتهم بآخر تحقق ناجح بعدها. «لم يعد يتابع» تظهر فقط إذا فيه قراءة ناجحة لاحقة تؤكد عدم المتابعة — ووقت اكتشافها مو بالضرورة وقت الإلغاء، وما تثبت سببه. وهذي مو قائمة شاملة بكل من ألغى متابعتك.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Mini label="كانوا متابعين وقت الاستلام" value={r.cohort} />
        <Mini label="أُعيد التحقق منهم" value={r.rechecked} />
        <Mini label="ما زالوا يتابعون" value={r.still_following} tone="text-emerald-600 dark:text-emerald-400" />
        <Mini label="لم يعودوا يتابعون" value={r.no_longer_following} tone="text-amber-600 dark:text-amber-400" />
        <Mini label="غير معروف" value={r.unknown} />
      </div>
      {r.rechecked > 0 && <p className="mt-2 text-sm">نسبة الاحتفاظ: <b>{pct(r.still_following, r.rechecked)}</b> من {fmt(r.rechecked)} شخص أمكن إعادة التحقق منهم (و{fmt(r.unknown)} غير معروف).</p>}
      <div className="mt-4 rounded-2xl border border-[var(--border)] p-3">
        <Toggle checked={recheck.enabled} onChange={save} label="إعادة التحقق التلقائي من المتابعة" description={recheck.enabled ? `يعمل — كل ${recheck.days} أيام لكل شخص، 3 أشخاص بالساعة كحد أقصى.` : "متوقف (الافتراضي). بدونه تعتمد الأرقام على التحققات اللي صارت أثناء الحملات فقط."} />
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <span className="muted">أعد التحقق كل</span>
          <input className="input !w-20 text-center" type="number" min={1} max={90} value={days} onChange={(e) => setDays(Math.min(90, Math.max(1, Number(e.target.value) || 7)))} aria-label="عدد الأيام بين كل تحقق" />
          <span className="muted">أيام</span>
          {recheck.enabled && days !== recheck.days && <button className="btn btn-ghost min-h-9 text-xs" onClick={() => save(true)}>حفظ</button>}
        </div>
      </div>
      {r.items.length > 0 && (
        <div className="-mx-4 mt-4 overflow-x-auto sm:-mx-5">
          <table className="w-full min-w-[620px] text-sm">
            <thead><tr className="muted bg-[var(--surface-2)] text-right text-xs">
              <th className="px-4 py-2 font-semibold">الحساب</th><th className="px-3 py-2 font-semibold">الحملة</th><th className="px-3 py-2 font-semibold">استلم المحتوى</th>
              <th className="px-3 py-2 font-semibold">وقت الاستلام</th><th className="px-3 py-2 font-semibold">آخر حالة</th><th className="px-3 py-2 font-semibold">آخر تحقق</th>
            </tr></thead>
            <tbody>
              {r.items.slice(0, 200).map((i: any, k: number) => (
                <tr key={k} className="border-t border-[var(--border)]">
                  <td className="px-4 py-2" dir="ltr" style={{ textAlign: "right" }}>{i.username ? `@${i.username}` : "—"}</td>
                  <td className="px-3 py-2">{i.campaign}</td>
                  <td className="px-3 py-2 text-xs">{fmtTime(i.delivered_at)}</td>
                  <td className="px-3 py-2 text-xs text-emerald-600">يتابع</td>
                  <td className={`px-3 py-2 text-xs ${i.last_status === "not_following" ? "text-amber-600" : i.last_status === "unknown" ? "muted" : "text-emerald-600"}`}>{label[i.last_status]}</td>
                  <td className="px-3 py-2 text-xs">{i.last_checked_at ? fmtTime(i.last_checked_at) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
