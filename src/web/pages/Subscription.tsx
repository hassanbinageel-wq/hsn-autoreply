import { useEffect, useState } from "react";
import { askConfirm } from "../components/Confirm";
import { isStaff } from "../lib/me";
import { isNative, openExternal } from "../platform";
import { api } from "../api";
import { Icon } from "../components/Icon";
import { PlansShowcase } from "../components/PlansShowcase";
import { Alert, Card, InfoDot, Spinner, fmtDate, fmtTime, toast, useAsync } from "../components/ui";

const n = (v: number | null) => (v === null ? "غير محدود" : v.toLocaleString("en-US"));

function Meter({ label, used, max }: { label: React.ReactNode; used: number; max: number | null }) {
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
  // Back from the card payment page (#/subscription?paid=<id>): re-check that payment with the gateway.
  const [paidId, setPaidId] = useState(() => new URLSearchParams(location.hash.split("?")[1] ?? "").get("paid"));
  const [checkKey, setCheckKey] = useState(0);
  const [payResult, setPayResult] = useState<{ status: string; amount?: number; days?: number; upgrade?: boolean } | null>(null);
  useEffect(() => {
    if (!paidId) return;
    let stop = false;
    let tries = 0;
    const check = async () => {
      try {
        const r = await api<{ status: string; amount: number; days: number; upgrade: boolean }>(`/api/subscription/pay/${encodeURIComponent(paidId)}`);
        if (stop) return;
        setPayResult(r);
        if (r.status === "paid") return reload();
        // The callback can arrive a few seconds after the customer is sent back.
        if (r.status === "initiated" && ++tries < 6) setTimeout(check, 4000);
      } catch (e: any) {
        if (!stop) setPayResult({ status: "error" });
      }
    };
    check();
    return () => { stop = true; };
  }, [paidId, checkKey]);
  const payCard = async (planId: string) => {
    const plan = data?.plans?.find((p: any) => p.id === planId);
    if (!plan?.card_price) return;
    const ok = await askConfirm({
      title: `الدفع بالبطاقة — ${plan.name}`,
      message: `راح تنتقل لصفحة الدفع الآمنة (ميسّر) وتدفع ${plan.card_price.toLocaleString("en-US")} ر.س بمدى أو فيزا أو ماستركارد أو Apple Pay. بعد الدفع تتفعّل الباقة تلقائيًا${data.active && data.plan?.id === planId ? "، والمدة الجديدة تنضاف بعد تاريخ انتهاء اشتراكك الحالي" : data.active ? " — تنبيه: باقتك الحالية تتغيّر لهذي الباقة، والأيام المتبقية تنضاف لها" : ""}. أكواد الخصم ما تنطبق على الدفع بالبطاقة.`,
      confirmLabel: "انتقل للدفع",
    });
    if (!ok) return;
    try {
      goPay(await api<{ id: number; url: string }>("/api/subscription/pay", { body: { plan_id: planId } }));
    } catch (e: any) {
      toast(e.message, "bad");
    }
  };
  // In the Android app the payment page opens in the browser; back in the app, this page checks the payment.
  const goPay = async (r: { id: number; url: string }) => {
    if (isNative) {
      await openExternal(r.url);
      setPaidId(String(r.id));
      setPayResult({ status: "initiated" });
    } else location.href = r.url;
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
      {payResult && (
        payResult.status === "paid" ? <Alert tone="good">{payResult.upgrade ? "✅ تم دفع الفرق وترقّت باقتك — تاريخ الانتهاء نفسه." : `✅ تم الدفع وتفعّلت باقتك${payResult.days ? ` (${payResult.days} يوم)` : ""}. شكرًا لك!`}</Alert>
        : payResult.status === "initiated" ? <Alert tone="info">ننتظر تأكيد الدفع… إذا دفعت، تتفعّل الباقة تلقائيًا خلال دقائق ويوصلك إشعار. <button className="font-bold underline" onClick={() => setCheckKey((k) => k + 1)}>تحقق الحين</button></Alert>
        : <Alert tone="bad">ما اكتمل الدفع ({payResult.status === "failed" ? "رُفضت البطاقة" : payResult.status === "expired" ? "انتهت مهلة الصفحة" : payResult.status === "canceled" ? "أُلغي" : "تعذر التأكد"}). ما انخصم منك شي إذا ما اكتمل — جرّب مرة ثانية أو استخدم طريقة دفع ثانية.</Alert>
      )}
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
              <Meter label={<span className="inline-flex items-center gap-1">رسائل الدورة الحالية <InfoDot text="كل رسالة يرسلها النظام تلقائيًا وتقبلها إنستقرام تنحسب وحدة: الرد العلني على التعليق، والرد الخاص على التعليق، والرسائل في الخاص (مثل رسالة الرابط والمتابعة). ما تنحسب: تجارب المحاكاة، والردود اللي ترسلها بيدك من صندوق الرسائل. العدّاد يتجدد كل 30 يوم من تاريخ تفعيل اشتراكك وما دام الاشتراك فعّال — وإذا انتهى الاشتراك يتجدد مع التجديد." /></span>} used={data.usage.messages} max={data.limits.monthly_messages} />
              <p className="muted -mt-1 text-xs">{data.usage.resets_at ? `يتجدد عدّاد الرسائل والسحوبات في ${fmtDate(data.usage.resets_at)}` : "يتجدد عدّاد الرسائل والسحوبات مع تجديد اشتراكك"}</p>
              <Meter label="الحملات النشطة" used={data.usage.active_campaigns} max={data.limits.active_campaigns} />
              {data.limits.draws_per_month !== 0 && <Meter label="سحوبات الدورة الحالية" used={data.usage.draws_this_month} max={data.limits.draws_per_month} />}
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
      {data.active && data.card_payments && !isStaff() && <UpgradeCard data={data} onPay={goPay} onPayFull={payCard} />}
      <ReferralCard />
      <h2 id="plans" className="font-display scroll-mt-20 pt-2 text-lg font-extrabold">الباقات وطرق الدفع</h2>
      <PlansShowcase catalog={data} currentPlanId={data.plan?.id} onCardPay={data.card_payments && !isStaff() ? payCard : undefined} />
    </div>
  );
}

/** The customer's invitation link: a friend who signs up with it gives both of them bonus days. */
function ReferralCard() {
  const { data } = useAsync(() => api<any>("/api/referral").catch(() => null), []);
  if (!data || !data.days_per_referral) return null;
  const link = `${location.origin}/#/register?ref=${data.code}`;
  const share = async () => {
    const text = `أستخدم شيّك للرد التلقائي على تعليقات إنستقرام 🚀 اشترك من رابطي وتاخذ ${data.days_per_referral} أيام هدية:\n${link}`;
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

const UPGRADE_STATUS: Record<string, string> = { pending: "قيد المراجعة", approved: "مقبول — بانتظار الدفع", rejected: "ما انقبل", paid: "تمت الترقية ✅", done: "تمت الترقية ✅" };

/**
 * Upgrading to a higher plan without losing the current period: the customer asks, the service reviews the usage
 * and approves the price difference, then the customer pays only that and the plan changes with the same expiry.
 */
function UpgradeCard({ data, onPay, onPayFull }: { data: any; onPay: (r: { id: number; url: string }) => void; onPayFull: (planId: string) => void }) {
  const { data: st, reload } = useAsync(() => api<{ upgrade: any }>("/api/subscription/upgrade"), []);
  const current = data.plans?.find((p: any) => p.id === data.plan?.id);
  const higher = (data.plans ?? []).filter((p: any) => p.card_price && current?.card_price && p.card_price > current.card_price);
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const u = st?.upgrade;
  const chosen = higher.find((p: any) => p.id === (target || higher[0]?.id));
  const { data: quote } = useAsync(
    () => (chosen && !(u && (u.status === "pending" || u.status === "approved")) ? api<{ auto: boolean; amount: number | null; used_messages: number; full_price: number }>(`/api/subscription/upgrade/quote?plan_id=${encodeURIComponent(chosen.id)}`) : Promise.resolve(null)),
    [chosen?.id, u?.status],
  );
  const open = u && (u.status === "pending" || u.status === "approved");
  if (!st || (!higher.length && !u)) return null;
  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  // Nothing used: the request is approved by itself, so go straight to paying the difference.
  const request = () => act(async () => {
    if (!chosen) return;
    const r = await api<{ id: number; auto: boolean; amount: number | null }>("/api/subscription/upgrade", { body: { plan_id: chosen.id } });
    if (r.auto) return onPay(await api<{ id: number; url: string }>(`/api/subscription/upgrade/${r.id}/pay`, { body: {} }));
    toast("وصلنا طلبك — نراجع استهلاكك ونرسل لك مبلغ الفرق بإشعار");
    reload();
  });
  const cancel = () => act(async () => {
    if (!(await askConfirm({ title: "إلغاء طلب الترقية؟", confirmLabel: "إلغاء الطلب", danger: true }))) return;
    await api(`/api/subscription/upgrade/${u.id}`, { method: "DELETE" });
    reload();
  });
  const pay = () => act(async () => onPay(await api<{ id: number; url: string }>(`/api/subscription/upgrade/${u.id}/pay`, { body: {} })));
  return (
    <Card title="⬆️ ترقية الباقة">
      {open ? (
        <div className="space-y-3">
          <p className="text-sm">طلب ترقية من <b>{u.from_name ?? u.from_plan}</b> إلى <b>{u.to_name ?? u.to_plan}</b> — <span className="font-bold">{UPGRADE_STATUS[u.status]}</span></p>
          {u.status === "pending" ? (
            <p className="muted text-sm">نراجع استهلاكك ونرسل لك مبلغ الفرق بإشعار. ما يتغيّر شي في باقتك قبل الدفع.</p>
          ) : (
            <button className="btn btn-primary w-full" disabled={busy} onClick={pay}><Icon name="lock" size={17} />ادفع الفرق {Number(u.amount).toLocaleString("en-US")} ر.س</button>
          )}
          <button className="btn btn-ghost w-full" disabled={busy} onClick={cancel}>إلغاء الطلب</button>
        </div>
      ) : (
        <div className="space-y-3">
          {u?.status === "rejected" && <Alert tone="warn">ما انقبل آخر طلب ترقية{u.note ? ` — ${u.note}` : ""}.</Alert>}
          {(u?.status === "paid" || u?.status === "done") && <Alert tone="good">تمت ترقية باقتك إلى «{u.to_name ?? u.to_plan}».</Alert>}
          {higher.length > 0 && (
            <>
              <p className="muted text-sm">تبي باقة أعلى؟ ما تحتاج تنتظر انتهاء اشتراكك ولا تدفع شهر كامل — تدفع <b>فرق السعر</b> فقط، وتترقى فورًا وتاريخ الانتهاء يبقى نفسه. إذا ما استخدمت شي من باقتك يطلع لك المبلغ مباشرة، وإذا استخدمت نراجع استهلاكك ونرسل لك المبلغ.</p>
              <select className="input" value={target || higher[0].id} onChange={(e) => setTarget(e.target.value)} aria-label="الباقة الجديدة">
                {higher.map((p: any) => <option key={p.id} value={p.id}>{p.name} — {Number(p.card_price).toLocaleString("en-US")} ر.س</option>)}
              </select>
              {!quote ? (
                <Spinner />
              ) : quote.auto ? (
                <button className="btn btn-primary w-full" disabled={busy} onClick={request}><Icon name="lock" size={17} />ادفع الفرق {Number(quote.amount).toLocaleString("en-US")} ر.س وترقَّ الحين</button>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs">استخدمت {quote.used_messages.toLocaleString("en-US")} رسالة من باقتك هذي الدورة، فعندك خيارين:</p>
                  <button className="btn btn-primary w-full" disabled={busy} onClick={() => onPayFull(chosen.id)}>ادفع السعر كامل {Number(quote.full_price).toLocaleString("en-US")} ر.س — تترقى الحين وتنضاف مدة جديدة</button>
                  <button className="btn btn-ghost w-full" disabled={busy} onClick={request}>اطلب دفع الفرق فقط — نراجع استهلاكك ونرسل لك المبلغ</button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Card>
  );
}
