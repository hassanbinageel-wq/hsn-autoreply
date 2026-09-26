import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Link, navigate } from "../App";
import { AR_LABELS } from "../../shared/states";
import { Alert, Badge, Empty, PageHeader, Spinner, toast, useAsync } from "../components/ui";

const TYPE_ICON: Record<string, string> = { comment: "💬", story_reply: "↩️", story_mention: "📣" };

function CardMenu({ c, act }: { c: any; act: (fn: () => Promise<unknown>, msg: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  const item = "block w-full px-4 py-2.5 text-right text-sm hover:bg-[var(--surface-2)]";
  return (
    <div className="relative" ref={ref}>
      <button className="muted rounded-lg px-2 py-1 text-lg" aria-label="خيارات" aria-haspopup="menu" onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>⋮</button>
      {open && (
        <div role="menu" className="card absolute bottom-9 left-0 z-20 w-44 overflow-hidden p-0 shadow-xl" onClick={(e) => e.stopPropagation()}>
          <button role="menuitem" className={item} onClick={() => navigate(`/campaigns/${c.id}`)}>✏️ تعديل</button>
          {c.status === "active" ? (
            <button role="menuitem" className={item} onClick={() => act(() => api(`/api/campaigns/${c.id}/status`, { body: { status: "paused" } }), "تم الإيقاف")}>⏸️ إيقاف</button>
          ) : (
            <button role="menuitem" className={item} onClick={() => act(() => api(`/api/campaigns/${c.id}/status`, { body: { status: "active" } }), "تم التفعيل")}>▶️ تشغيل</button>
          )}
          <button role="menuitem" className={item} onClick={() => act(() => api(`/api/campaigns/${c.id}/duplicate`, { body: {} }), "تم النسخ كمسودة")}>📄 نسخ</button>
          <button role="menuitem" className={`${item} text-red-600`} onClick={() => confirm(`حذف «${c.name}»؟ ستُلغى مهامها المعلّقة.`) && act(() => api(`/api/campaigns/${c.id}`, { method: "DELETE" }), "تم الحذف")}>🗑️ حذف</button>
        </div>
      )}
    </div>
  );
}

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
        <Empty title="لا توجد حملات">أنشئ أول حملة، ثم جرّبها في المعاينة قبل التفعيل.</Empty>
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
          <Link to="/campaigns/new" className="card flex min-h-[220px] flex-col items-center justify-center gap-2 border-dashed text-center hover:border-[var(--color-brand-500)]">
            <span className="text-4xl text-brand-600">+</span>
            <span className="font-bold">حملة جديدة</span>
          </Link>
          {data!.map((c) => (
            <div
              key={c.id}
              role="button"
              tabIndex={0}
              onClick={() => navigate(`/campaigns/${c.id}`)}
              onKeyDown={(e) => e.key === "Enter" && navigate(`/campaigns/${c.id}`)}
              className="card group flex cursor-pointer flex-col overflow-hidden p-0 transition hover:shadow-lg"
            >
              <div className="relative aspect-[4/3] w-full overflow-hidden bg-gradient-to-br from-violet-700 via-fuchsia-600 to-orange-500">
                {c.cover_url ? (
                  <img src={c.cover_url} alt="" loading="lazy" referrerPolicy="no-referrer" className={`h-full w-full object-cover transition group-hover:scale-105 ${c.status !== "active" ? "opacity-60 grayscale-[40%]" : ""}`} />
                ) : (
                  <div className="flex h-full items-center justify-center text-5xl opacity-90">{TYPE_ICON[c.type]}</div>
                )}
                <div className="absolute right-2 top-2">
                  <Badge value={c.status} label={{ active: "نشطة", paused: "متوقفة", draft: "مسودة", archived: "مؤرشفة" }[c.status as string]} />
                </div>
                {c.require_follow ? <span className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-xs text-white">🔒 متابعة</span> : null}
                {c.media_count > 1 && <span className="absolute bottom-2 left-2 rounded-full bg-black/60 px-2 py-0.5 text-xs text-white">+{c.media_count - 1}</span>}
              </div>
              <div className="flex items-center gap-2 p-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-bold">{c.name}</div>
                  <div className="muted truncate text-xs">
                    {TYPE_ICON[c.type]} {AR_LABELS[c.type]} · سُلّم {c.delivered_count}
                  </div>
                </div>
                <CardMenu c={c} act={act} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
