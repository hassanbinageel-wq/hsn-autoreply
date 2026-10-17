import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "../App";
import { Icon } from "../components/Icon";
import { api, authedObjectUrl, uploadFile } from "../api";
import { DateTimeField } from "../components/DateTimeField";
import { askConfirm } from "../components/Confirm";
import { Alert, Card, Field, Modal, PageHeader, Spinner, Toggle, fmtDate, fmtTime, toast, useAsync } from "../components/ui";

/**
 * Scheduled publishing through Meta's official Content Publishing API. The server keeps the time and publishes;
 * files stay in private storage until the post is live, then they are deleted. Campaign start/end times are
 * shown at the bottom (they already worked before publishing existed).
 */

type Kind = "IMAGE" | "CAROUSEL" | "REELS" | "STORY";
type View = "month" | "week" | "list";
const DAY = 86_400_000;
const KIND_LABEL: Record<Kind, string> = { IMAGE: "منشور صورة", CAROUSEL: "منشور متعدد", REELS: "ريل", STORY: "ستوري" };
const KIND_SHORT: Record<Kind, string> = { IMAGE: "صورة", CAROUSEL: "متعدد", REELS: "ريل", STORY: "ستوري" };
const STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: "مسودة", cls: "surface-2 muted" },
  scheduled: { label: "مجدول", cls: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300" },
  publishing: { label: "جاري النشر", cls: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300" },
  uncertain: { label: "نتحقق من Meta", cls: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300" },
  published: { label: "منشور", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" },
  failed: { label: "فشل", cls: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300" },
  cancelled: { label: "ملغي", cls: "surface-2 muted line-through" },
};
const WEEKDAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const MONTH = new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-latn", { month: "long", year: "numeric", timeZone: "UTC" });
const HM = new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-latn", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });

/** Wall-clock string in the customer's zone ↔ epoch ms. */
const toLocal = (ms: number, off: number) => new Date(ms + off * 60_000).toISOString().slice(0, 16);
const fromLocal = (s: string, off: number) => Date.parse(`${s}:00Z`) - off * 60_000;
/** Day index (days since epoch) of a time in the customer's zone. */
const dayOf = (ms: number, off: number) => Math.floor((ms + off * 60_000) / DAY);

function StatusChip({ s }: { s: string }) {
  const x = STATUS[s] ?? STATUS.draft;
  return <span className={`chip ${x.cls}`}>{x.label}</span>;
}

export function SchedulePage() {
  const { data: meta, reload: reloadMeta } = useAsync(() => api<any>("/api/schedule/meta"), []);
  const ready = meta && meta.plan && meta.granted && meta.storage;
  return (
    <div className="space-y-5">
      <PageHeader title="الجدولة" subtitle="جدولة نشر المنشورات والريلز والستوري على حسابك، وجدولة الحملات." />
      {!meta ? <Spinner /> : ready ? <Planner meta={meta} /> : <PublishSetup meta={meta} onChanged={reloadMeta} />}
      <ScheduledCampaigns />
    </div>
  );
}

/** What is missing before publishing can work, in order. */
function PublishSetup({ meta, onChanged }: { meta: any; onChanged: () => void }) {
  return (
    <Card title="جدولة نشر المحتوى" action={<span className="chip bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">غير مفعّلة بعد</span>}>
      <div className="space-y-3 text-sm">
        <p>نشر بوست بصورة، أو منشور متعدد، أو ريل، أو ستوري في وقت تحدده — والنظام ينشره عبر واجهة Meta الرسمية، ويقدر يشغّل حملة على المنشور أول ما ينتشر.</p>
        {!meta.plan ? (
          <Alert tone="warn">باقتك لا تشمل جدولة النشر — رقِّ باقتك من صفحة «اشتراكي».</Alert>
        ) : !meta.connected ? (
          <Alert tone="warn">اربط حساب إنستقرام أولًا من <Link to="/connection" className="font-semibold underline">صفحة الربط</Link>.</Alert>
        ) : !meta.granted ? (
          <Alert tone="info">
            صلاحية النشر <span dir="ltr">(instagram_business_content_publish)</span> غير مفعّلة على حسابك.
            {meta.requested ? <> هي مطلوبة الحين عند الربط — <Link to="/connection" className="font-semibold underline">أعد ربط الحساب</Link> ووافق عليها.</> : " تواصل مع إدارة الخدمة لتفعيلها."}
          </Alert>
        ) : !meta.storage ? (
          <Alert tone="warn">مساحة حفظ الملفات غير مفعّلة على الخادم بعد.</Alert>
        ) : null}
        <ul className="muted list-disc space-y-1 pr-5">
          <li>Meta تحدد عدد المنشورات عبر الواجهة خلال 24 ساعة لكل حساب، والنظام يتحقق من الحد قبل كل نشر.</li>
          <li>الصور تتحول تلقائيًا لصيغة JPEG (الصيغة الوحيدة اللي تقبلها Meta). الفيديو MP4 أو MOV حتى 95 ميجا.</li>
          <li>الملفات تنحفظ بشكل خاص وتنحذف تلقائيًا بعد النشر.</li>
        </ul>
        {meta.scope_mode !== undefined && <ScopeControl mode={meta.scope_mode} onChanged={onChanged} />}
      </div>
    </Card>
  );
}

function ScopeControl({ mode, onChanged }: { mode: "off" | "owner" | "all"; onChanged: () => void }) {
  const set = async (m: "off" | "owner" | "all") => {
    if (m !== "off" && !(await askConfirm({
      title: "طلب صلاحية النشر عند الربط؟",
      message: "لازم تكون صلاحية instagram_business_content_publish مضافة لتطبيقك في لوحة Meta، وإلا بيفشل الربط.\n\nقبل موافقة Meta في مراجعة التطبيق، تشتغل فقط للحسابات اللي لها دور في التطبيق (مثل حسابك). لا تختار «كل العملاء» قبل الموافقة.\n\nبعد التفعيل: صفحة الربط ← «إعادة الاتصال» ← فعّل كل الصلاحيات ← السماح.",
      confirmLabel: "فعّل",
    }))) return;
    try {
      await api("/api/schedule/scope", { method: "PUT", body: { mode: m } });
      toast("تم الحفظ");
      onChanged();
    } catch (e: any) {
      toast(e.message, "bad");
    }
  };
  const opts: Array<[typeof mode, string]> = [["off", "إيقاف"], ["owner", "حسابي فقط"], ["all", "كل العملاء"]];
  return (
    <div className="rounded-2xl border border-dashed border-[var(--border)] p-3">
      <div className="mb-2 font-semibold">لإدارة الخدمة: طلب صلاحية النشر عند ربط الحساب</div>
      <div className="seg" role="group" aria-label="طلب صلاحية النشر">
        {opts.map(([k, l]) => <button key={k} type="button" aria-pressed={mode === k} className={mode === k ? "on" : ""} onClick={() => mode !== k && set(k)}>{l}</button>)}
      </div>
    </div>
  );
}

// ---- calendar ------------------------------------------------------------------------------------------------------

function Planner({ meta }: { meta: any }) {
  const off: number = meta.tz_offset_min ?? 180;
  const [view, setView] = useState<View>("month");
  const [cursor, setCursor] = useState(() => dayOf(Date.now(), off));
  const [editing, setEditing] = useState<{ id?: number; at?: number } | null>(null);
  const [detail, setDetail] = useState<number | null>(null);
  // Visible range in day indexes.
  const range = useMemo(() => {
    if (view === "list") return { a: dayOf(Date.now(), off) - 7, b: dayOf(Date.now(), off) + 80 };
    const d = new Date(cursor * DAY);
    if (view === "week") {
      const a = cursor - d.getUTCDay();
      return { a, b: a + 7 };
    }
    const first = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / DAY;
    const a = first - new Date(first * DAY).getUTCDay();
    const last = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / DAY;
    return { a, b: last + ((7 - new Date(last * DAY).getUTCDay()) % 7) };
  }, [view, cursor, off]);
  const from = range.a * DAY - off * 60_000;
  const to = range.b * DAY - off * 60_000;
  const { data, reload } = useAsync(() => api<{ items: any[] }>(`/api/schedule?from=${from}&to=${to}`), [from, to]);
  const items = data?.items ?? [];
  const byDay = useMemo(() => {
    const m = new Map<number, any[]>();
    for (const p of items) {
      const k = dayOf(p.publish_at, off);
      m.set(k, [...(m.get(k) ?? []), p]);
    }
    return m;
  }, [items, off]);
  // Keep the calendar fresh while something is being published.
  useEffect(() => {
    if (!items.some((p) => ["publishing", "uncertain"].includes(p.status) || (p.status === "scheduled" && p.publish_at < Date.now() + 5 * 60_000))) return;
    const t = setInterval(reload, 30_000);
    return () => clearInterval(t);
  }, [items, reload]);
  const today = dayOf(Date.now(), off);
  const move = (dir: number) => {
    if (view === "week") return setCursor((c) => c + dir * 7);
    const d = new Date(cursor * DAY);
    setCursor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + dir, 1) / DAY);
  };
  const title = view === "week" ? `${fmtDate(range.a * DAY - off * 60_000)} — ${fmtDate((range.b - 1) * DAY - off * 60_000)}` : MONTH.format(new Date(cursor * DAY));
  const newAt = (day: number) => {
    const at = Math.max(day * DAY - off * 60_000 + 12 * 3_600_000, Math.ceil((Date.now() + 15 * 60_000) / 900_000) * 900_000);
    setEditing({ at });
  };

  return (
    <Card
      title="تقويم النشر"
      action={<button className="btn btn-primary min-h-9 text-xs" onClick={() => setEditing({})}><Icon name="plus" size={15} />منشور جديد</button>}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="seg" role="group" aria-label="العرض">
          {(["month", "week", "list"] as View[]).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} className={view === v ? "on" : ""} onClick={() => setView(v)}>{{ month: "شهر", week: "أسبوع", list: "قائمة" }[v]}</button>
          ))}
        </div>
        {view !== "list" && (
          <div className="flex items-center gap-1">
            <button className="btn btn-ghost min-h-9 px-2" onClick={() => move(-1)} aria-label="السابق">›</button>
            <b className="min-w-[9rem] text-center text-sm">{title}</b>
            <button className="btn btn-ghost min-h-9 px-2" onClick={() => move(1)} aria-label="التالي">‹</button>
            <button className="btn btn-ghost min-h-9 px-2 text-xs" onClick={() => setCursor(today)}>اليوم</button>
          </div>
        )}
      </div>

      {!data ? <Spinner /> : view === "list" ? (
        items.length ? (
          <div className="divide-y divide-[var(--border)]">
            {items.map((p) => <PostRowItem key={p.id} p={p} off={off} onClick={() => setDetail(p.id)} />)}
          </div>
        ) : <p className="muted py-6 text-center text-sm">ما فيه منشورات مجدولة. اضغط «منشور جديد».</p>
      ) : (
        <div className="overflow-x-auto">
          <div className={`grid min-w-[640px] grid-cols-7 gap-1 ${view === "week" ? "" : ""}`}>
            {WEEKDAYS.map((w) => <div key={w} className="muted py-1 text-center text-[11px] font-semibold">{w}</div>)}
            {Array.from({ length: range.b - range.a }, (_, i) => range.a + i).map((d) => {
              const inMonth = view === "week" || new Date(d * DAY).getUTCMonth() === new Date(cursor * DAY).getUTCMonth();
              const list = byDay.get(d) ?? [];
              return (
                <div key={d} className={`group flex min-h-[5.5rem] flex-col rounded-xl border p-1 ${d === today ? "border-[var(--primary)]" : "border-[var(--border)]"} ${inMonth ? "" : "opacity-40"} ${view === "week" ? "min-h-[14rem]" : ""}`}>
                  <div className="flex items-center justify-between px-1">
                    <span className={`text-xs font-bold ${d === today ? "text-[var(--primary)]" : ""}`}>{new Date(d * DAY).getUTCDate()}</span>
                    {d >= today && <button className="muted rounded px-1 text-sm opacity-0 group-hover:opacity-100 focus:opacity-100" onClick={() => newAt(d)} aria-label="منشور في هذا اليوم">+</button>}
                  </div>
                  <div className="mt-0.5 space-y-0.5">
                    {list.slice(0, view === "week" ? 12 : 3).map((p) => (
                      <button key={p.id} onClick={() => setDetail(p.id)} className={`block w-full truncate rounded-md px-1 py-0.5 text-right text-[10.5px] ${STATUS[p.status]?.cls ?? ""}`}>
                        {HM.format(new Date(p.publish_at + off * 60_000))} · {KIND_SHORT[p.kind as Kind]}
                      </button>
                    ))}
                    {list.length > (view === "week" ? 12 : 3) && <div className="muted px-1 text-[10px]">+{list.length - 3} أخرى</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="muted mt-3 flex flex-wrap gap-2 text-[11px]">
        {Object.entries(STATUS).map(([k, v]) => <span key={k} className={`chip ${v.cls}`}>{v.label}</span>)}
      </div>
      <p className="muted mt-2 text-xs">الأوقات بتوقيت حسابك (الإعدادات). Meta ما فيها جدولة، فالنظام هو اللي ينشر في الوقت — عادةً خلال دقيقة إلى دقيقتين، والفيديو ياخذ وقت أطول للمعالجة.</p>

      {editing && <PostEditor id={editing.id} presetAt={editing.at} off={off} limits={meta.limits} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
      {detail && <PostDetail id={detail} off={off} onClose={() => setDetail(null)} onChanged={reload} onEdit={(id) => { setDetail(null); setEditing({ id }); }} />}
    </Card>
  );
}

function Thumb({ mediaId, mime, published, className = "size-12" }: { mediaId?: number | null; mime?: string | null; published?: string | null; className?: string }) {
  const [src, setSrc] = useState<string | null>(published ?? null);
  useEffect(() => {
    if (published || !mediaId || (mime && !mime.startsWith("image/"))) return;
    let url: string | null = null;
    authedObjectUrl(`/api/schedule/media/${mediaId}`).then((u) => setSrc((url = u))).catch(() => undefined);
    return () => void (url && URL.revokeObjectURL(url));
  }, [mediaId, mime, published]);
  if (src) return <img src={src} alt="" className={`${className} shrink-0 rounded-lg object-cover`} />;
  return <span className={`${className} surface-2 grid shrink-0 place-items-center rounded-lg text-lg`}>{mime?.startsWith("video/") ? "🎬" : "🖼️"}</span>;
}

function PostRowItem({ p, off, onClick }: { p: any; off: number; onClick: () => void }) {
  return (
    <button className="flex w-full items-center gap-3 py-2.5 text-right" onClick={onClick}>
      <Thumb mediaId={p.thumb_id} mime={p.thumb_mime} published={p.published_thumb} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{p.caption || <span className="muted">بدون وصف</span>}</div>
        <div className="muted text-xs">{KIND_LABEL[p.kind as Kind]} · {fmtTime(p.publish_at)}{p.campaign_name ? ` · حملة: ${p.campaign_name}` : ""}</div>
        {p.status === "failed" && p.last_error && <div className="text-xs text-red-600 dark:text-red-400">{p.last_error}</div>}
      </div>
      <StatusChip s={p.status} />
      <span className="sr-only">{toLocal(p.publish_at, off)}</span>
    </button>
  );
}

// ---- editor ------------------------------------------------------------------------------------------------------

interface LocalFile {
  key: string;
  blob?: Blob; // new (not uploaded yet)
  serverId?: number; // already uploaded
  mime: string;
  url?: string; // preview
  w?: number;
  h?: number;
  duration?: number;
}

/** Any image → JPEG (Meta accepts JPEG only), at most 1440 px wide like Instagram. */
async function toJpeg(file: File): Promise<{ blob: Blob; w: number; h: number }> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1440 / bmp.width);
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, w, h);
  g.drawImage(bmp, 0, 0, w, h);
  const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("jpeg"))), "image/jpeg", 0.9));
  return { blob, w, h };
}
function videoInfo(url: string): Promise<{ w: number; h: number; duration: number }> {
  return new Promise((res) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => res({ w: v.videoWidth, h: v.videoHeight, duration: v.duration });
    v.onerror = () => res({ w: 0, h: 0, duration: 0 });
    v.src = url;
  });
}

function PostEditor({ id, presetAt, off, limits, onClose, onSaved }: { id?: number; presetAt?: number; off: number; limits: any; onClose: () => void; onSaved: () => void }) {
  const [kind, setKind] = useState<Kind>("IMAGE");
  const [caption, setCaption] = useState("");
  const [when, setWhen] = useState(() => toLocal(presetAt ?? Math.ceil((Date.now() + 30 * 60_000) / 900_000) * 900_000, off));
  const [campaign, setCampaign] = useState<string>("");
  const [shareToFeed, setShareToFeed] = useState(true);
  const [files, setFiles] = useState<LocalFile[]>([]);
  const [cover, setCover] = useState<LocalFile | null>(null);
  const [removed, setRemoved] = useState<number[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(!id);
  const pick = useRef<HTMLInputElement>(null);
  const pickCover = useRef<HTMLInputElement>(null);
  const { data: campaigns } = useAsync(() => api<any[]>("/api/campaigns"), []);

  useEffect(() => {
    if (!id) return;
    api<any>(`/api/schedule/${id}`).then(async (d) => {
      setKind(d.post.kind);
      setCaption(d.post.caption ?? "");
      setWhen(toLocal(d.post.publish_at, off));
      setCampaign(d.post.campaign_id ? String(d.post.campaign_id) : "");
      setShareToFeed(!!d.post.share_to_feed);
      const live = d.media.filter((m: any) => !m.deleted_at);
      const toLocalFile = async (m: any): Promise<LocalFile> => ({ key: `s${m.id}`, serverId: m.id, mime: m.mime, url: m.mime.startsWith("image/") ? await authedObjectUrl(`/api/schedule/media/${m.id}`).catch(() => undefined) : undefined });
      setFiles(await Promise.all(live.filter((m: any) => m.role === "item").map(toLocalFile)));
      const c = live.find((m: any) => m.role === "cover");
      setCover(c ? await toLocalFile(c) : null);
      setLoaded(true);
    }).catch((e) => { toast(e.message, "bad"); onClose(); });
  }, [id]);

  const accept = kind === "IMAGE" ? "image/*" : kind === "REELS" ? "video/mp4,video/quicktime" : "image/*,video/mp4,video/quicktime";
  const maxFiles = kind === "CAROUSEL" ? limits.carouselMax : 1;
  const addFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy("تجهيز الملفات…");
    const out: LocalFile[] = [];
    try {
      for (const f of Array.from(list)) {
        if (f.type.startsWith("image/")) {
          if (kind === "REELS") continue;
          const j = await toJpeg(f);
          out.push({ key: crypto.randomUUID(), blob: j.blob, mime: "image/jpeg", url: URL.createObjectURL(j.blob), w: j.w, h: j.h });
        } else if (f.type === "video/mp4" || f.type === "video/quicktime") {
          if (kind === "IMAGE") continue;
          if (f.size > limits.videoBytes) {
            toast(`«${f.name}» أكبر من 95 ميجا`, "bad");
            continue;
          }
          const url = URL.createObjectURL(f);
          const info = await videoInfo(url);
          out.push({ key: crypto.randomUUID(), blob: f, mime: f.type, url, ...info });
        } else toast(`«${f.name}»: نوع غير مدعوم`, "bad");
      }
    } catch {
      toast("تعذّر قراءة أحد الملفات", "bad");
    }
    setBusy(null);
    setFiles((cur) => (maxFiles === 1 ? [...out.slice(0, 1)] : [...cur, ...out].slice(0, maxFiles)));
    if (maxFiles === 1) setRemoved((r) => [...r, ...files.filter((x) => x.serverId).map((x) => x.serverId!)]);
  };
  const removeFile = (f: LocalFile) => {
    if (f.serverId) setRemoved((r) => [...r, f.serverId!]);
    setFiles((cur) => cur.filter((x) => x.key !== f.key));
  };
  const moveFile = (i: number, d: number) => setFiles((cur) => {
    const a = [...cur];
    const j = i + d;
    if (j < 0 || j >= a.length) return a;
    [a[i], a[j]] = [a[j], a[i]];
    return a;
  });

  // Warnings that Meta may reject (shown, not blocking).
  const warnings: string[] = [];
  for (const f of files) {
    if (!f.w || !f.h) continue;
    const r = f.w / f.h;
    if ((kind === "IMAGE" || kind === "CAROUSEL") && f.mime.startsWith("image/") && (r < 0.8 || r > 1.91)) warnings.push("أبعاد صورة خارج المسموح للمنشور (من 4:5 طولي إلى 1.91:1 عرضي) — Meta ممكن ترفضها.");
    if (kind === "STORY" && f.duration && f.duration > 60) warnings.push("فيديو الستوري أطول من 60 ثانية.");
    if (kind === "REELS" && f.duration && (f.duration < 3 || f.duration > 900)) warnings.push("مدة الريل لازم تكون بين 3 ثواني و15 دقيقة.");
  }
  const hashtags = (caption.match(/#[^\s#]+/g) ?? []).length;
  const publishAt = fromLocal(when, off);
  const problems: string[] = [];
  if (!files.length) problems.push("أضف ملف");
  if (kind === "CAROUSEL" && files.length < 2) problems.push("المتعدد يحتاج ملفين على الأقل");
  if (publishAt < Date.now() + 2 * 60_000) problems.push("الوقت لازم يكون بعد دقيقتين على الأقل");
  if (caption.length > limits.captionChars) problems.push("الوصف طويل");
  if (hashtags > limits.hashtags) problems.push("هاشتاقات كثيرة");

  const save = async (submit: boolean) => {
    setBusy("حفظ…");
    try {
      const body = { kind, caption: kind === "STORY" ? null : caption, publish_at: publishAt, share_to_feed: shareToFeed, campaign_id: campaign ? Number(campaign) : null };
      let postId = id;
      if (postId) await api(`/api/schedule/${postId}`, { method: "PATCH", body });
      else postId = (await api<{ id: number }>("/api/schedule", { body })).id;
      for (const mid of removed) await api(`/api/schedule/${postId}/media/${mid}`, { method: "DELETE" }).catch(() => undefined);
      const fresh = files.filter((f) => f.blob);
      for (const [i, f] of files.entries()) {
        if (!f.blob) continue;
        const n = fresh.indexOf(f) + 1;
        await uploadFile(`/api/schedule/${postId}/media?role=item&position=${i}&w=${f.w ?? ""}&h=${f.h ?? ""}`, f.blob, (p) => setBusy(`رفع ${n} من ${fresh.length}… ${Math.round(p * 100)}%`));
      }
      if (cover?.blob && kind === "REELS") await uploadFile(`/api/schedule/${postId}/media?role=cover`, cover.blob, (p) => setBusy(`رفع الغلاف… ${Math.round(p * 100)}%`));
      if (submit) {
        await api(`/api/schedule/${postId}/submit`, { body: {} });
        toast(`تمت الجدولة — ${fmtTime(publishAt)}`);
      } else toast("تم الحفظ كمسودة");
      onSaved();
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(null);
    }
  };

  const first = files[0];
  const tall = kind === "REELS" || kind === "STORY";
  return (
    <Modal open onClose={() => !busy && onClose()} title={id ? "تعديل المنشور" : "منشور جديد"}>
      {!loaded ? <Spinner /> : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <div className="space-y-4">
            <Field label="النوع">
              <div className="seg flex-wrap" role="group" aria-label="نوع المنشور">
                {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
                  <button key={k} type="button" aria-pressed={kind === k} className={kind === k ? "on" : ""} onClick={() => { if (k !== kind) { setRemoved((r) => [...r, ...files.filter((x) => x.serverId).map((x) => x.serverId!)]); setFiles([]); setKind(k); } }}>{KIND_LABEL[k]}</button>
                ))}
              </div>
            </Field>

            <Field label={kind === "CAROUSEL" ? `الملفات (${files.length} من ${limits.carouselMax})` : "الملف"} hint={kind === "REELS" ? "فيديو MP4/MOV حتى 95 ميجا، من 3 ثواني إلى 15 دقيقة." : kind === "STORY" ? "صورة أو فيديو (حتى 60 ثانية)." : kind === "CAROUSEL" ? "صور وفيديوهات، من 2 إلى 10، بالترتيب." : "الصورة تتحول تلقائيًا لـ JPEG."}>
              <div className="flex flex-wrap gap-2">
                {files.map((f, i) => (
                  <div key={f.key} className="relative">
                    {f.url && f.mime.startsWith("image/") ? <img src={f.url} alt="" className="size-20 rounded-xl object-cover" /> : f.url ? <video src={f.url} className="size-20 rounded-xl object-cover" muted /> : <Thumb mime={f.mime} className="size-20" />}
                    <button type="button" className="absolute -left-1 -top-1 grid size-6 place-items-center rounded-full bg-red-600 text-xs text-white" onClick={() => removeFile(f)} aria-label="حذف">✕</button>
                    {kind === "CAROUSEL" && files.length > 1 && (
                      <div className="absolute inset-x-0 bottom-0 flex justify-between px-0.5">
                        <button type="button" className="rounded bg-black/60 px-1 text-xs text-white" onClick={() => moveFile(i, -1)} aria-label="قبل">›</button>
                        <span className="rounded bg-black/60 px-1 text-[10px] text-white">{i + 1}</span>
                        <button type="button" className="rounded bg-black/60 px-1 text-xs text-white" onClick={() => moveFile(i, 1)} aria-label="بعد">‹</button>
                      </div>
                    )}
                  </div>
                ))}
                {files.length < maxFiles && (
                  <button type="button" className="surface-2 grid size-20 place-items-center rounded-xl border border-dashed border-[var(--border)] text-2xl" onClick={() => pick.current?.click()} aria-label="إضافة ملف">+</button>
                )}
                <input ref={pick} type="file" accept={accept} multiple={kind === "CAROUSEL"} hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
              </div>
            </Field>

            {kind === "REELS" && (
              <>
                <Field label="غلاف الريل (اختياري)" hint="صورة تظهر كغلاف. بدونها Meta تختار لقطة من الفيديو.">
                  <div className="flex items-center gap-2">
                    {cover?.url && <img src={cover.url} alt="" className="size-14 rounded-lg object-cover" />}
                    <button type="button" className="btn btn-ghost min-h-9 text-xs" onClick={() => pickCover.current?.click()}>{cover ? "تغيير" : "اختيار صورة"}</button>
                    {cover && <button type="button" className="btn btn-ghost min-h-9 text-xs" onClick={() => { if (cover.serverId) setRemoved((r) => [...r, cover.serverId!]); setCover(null); }}>إزالة</button>}
                    <input ref={pickCover} type="file" accept="image/*" hidden onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (!f) return; const j = await toJpeg(f); if (cover?.serverId) setRemoved((r) => [...r, cover.serverId!]); setCover({ key: "cover", blob: j.blob, mime: "image/jpeg", url: URL.createObjectURL(j.blob), w: j.w, h: j.h }); }} />
                  </div>
                </Field>
                <Toggle checked={shareToFeed} onChange={setShareToFeed} label="يظهر في شبكة الحساب أيضًا" description="بدونها يظهر في تبويب الريلز فقط." />
              </>
            )}

            {kind !== "STORY" ? (
              <Field label="الوصف" hint={`${caption.length} / ${limits.captionChars} حرف · ${hashtags} / ${limits.hashtags} هاشتاق`}>
                <textarea className="input min-h-[7rem]" value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={limits.captionChars} placeholder="اكتب وصف المنشور…" />
              </Field>
            ) : <p className="muted text-xs">الستوري ما لها وصف عبر واجهة النشر.</p>}

            <Field label="وقت النشر" hint="بتوقيت حسابك.">
              <DateTimeField value={when} onChange={(v) => v && setWhen(v)} label="وقت النشر" clearable={false} />
            </Field>

            {kind !== "STORY" && (
              <Field label="تشغيل حملة على هذا المنشور (اختياري)" hint="أول ما ينتشر المنشور، تنربط الحملة فيه وتتفعّل تلقائيًا — والتعليقات من أول لحظة تنحسب.">
                <select className="input" value={campaign} onChange={(e) => setCampaign(e.target.value)}>
                  <option value="">بدون حملة</option>
                  {(campaigns ?? []).filter((c: any) => c.type === "comment").map((c: any) => <option key={c.id} value={c.id}>{c.name}{c.status === "active" ? " (نشطة)" : ""}</option>)}
                </select>
              </Field>
            )}

            {warnings.length > 0 && <Alert tone="warn">{[...new Set(warnings)].join(" ")}</Alert>}
          </div>

          {/* Preview */}
          <div>
            <div className="muted mb-1 text-xs font-semibold">معاينة</div>
            <div className="mx-auto w-full max-w-[16rem] overflow-hidden rounded-2xl border border-[var(--border)] bg-black">
              <div className={`relative ${tall ? "aspect-[9/16]" : "aspect-[4/5]"} grid place-items-center`}>
                {first?.url ? (first.mime.startsWith("image/") ? <img src={first.url} alt="" className="size-full object-cover" /> : <video src={first.url} className="size-full object-cover" muted autoPlay loop playsInline />) : <span className="text-sm text-white/60">بدون ملف</span>}
                {kind === "CAROUSEL" && files.length > 1 && <span className="absolute left-2 top-2 rounded-full bg-black/60 px-2 text-[11px] text-white">1/{files.length}</span>}
              </div>
              {kind !== "STORY" && caption && <div className="max-h-24 overflow-hidden bg-[var(--surface)] p-2 text-xs whitespace-pre-wrap">{caption}</div>}
            </div>
            <p className="muted mt-2 text-center text-[11px]">{KIND_LABEL[kind]} · {fmtTime(publishAt)}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2 md:col-span-2">
            <button className="btn btn-primary" disabled={!!busy || problems.length > 0} onClick={() => save(true)}>{busy ?? "جدولة"}</button>
            <button className="btn btn-ghost" disabled={!!busy || !files.length} onClick={() => save(false)}>حفظ كمسودة</button>
            {problems.length > 0 && !busy && <span className="muted text-xs">{problems[0]}</span>}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---- detail --------------------------------------------------------------------------------------------------------

const STEP_LABEL: Record<string, string> = {
  start: "بدأ النشر",
  quota: "حد النشر اليومي",
  container: "تجهيز المنشور عند Meta",
  expired: "انتهت صلاحية التجهيز",
  verify: "التحقق من النتيجة",
  publish: "طلب النشر",
  published: "نُشر",
  campaign: "الحملة",
  failed: "فشل",
};

function PostDetail({ id, off, onClose, onChanged, onEdit }: { id: number; off: number; onClose: () => void; onChanged: () => void; onEdit: (id: number) => void }) {
  const { data, reload } = useAsync(() => api<any>(`/api/schedule/${id}`), [id]);
  const p = data?.post;
  const act = async (what: "cancel" | "delete") => {
    if (!(await askConfirm({ title: what === "cancel" ? "إلغاء الجدولة؟" : "حذف المنشور المجدول؟", message: what === "cancel" ? "ما راح يُنشر. تقدر تعدله وتجدوله من جديد." : "يُحذف من الجدولة مع ملفاته. المنشور اللي انتشر على إنستقرام ما يتأثر.", confirmLabel: what === "cancel" ? "إلغاء الجدولة" : "حذف", danger: what === "delete" }))) return;
    try {
      if (what === "cancel") await api(`/api/schedule/${id}/cancel`, { body: {} });
      else await api(`/api/schedule/${id}`, { method: "DELETE" });
      toast(what === "cancel" ? "تم الإلغاء" : "تم الحذف");
      onChanged();
      what === "delete" ? onClose() : reload();
    } catch (e: any) {
      toast(e.message, "bad");
    }
  };
  const items = (data?.media ?? []).filter((m: any) => m.role === "item");
  return (
    <Modal open onClose={onClose} title="تفاصيل المنشور">
      {!p ? <Spinner /> : (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip s={p.status} />
            <b>{KIND_LABEL[p.kind as Kind]}</b>
            <span className="muted">· {fmtTime(p.publish_at)}</span>
          </div>
          {p.status === "failed" && p.last_error && <Alert tone="bad">{p.last_error}</Alert>}
          {p.status === "publishing" && p.last_error && <Alert tone="warn">{p.last_error}</Alert>}
          <div className="flex flex-wrap gap-2">
            {items.map((m: any) => <Thumb key={m.id} mediaId={m.deleted_at ? null : m.id} mime={m.mime} className="size-16" />)}
          </div>
          {p.caption && <p className="surface-2 whitespace-pre-wrap rounded-xl p-3">{p.caption}</p>}
          {p.permalink && <a href={p.permalink} target="_blank" rel="noreferrer" className="font-semibold text-[var(--primary)]">فتح المنشور في إنستقرام ↗</a>}
          {data.log.length > 0 && (
            <div>
              <div className="muted mb-1 text-xs font-semibold">سجل التنفيذ</div>
              <ol className="space-y-1 text-xs">
                {data.log.map((l: any, i: number) => (
                  <li key={i} className="flex gap-2">
                    <span>{l.ok ? "✅" : "⚠️"}</span>
                    <span className="muted whitespace-nowrap">{HM.format(new Date(l.at + off * 60_000))}</span>
                    <span><b>{STEP_LABEL[l.step] ?? l.step}</b>{l.detail ? ` — ${l.detail}` : ""}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            {["draft", "scheduled", "failed", "cancelled"].includes(p.status) && <button className="btn btn-primary" onClick={() => onEdit(p.id)}>{p.status === "failed" || p.status === "cancelled" ? "تعديل وإعادة الجدولة" : "تعديل"}</button>}
            {["draft", "scheduled", "failed"].includes(p.status) && !p.publish_requested_at && <button className="btn btn-ghost" onClick={() => act("cancel")}>إلغاء الجدولة</button>}
            {!["publishing", "uncertain"].includes(p.status) && <button className="btn btn-danger" onClick={() => act("delete")}>حذف</button>}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---- campaigns with a start / end time (unchanged behavior) -------------------------------------------------------

function ScheduledCampaigns() {
  const { data: campaigns } = useAsync(() => api<any[]>("/api/campaigns"), []);
  const scheduled = (campaigns ?? []).filter((c) => c.schedule_start || c.schedule_end);
  return (
    <Card title="الحملات المجدولة" action={<Link to="/campaigns/new" className="btn btn-ghost min-h-9 text-xs"><Icon name="plus" size={15} />حملة جديدة</Link>}>
      <p className="muted mb-3 text-sm">حدد بداية ونهاية أي حملة من محرر الحملة ← خطوة «الجدول والأولوية والتكرار». الحملة ترد فقط داخل الفترة، والرسائل تلتزم بنوافذ Meta وقت التنفيذ.</p>
      {!scheduled.length ? (
        <p className="muted py-4 text-center text-sm">ما فيه حملات بموعد محدد. الحملات بدون موعد تشتغل طول ما هي «نشطة».</p>
      ) : (
        <div className="divide-y divide-[var(--border)]">
          {scheduled.map((c) => {
            const now = Date.now();
            const state = c.schedule_end && c.schedule_end < now ? "انتهت" : c.schedule_start && c.schedule_start > now ? "مجدولة" : c.status === "active" ? "تعمل الآن" : "متوقفة";
            return (
              <div key={c.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <span className="chip surface-2">{state}</span>
                <b className="min-w-0 flex-1 truncate">{c.name}</b>
                <span className="muted text-xs">{c.schedule_start ? `من ${fmtTime(c.schedule_start)}` : "من التفعيل"} — {c.schedule_end ? `إلى ${fmtTime(c.schedule_end)}` : "بدون نهاية"}</span>
                <Link to={`/campaigns/${c.id}`} className="btn btn-ghost min-h-9 px-3 text-xs">تعديل</Link>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
