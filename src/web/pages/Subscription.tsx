import { useState } from "react";
import { api } from "../api";
import { Icon } from "../components/Icon";
import { EVENT_LABELS, FEATURE_HINTS, FEATURE_LABELS, LIMIT_HINTS, type PlanLimits } from "../../shared/plans";
import { Alert, Card, Spinner, Tip, fmtTime, toast, useAsync } from "../components/ui";

const n = (v: number | null) => (v === null ? "غير محدود" : v.toLocaleString("en-US"));

function Meter({ label, used, max }: { label: string; used: number; max: number | null }) {
  const pct = max === null ? 0 : max === 0 ? 100 : Math.min(100, Math.round((used / max) * 100));
  return (
    <div>
      <div className="flex justify-between text-sm"><span className="font-semibold">{label}</span><span className="muted">{used.toLocaleString("en-US")} / {n(max)}</span></div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-[var(--surface-2)]">
        <div className={`h-full rounded-full ${pct >= 90 ? "bg-red-500" : "grad"}`} style={{ width: `${max === null ? 4 : Math.max(2, pct)}%` }} />
      </div>
    </div>
  );
}

export function Features({ limits }: { limits: PlanLimits }) {
  return (
    <ul className="space-y-1.5 text-sm">
      <li><Tip text={LIMIT_HINTS.events}>✅ {limits.events.map((e) => EVENT_LABELS[e] ?? e).join(" · ") || "—"}</Tip></li>
      <li><Tip text={LIMIT_HINTS.active_campaigns}>✅ الحملات النشطة: {n(limits.active_campaigns)}</Tip></li>
      <li><Tip text={LIMIT_HINTS.monthly_messages}>✅ الرسائل شهريًا: {n(limits.monthly_messages)}</Tip></li>
      <li><Tip text={LIMIT_HINTS.draws_per_month}><span className={limits.draws_per_month === 0 ? "muted line-through" : ""}>{limits.draws_per_month === 0 ? "—" : "✅"} السحوبات: {limits.draws_per_month === null ? "غير محدودة" : `${limits.draws_per_month} شهريًا`}</span></Tip></li>
      {Object.entries(FEATURE_LABELS).map(([k, label]) => (
        <li key={k}><Tip text={FEATURE_HINTS[k]}><span className={(limits as any)[k] ? "" : "muted line-through"}>{(limits as any)[k] ? "✅" : "—"} {label}</span></Tip></li>
      ))}
    </ul>
  );
}

export function SubscriptionPage() {
  const { data, loading, error, reload } = useAsync(() => api<any>("/api/subscription"), []);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const redeem = async () => {
    setBusy(true);
    try {
      const r = await api("/api/subscription/redeem", { body: { code } });
      toast(`تم التفعيل ✅ — صالح حتى ${fmtTime(r.expires_at)}`);
      setCode("");
      reload();
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  if (loading && !data) return <Spinner />;
  if (error) return <Alert tone="bad">{error}</Alert>;
  if (data.owner) return <Alert tone="info">حساب المالك يعمل بكل المزايا بدون اشتراك.</Alert>;
  const daysLeft = data.expires_at ? Math.ceil((data.expires_at - Date.now()) / 86_400_000) : null;
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-extrabold leading-tight sm:text-[26px]">اشتراكي</h1>
        <p className="muted mt-1 text-sm">باقتك الحالية واستهلاكك هذا الشهر، وتفعيل الكود.</p>
      </header>
      {!data.active ? (
        <Alert tone="bad">
          {data.reason === "expired" ? `انتهى اشتراكك${data.expires_at ? ` في ${fmtTime(data.expires_at)}` : ""}` : "لا يوجد اشتراك فعّال"} — الردود التلقائية متوقفة حتى تُدخل كود تفعيل. بياناتك وحملاتك محفوظة.
        </Alert>
      ) : daysLeft !== null && daysLeft <= 3 ? (
        <Alert tone="warn">اشتراكك ينتهي خلال {daysLeft} {daysLeft === 1 ? "يوم" : "أيام"} — جدّده بكود جديد حتى لا تتوقف الردود. الأيام المتبقية تُضاف للكود الجديد.</Alert>
      ) : null}
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="باقتك" action={data.active ? <span className="chip bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"><span className="h-1.5 w-1.5 rounded-full bg-current" />فعّال</span> : <span className="chip bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300">غير فعّال</span>}>
          <div className="font-display text-2xl font-extrabold">{data.plan?.name ?? "—"}</div>
          <p className="muted mt-1 text-sm">{data.expires_at ? `صالح حتى ${fmtTime(data.expires_at)}${daysLeft !== null && daysLeft > 0 ? ` (${daysLeft} يوم)` : ""}` : "لم يُفعَّل بعد"}</p>
          {data.active && (
            <div className="mt-4 space-y-3">
              <Meter label="الرسائل هذا الشهر" used={data.usage.messages} max={data.limits.monthly_messages} />
              <Meter label="الحملات النشطة" used={data.usage.active_campaigns} max={data.limits.active_campaigns} />
              {data.limits.draws_per_month !== 0 && <Meter label="السحوبات هذا الشهر" used={data.usage.draws_this_month} max={data.limits.draws_per_month} />}
            </div>
          )}
        </Card>
        <Card title="تفعيل كود">
          <p className="muted mb-3 text-sm">أدخل كود التفعيل اللي وصلك بعد الاشتراك. إذا كان اشتراكك ما زال فعّالًا، تُضاف المدة الجديدة بعد تاريخ انتهائه.</p>
          <div className="flex gap-2">
            <input className="input" dir="ltr" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="HSN-XXXX-XXXX-XXXX" aria-label="كود التفعيل" />
            <button className="btn btn-primary shrink-0" disabled={busy || code.trim().length < 12} onClick={redeem}>{busy ? "…" : "تفعيل"}</button>
          </div>
          {data.sales_contact && (
            <a className="btn btn-ghost mt-4 w-full" href={data.sales_contact} target="_blank" rel="noopener"><Icon name="send" size={17} />تواصل معنا لشراء أو ترقية الباقة</a>
          )}
        </Card>
      </div>
      <h2 className="font-display pt-2 text-lg font-extrabold">الباقات</h2>
      <div className="grid gap-4 md:grid-cols-3">
        {data.plans.map((p: any) => (
          <Card key={p.id} className={p.id === data.plan?.id ? "ring-2 ring-violet-500" : ""}>
            <div className="flex items-baseline justify-between gap-2">
              <b className="font-display text-lg">{p.name}</b>
              {p.id === data.plan?.id && <span className="chip bg-violet-500/10 text-violet-700 dark:text-violet-200">باقتك</span>}
            </div>
            <div className="font-display mt-1 text-xl font-extrabold text-violet-600 dark:text-violet-300">{p.price_label || "تواصل معنا"}</div>
            {p.description && <p className="muted mt-1 text-xs">{p.description}</p>}
            <div className="mt-3"><Features limits={p.limits} /></div>
          </Card>
        ))}
      </div>
    </div>
  );
}
