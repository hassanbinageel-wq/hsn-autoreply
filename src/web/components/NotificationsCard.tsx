import { useEffect, useState } from "react";
import { api } from "../api";
import { Alert, Card, Field, Spinner, Toggle, toast } from "./ui";
import { Icon } from "./Icon";

/**
 * Telegram notifications: the owner creates a bot with @BotFather, pastes its token here (stored encrypted on the
 * server, never shown again), sends /start to the bot, then taps "detect" so the server learns the chat id.
 */
export function NotificationsCard() {
  const [s, setS] = useState<any>(null);
  const [hasToken, setHasToken] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api("/api/notifications")
      .then((r) => {
        setS(r.settings);
        setHasToken(r.has_token);
      })
      .catch((e) => toast(e.message, "bad"));
  }, []);

  const save = async (patch: Record<string, unknown>, msg = "تم الحفظ") => {
    setBusy(true);
    try {
      const r = await api("/api/notifications", { method: "PUT", body: patch });
      setS(r.settings);
      setHasToken(r.has_token);
      toast(msg);
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  const run = async (path: string, body: unknown, msg: string) => {
    setBusy(true);
    try {
      const r = await api(path, { body });
      if (r.settings) setS(r.settings);
      toast(r.name ? `${msg} (${r.name})` : msg);
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };

  if (!s) return <Card title="إشعارات تيليجرام"><Spinner /></Card>;
  const ready = hasToken && !!s.chat_id;

  return (
    <Card
      title="إشعارات تيليجرام"
      className="h-full"
      action={hasToken ? <span className={`chip ${ready ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" : "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"}`}><span className="h-1.5 w-1.5 rounded-full bg-current" />{ready ? "البوت مضبوط" : "حدّد المحادثة"}</span> : <span className="chip surface-2 muted">غير مضبوط</span>}
    >
      {!hasToken ? (
        <div className="space-y-3">
          <Alert tone="info">
            الإشعارات تصلك عبر بوت تيليجرام خاص بك (مجاني):
            <br />1) افتح تيليجرام وابحث عن <b dir="ltr">@BotFather</b> ← أرسل <b dir="ltr">/newbot</b> واختر اسمًا للبوت.
            <br />2) سيعطيك «توكن» — انسخه والصقه هنا (يُحفظ مشفّرًا على الخادم ولا يظهر مرة أخرى، ولا ترسله لأي أحد).
            <br />3) افتح البوت الجديد واضغط <b>Start</b>، ثم ارجع واضغط «اكتشاف المحادثة».
          </Alert>
          <Field label="توكن البوت">
            <input className="input" dir="ltr" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value.trim())} placeholder="123456789:AA..." />
          </Field>
          <button className="btn btn-primary" disabled={busy || !token} onClick={() => save({ bot_token: token }, "تم حفظ التوكن").then(() => setToken(""))}>
            حفظ التوكن
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {!s.chat_id && <Alert tone="warn">لم تُحدَّد المحادثة بعد — افتح البوت واضغط Start ثم «اكتشاف المحادثة».</Alert>}
          <Toggle checked={!!s.enabled} onChange={(v) => save({ enabled: v })} label="تفعيل الإشعارات" description="رئيسي: بدونه لا يُرسل أي إشعار" disabled={!ready || busy} />
          {s.enabled && (
            <div className="divide-y divide-[var(--border)] border-t border-[var(--border)] [&>*]:py-2">
              <Toggle checked={s.daily_report} onChange={(v) => save({ daily_report: v })} label="التقرير اليومي" description="ملخص آخر 24 ساعة: تعليقات، أشخاص، متابعون جدد، من استلم المحتوى، من ضغط الرابط، وأنشط الحملات." />
              {s.daily_report && (
                <Field label="ساعة إرسال التقرير">
                  <select className="input max-w-xs" value={s.report_hour} onChange={(e) => save({ report_hour: Number(e.target.value) })}>
                    {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
                  </select>
                </Field>
              )}
              <Toggle checked={s.alert_reauth} onChange={(v) => save({ alert_reauth: v })} label="تنبيه عند انقطاع ربط إنستقرام" description="حتى تعيد الربط بسرعة ولا تتوقف الردود." />
              <Toggle checked={s.alert_failures} onChange={(v) => save({ alert_failures: v })} label="تنبيه عند فشل عدة رسائل" description="3 رسائل أو أكثر فشلت خلال ساعة (مرة كل 3 ساعات كحد أقصى)." />
              <Toggle checked={s.alert_usage !== false} onChange={(v) => save({ alert_usage: v })} label="تنبيه عند الاقتراب من الحد المجاني (80%)" description="تقديري، مرة كل 12 ساعة كحد أقصى." />
              <Toggle checked={s.alert_spike} onChange={(v) => save({ alert_spike: v })} label="تنبيه التفاعل الكبير" description={`عندما يتفاعل ${s.spike_per_hour} شخصًا أو أكثر خلال ساعة.`} />
              {s.alert_spike && (
                <Field label="حد التفاعل الكبير (أشخاص في الساعة)">
                  <input className="input max-w-xs" type="number" min={5} defaultValue={s.spike_per_hour} onBlur={(e) => Number(e.target.value) !== s.spike_per_hour && save({ spike_per_hour: Number(e.target.value) })} />
                </Field>
              )}
              <Toggle checked={s.notify_new_follower} onChange={(v) => save({ notify_new_follower: v })} label="إشعار لكل متابع جديد" description="رسالة عند كل شخص يتابعك عبر الحملات (قد تكون كثيرة)." />
              <Toggle checked={s.notify_delivery} onChange={(v) => save({ notify_delivery: v })} label="إشعار لكل تسليم محتوى" description="رسالة عند كل شخص يستلم المحتوى (قد تكون كثيرة جدًا)." />
            </div>
          )}
          <div className="flex flex-wrap gap-2 border-t border-[var(--border)] pt-4">
            <button className="btn btn-ghost text-sm" disabled={busy || !ready} onClick={() => run("/api/notifications/test", { kind: "test" }, "أُرسلت رسالة تجريبية")}><Icon name="send" size={16} />رسالة تجريبية</button>
            <button className="btn btn-ghost text-sm" disabled={busy || !ready} onClick={() => run("/api/notifications/test", { kind: "report" }, "أُرسل التقرير")}>أرسل التقرير الآن</button>
            <button className="btn btn-ghost text-sm" disabled={busy} onClick={() => run("/api/notifications/detect", {}, "تم ربط المحادثة")}><Icon name="search" size={16} />اكتشاف المحادثة</button>
            <button className="btn btn-ghost text-sm text-red-600" disabled={busy} onClick={() => confirm("إزالة البوت وإيقاف الإشعارات؟") && save({ bot_token: "", enabled: false }, "أُزيل البوت")}>إزالة البوت</button>
          </div>
        </div>
      )}
    </Card>
  );
}
