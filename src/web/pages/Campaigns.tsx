import { useState } from "react";
import { api } from "../api";
import { Link, navigate } from "../App";
import { AR_LABELS } from "../../shared/states";
import { Alert, Badge, Card, Empty, PageHeader, Spinner, toast, useAsync } from "../components/ui";

export function CampaignsPage() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const { data, loading, error, reload } = useAsync(
    () => api<any[]>(`/api/campaigns?q=${encodeURIComponent(q)}&status=${status}&type=${type}`),
    [q, status, type],
  );

  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast(msg);
      reload();
    } catch (e: any) {
      toast(e.message, "bad");
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader title="الحملات" actions={<Link to="/campaigns/new" className="btn btn-primary">+ حملة جديدة</Link>} />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <input className="input" placeholder="بحث بالاسم…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="بحث" />
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="الحالة">
          <option value="">كل الحالات</option>
          <option value="active">نشطة</option>
          <option value="paused">متوقفة</option>
          <option value="draft">مسودة</option>
        </select>
        <select className="input" value={type} onChange={(e) => setType(e.target.value)} aria-label="النوع">
          <option value="">كل الأنواع</option>
          <option value="comment">تعليقات</option>
          <option value="story_reply">ردود الستوري</option>
          <option value="story_mention">منشن الستوري</option>
        </select>
      </div>
      {loading && !data ? (
        <Spinner />
      ) : error ? (
        <Alert tone="bad">{error}</Alert>
      ) : !data!.length ? (
        <Empty title="لا توجد حملات">أنشئ أول حملة، ثم جرّبها في المحاكاة قبل التفعيل.</Empty>
      ) : (
        <div className="space-y-3">
          {data!.map((c) => (
            <Card key={c.id}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="text-lg font-bold">{c.name}</div>
                  <div className="mt-1 flex flex-wrap gap-2 text-sm">
                    <Badge value={c.status} label={{ active: "نشطة", paused: "متوقفة", draft: "مسودة", archived: "مؤرشفة" }[c.status as string]} />
                    <span className="surface-2 rounded-full px-2.5 py-0.5 text-xs">{AR_LABELS[c.type]}</span>
                    {c.require_follow ? <span className="surface-2 rounded-full px-2.5 py-0.5 text-xs">🔒 يشترط المتابعة</span> : null}
                    <span className="muted text-xs">أولوية {c.priority}</span>
                  </div>
                  <div className="muted mt-1 text-sm">مسارات: {c.flows_count} · سُلّم المحتوى: {c.delivered_count}</div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {c.status === "active" ? (
                    <button className="btn btn-ghost" onClick={() => act(() => api(`/api/campaigns/${c.id}/status`, { body: { status: "paused" } }), "تم الإيقاف")}>إيقاف</button>
                  ) : (
                    <button className="btn btn-primary" onClick={() => act(() => api(`/api/campaigns/${c.id}/status`, { body: { status: "active" } }), "تم التفعيل")}>تشغيل</button>
                  )}
                  <button className="btn btn-ghost" onClick={() => navigate(`/campaigns/${c.id}`)}>تعديل</button>
                  <button className="btn btn-ghost" onClick={() => act(() => api(`/api/campaigns/${c.id}/duplicate`, { body: {} }), "تم النسخ كمسودة")}>نسخ</button>
                  <button
                    className="btn btn-ghost text-red-600"
                    onClick={() => confirm(`حذف «${c.name}»؟ ستُلغى مهامها المعلّقة.`) && act(() => api(`/api/campaigns/${c.id}`, { method: "DELETE" }), "تم الحذف")}
                  >
                    حذف
                  </button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
