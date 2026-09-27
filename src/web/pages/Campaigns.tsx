import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Link, navigate } from "../App";
import { AR_LABELS } from "../../shared/states";
import { Alert, Badge, Empty, Modal, PageHeader, Spinner, toast, useAsync } from "../components/ui";

const TYPE_ICON: Record<string, string> = { comment: "💬", story_reply: "↩️", story_mention: "📣" };

/** "Copy to a new reel": same messages and settings, attached to the posts/reels picked here, active right away. */
function CopyToReelModal({ c, onClose, onDone }: { c: any; onClose: () => void; onDone: () => void }) {
  const [items, setItems] = useState<any[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [name, setName] = useState(`${c.name} — ريل جديد`);
  const [busy, setBusy] = useState(false);
  const [reelsOnly, setReelsOnly] = useState(true);
  const load = () => api("/api/media?kind=media").then((r) => setItems(r.items)).catch((e) => toast(e.message, "bad"));
  useEffect(() => {
    load();
  }, []);
  const refresh = async () => {
    setBusy(true);
    try {
      await api("/api/media/refresh", { body: { kind: "media" } });
      await load();
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  const list = (items ?? [])
    .filter((m) => !reelsOnly || m.media_product_type === "REELS")
    .sort((a, b) => (b.posted_at ?? 0) - (a.posted_at ?? 0))
    .slice(0, 60);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api(`/api/campaigns/${c.id}/duplicate`, { body: { media_ids: picked, name: name.trim() || undefined, activate: true } });
      toast("تم إنشاء الحملة وتفعيلها على الريل الجديد ✅");
      onDone();
      navigate(`/campaigns/${r.id}`);
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="🎬 نسخ الحملة لريل جديد">
      <p className="muted mb-3 text-sm">نفس الكلمات والرسائل والإعدادات، على المنشورات التي تختارها هنا، وتُفعَّل مباشرة. الحملة الأصلية تبقى كما هي.</p>
      <label className="mb-1 block text-sm font-semibold">اسم الحملة الجديدة</label>
      <input className="input mb-3" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <button className="btn btn-ghost text-sm" disabled={busy} onClick={refresh}>🔄 جلب أحدث المنشورات</button>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={reelsOnly} onChange={(e) => setReelsOnly(e.target.checked)} /> الريلز فقط</label>
        <span className="muted text-xs">اختيرت {picked.length}</span>
      </div>
      {!items ? (
        <Spinner />
      ) : !list.length ? (
        <p className="muted py-6 text-center text-sm">لا توجد عناصر — اضغط «جلب أحدث المنشورات».</p>
      ) : (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {list.map((m) => (
            <button
              key={m.media_id}
              type="button"
              onClick={() => toggle(m.media_id)}
              className={`relative aspect-[4/5] overflow-hidden rounded-lg border-2 ${picked.includes(m.media_id) ? "border-[var(--color-brand-500)]" : "border-transparent"}`}
              title={m.caption ?? ""}
            >
              {m.thumbnail_url ? (
                <img src={m.thumbnail_url} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full items-center justify-center bg-gradient-to-br from-violet-700 to-orange-500 text-2xl">🎬</div>
              )}
              {picked.includes(m.media_id) && <span className="absolute right-1 top-1 rounded-full bg-[var(--color-brand-500)] px-1.5 text-xs text-white">✓</span>}
              <span className="absolute inset-x-0 bottom-0 truncate bg-black/60 px-1 py-0.5 text-[10px] text-white">{m.caption || "بدون وصف"}</span>
            </button>
          ))}
        </div>
      )}
      <button className="btn btn-primary mt-4 w-full" disabled={busy || !picked.length} onClick={submit}>
        نسخ وتفعيل على {picked.length || "…"} منشور
      </button>
    </Modal>
  );
}

function CardMenu({ c, act, onCopy }: { c: any; act: (fn: () => Promise<unknown>, msg: string) => void; onCopy: () => void }) {
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
          <button role="menuitem" className={item} onClick={() => navigate(`/campaigns/${c.id}/stats`)}>📊 الإحصائيات</button>
          <button role="menuitem" className={item} onClick={() => navigate(`/campaigns/${c.id}/draws`)}>🎁 السحوبات</button>
          <button role="menuitem" className={item} onClick={() => navigate(`/campaigns/${c.id}`)}>✏️ تعديل</button>
          {c.status === "active" ? (
            <button role="menuitem" className={item} onClick={() => act(() => api(`/api/campaigns/${c.id}/status`, { body: { status: "paused" } }), "تم الإيقاف")}>⏸️ إيقاف</button>
          ) : (
            <button role="menuitem" className={item} onClick={() => act(() => api(`/api/campaigns/${c.id}/status`, { body: { status: "active" } }), "تم التفعيل")}>▶️ تشغيل</button>
          )}
          {c.type === "comment" && <button role="menuitem" className={item} onClick={() => { setOpen(false); onCopy(); }}>🎬 نسخ لريل جديد</button>}
          <button role="menuitem" className={item} onClick={() => act(() => api(`/api/campaigns/${c.id}/duplicate`, { body: {} }), "تم النسخ كمسودة")}>📄 نسخ كمسودة</button>
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
  const [copyFor, setCopyFor] = useState<any>(null);
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
      {copyFor && <CopyToReelModal c={copyFor} onClose={() => setCopyFor(null)} onDone={() => { setCopyFor(null); reload(); }} />}
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
                    👥 {c.people_count} شخص · ✅ {c.delivered_count} سُلّم
                  </div>
                </div>
                <button
                  className="surface-2 shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold hover:ring-1 hover:ring-[var(--color-brand-500)]"
                  title="الإحصائيات"
                  onClick={(e) => { e.stopPropagation(); navigate(`/campaigns/${c.id}/stats`); }}
                >📊 إحصائيات</button>
                <CardMenu c={c} act={act} onCopy={() => setCopyFor(c)} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
