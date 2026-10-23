import { useEffect, useState } from "react";
import { askConfirm } from "../components/Confirm";
import { isStaff } from "../lib/me";
import { isNative, openExternal } from "../platform";
import { api } from "../api";
import { Icon } from "../components/Icon";
import { PlansShowcase } from "../components/PlansShowcase";
import { TopupPicker } from "../components/Promos";
import { Alert, Card, InfoDot, Spinner, fmtDate, fmtTime, toast, useAsync } from "../components/ui";

const n = (v: number | null) => (v === null ? "غير محدود" : v.toLocaleString("en-US"));

function Meter({ label, used, max, extra = 0 }: { label: React.ReactNode; used: number; max: number | null; extra?: number }) {
  const pct = max === null ? 0 : max === 0 ? 100 : Math.min(100, Math.round((used / max) * 100));
  // Top-up messages: the last part of the bar is orange (they are used after the plan's own).
  const extraPct = max && extra ? Math.min(100, (extra / max) * 100) : 0;
  return (
    <div>
      <div className="flex justify-between text-sm"><span className="font-semibold">{label}</span><span className="muted">{used.toLocaleString("en-US")} / {n(max)}</span></div>
      <div className="relative mt-1.5 h-2 overflow-hidden rounded-full bg-[var(--surface-2)]">
        {extraPct > 0 && <div className="absolute inset-y-0 left-0 bg-orange-400/30" style={{ width: `${extraPct}%` }} />}
        <div className={`relative h-full rounded-full ${pct >= 90 ? "bg-red-500" : "grad"}`} style={{ width: `${max === null ? 4 : Math.max(2, pct)}%` }} />
      </div>
      {extra > 0 && max !== null && <p className="muted mt-1 text-xs">الباقة {(max - extra).toLocaleString("en-US")} + <span className="font-semibold text-orange-600 dark:text-orange-400">إضافي {extra.toLocaleString("en-US")}</span></p>}
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
  // Drop ?paid=… from the address once read, so a refresh does not show the payment notice again.
  useEffect(() => {
    if (location.hash.includes("paid=")) history.replaceState(null, "", `${location.pathname}${location.search}#/subscription`);
  }, []);
  const [checkKey, setCheckKey] = useState(0);
  const [payResult, setPayResult] = useState<{ status: string; amount?: number; days?: number; upgrade?: boolean; topup_messages?: number | null } | null>(null);
  useEffect(() => {
    if (payResult?.status !== "paid") return;
    const t = setTimeout(() => setPayResult(null), 15_000);
    return () => clearTimeout(t);
  }, [payResult?.status]);
  useEffect(() => {
    if (!paidId) return;
    let stop = false;
    let tries = 0;
    const check = async () => {
      try {
        const r = await api<{ status: string; amount: number; days: number; upgrade: boolean; topup_messages: number | null }>(`/api/subscription/pay/${encodeURIComponent(paidId)}`);
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
    if (data.active && data.plan?.id && data.plan.id !== planId) {
      const cur = data.plans.find((p: any) => p.id === data.plan.id);
      toast(cur?.card_price && plan.card_price > cur.card_price ? "للانتقال لباقة أعلى استخدم «ترقية الباقة» فوق وادفع الفرق فقط" : "ما تقدر تنزل لباقة أقل وانت مشترك — تقدر تختارها بعد ما ينتهي اشتراكك", "bad");
      document.getElementById("upgrade")?.scrollIntoView({ behavior: "smooth" });
      return;
    }
    const ok = await askConfirm({
      title: `الدفع بالبطاقة — ${plan.name}`,
      message: `راح تنتقل لصفحة الدفع الآمنة وتدفع ${plan.card_price.toLocaleString("en-US")} ر.س بمدى أو فيزا أو ماستركارد أو Apple Pay. بعد الدفع تتفعّل الباقة تلقائيًا${data.active && data.plan?.id === planId ? "، والمدة الجديدة تنضاف بعد تاريخ انتهاء اشتراكك الحالي" : data.active ? " — تنبيه: باقتك الحالية تتغيّر لهذي الباقة، والأيام المتبقية تنضاف لها" : ""}. أكواد الخصم ما تنطبق على الدفع بالبطاقة.`,
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
  // Next to «باقتك»: the upgrade card when a higher plan can be bought, otherwise (top plan) the invitation card.
  const curPlan = data.plans?.find((p: any) => p.id === data.plan?.id);
  const canUpgrade = !!(data.active && data.card_payments && !isStaff() && curPlan?.card_price && data.plans.some((p: any) => p.card_price && p.card_price > curPlan.card_price));
  const daysLeft = data.expires_at ? Math.ceil((data.expires_at - Date.now()) / 86_400_000) : null;
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-extrabold leading-tight sm:text-[26px]">اشتراكي</h1>
        <p className="muted mt-1 text-sm">باقتك الحالية واستهلاكك هذا الشهر، وتفعيل الكود.</p>
      </header>
      {payResult && (
        payResult.status === "paid" ? <Alert tone="good">{payResult.topup_messages ? `✅ تم الشحن: انضافت ${payResult.topup_messages.toLocaleString("en-US")} رسالة لرصيدك والردود التلقائية رجعت تشتغل.` : payResult.upgrade ? "✅ تم دفع الفرق وترقّت باقتك — تاريخ الانتهاء نفسه." : `✅ تم الدفع وتفعّلت باقتك${payResult.days ? ` (${payResult.days} يوم)` : ""}. شكرًا لك!`}</Alert>
        : payResult.status === "initiated" ? <Alert tone="info">ننتظر تأكيد الدفع… إذا دفعت، {payResult.topup_messages ? "تنضاف الرسائل" : "تتفعّل الباقة"} تلقائيًا خلال دقائق ويوصلك إشعار. <button className="font-bold underline" onClick={() => setCheckKey((k) => k + 1)}>تحقق الحين</button></Alert>
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
              <Meter label={<span className="inline-flex items-center gap-1">رسائل الدورة الحالية <InfoDot text="كل رسالة يرسلها النظام تلقائيًا وتقبلها إنستقرام تنحسب وحدة: الرد العلني على التعليق، والرد الخاص على التعليق، والرسائل في الخاص (مثل رسالة الرابط والمتابعة). ما تنحسب: تجارب المحاكاة، والردود اللي ترسلها بيدك من صندوق الرسائل. العدّاد يتجدد كل 30 يوم من تاريخ تفعيل اشتراكك وما دام الاشتراك فعّال — وإذا انتهى الاشتراك يتجدد مع التجديد." /></span>} used={data.usage.messages} max={data.limits.monthly_messages} extra={data.extra_messages ?? 0} />
              <p className="muted -mt-1 text-xs">{data.usage.resets_at ? `يتجدد عدّاد الرسائل والسحوبات في ${fmtDate(data.usage.resets_at)}` : "يتجدد عدّاد الرسائل والسحوبات مع تجديد اشتراكك"}</p>
              <Meter label="الحملات النشطة" used={data.usage.active_campaigns} max={data.limits.active_campaigns} />
              {data.limits.draws_per_month !== 0 && <Meter label="سحوبات الدورة الحالية" used={data.usage.draws_this_month} max={data.limits.draws_per_month} />}
            </div>
          )}
        </Card>
        {canUpgrade ? <div id="upgrade" className="scroll-mt-20"><UpgradeCard data={data} onPay={goPay} /></div> : <ReferralCard />}
      </div>
      {data.active && !isStaff() && <TopupCard />}
      {canUpgrade && <ReferralCard />}
      <h2 id="plans" className="font-display scroll-mt-20 pt-2 text-lg font-extrabold">الباقات وطرق الدفع</h2>
      <PlansShowcase catalog={data} currentPlanId={data.plan?.id} onCardPay={data.card_payments && !isStaff() ? payCard : undefined} />
      {data.code_box?.enabled && (
        <Card title={data.code_box.title || "عندك كود تفعيل؟"}>
          {data.code_box.text && <p className="muted mb-3 whitespace-pre-line text-sm">{data.code_box.text}</p>}
          <div className="flex gap-2">
            <input className="input" dir="ltr" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="HSN-XXXX-XXXX-XXXX" aria-label="كود التفعيل" />
            <button className="btn btn-primary shrink-0" disabled={busy || code.trim().length < 4} onClick={redeem}>{busy ? "…" : "تفعيل"}</button>
          </div>
          {data.code_box.button_url && data.code_box.button_label && (
            <a
              className="btn btn-ghost mt-4 w-full"
              href={data.code_box.button_url}
              target="_blank"
              rel="noopener"
              onClick={(e) => { if (isNative) { e.preventDefault(); openExternal(data.code_box.button_url); } }}
            >
              <Icon name="send" size={17} />{data.code_box.button_label}
            </a>
          )}
        </Card>
      )}
    </div>
  );
}

/** Extra message packs, always on «اشتراكي» while the plan is active (hidden when the owner sells none). */
function TopupCard() {
  const [has, setHas] = useState(true);
  return has ? (
    <div id="topup" className="scroll-mt-20">
      <Card title={<span className="flex items-center gap-2"><Icon name="zap" size={18} />رسائل إضافية</span>}>
        <TopupPickerOrHide onEmpty={() => setHas(false)} />
      </Card>
    </div>
  ) : null;
}
function TopupPickerOrHide({ onEmpty }: { onEmpty: () => void }) {
  const { data } = useAsync(() => api<any>("/api/topups").catch(() => null), []);
  useEffect(() => { if (data && !data.packs?.length) onEmpty(); }, [data]);
  return data?.packs?.length ? <TopupPicker /> : <Spinner />;
}

/** The customer's invitation link: a friend who signs up with it gives both of them bonus days. */
function ReferralCard() {
  const { data } = useAsync(() => api<any>("/api/referral").catch(() => null), []);
  if (!data || !data.days_per_referral) return null;
  // Always the public site (inside the app the page itself runs on a local address).
  const link = `https://shayyek.sa/#/register?ref=${data.code}`;
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

/**
 * Upgrading to a higher plan, fully automatic: the price is the higher plan for the days left less what is left of
 * the current plan (its unused share), the customer pays it and the plan changes with the same expiry date.
 */
function UpgradeCard({ data, onPay }: { data: any; onPay: (r: { id: number; url: string }) => void }) {
  const { data: st } = useAsync(() => api<{ upgrade: any }>("/api/subscription/upgrade"), []);
  const current = data.plans?.find((p: any) => p.id === data.plan?.id);
  const higher = (data.plans ?? []).filter((p: any) => p.card_price && current?.card_price && p.card_price > current.card_price);
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const chosen = higher.find((p: any) => p.id === (target || higher[0]?.id));
  const { data: quote, error: quoteError } = useAsync(
    () => (chosen ? api<{ amount: number; days_left: number; used_messages: number; messages_limit: number | null; new_value: number; credit: number }>(`/api/subscription/upgrade/quote?plan_id=${encodeURIComponent(chosen.id)}`) : Promise.resolve(null)),
    [chosen?.id],
  );
  // The «upgraded» notice shows once per upgrade (remembered on this device) and hides after 15 seconds.
  const [seenBefore] = useState(() => { try { return Number(localStorage.getItem("upgrade_seen")) || 0; } catch { return 0; } });
  const [showDone, setShowDone] = useState(true);
  const doneId = st?.upgrade?.id as number | undefined;
  useEffect(() => {
    if (!doneId) return;
    try { localStorage.setItem("upgrade_seen", String(doneId)); } catch { /* private mode */ }
    const t = setTimeout(() => setShowDone(false), 15_000);
    return () => clearTimeout(t);
  }, [doneId]);
  const u = showDone && doneId && doneId !== seenBefore ? st?.upgrade : null;
  if (!higher.length && !u) return null;
  const pay = async () => {
    if (!chosen || !quote) return;
    const ok = await askConfirm({
      title: `ترقية إلى ${chosen.name}`,
      message: `تدفع ${quote.amount.toLocaleString("en-US")} ر.س عبر بوابة الدفع الآمنة، وتترقى باقتك فورًا بعد الدفع. تاريخ انتهاء اشتراكك يبقى نفسه.`,
      confirmLabel: "انتقل للدفع",
    });
    if (!ok) return;
    setBusy(true);
    try {
      onPay(await api<{ id: number; url: string }>("/api/subscription/upgrade", { body: { plan_id: chosen.id } }));
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  const sar = (v: number) => `${v.toLocaleString("en-US", { maximumFractionDigits: 2 })} ر.س`;
  return (
    <Card title="⬆️ ترقية الباقة">
      <div className="space-y-3">
        {u && <Alert tone="good">تمت ترقية باقتك إلى «{u.to_name ?? u.to_plan}».</Alert>}
        {higher.length > 0 && (
          <>
            <p className="muted text-sm">ترقَّ لباقة أعلى الحين بدون ما تنتظر انتهاء اشتراكك: تدفع <b>الفرق فقط</b> وتبقى نفس أيامك. ما تقدر تنزل لباقة أقل إلا بعد انتهاء اشتراكك.</p>
            <select className="input" value={target || higher[0].id} onChange={(e) => setTarget(e.target.value)} aria-label="الباقة الجديدة">
              {higher.map((p: any) => <option key={p.id} value={p.id}>{p.name} — {Number(p.card_price).toLocaleString("en-US")} ر.س</option>)}
            </select>
            {quoteError ? (
              <Alert tone="warn">{quoteError}</Alert>
            ) : !quote ? (
              <Spinner />
            ) : (
              <>
                <ul className="muted space-y-1 text-xs">
                  <li>الأيام الباقية: <b>{quote.days_left}</b> يوم (تبقى نفسها)</li>
                  <li>رسائل هذي الدورة: <b>{quote.used_messages.toLocaleString("en-US")}</b>{quote.messages_limit ? ` من ${quote.messages_limit.toLocaleString("en-US")}` : ""}</li>
                  <li>«{chosen.name}» للأيام الباقية: <b>{sar(quote.new_value)}</b> − المتبقي من باقتك: <b>{sar(quote.credit)}</b></li>
                </ul>
                <button className="btn btn-primary w-full" disabled={busy} onClick={pay}><Icon name="lock" size={17} />ادفع الفرق {sar(quote.amount)} وترقَّ الحين</button>
              </>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
