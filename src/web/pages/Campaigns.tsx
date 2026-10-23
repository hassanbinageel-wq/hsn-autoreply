import { useEffect, useRef, useState } from "react";
import { askConfirm } from "../components/Confirm";
import { api } from "../api";
import { Link, navigate } from "../App";
import { AR_LABELS } from "../../shared/states";
import { Alert, Badge, Modal, Spinner, toast, useAsync } from "../components/ui";
import { Icon } from "../components/Icon";

const TYPE_ICON: Record<string, string> = { comment: "msg", story_reply: "play", story_mention: "sparkle" };
const TYPE_GRAD: Record<string, string> = {
  comment: "linear-gradient(135deg,#7c3aed,#c026d3 60%,#f97316)",
  story_reply: "linear-gradient(135deg,#0ea5e9,#6366f1)",
  story_mention: "linear-gradient(135deg,#f97316,#e11d48)",
};

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
      <button className="btn btn-ghost min-h-9 px-2.5" aria-label="خيارات الحملة" aria-haspopup="menu" aria-expanded={open} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}><Icon name="more" size={18} /></button>
      {open && (
        <div role="menu" className="card absolute bottom-9 left-0 z-20 w-44 overflow-hidden p-0 shadow-xl" onClick={(e) => e.stopPropagation()}>
          <button role="menuitem" className={item} onClick={() => navigate(`/campaigns/${c.id}/stats`)}>📊 الإحصائيات</button>
          <button role="menuitem" className={item} onClick={() => navigate(`/campaigns/${c.id}`)}>✏️ تعديل</button>
          {c.status === "active" ? (
            <button role="menuitem" className={item} onClick={() => act(() => api(`/api/campaigns/${c.id}/status`, { body: { status: "paused" } }), "تم الإيقاف")}>⏸️ إيقاف</button>
          ) : (
            <button role="menuitem" className={item} onClick={() => act(() => api(`/api/campaigns/${c.id}/status`, { body: { status: "active" } }), "تم التفعيل")}>▶️ تشغيل</button>
          )}
          {c.type === "comment" && <button role="menuitem" className={item} onClick={() => { setOpen(false); onCopy(); }}>🎬 نسخ لريل جديد</button>}
          <button role="menuitem" className={item} onClick={() => act(() => api(`/api/campaigns/${c.id}/duplicate`, { body: {} }), "تم النسخ كمسودة")}>📄 نسخ كمسودة</button>
          <button role="menuitem" className={`${item} text-red-600`} onClick={async () => { setOpen(false); (await askConfirm({ title: `حذف «${c.name}»؟`, message: "تنحذف الحملة وتُلغى رسائلها المعلّقة.", confirmLabel: "حذف الحملة", danger: true })) && act(() => api(`/api/campaigns/${c.id}`, { method: "DELETE" }), "تم الحذف"); }}>🗑️ حذف</button>
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
  // Card size (min card width in px), remembered on this device.
  const [size, setSize] = useState(() => {
    try {
      return Number(localStorage.getItem("hsn.campaignCardSize")) || 320;
    } catch {
      return 320;
    }
  });
  const changeSize = (v: number) => {
    setSize(v);
    try {
      localStorage.setItem("hsn.campaignCardSize", String(v));
    } catch {
      /* storage unavailable */
    }
  };
  // Phones: two campaigns per row (compact cards); the size slider is for larger screens.
  const [phone, setPhone] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 639px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const on = () => setPhone(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const compact = phone || size < 250;
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
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <div>
            <h1 className="text-2xl font-extrabold leading-tight sm:text-[26px]">الحملات</h1>
            {data && <p className="muted mt-1 text-sm">{data.length} حملة · {data.filter((c) => c.status === "active").length} نشطة</p>}
          </div>
          <label className="hidden items-center gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 sm:flex" title="حجم بطاقات الحملات">
            <Icon name="grid" size={15} className="muted" />
            <input
              type="range"
              min={200}
              max={460}
              step={10}
              value={size}
              onChange={(e) => changeSize(Number(e.target.value))}
              aria-label="حجم بطاقات الحملات"
              className="size-range w-28 sm:w-36"
            />
            <Icon name="image" size={19} className="muted" />
          </label>
        </div>
        <Link to="/campaigns/new" className="btn btn-primary"><Icon name="plus" size={18} />حملة جديدة</Link>
      </header>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
          <Icon name="search" size={17} className="muted absolute right-3 top-1/2 -translate-y-1/2" />
          <input className="input pr-10" placeholder="بحث بالاسم…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="بحث" />
        </div>
        <div className="seg max-w-full overflow-x-auto" role="group" aria-label="تصفية حسب الحالة">
          {[["", "الكل"], ["active", "نشطة"], ["paused", "متوقفة"], ["draft", "مسودة"]].map(([v, l]) => (
            <button key={v} type="button" aria-pressed={status === v} className={status === v ? "on" : ""} onClick={() => setStatus(v)}>{l}</button>
          ))}
        </div>
        <div className="seg max-w-full overflow-x-auto" role="group" aria-label="تصفية حسب النوع">
          {[["", "كل الأنواع"], ["comment", "تعليقات"], ["story_reply", "ردود ستوري"], ["story_mention", "منشن"]].map(([v, l]) => (
            <button key={v} type="button" aria-pressed={type === v} className={type === v ? "on" : ""} onClick={() => setType(v)}>{l}</button>
          ))}
        </div>
      </div>
      {loading && !data ? (
        <Spinner />
      ) : error ? (
        <Alert tone="bad">{error}</Alert>
      ) : !data!.length ? (
        <div className="grid max-w-md">
          <Link to="/campaigns/new" className="flex min-h-[180px] flex-col items-center sm:min-h-[220px] justify-center gap-2 rounded-2xl border-2 border-dashed border-[var(--border)] text-center transition hover:border-violet-400">
            <span className="grad flex h-14 w-14 items-center justify-center rounded-2xl text-white shadow-lg shadow-violet-500/30"><Icon name="plus" size={26} /></span>
            <b className="font-display mt-2 text-base">لا توجد حملات — أنشئ أول حملة</b>
            <span className="muted text-xs">ابدأ واختبرها في المحاكاة قبل التفعيل</span>
          </Link>
        </div>
      ) : (
        <div className="grid gap-3 sm:gap-4" style={{ gridTemplateColumns: phone ? "repeat(2, minmax(0, 1fr))" : `repeat(auto-fill, minmax(min(100%, ${size}px), 1fr))` }}>
          {data!.map((c) => {
            const rate = c.people_count ? Math.round((c.delivered_count / c.people_count) * 100) : null;
            return (
              // The name is the card's link and stretches over the whole card; the buttons sit above it.
              <div key={c.id} className="card group relative flex flex-col overflow-hidden transition hover:-translate-y-0.5 hover:shadow-xl">
                <div className="relative w-full overflow-hidden" style={{ background: TYPE_GRAD[c.type], height: phone ? 92 : Math.round(size * 0.45) }}>
                  {c.cover_url && <img src={c.cover_url} alt="" loading="lazy" referrerPolicy="no-referrer" className={`h-full w-full object-cover transition group-hover:scale-105 ${c.status !== "active" ? "opacity-60 grayscale-[40%]" : ""}`} />}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-transparent" />
                  <div className={`absolute ${phone ? "right-2 top-2 origin-top-right scale-90" : "right-3 top-3"}`}>
                    <span className="rounded-full bg-white/95 px-0.5 py-0.5 dark:bg-black/60"><Badge value={c.status} label={{ active: "نشطة", paused: "متوقفة", draft: "مسودة", archived: "مؤرشفة" }[c.status as string]} /></span>
                  </div>
                  <span className={`absolute flex items-center justify-center rounded-xl bg-white/20 text-white backdrop-blur ${phone ? "left-2 top-2 h-7 w-7" : "left-3 top-3 h-9 w-9"}`}><Icon name={TYPE_ICON[c.type]} size={phone ? 15 : 18} /></span>
                  <div className="absolute bottom-3 right-3 flex flex-wrap gap-1.5">
                    {c.follow_invite && !compact ? <span className="chip bg-black/40 text-white"><Icon name="userplus" size={12} />دعوة للمتابعة</span> : null}
                    {c.media_count > 1 && !compact && <span className="chip bg-black/40 text-white">{c.media_count} منشورات</span>}
                  </div>
                </div>
                <div className={`flex flex-1 flex-col ${phone ? "p-2.5" : compact ? "p-3" : "p-4"}`}>
                  <Link to={`/campaigns/${c.id}`} className={`font-display truncate font-extrabold after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:rounded-2xl focus-visible:after:ring-2 focus-visible:after:ring-violet-500 ${phone ? "text-[13px]" : "text-[15px]"}`}>{c.name}</Link>
                  <span className="muted text-[11px] sm:text-xs">{AR_LABELS[c.type] ?? c.type}</span>
                  <div className={`grid grid-cols-3 ${phone ? "mt-2 gap-1 text-[10px]" : "mt-3 gap-2 text-xs"}`}>
                    <div><b className={`font-display block ${phone ? "text-sm" : "text-base"}`}>{c.people_count}</b><span className="muted">شخص</span></div>
                    <div><b className={`font-display block ${phone ? "text-sm" : "text-base"}`}>{c.delivered_count}</b><span className="muted">سُلِّم</span></div>
                    <div><b className={`font-display block ${phone ? "text-sm" : "text-base"}`}>{rate == null ? "—" : `${rate}%`}</b><span className="muted">{phone ? "التسليم" : "نسبة التسليم"}</span></div>
                  </div>
                  <div className={`relative z-10 flex gap-1.5 ${phone ? "mt-2" : "mt-3 gap-2"}`}>
                    <button className="btn btn-ghost min-h-9 flex-1 text-xs" aria-label={`إحصائيات ${c.name}`} onClick={(e) => { e.stopPropagation(); navigate(`/campaigns/${c.id}/stats`); }}>
                      <Icon name="eye" size={16} />{!compact && "الإحصائيات"}
                    </button>
                    <CardMenu c={c} act={act} onCopy={() => setCopyFor(c)} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
