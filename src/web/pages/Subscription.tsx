import { useState } from "react";
import { api } from "../api";
import { Icon } from "../components/Icon";
import { PlansShowcase } from "../components/PlansShowcase";
import { Alert, Card, Spinner, fmtTime, toast, useAsync } from "../components/ui";

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
          <p className="muted mb-3 text-sm">أدخل <b>كود التفعيل</b> اللي وصلك بعد الدفع (يبدأ بـ HSN-). إذا كان اشتراكك ما زال فعّالًا، تُضاف المدة الجديدة بعد تاريخ انتهائه. <b>كود الخصم</b> مكانه تحت في الباقات ← «عندك كود خصم؟».</p>
          <div className="flex gap-2">
            <input className="input" dir="ltr" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="HSN-XXXX-XXXX-XXXX" aria-label="كود التفعيل" />
            <button className="btn btn-primary shrink-0" disabled={busy || code.trim().length < 4} onClick={redeem}>{busy ? "…" : "تفعيل"}</button>
          </div>
          {data.sales_contact && (
            <a className="btn btn-ghost mt-4 w-full" href={data.sales_contact} target="_blank" rel="noopener"><Icon name="send" size={17} />تواصل معنا لشراء أو ترقية الباقة</a>
          )}
        </Card>
      </div>
      <ReferralCard />
      <h2 id="plans" className="font-display scroll-mt-20 pt-2 text-lg font-extrabold">الباقات وطرق الدفع</h2>
      <PlansShowcase catalog={data} currentPlanId={data.plan?.id} />
    </div>
  );
}

/** The customer's invitation link: a friend who signs up with it gives both of them bonus days. */
function ReferralCard() {
  const { data } = useAsync(() => api<any>("/api/referral").catch(() => null), []);
  if (!data || !data.days_per_referral) return null;
  const link = `${location.origin}/#/register?ref=${data.code}`;
  const share = async () => {
    const text = `أستخدم HSN AutoReply للرد التلقائي على تعليقات إنستقرام 🚀 اشترك من رابطي وتاخذ ${data.days_per_referral} أيام هدية:\n${link}`;
    try {
      if (navigator.share) await navigator.share({ text });
      else {
        await navigator.clipboard.writeText(text);
        toast("نسخنا الرابط ✅");
      }
    } catch {
      /* cancelled */
    }
  };
  return (
    <Card title="🎁 ادعُ صديق واكسب أيام مجانية">
      <p className="muted text-sm">إذا اشترك أحد من رابطك، تاخذ أنت <b>{data.days_per_referral} أيام</b> إضافية على اشتراكك، وهو بعد ياخذ {data.days_per_referral} أيام هدية.</p>
      <div className="mt-3 flex gap-2">
        <input className="input text-xs" dir="ltr" readOnly value={link} onFocus={(e) => e.target.select()} aria-label="رابط الدعوة" />
        <button className="btn btn-primary shrink-0" onClick={share}><Icon name="send" size={16} />مشاركة</button>
      </div>
      <p className="muted mt-2 text-xs">اشترك من رابطك: <b>{data.referred}</b> · كسبت: <b>{data.rewarded * data.days_per_referral}</b> يوم</p>
    </Card>
  );
}
