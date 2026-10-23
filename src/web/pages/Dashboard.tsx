import { webhookLabel } from "../../shared/states";
import { askConfirm } from "../components/Confirm";
import { useMemo, useState } from "react";
import { api } from "../api";
import { Link } from "../App";
import { Alert, Badge, Card, PageHeader, Spinner, Stat, Toggle, toast, useAsync, fmtTime, currentTz } from "../components/ui";
import { AccountAvatar, UserAvatar } from "../components/UserAvatar";
import { UsageCard } from "../components/UsageCard";
import { hasPerm, isStaff } from "../lib/me";
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
  // Linked = an Instagram account the automation can work on. A customer who never linked one sees only the first
  // steps and the status (empty numbers and charts before that only look broken).
  const linked = !!acc && acc.status !== "disconnected";
  const fresh = !acc;

  const toggleAutomation = async (enabled: boolean) => {
    if (!enabled && !(await askConfirm({ title: "إيقاف كل الأتمتة؟", message: "تُلغى الرسائل المعلّقة، وما تُعالج التعليقات الجديدة لين تشغّلها من جديد.", confirmLabel: "إيقاف الأتمتة", danger: true }))) return;
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
  const newFollowers = d.follows?.new_followers ?? 0;
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
            {hasPerm("campaigns") && <Link to="/campaigns/new" className="btn btn-primary"><Icon name="plus" size={18} />حملة جديدة</Link>}
          </>
        }
      />

      <EmailNudge />
      {!isStaff() && <GettingStarted connected={!!acc && acc.status === "active"} total={(d.campaigns?.active ?? 0) + (d.campaigns?.paused ?? 0) + (d.campaigns?.draft ?? 0)} active={d.campaigns?.active ?? 0} />}

      {!fresh && <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        {[
          { label: "تفاعلات مستلمة", value: received, hint: "تعليقات وردود ومنشن ستوري", info: "كل تعليق أو رد على ستوري أو منشن في ستوري وصل للنظام خلال المدة المختارة، ومعها المكرر واللي ما طابق كلمات الحملات.", icon: "msg", accent: "violet", s: series?.comments, c: "#7c3aed" },
          { label: "رسائل وصلت", value: sent, hint: "قبلتها Meta (≠ قُرئت)", info: "عدد الرسائل الخاصة اللي أرسلها النظام وقبلتها Meta. القبول يعني إنها انرسلت، مو بالضرورة إن الشخص قرأها.", icon: "send", accent: "pink", s: undefined, c: "#db2777" },
          { label: "محتوى سُلِّم", value: delivered, hint: "وصل الرابط النهائي", info: "عدد الأشخاص اللي وصلتهم الرسالة الأخيرة فيها المحتوى أو الرابط، يعني أكملوا خطوات الحملة.", icon: "check", accent: "green", s: series?.delivered, c: "#10b981" },
          { label: "متابعون جدد", value: newFollowers, hint: "تابعوا حسابك بعد تفاعلهم", info: "عدد الأشخاص اللي كانوا مو متابعين لحسابك وقت تفاعلهم، وتأكد النظام من Meta إنهم صاروا متابعين خلال المدة. اللي كانوا متابعين من قبل ما ينحسبون.", icon: "userplus", accent: "orange", s: undefined, c: "#f97316" },
        ].map((k) => (
          <div key={k.label} className="relative">
            <Stat label={k.label} value={fmt(k.value)} hint={k.hint} info={k.info} icon={<Icon name={k.icon} size={19} />} accent={k.accent as any} />
            <div className="pointer-events-none absolute bottom-4 left-4 hidden sm:block"><Sparkline values={spark(k.s)} color={k.c} /></div>
          </div>
        ))}
      </div>}

      <div className={`grid grid-cols-[minmax(0,1fr)] gap-4 ${fresh ? "" : "lg:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]"}`}>
        {!fresh && <Card
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
        </Card>}

        <Card className="order-first lg:order-none" title="حالة النظام" action={linked ? <Badge value={d.automation_enabled ? "active" : "paused"} label={d.automation_enabled ? "يعمل" : "متوقف"} /> : <Badge value="paused" label="غير مربوط" />}>
          <div className="space-y-4">
            {linked && <Toggle
              checked={!!d.automation_enabled}
              onChange={toggleAutomation}
              disabled={busy || isStaff()}
              label={d.automation_enabled ? "الأتمتة تعمل" : "الأتمتة متوقفة"}
              description="إيقاف شامل: يوقف معالجة الأحداث الجديدة ويلغي الرسائل المعلّقة."
            />}
            {acc && acc.status !== "disconnected" ? (
              <div className="flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
                <AccountAvatar url={acc.profile_picture_url} name={acc.username} size={44} />
                <div className="min-w-0 flex-1">
                  <b className="block truncate" dir="ltr" style={{ textAlign: "right" }}>@{acc.username}</b>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    <Badge value={acc.status} label={acc.status === "active" ? "متصل" : undefined} />
                    <Badge value={acc.webhook_status} label={webhookLabel(acc.webhook_status)} />
                  </div>
                  <div className="muted mt-1 text-xs">آخر حدث: {fmtTime(acc.last_webhook_at)}</div>
                </div>
                <Link to="/connection" className="btn btn-ghost min-h-9 px-3 text-xs">إدارة</Link>
              </div>
            ) : (
              <Alert tone="warn">لا يوجد حساب إنستقرام متصل. الأتمتة لن تعمل قبل الربط الرسمي عبر Meta.</Alert>
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

      {!fresh && <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
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
      </div>}

      {!isStaff() && <UsageCard />}

      {!fresh && <details className="card group p-0">
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between px-5 py-3 font-bold [&::-webkit-details-marker]:hidden">
          تفاصيل المدة
          <Icon name="chev" size={18} className="muted transition group-open:rotate-180" />
        </summary>
        <div className="grid grid-cols-2 gap-3 border-t border-[var(--border)] p-4 sm:grid-cols-3 sm:p-5 lg:grid-cols-4">
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
      </details>}
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

/** First steps for a new account; disappears once the account is connected and a campaign is running. */
function GettingStarted({ connected, total, active }: { connected: boolean; total: number; active: number }) {
  const { data: stores } = useAsync(() => api<any>("/api/stores").catch(() => null), []);
  if (connected && active > 0) return null;
  const storeConnected = !!stores?.stores?.some((s: any) => s.status === "active");
  const steps: Array<{ done: boolean; title: string; text: string; to: string; cta: string }> = [
    { done: connected, title: "اربط حساب إنستقرام حقك", text: "دقيقة وحدة عبر Meta الرسمي، بدون كلمة مرور إنستقرام. لازم يكون الحساب «احترافي» (أعمال أو صانع محتوى) — التحويل مجاني من إعدادات إنستقرام.", to: "/connection", cta: "اربط حسابي" },
    { done: total > 0, title: "أنشئ أول حملة", text: "اختر المنشور، والكلمة اللي يكتبها المتابع، والرسالة اللي توصله.", to: "/campaigns/new", cta: "حملة جديدة" },
    { done: active > 0, title: "جرّبها ثم فعّلها", text: "المحاكاة تبيّن لك وش يصير بالضبط، بدون إرسال أي رسالة حقيقية.", to: total > 0 ? "/campaigns" : "/simulator", cta: total > 0 ? "الحملات" : "المحاكاة" },
  ];
  // Optional: the store, for orders and profit per campaign (only when the plan includes it).
  if (stores?.plan) steps.push({ done: storeConnected, title: "اربط متجرك (اختياري)", text: "سلة: تعرف كم طلب وربح جابت كل حملة، بصلاحيات قراءة فقط.", to: "/connection", cta: "اربط المتجر" });
  const next = steps.findIndex((s) => !s.done);
  return (
    <section className="card border-violet-500/30 p-4 sm:p-5" aria-labelledby="start-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="start-title" className="font-display text-lg font-extrabold">ابدأ هنا</h2>
        <span className="muted text-xs">{steps.filter((s) => s.done).length} من {steps.length} خطوات</span>
        <p className="muted w-full text-xs">ابدأ بربط إنستقرام (أساسي)، بعدها أنشئ حملتك، وإذا عندك متجر اربطه عشان تشوف المبيعات والربح.</p>
      </div>
      <ol className={`mt-3 grid gap-2 ${steps.length > 3 ? "md:grid-cols-2 xl:grid-cols-4" : "md:grid-cols-3"}`}>
        {steps.map((s, i) => (
          <li key={s.title} className={`flex gap-3 rounded-2xl border p-3 ${i === next ? "border-violet-500/50 bg-violet-500/5" : "border-[var(--border)]"}`}>
            <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-extrabold ${s.done ? "bg-emerald-500/15 text-emerald-600" : i === next ? "grad text-white" : "surface-2 muted"}`} aria-hidden>
              {s.done ? <Icon name="check" size={14} /> : i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <b className={`block text-sm ${s.done ? "muted line-through decoration-1" : ""}`}>{s.title}<span className="sr-only">{s.done ? " (تم)" : ""}</span></b>
              {!s.done && <p className="muted mt-0.5 text-xs leading-relaxed">{s.text}</p>}
              {i === next && <Link to={s.to} className="btn btn-primary mt-2 min-h-10 px-4 text-sm">{s.cta}</Link>}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Customers without a confirmed email cannot recover their password: a gentle reminder until they add one. */
function EmailNudge() {
  const { data } = useAsync(() => api<{ email: string | null; verified: boolean; enabled: boolean }>("/api/account/email").catch(() => null), []);
  if (!data || !data.enabled || data.verified) return null;
  return (
    <Alert tone="warn">
      📧 {data.email ? "أكّد إيميلك" : "أضف إيميلك"} عشان تقدر تسترجع حسابك لو نسيت كلمة المرور.{" "}
      <Link to="/settings" className="font-bold underline">من الإعدادات ←</Link>
    </Alert>
  );
}
