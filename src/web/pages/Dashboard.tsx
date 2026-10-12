import { useMemo, useState } from "react";
import { api } from "../api";
import { Link } from "../App";
import { Alert, Badge, Card, PageHeader, Spinner, Stat, Toggle, toast, useAsync, fmtTime, currentTz } from "../components/ui";
import { AccountAvatar, UserAvatar } from "../components/UserAvatar";
import { UsageCard } from "../components/UsageCard";
import { Icon } from "../components/Icon";
import { AreaChart, Sparkline } from "../components/Charts";
import { AR_LABELS } from "../../shared/states";

type Row = { n: number; [k: string]: any };
const sum = (rows: Row[] | undefined, pred: (r: Row) => boolean) => (rows ?? []).filter(pred).reduce((a, r) => a + r.n, 0);
const fmt = (n: number) => n.toLocaleString("en-US");
const TYPE_ICON: Record<string, string> = { comment: "msg", story_reply: "play", story_mention: "sparkle" };
const TYPE_GRAD: Record<string, string> = {
  comment: "linear-gradient(135deg,#7c3aed,#c026d3 60%,#f97316)",
  story_reply: "linear-gradient(135deg,#0ea5e9,#6366f1)",
  story_mention: "linear-gradient(135deg,#f97316,#e11d48)",
};

/** Daily buckets (UTC day numbers from the API) → values for the last `days` days, oldest first. */
function daily(rows: Array<{ d: number; n: number }> | undefined, days: number): number[] {
  const today = Math.floor(Date.now() / 86_400_000);
  const map = new Map((rows ?? []).map((r) => [r.d, r.n]));
  return Array.from({ length: days }, (_, i) => map.get(today - (days - 1 - i)) ?? 0);
}

export function DashboardPage() {
  const [days, setDays] = useState(7);
  const { data, loading, error, reload } = useAsync(() => api("/api/dashboard?days=" + days), [days]);
  const [busy, setBusy] = useState(false);

  const chartDays = Math.max(days, 7);
  const series = useMemo(() => {
    if (!data?.series) return null;
    return { comments: daily(data.series.comments, chartDays), delivered: daily(data.series.delivered, chartDays) };
  }, [data, chartDays]);
  const labels = useMemo(() => {
    const today = Math.floor(Date.now() / 86_400_000);
    const f = new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-latn", { timeZone: currentTz(), ...(chartDays <= 7 ? { weekday: "long" } : { day: "numeric", month: "short" }) });
    return Array.from({ length: chartDays }, (_, i) => f.format(new Date((today - (chartDays - 1 - i)) * 86_400_000 + 43_200_000)));
  }, [chartDays]);

  if (loading && !data) return <Spinner />;
  if (error) return <Alert tone="bad">{error}</Alert>;
  const d = data!;
  const ev = d.events as Row[];
  const jobs = d.jobs as Row[];
  const flows = d.flows as Row[];
  const acc = d.account;

  const toggleAutomation = async (enabled: boolean) => {
    if (!enabled && !confirm("إيقاف شامل للأتمتة؟ ستُلغى الرسائل المعلّقة ولن تُعالج الأحداث الجديدة حتى إعادة التشغيل.")) return;
    setBusy(true);
    try {
      await api("/api/automation", { body: { enabled } });
      toast(enabled ? "تم تشغيل الأتمتة" : "تم إيقاف الأتمتة");
      reload();
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };

  const received = sum(ev, (r) => ["comment", "story_reply", "story_mention"].includes(r.event_type));
  const sent = sum(jobs, (r) => r.kind === "send_message" && r.status === "accepted");
  const delivered = sum(flows, (r) => r.state === "content_sent");
  const verified = d.follows?.verified ?? 0;
  const spark = (v?: number[]) => (v ? v.slice(-Math.min(14, v.length)) : []);

  return (
    <div className="space-y-5">
      <PageHeader
        title="لوحة التحكم"
        subtitle="ملخص أداء حسابك — الأرقام تستثني بيانات وضع التجربة."
        actions={
          <>
            <div className="seg" role="tablist" aria-label="المدة">
              {[1, 7, 30, 90].map((n) => (
                <button key={n} role="tab" aria-selected={days === n} className={days === n ? "on" : ""} onClick={() => setDays(n)}>
                  {n === 1 ? "24 ساعة" : `${n} يومًا`.replace("7 يومًا", "7 أيام")}
                </button>
              ))}
            </div>
            <Link to="/campaigns/new" className="btn btn-primary"><Icon name="plus" size={18} />حملة جديدة</Link>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        {[
          { label: "تفاعلات مستلمة", value: received, hint: "تعليقات وردود ومنشن ستوري", icon: "msg", accent: "violet", s: series?.comments, c: "#7c3aed" },
          { label: "رسائل وصلت", value: sent, hint: "قبلتها Meta (≠ قُرئت)", icon: "send", accent: "pink", s: undefined, c: "#db2777" },
          { label: "محتوى سُلِّم", value: delivered, hint: "وصل الرابط النهائي", icon: "check", accent: "green", s: series?.delivered, c: "#10b981" },
          { label: "متابعات تم التحقق منها", value: verified, hint: "ليست «جددًا» بالضرورة", icon: "userplus", accent: "orange", s: undefined, c: "#f97316" },
        ].map((k) => (
          <div key={k.label} className="relative">
            <Stat label={k.label} value={fmt(k.value)} hint={k.hint} icon={<Icon name={k.icon} size={19} />} accent={k.accent as any} />
            <div className="pointer-events-none absolute bottom-4 left-4 hidden sm:block"><Sparkline values={spark(k.s)} color={k.c} /></div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.65fr_1fr]">
        <Card
          title="نشاط الحملات"
          action={
            <div className="flex items-center gap-2 text-xs font-bold">
              <span className="chip bg-violet-500/10 text-violet-600 dark:text-violet-300"><span className="h-1.5 w-1.5 rounded-full bg-current" />تفاعلات</span>
              <span className="chip bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"><span className="h-1.5 w-1.5 rounded-full bg-current" />تسليم المحتوى</span>
            </div>
          }
        >
          {series ? (
            <AreaChart labels={labels} series={[{ label: "تفاعل", color: "#7c3aed", values: series.comments }, { label: "تسليم", color: "#10b981", values: series.delivered }]} />
          ) : (
            <Spinner />
          )}
        </Card>

        <Card title="حالة النظام" action={<Badge value={d.automation_enabled ? "active" : "paused"} label={d.automation_enabled ? "يعمل" : "متوقف"} />}>
          <div className="space-y-4">
            <Toggle
              checked={!!d.automation_enabled}
              onChange={toggleAutomation}
              disabled={busy}
              label={d.automation_enabled ? "الأتمتة تعمل" : "الأتمتة متوقفة"}
              description="إيقاف شامل: يوقف معالجة الأحداث الجديدة ويلغي الرسائل المعلّقة."
            />
            {acc && acc.status !== "disconnected" ? (
              <div className="flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
                <AccountAvatar url={acc.profile_picture_url} name={acc.username} size={44} />
                <div className="min-w-0 flex-1">
                  <b className="block truncate" dir="ltr" style={{ textAlign: "right" }}>@{acc.username}</b>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    <Badge value={acc.status} label={acc.status === "active" ? "مفوَّض" : undefined} />
                    <Badge value={acc.webhook_status} label={acc.webhook_status === "subscribed" ? "Webhooks مشتركة" : `Webhooks: ${acc.webhook_status}`} />
                  </div>
                  <div className="muted mt-1 text-xs">آخر حدث: {fmtTime(acc.last_webhook_at)}</div>
                </div>
                <Link to="/connection" className="btn btn-ghost min-h-9 px-3 text-xs">إدارة</Link>
              </div>
            ) : (
              <Alert tone="warn">لا يوجد حساب إنستقرام متصل. الأتمتة لن تعمل قبل الربط الرسمي عبر Meta. <Link to="/connection" className="font-bold underline">اربط الآن</Link></Alert>
            )}
            <div className="grid grid-cols-3 gap-2 text-center">
              {[
                ["نشطة", d.campaigns?.active ?? 0, "text-emerald-600 dark:text-emerald-400"],
                ["متوقفة", d.campaigns?.paused ?? 0, "text-amber-600"],
                ["مسودة", d.campaigns?.draft ?? 0, ""],
              ].map(([l, v, c]) => (
                <Link key={l as string} to="/campaigns" className="rounded-xl border border-[var(--border)] p-2">
                  <div className={`font-display text-xl font-extrabold ${c}`}>{v as number}</div>
                  <div className="muted text-[11px]">حملات {l}</div>
                </Link>
              ))}
            </div>
          </div>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.65fr_1fr]">
        <Card title="أفضل الحملات" action={<Link to="/campaigns" className="btn btn-ghost min-h-9 px-3 text-xs">عرض الكل</Link>}>
          {!(d.top_campaigns as any[])?.length ? (
            <p className="muted py-6 text-center text-sm">لا توجد تفاعلات في هذه المدة بعد.</p>
          ) : (
            <div className="-mx-4 -my-4 overflow-x-auto sm:-mx-5 sm:-my-5">
              <table className="w-full text-sm">
                <thead>
                  <tr className="muted bg-[var(--surface-2)] text-right text-xs">
                    <th className="px-4 py-2.5 font-semibold">الحملة</th>
                    <th className="px-3 py-2.5 font-semibold">تفاعلات</th>
                    <th className="px-3 py-2.5 font-semibold">سُلِّم</th>
                    <th className="hidden px-4 py-2.5 font-semibold sm:table-cell">التحويل</th>
                  </tr>
                </thead>
                <tbody>
                  {(d.top_campaigns as any[]).map((c) => {
                    const pct = c.triggers ? Math.round(((c.delivered ?? 0) / c.triggers) * 100) : 0;
                    return (
                      <tr key={c.id} className="border-t border-[var(--border)]">
                        <td className="px-4 py-3">
                          <Link to={`/campaigns/${c.id}/stats`} className="flex items-center gap-2.5">
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-white" style={{ background: TYPE_GRAD[c.type] }}><Icon name={TYPE_ICON[c.type] ?? "msg"} size={17} /></span>
                            <span className="min-w-0"><b className="block truncate">{c.name}</b><span className="muted text-xs">{AR_LABELS[c.type] ?? c.type}</span></span>
                          </Link>
                        </td>
                        <td className="font-display px-3 py-3 font-bold">{fmt(c.triggers)}</td>
                        <td className="px-3 py-3">{fmt(c.delivered ?? 0)}</td>
                        <td className="hidden w-40 px-4 py-3 sm:table-cell">
                          <div className="flex items-center gap-2">
                            <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--surface-2)]"><div className="grad h-full rounded-full" style={{ width: `${pct}%` }} /></div>
                            <span className="muted w-9 text-xs">{pct}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="آخر النشاطات" action={<Link to="/logs" className="btn btn-ghost min-h-9 px-3 text-xs">السجل</Link>}>
          {!(d.recent as any[])?.length ? (
            <p className="muted py-6 text-center text-sm">لا يوجد نشاط بعد.</p>
          ) : (
            <div className="space-y-3">
              {(d.recent as any[]).map((r) => (
                <div key={r.id} className="flex items-center gap-3">
                  <UserAvatar url={r.profile_pic_url} name={r.username} size={34} />
                  <div className="min-w-0 flex-1 text-sm">
                    <b className="block truncate"><span dir="ltr">{r.username ? `@${r.username}` : "شخص"}</span> · {AR_LABELS[r.state] ?? r.state}</b>
                    <span className="muted block truncate text-xs">{r.campaign} · {fmtTime(r.updated_at)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <UsageCard />

      <Card title="تفاصيل المدة">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <MiniStat label="تعليقات" value={sum(ev, (r) => r.event_type === "comment")} />
          <MiniStat label="ردود ستوري" value={sum(ev, (r) => r.event_type === "story_reply")} />
          <MiniStat label="منشن ستوري" value={sum(ev, (r) => r.event_type === "story_mention")} />
          <MiniStat label="ردود عامة مقبولة" value={sum(jobs, (r) => r.kind === "public_reply" && r.status === "accepted")} />
          <MiniStat label="بانتظار التفاعل" value={sum(flows, (r) => r.state === "awaiting_user_interaction")} tone="warn" />
          <MiniStat label="بانتظار المتابعة" value={sum(flows, (r) => r.state === "awaiting_follow")} tone="warn" />
          <MiniStat label="فشل" value={sum(jobs, (r) => r.status === "failed")} tone="bad" />
          <MiniStat
            label="معلّقة / غير مؤكدة"
            value={`${sum(jobs, (r) => ["pending", "retry_scheduled", "processing"].includes(r.status))} / ${sum(jobs, (r) => r.status === "uncertain")}`}
            tone="warn"
            hint="غير المؤكدة تحتاج مراجعة يدوية"
          />
        </div>
      </Card>
    </div>
  );
}

function MiniStat({ label, value, tone, hint }: { label: string; value: number | string; tone?: "warn" | "bad"; hint?: string }) {
  const c = tone === "warn" ? "text-amber-600 dark:text-amber-400" : tone === "bad" ? "text-red-600 dark:text-red-400" : "";
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
      <div className="muted text-xs">{label}</div>
      <div className={`font-display text-xl font-extrabold tabular-nums ${c}`}>{typeof value === "number" ? fmt(value) : value}</div>
      {hint && <div className="muted text-[11px]">{hint}</div>}
    </div>
  );
}
