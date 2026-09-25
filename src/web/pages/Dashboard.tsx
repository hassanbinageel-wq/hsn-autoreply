import { useState } from "react";
import { api } from "../api";
import { Link } from "../App";
import { Alert, Badge, Card, PageHeader, Spinner, Stat, Toggle, toast, useAsync, fmtTime } from "../components/ui";

type Row = { n: number; [k: string]: any };
const sum = (rows: Row[] | undefined, pred: (r: Row) => boolean) => (rows ?? []).filter(pred).reduce((a, r) => a + r.n, 0);

export function DashboardPage() {
  const [days, setDays] = useState(30);
  const { data, loading, error, reload } = useAsync(() => api("/api/dashboard?days=" + days), [days]);
  const [busy, setBusy] = useState(false);

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

  return (
    <div className="space-y-4">
      <PageHeader
        title="لوحة التحكم"
        subtitle="الإحصاءات تستثني بيانات وضع التجربة"
        actions={
          <select className="input w-auto" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="المدة">
            <option value={1}>آخر 24 ساعة</option>
            <option value={7}>آخر 7 أيام</option>
            <option value={30}>آخر 30 يومًا</option>
            <option value={90}>آخر 90 يومًا</option>
          </select>
        }
      />

      <Card>
        <Toggle
          checked={!!d.automation_enabled}
          onChange={toggleAutomation}
          disabled={busy}
          label={d.automation_enabled ? "الأتمتة تعمل ✅" : "الأتمتة متوقفة ⏸️"}
          description="إيقاف شامل: يوقف معالجة الأحداث الجديدة ويلغي الرسائل المعلّقة."
        />
      </Card>

      <Card title="حالة الربط" action={<Link to="/connection" className="btn btn-ghost min-h-10 text-sm">إدارة</Link>}>
        {acc && acc.status !== "disconnected" ? (
          <div className="flex flex-wrap items-center gap-3">
            {acc.profile_picture_url && <img src={acc.profile_picture_url} alt="" className="h-12 w-12 rounded-full" referrerPolicy="no-referrer" />}
            <div>
              <div className="font-bold">@{acc.username}</div>
              <div className="flex flex-wrap gap-2 text-sm">
                <Badge value={acc.status} label={acc.status === "active" ? "مفوَّض" : undefined} />
                <Badge value={acc.webhook_status} label={`Webhooks: ${acc.webhook_status}`} />
                <span className="muted">آخر حدث: {fmtTime(acc.last_webhook_at)}</span>
              </div>
            </div>
          </div>
        ) : (
          <Alert tone="warn">لا يوجد حساب إنستقرام متصل. الأتمتة لن تعمل قبل الربط الرسمي عبر Meta.</Alert>
        )}
      </Card>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="الحملات النشطة" value={d.campaigns?.active ?? 0} hint={`${d.campaigns?.paused ?? 0} متوقفة · ${d.campaigns?.draft ?? 0} مسودة`} />
        <Stat label="تعليقات مستلمة" value={sum(ev, (r) => r.event_type === "comment")} />
        <Stat label="ردود ستوري" value={sum(ev, (r) => r.event_type === "story_reply")} />
        <Stat label="منشن ستوري" value={sum(ev, (r) => r.event_type === "story_mention")} />
        <Stat label="رسائل قبلت Meta إرسالها" value={sum(jobs, (r) => r.kind === "send_message" && r.status === "accepted")} hint="قبول الطلب ≠ قراءة الرسالة" tone="good" />
        <Stat label="محتوى سُلِّم بطلب ناجح" value={sum(flows, (r) => r.state === "content_sent")} tone="good" />
        <Stat label="بانتظار التفاعل" value={sum(flows, (r) => r.state === "awaiting_user_interaction")} tone="warn" />
        <Stat label="بانتظار المتابعة" value={sum(flows, (r) => r.state === "awaiting_follow")} tone="warn" />
        <Stat label="حالات متابعة تم التحقق منها" value={d.follows?.verified ?? 0} hint="ليست «متابعين جدد» بالضرورة" />
        <Stat label="ردود عامة مقبولة" value={sum(jobs, (r) => r.kind === "public_reply" && r.status === "accepted")} />
        <Stat label="فشل" value={sum(jobs, (r) => r.status === "failed")} tone="bad" />
        <Stat label="معلّقة / غير مؤكدة" value={`${sum(jobs, (r) => ["pending", "retry_scheduled", "processing"].includes(r.status))} / ${sum(jobs, (r) => r.status === "uncertain")}`} hint="غير المؤكدة تحتاج مراجعة يدوية" tone="warn" />
      </div>
    </div>
  );
}
