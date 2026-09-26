import { useState } from "react";
import { api, download } from "../api";
import { AR_LABELS } from "../../shared/states";
import { Alert, Badge, Card, Empty, Modal, PageHeader, Spinner, fmtTime, toast, useAsync } from "../components/ui";

type Tab = "events" | "flows" | "jobs";

export const REASONS: Record<string, string> = {
  campaign_matched: "طابق حملة",
  no_keyword_match: "لا توجد كلمة مطابقة",
  excluded_keyword: "كلمة استثناء",
  threaded_reply_excluded: "رد متفرع غير مشمول",
  own_account: "من حسابك نفسه",
  message_echo: "صدى رسالة مرسلة (echo)",
  event_before_activation: "أقدم من وقت التفعيل",
  media_not_in_scope: "المنشور خارج نطاق الحملة",
  no_active_campaign: "لا توجد حملة نشطة لهذا النوع",
  no_matching_campaign: "لم تطابق أي حملة",
  max_deliveries_reached: "بلغ حد التسليم للمستخدم",
  user_cooldown: "ضمن فترة الانتظار للمستخدم",
  user_hourly_limit: "تجاوز حد الساعة للمستخدم",
  flow_already_open: "يوجد مسار مفتوح لنفس المستخدم",
  plain_message_no_trigger: "رسالة عادية بدون مسار",
  verify_cooldown: "طلب تحقق خلال فترة الانتظار",
  verify_attempts_exceeded: "تجاوز حد محاولات التحقق",
  invalid_button_token: "زر غير صالح لهذا المستخدم",
  automation_paused: "الأتمتة متوقفة",
  unsupported_event: "حدث غير مدعوم",
  reaction_not_a_trigger: "تفاعل إيموجي — ليس مشغلًا",
  flow_start: "بدأ التحقق بعد تفاعل المستخدم",
  verify_requested: "طلب تحقق جديد",
  story_not_identifiable: "لا يمكن تحديد الستوري",
  unknown_account: "حساب غير معروف",
};

export function LogsPage() {
  const [tab, setTab] = useState<Tab>("events");
  const [status, setStatus] = useState("");
  const [demo, setDemo] = useState("0");
  const [days, setDays] = useState("7");
  const [flowId, setFlowId] = useState<number | null>(null);
  const statusKey = tab === "flows" ? "state" : "status";
  const { data, loading, error, reload } = useAsync(
    () => api<any[]>(`/api/logs/${tab}?${statusKey}=${status}&demo=${demo}&days=${days}`),
    [tab, status, demo, days],
  );
  const statuses =
    tab === "events" ? ["pending", "processed", "ignored", "failed"] : tab === "jobs" ? ["pending", "processing", "accepted", "retry_scheduled", "uncertain", "failed", "cancelled"] : ["awaiting_user_interaction", "checking_follow", "awaiting_follow", "delivering", "content_sent", "verification_unavailable", "expired", "failed", "cancelled"];

  return (
    <div className="space-y-4">
      <PageHeader
        title="سجل العمليات"
        actions={<button className="btn btn-ghost" onClick={() => download(`/api/logs/export?type=${tab}`, `hsn-${tab}.csv`).catch((e) => toast(e.message, "bad"))}>تصدير CSV</button>}
      />
      <div className="flex gap-2" role="tablist">
        {(["events", "flows", "jobs"] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`btn ${tab === t ? "btn-primary" : "btn-ghost"}`} onClick={() => { setTab(t); setStatus(""); }}>
            {{ events: "الأحداث", flows: "المسارات", jobs: "الإجراءات" }[t]}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2">
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="الحالة">
          <option value="">كل الحالات</option>
          {statuses.map((s) => <option key={s} value={s}>{AR_LABELS[s] ?? s}</option>)}
        </select>
        <select className="input" value={demo} onChange={(e) => setDemo(e.target.value)} aria-label="المصدر">
          <option value="0">الإنتاج</option>
          <option value="1">التجربة</option>
          <option value="">الكل</option>
        </select>
        <select className="input" value={days} onChange={(e) => setDays(e.target.value)} aria-label="المدة">
          <option value="1">24 ساعة</option>
          <option value="7">7 أيام</option>
          <option value="30">30 يومًا</option>
          <option value="">الكل</option>
        </select>
      </div>

      {loading && !data ? <Spinner /> : error ? <Alert tone="bad">{error}</Alert> : !data!.length ? <Empty title="لا توجد سجلات" /> : (
        <div className="space-y-2">
          {tab === "events" && data!.map((e) => (
            <Card key={e.id} className="p-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge value={e.status} /> <b>{AR_LABELS[e.event_type] ?? e.event_type}</b>
                {e.sender_username && <span dir="ltr">@{e.sender_username}</span>}
                {e.is_demo ? <span className="surface-2 rounded-full px-2 text-xs">تجريبي</span> : null}
                <span className="muted mr-auto text-xs">{fmtTime(e.received_at)}</span>
              </div>
              {e.text && <div className="mt-1 text-sm">«{e.text}»</div>}
              <div className="muted mt-1 text-xs">السبب: {REASONS[e.reason?.split(" ")[0]] ?? e.reason ?? "—"} {e.campaign_id ? `· حملة #${e.campaign_id}` : ""}</div>
              {e.flow_id && <button className="mt-1 text-sm font-semibold text-brand-700 underline dark:text-brand-500" onClick={() => setFlowId(e.flow_id)}>عرض المسار #{e.flow_id}</button>}
            </Card>
          ))}
          {tab === "flows" && data!.map((f) => (
            <Card key={f.id} className="p-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge value={f.state} /> <b>{f.campaign_name ?? `#${f.campaign_id}`}</b>
                {f.username && <span dir="ltr">@{f.username}</span>}
                <span className="muted mr-auto text-xs">{fmtTime(f.updated_at)}</span>
              </div>
              <div className="muted mt-1 flex flex-wrap gap-3 text-xs">
                <span>رد خاص: {AR_LABELS[f.private_reply_status] ?? f.private_reply_status ?? "—"}</span>
                <span>رد عام: {AR_LABELS[f.public_reply_status] ?? f.public_reply_status ?? "—"}</span>
                <span>المحتوى: {AR_LABELS[f.content_status] ?? f.content_status ?? "—"}</span>
                <span>التحقق: {AR_LABELS[f.last_follow_result] ?? f.last_follow_result ?? "—"} ({f.verify_attempts} محاولة) · آخر فحص {fmtTime(f.last_check_at)}</span>
              </div>
              <button className="mt-1 text-sm font-semibold text-brand-700 underline dark:text-brand-500" onClick={() => setFlowId(f.id)}>التفاصيل</button>
            </Card>
          ))}
          {tab === "jobs" && data!.map((j) => (
            <Card key={j.id} className="p-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge value={j.status} /> <b>{j.kind}</b> {j.purpose && <span className="muted">({j.purpose})</span>}
                <span className="muted">محاولات {j.attempts}/{j.max_attempts}</span>
                <span className="muted mr-auto text-xs">{fmtTime(j.updated_at)}</span>
              </div>
              {j.last_error && <div className="mt-1 text-xs text-red-600">{j.last_error}</div>}
              {j.status === "uncertain" && <UncertainActions id={j.id} onDone={reload} />}
            </Card>
          ))}
        </div>
      )}
      <FlowModal id={flowId} onClose={() => setFlowId(null)} onChange={reload} />
    </div>
  );
}

function UncertainActions({ id, onDone }: { id: number; onDone: () => void }) {
  const act = async (action: string, msg: string) => {
    if (action === "retry" && !confirm("إعادة الإرسال قد تُنتج رسالة مكررة إن كانت الأولى وصلت. هل تحققت من المحادثة في إنستقرام؟")) return;
    try {
      await api(`/api/jobs/${id}/resolve`, { body: { action } });
      toast(msg);
      onDone();
    } catch (e: any) {
      toast(e.message, "bad");
    }
  };
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      <span className="muted text-xs">نتيجة غير مؤكدة — راجع المحادثة في إنستقرام ثم:</span>
      <button className="btn btn-ghost min-h-9 text-xs" onClick={() => act("mark_accepted", "تم التعليم كمرسلة")}>وصلت</button>
      <button className="btn btn-ghost min-h-9 text-xs" onClick={() => act("mark_failed", "تم التعليم كفاشلة")}>لم تصل</button>
      <button className="btn btn-ghost min-h-9 text-xs" onClick={() => act("retry", "أعيدت الجدولة")}>إعادة المحاولة</button>
    </div>
  );
}

function FlowModal({ id, onClose, onChange }: { id: number | null; onClose: () => void; onChange: () => void }) {
  const { data, loading } = useAsync(() => (id ? api(`/api/flows/${id}`) : Promise.resolve(null)), [id]);
  return (
    <Modal open={!!id} onClose={onClose} title={`المسار #${id}`}>
      {loading || !data ? <Spinner /> : (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap gap-2"><Badge value={data.flow.state} /> <span dir="ltr">@{data.flow.username ?? data.flow.igsid}</span> <span className="muted">{data.flow.state_reason}</span></div>
          <h3 className="font-bold">فحوص المتابعة</h3>
          {data.checks.length ? data.checks.map((c: any) => (
            <div key={c.id}><Badge value={c.result} /> <span className="muted">{fmtTime(c.checked_at)} · HTTP {c.http_status ?? "—"} {c.error_code ? `· code ${c.error_code}` : ""} · الحقل {c.field_present ? "موجود" : "غير موجود"}</span></div>
          )) : <div className="muted">لا يوجد</div>}
          <h3 className="font-bold">الإجراءات</h3>
          {data.jobs.map((j: any) => (
            <div key={j.id} className="surface-2 rounded-lg p-2">
              <Badge value={j.status} /> <b>{j.kind}</b> <span className="muted">{j.purpose}</span> · محاولات {j.attempts}
              {j.last_error && <div className="text-xs text-red-600">{j.last_error}</div>}
              {j.status === "uncertain" && <UncertainActions id={j.id} onDone={onChange} />}
            </div>
          ))}
          <h3 className="font-bold">المحاولات</h3>
          {data.attempts.map((a: any) => (
            <div key={a.id} className="muted text-xs">#{a.job_id}/{a.attempt_no} · {a.outcome} · HTTP {a.http_status ?? "—"} {a.error_message ?? ""} · {fmtTime(a.started_at)}</div>
          ))}
        </div>
      )}
    </Modal>
  );
}
