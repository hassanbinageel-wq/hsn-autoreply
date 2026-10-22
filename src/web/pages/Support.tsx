import { useEffect, useMemo, useRef, useState } from "react";
import { api, authedObjectUrl, uploadFile } from "../api";
import { askConfirm, askText } from "../components/Confirm";
import { Icon } from "../components/Icon";
import { Alert, Card, Field, Modal, PageHeader, Spinner, Toggle, fmtTime, toast, useAsync } from "../components/ui";
import { normText } from "../lib/text";
import { ATTACH_IMAGE, ATTACH_IMAGE_BYTES, ATTACH_VIDEO, ATTACH_VIDEO_BYTES, CATEGORIES, parseFaqText, PRIORITIES, STATES, ticketNo, type TicketCategory, type TicketPriority, type TicketState } from "../../shared/support";

/**
 * Support center. Customers: their tickets with the service owner (type, number, state, replies, one image or
 * video per message). Owner (inside the owner panel): every ticket with filters, priority and canned replies,
 * plus the FAQ, the canned replies, the expected response time and the incident banner.
 */
export function SupportPage() {
  const { data: center } = useAsync(() => api<{ response_time: string }>("/api/public/support"), []);
  return (
    <div className="space-y-5">
      <PageHeader title="مركز الدعم" subtitle={<>افتح طلب دعم وتابع حالته هنا — يوصلك الرد هنا وفي جرس الإشعارات.{center?.response_time ? <> <b>{center.response_time}</b></> : null}</>} />
      <SupportInbox mode="customer" />
    </div>
  );
}

const STATE_TONE: Record<string, string> = {
  new: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
  in_progress: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  waiting: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300",
  resolved: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
};
const PRIORITY_TONE: Record<string, string> = { urgent: "text-red-600", high: "text-amber-600", normal: "muted", low: "muted" };
const CATEGORY_ICON: Record<string, string> = { tech: "settings", question: "msg", billing: "bank", suggestion: "sparkle" };

/** The customer sees "بانتظار ردك"; the owner sees the same state as "بانتظار رد العميل". */
const stateLabel = (s: string, mode: "customer" | "owner") => (mode === "owner" && s === "waiting" ? "بانتظار رد العميل" : (STATES as Record<string, string>)[s] ?? s);
function StateChip({ state, mode }: { state: string; mode: "customer" | "owner" }) {
  return <span className={`chip shrink-0 !py-0 text-[10.5px] ${STATE_TONE[state] ?? "surface-2 muted"}`}>{stateLabel(state, mode)}</span>;
}

export function SupportInbox({ mode }: { mode: "customer" | "owner" }) {
  const base = mode === "owner" ? "/api/owner/support" : "/api/support";
  const query = () => new URLSearchParams(location.hash.split("?")[1] ?? "");
  const [list, setList] = useState<any[] | null>(null);
  const [open, setOpen] = useState<number | null>(() => Number(query().get("thread")) || null);
  const [creating, setCreating] = useState(() => mode === "customer" && query().get("new") === "1");
  const [q, setQ] = useState("");
  const [fState, setFState] = useState<string>("active");
  const [fCat, setFCat] = useState<string>("");
  const [fPri, setFPri] = useState<string>("");
  const load = () => api<any[]>(base).then(setList).catch((e) => toast(e.message, "bad"));
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    // A notification link (…?thread=12 / ?new=1) while the page is already open.
    const onHash = () => {
      const id = Number(query().get("thread"));
      if (id) (setOpen(id), setCreating(false));
      if (mode === "customer" && query().get("new") === "1") (setCreating(true), setOpen(null));
    };
    window.addEventListener("hashchange", onHash);
    return () => {
      clearInterval(t);
      window.removeEventListener("hashchange", onHash);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const shown = useMemo(() => {
    if (!list) return null;
    const nq = normText(q);
    return list.filter(
      (t) =>
        (fState === "" || (fState === "active" ? t.state !== "resolved" : t.state === fState)) &&
        (!fCat || t.category === fCat) &&
        (!fPri || t.priority === fPri) &&
        (!nq || [t.subject, t.last_body, t.tenant_name, t.tenant_usernames, t.ig_username, String(ticketNo(t.id))].some((v) => v && normText(String(v)).includes(nq))),
    );
  }, [list, q, fState, fCat, fPri]);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
      <div className={`card min-w-0 p-2 sm:p-3 ${open !== null || creating ? "hidden lg:block" : ""}`}>
        {mode === "customer" && <button className="btn btn-primary mb-2 w-full" onClick={() => { setCreating(true); setOpen(null); }}><Icon name="plus" size={16} />فتح طلب دعم</button>}
        <div className="mb-2 space-y-2">
          <input className="input min-h-9 py-1.5 text-sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder={mode === "owner" ? "بحث: رقم الطلب، العنوان، العميل…" : "بحث في طلباتك"} aria-label="بحث" />
          <div className={`grid gap-1.5 ${mode === "owner" ? "grid-cols-3" : "grid-cols-1"}`}>
            <select className="input min-h-8 min-w-0 px-2 py-1 text-xs" value={fState} onChange={(e) => setFState(e.target.value)} aria-label="الحالة">
              <option value="active">المفتوحة</option>
              <option value="">كل الحالات</option>
              {Object.keys(STATES).map((k) => <option key={k} value={k}>{stateLabel(k, mode)}</option>)}
            </select>
            {mode === "owner" && (
              <>
                <select className="input min-h-8 min-w-0 px-2 py-1 text-xs" value={fCat} onChange={(e) => setFCat(e.target.value)} aria-label="النوع">
                  <option value="">كل الأنواع</option>
                  {Object.entries(CATEGORIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
                <select className="input min-h-8 min-w-0 px-2 py-1 text-xs" value={fPri} onChange={(e) => setFPri(e.target.value)} aria-label="الأولوية">
                  <option value="">كل الأولويات</option>
                  {Object.entries(PRIORITIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </>
            )}
          </div>
        </div>
        {!shown ? <Spinner /> : !shown.length ? (
          <p className="muted py-6 text-center text-sm">{list?.length ? "ما فيه طلبات بهذا الفلتر." : mode === "owner" ? "ما فيه طلبات دعم من العملاء بعد." : "ما عندك طلبات دعم. افتح طلب لأي سؤال أو مشكلة."}</p>
        ) : (
          <div className="divide-y divide-[var(--border)]">
            {shown.map((t) => (
              <button key={t.id} onClick={() => { setOpen(t.id); setCreating(false); }} className={`flex w-full flex-col gap-0.5 rounded-xl px-2.5 py-2.5 text-right transition hover:bg-[var(--surface-2)] ${open === t.id ? "bg-violet-500/10" : ""}`}>
                <div className="flex items-center gap-2">
                  <span className="muted shrink-0 text-[11px] font-bold" dir="ltr">#{ticketNo(t.id)}</span>
                  <b className="min-w-0 flex-1 truncate text-sm">{t.subject}</b>
                  {!!t.unread && <span className="h-2 w-2 shrink-0 rounded-full bg-pink-600" aria-label="جديد" />}
                  <StateChip state={t.state} mode={mode} />
                </div>
                {mode === "owner" && <Who t={t} />}
                <span className="muted flex items-center gap-1.5 text-[11px]">
                  <Icon name={CATEGORY_ICON[t.category] ?? "msg"} size={12} />{(CATEGORIES as Record<string, string>)[t.category] ?? t.category}
                  {mode === "owner" && t.priority !== "normal" && <b className={PRIORITY_TONE[t.priority]}>· {(PRIORITIES as Record<string, string>)[t.priority]}</b>}
                </span>
                <span className="muted truncate text-xs">{t.last_from === "owner" ? "↩ " : ""}{t.last_body}</span>
                <span className="muted text-[10.5px]">{fmtTime(t.updated_at)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className={`card min-w-0 p-3 sm:p-4 ${open === null && !creating ? "hidden lg:block" : ""}`}>
        {creating ? (
          <NewTicket onDone={(id) => { setCreating(false); load(); if (id) setOpen(id); }} />
        ) : open === null ? (
          <p className="muted py-10 text-center text-sm">اختر طلبًا.</p>
        ) : (
          <Thread key={open} id={open} base={base} mode={mode} onBack={() => setOpen(null)} onChange={load} />
        )}
      </div>
    </div>
  );
}

/** Checks a file against the limits; returns an error message or null. */
function fileProblem(f: File): string | null {
  if (ATTACH_IMAGE.includes(f.type)) return f.size > ATTACH_IMAGE_BYTES ? "الصورة أكبر من 5 ميجا" : null;
  if (ATTACH_VIDEO.includes(f.type)) return f.size > ATTACH_VIDEO_BYTES ? "الفيديو أكبر من 25 ميجا" : null;
  return "اختر صورة (JPG / PNG / WEBP) أو فيديو (MP4 / MOV)";
}

function FilePick({ file, onChange }: { file: File | null; onChange: (f: File | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <button type="button" className="btn btn-ghost min-h-9 text-xs" onClick={() => ref.current?.click()}><Icon name="image" size={15} />{file ? "تغيير المرفق" : "إرفاق صورة أو فيديو"}</button>
      {file ? (
        <span className="flex min-w-0 items-center gap-1.5"><span className="truncate" dir="ltr">{file.name}</span> <span className="muted">({(file.size / 1024 / 1024).toFixed(1)} ميجا)</span> <button type="button" className="text-red-600 underline" onClick={() => onChange(null)}>إزالة</button></span>
      ) : (
        <span className="muted">اختياري — صورة حتى 5 ميجا أو فيديو حتى 25 ميجا</span>
      )}
      <input
        ref={ref}
        type="file"
        accept={[...ATTACH_IMAGE, ...ATTACH_VIDEO].join(",")}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null;
          e.target.value = "";
          if (!f) return;
          const bad = fileProblem(f);
          if (bad) return toast(bad, "bad");
          onChange(f);
        }}
      />
    </div>
  );
}

async function attach(ticketId: number, messageId: number, file: File, onProgress: (p: number) => void) {
  await uploadFile(`/api/support/${ticketId}/messages/${messageId}/attachment`, file, onProgress);
}

function NewTicket({ onDone }: { onDone: (id?: number) => void }) {
  const [category, setCategory] = useState<TicketCategory>("tech");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const send = async () => {
    setBusy(true);
    try {
      const r = await api<{ id: number; number: number; message_id: number }>("/api/support", { body: { category, subject, body } });
      if (file) {
        setProgress(0);
        await attach(r.id, r.message_id, file, setProgress).catch((e) => toast(`انفتح الطلب لكن ما انرفع المرفق: ${e.message}`, "bad"));
      }
      toast(`وصل طلبك رقم ${r.number} ✅`);
      onDone(r.id);
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };
  return (
    <div className="space-y-3">
      <b className="font-display text-lg">فتح طلب دعم</b>
      <Field label="نوع الطلب">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(Object.entries(CATEGORIES) as Array<[TicketCategory, string]>).map(([k, l]) => (
            <button key={k} type="button" onClick={() => setCategory(k)} className={`flex items-center justify-center gap-1.5 rounded-xl border px-2 py-2.5 text-sm font-bold ${category === k ? "border-violet-500 bg-violet-500/10 text-violet-700 dark:text-violet-300" : "border-[var(--border)] muted"}`}>
              <Icon name={CATEGORY_ICON[k]} size={15} />{l}
            </button>
          ))}
        </div>
      </Field>
      <Field label="العنوان"><input className="input" maxLength={120} value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
      <Field label="الوصف" hint="اكتب وش صار بالتفصيل: الخطوات، ووش توقعت يصير. لا تكتب كلمات مرور أو أكواد سرية.">
        <textarea className="input min-h-[9rem]" maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} />
      </Field>
      <FilePick file={file} onChange={setFile} />
      {progress !== null && <div className="h-1.5 overflow-hidden rounded-full bg-[var(--border)]"><div className="grad h-full" style={{ width: `${Math.round(progress * 100)}%` }} /></div>}
      <div className="flex gap-2">
        <button className="btn btn-primary" disabled={busy || subject.trim().length < 3 || !body.trim()} onClick={send}>{busy ? "…" : "إرسال الطلب"}</button>
        <button className="btn btn-ghost" onClick={() => onDone()}>إلغاء</button>
      </div>
    </div>
  );
}

/** A message's file: the image inline, the video with controls (private files go through the API). */
function Attachment({ m, mode }: { m: any; mode: "customer" | "owner" }) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    if (!m.has_att) return;
    let url: string | null = null;
    authedObjectUrl(`${mode === "owner" ? "/api/owner/support" : "/api/support"}/attachment/${m.id}`).then((u) => setSrc((url = u))).catch(() => setErr(true));
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [m.id, m.has_att, mode]);
  if (m.att_removed) return <div className="mt-1.5 text-[11px] opacity-75">📎 انحذف المرفق (بعد 30 يوم من حل الطلب)</div>;
  if (!m.has_att) return null;
  if (err) return <div className="mt-1.5 text-[11px] opacity-75">📎 تعذّر تحميل المرفق</div>;
  if (!src) return <div className="mt-1.5 text-[11px] opacity-75">📎 جارٍ تحميل المرفق…</div>;
  return String(m.att_mime).startsWith("video/") ? (
    <video src={src} controls playsInline className="mt-2 max-h-72 w-full rounded-xl bg-black" />
  ) : (
    <a href={src} target="_blank" rel="noopener"><img src={src} alt="مرفق" className="mt-2 max-h-72 rounded-xl object-contain" /></a>
  );
}

function Thread({ id, base, mode, onBack, onChange }: { id: number; base: string; mode: "customer" | "owner"; onBack: () => void; onChange: () => void }) {
  const [data, setData] = useState<any>(null);
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [replyState, setReplyState] = useState<"waiting" | "in_progress" | "resolved">("waiting");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const { data: canned } = useAsync(() => (mode === "owner" ? api<any[]>("/api/owner/support-canned") : Promise.resolve([])), [mode]);
  const load = () => api(`${base}/${id}`).then(setData).catch((e) => toast(e.message, "bad"));
  useEffect(() => {
    load().then(onChange);
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [data?.messages?.length]);
  const send = async () => {
    const body = text.trim() || (file ? "📎 مرفق" : "");
    if (!body) return;
    setBusy(true);
    try {
      const r = await api<{ message_id: number }>(`${base}/${id}/reply`, { body: mode === "owner" ? { body, state: replyState } : { body } });
      if (file && mode === "customer") await attach(id, r.message_id, file, () => undefined).catch((e) => toast(`انرسل الرد لكن ما انرفع المرفق: ${e.message}`, "bad"));
      setText("");
      setFile(null);
      await load();
      onChange();
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  const meta = async (body: { state?: TicketState; priority?: TicketPriority }) => {
    try {
      await api(`${base}/${id}/meta`, { body });
      await load();
      onChange();
    } catch (e: any) {
      toast(e.message, "bad");
    }
  };
  if (!data) return <Spinner />;
  const t = data.thread;
  const mine = mode === "owner" ? "owner" : "customer";
  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] pb-3">
        <button className="btn btn-ghost h-9 w-9 p-0 lg:hidden" aria-label="رجوع" onClick={onBack}>→</button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="muted text-xs font-bold" dir="ltr">#{ticketNo(t.id)}</span>
            <StateChip state={t.state} mode={mode} />
            <span className="muted text-xs">{(CATEGORIES as Record<string, string>)[t.category] ?? t.category}</span>
          </div>
          <b className="block truncate">{t.subject}</b>
          {mode === "owner" && <Who t={t} />}
        </div>
        {mode === "owner" && (
          <div className="flex gap-1.5">
            <select className="input min-h-9 w-auto py-1 text-xs" value={t.state} onChange={(e) => meta({ state: e.target.value as TicketState })} aria-label="الحالة">
              {Object.keys(STATES).map((k) => <option key={k} value={k}>{stateLabel(k, "owner")}</option>)}
            </select>
            <select className={`input min-h-9 w-auto py-1 text-xs font-bold ${PRIORITY_TONE[t.priority] ?? ""}`} value={t.priority} onChange={(e) => meta({ priority: e.target.value as TicketPriority })} aria-label="الأولوية">
              {Object.entries(PRIORITIES).map(([k, l]) => <option key={k} value={k}>أولوية {l}</option>)}
            </select>
          </div>
        )}
      </div>
      <div ref={box} className="-mx-3 h-[50vh] min-h-[240px] space-y-2 overflow-y-auto bg-[var(--surface-2)] px-3 py-3 sm:-mx-4 sm:px-4">
        {data.messages.map((m: any) => (
          <div key={m.id} className={`flex ${m.sender === mine ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed shadow-sm ${m.sender === mine ? "bg-gradient-to-br from-violet-600 to-indigo-500 text-white" : "border border-[var(--border)] bg-[var(--surface)]"}`}>
              <div className="mb-0.5 text-[10.5px] opacity-75">{m.sender === "owner" ? "🎧 الدعم" : mode === "owner" ? t.tenant_name : "أنت"}</div>
              <div className="whitespace-pre-wrap break-words">{m.body}</div>
              <Attachment m={m} mode={mode} />
              <div className="mt-1 text-[10.5px] opacity-70">{fmtTime(m.created_at)}</div>
            </div>
          </div>
        ))}
      </div>
      {t.state === "resolved" && mode === "customer" && <div className="pt-2"><Alert tone="good">تم حل الطلب — إذا كتبت رد ينفتح من جديد.</Alert></div>}
      {t.state === "waiting" && mode === "customer" && <div className="pt-2"><Alert tone="info">فريق الدعم ينتظر ردك على هذا الطلب.</Alert></div>}
      <div className="space-y-2 border-t border-[var(--border)] pt-2.5">
        {mode === "owner" && !!canned?.length && (
          <div className="flex flex-wrap gap-1.5">
            {canned.map((c: any) => (
              <button key={c.id} type="button" className="rounded-full border border-[var(--border)] px-2.5 py-1 text-[11px] font-bold hover:border-violet-400" title={c.body} onClick={() => setText((x) => (x ? `${x}\n${c.body}` : c.body))}>⚡ {c.title}</button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea className="input min-h-[44px] flex-1 resize-none" rows={2} maxLength={4000} placeholder="اكتب ردك…" value={text} onChange={(e) => setText(e.target.value)} />
          <button className="btn btn-primary" disabled={busy || (!text.trim() && !file)} onClick={send}>{busy ? "…" : "إرسال"}</button>
        </div>
        {mode === "customer" ? (
          <FilePick file={file} onChange={setFile} />
        ) : (
          <label className="muted flex items-center gap-2 text-xs">
            بعد الإرسال تصير الحالة:
            <select className="input min-h-8 w-auto py-1 text-xs" value={replyState} onChange={(e) => setReplyState(e.target.value as typeof replyState)}>
              <option value="waiting">بانتظار رد العميل</option>
              <option value="in_progress">قيد المعالجة</option>
              <option value="resolved">تم الحل</option>
            </select>
          </label>
        )}
      </div>
    </div>
  );
}

/** Owner panel tab: tickets, FAQ, canned replies, response time and the incident banner. */
export function OwnerSupportTab() {
  const [view, setView] = useState<"tickets" | "faq" | "canned" | "settings">("tickets");
  const tabs: Array<[typeof view, string]> = [["tickets", "الطلبات"], ["faq", "الأسئلة الشائعة"], ["canned", "الردود الجاهزة"], ["settings", "وقت الرد وإعلان العطل"]];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        {tabs.map(([k, l]) => (
          <button key={k} type="button" onClick={() => setView(k)} className={`rounded-xl border px-3 py-1.5 text-sm font-bold ${view === k ? "border-violet-500 bg-violet-500/10 text-violet-700 dark:text-violet-300" : "border-[var(--border)] muted"}`}>{l}</button>
        ))}
      </div>
      {view === "tickets" && <SupportInbox mode="owner" />}
      {view === "faq" && <FaqManager />}
      {view === "canned" && <CannedManager />}
      {view === "settings" && <SupportSettings />}
    </div>
  );
}

type FaqItem = { id: number; question: string; answer: string; video_url: string | null; section_id: number | null; sort: number; active: number };
type FaqSection = { id: number; title: string; sort: number };

/** FAQ in sections: add / rename / order / delete sections, move questions between them, import many from text. */
function FaqManager() {
  const { data, reload } = useAsync(() => api<{ sections: FaqSection[]; items: FaqItem[] }>("/api/owner/support-faq"), []);
  const [edit, setEdit] = useState<any | null>(null);
  const [importing, setImporting] = useState(false);
  if (!data) return <Spinner />;
  const { sections, items } = data;
  const groups: Array<{ section: FaqSection | null; items: FaqItem[] }> = [
    ...sections.map((s) => ({ section: s, items: items.filter((i) => i.section_id === s.id) })),
    { section: null, items: items.filter((i) => !i.section_id || !sections.some((s) => s.id === i.section_id)) },
  ];
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      reload();
    } catch (e: any) {
      toast(e.message, "bad");
    }
  };
  const addSection = async () => {
    const title = await askText({ title: "قسم جديد", label: "اسم القسم (مثل: البداية والربط)", confirmLabel: "إضافة" });
    if (title?.trim()) run(() => api("/api/owner/support-faq-sections", { body: { title: title.trim() } }));
  };
  const moveSection = (i: number, d: -1 | 1) => {
    const ids = sections.map((s) => s.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    run(() => api("/api/owner/support-faq-sections/order", { method: "PUT", body: { ids } }));
  };
  const moveItem = (list: FaqItem[], i: number, d: -1 | 1) => {
    const a = list[i];
    const b = list[i + d];
    const sa = a.sort === b.sort ? b.sort + d : b.sort;
    run(async () => {
      await api(`/api/owner/support-faq/${a.id}/move`, { body: { sort: Math.max(0, sa) } });
      await api(`/api/owner/support-faq/${b.id}/move`, { body: { sort: a.sort } });
    });
  };
  return (
    <Card
      title="الأسئلة الشائعة"
      action={
        <div className="flex flex-wrap gap-1.5">
          <button className="btn btn-ghost min-h-9 text-xs" onClick={() => setImporting(true)}><Icon name="upload" size={14} />استيراد من نص</button>
          <button className="btn btn-ghost min-h-9 text-xs" onClick={addSection}><Icon name="plus" size={14} />قسم</button>
          {!edit && <button className="btn btn-primary min-h-9 text-xs" onClick={() => setEdit({ question: "", answer: "", video_url: "", active: true, section_id: sections[0]?.id ?? null })}><Icon name="plus" size={14} />سؤال</button>}
        </div>
      }
    >
      <p className="muted mb-3 text-sm">تظهر في أيقونة «؟» مجمّعة حسب الأقسام، مع البحث. تقدر تضيف رابط فيديو شرح من يوتيوب أو إنستقرام لأي سؤال.</p>
      {edit && <FaqForm item={edit} sections={sections} onDone={() => { setEdit(null); reload(); }} />}
      {importing && <FaqImport onClose={() => setImporting(false)} onDone={() => { setImporting(false); reload(); }} />}
      {!items.length && !sections.length && !edit ? (
        <p className="muted py-4 text-center text-sm">ما فيه أسئلة بعد — أضف سؤال أو استورد مجموعة من نص.</p>
      ) : (
        <div className="space-y-4">
          {groups.map(({ section, items: list }, gi) =>
            !section && !list.length ? null : (
              <div key={section?.id ?? "none"} className="rounded-2xl border border-[var(--border)]">
                <div className="flex items-center gap-1.5 border-b border-[var(--border)] bg-[var(--surface-2)] px-3 py-2">
                  <b className="flex-1 text-sm">{section ? section.title : "بدون قسم"} <span className="muted text-xs font-normal">({list.length})</span></b>
                  {section && (
                    <>
                      <button className="btn btn-ghost min-h-8 px-2 text-xs" disabled={gi === 0} aria-label="القسم لفوق" onClick={() => moveSection(gi, -1)}>▲</button>
                      <button className="btn btn-ghost min-h-8 px-2 text-xs" disabled={gi === sections.length - 1} aria-label="القسم لتحت" onClick={() => moveSection(gi, 1)}>▼</button>
                      <button className="btn btn-ghost min-h-8 text-xs" onClick={async () => { const t = await askText({ title: "اسم القسم", label: "الاسم", initial: section.title, confirmLabel: "حفظ" }); if (t?.trim()) run(() => api(`/api/owner/support-faq-sections/${section.id}`, { method: "PUT", body: { title: t.trim() } })); }}>تسمية</button>
                      <button className="btn btn-ghost min-h-8 text-xs text-red-600" onClick={async () => { if (await askConfirm({ title: `حذف قسم «${section.title}»؟`, message: "أسئلته ما تنحذف — تنتقل إلى «بدون قسم».", confirmLabel: "حذف القسم", danger: true })) run(() => api(`/api/owner/support-faq-sections/${section.id}`, { method: "DELETE" })); }}>حذف</button>
                    </>
                  )}
                </div>
                <div className="divide-y divide-[var(--border)] px-3">
                  {!list.length && <p className="muted py-3 text-xs">ما فيه أسئلة في هذا القسم.</p>}
                  {list.map((f, i) => (
                    <div key={f.id} className="flex flex-wrap items-start gap-2 py-2.5">
                      <div className="min-w-0 flex-1 basis-60">
                        <b className={`block text-sm ${f.active ? "" : "muted line-through"}`}>{f.question}</b>
                        <p className="muted line-clamp-2 whitespace-pre-line text-xs">{f.answer}</p>
                        {f.video_url && <span className="text-[11px] text-violet-700 dark:text-violet-300">🎬 فيديو مرفق</span>}
                      </div>
                      <select className="input min-h-8 w-auto max-w-[150px] px-2 py-1 text-xs" value={f.section_id ?? ""} aria-label="نقل إلى قسم" onChange={(e) => run(() => api(`/api/owner/support-faq/${f.id}/move`, { body: { section_id: e.target.value ? Number(e.target.value) : null } }))}>
                        <option value="">بدون قسم</option>
                        {sections.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
                      </select>
                      <button className="btn btn-ghost min-h-8 px-2 text-xs" disabled={i === 0} aria-label="لفوق" onClick={() => moveItem(list, i, -1)}>▲</button>
                      <button className="btn btn-ghost min-h-8 px-2 text-xs" disabled={i === list.length - 1} aria-label="لتحت" onClick={() => moveItem(list, i, 1)}>▼</button>
                      <button className="btn btn-ghost min-h-8 text-xs" onClick={() => setEdit({ ...f, video_url: f.video_url ?? "", active: !!f.active })}>تعديل</button>
                      <button className="btn btn-ghost min-h-8 text-xs text-red-600" onClick={async () => { if (await askConfirm({ title: "حذف السؤال؟", message: f.question, confirmLabel: "حذف", danger: true })) run(() => api(`/api/owner/support-faq/${f.id}`, { method: "DELETE" })); }}>حذف</button>
                    </div>
                  ))}
                </div>
              </div>
            ),
          )}
        </div>
      )}
    </Card>
  );
}

/** Paste many questions at once; a preview shows what will be added before saving. */
function FaqImport({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(() => parseFaqText(text), [text]);
  const count = parsed.sections.reduce((n, s) => n + s.items.length, 0);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api<{ added: number; updated: number }>("/api/owner/support-faq/import", { body: { text } });
      toast(`انضاف ${r.added} سؤال${r.updated ? ` — وانتقل ${r.updated} موجود من قبل لقسمه` : ""}`);
      onDone();
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="استيراد أسئلة من نص">
      <div className="space-y-3">
        <p className="muted text-sm leading-relaxed">
          الصق الأسئلة بهذا الشكل: اسم القسم في سطر لحاله، وتحته كل سؤال يبدأ بـ <b>«س:»</b> وجوابه بـ <b>«ج:»</b> (الجواب يقدر يكون أكثر من سطر). لرابط فيديو اكتب سطر <b dir="ltr">فيديو: https://…</b> تحت الجواب. السطر <b>---</b> ينهي الجواب. السؤال الموجود من قبل بنفس النص ما يتكرر — ينتقل للقسم الجديد ويتحدّث جوابه.
        </p>
        <textarea className="input min-h-[14rem] text-sm" value={text} onChange={(e) => setText(e.target.value)} placeholder={"البداية والربط\n\nس: كيف أربط حساب إنستقرام؟\nج: افتح صفحة «الربط» واضغط «ربط عبر Instagram».\n\nس: هل لازم يكون حسابي احترافي؟\nج: نعم…"} />
        {text.trim() && (
          <div className="rounded-2xl border border-[var(--border)] p-3 text-sm">
            <b>المعاينة: {parsed.sections.length} قسم · {count} سؤال</b>
            <ul className="mt-2 space-y-1">
              {parsed.sections.map((s, i) => (
                <li key={i}>
                  <b>{s.title}</b> <span className="muted">({s.items.length})</span>
                  <ul className="muted mr-4 list-disc text-xs">{s.items.map((it, j) => <li key={j}>{it.question}{it.video_url ? " 🎬" : ""}</li>)}</ul>
                </li>
              ))}
            </ul>
            {parsed.ignored.length > 0 && <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">أسطر ما تنضاف ({parsed.ignored.length}): {parsed.ignored.slice(0, 3).join(" · ").slice(0, 160)}{parsed.ignored.length > 3 ? "…" : ""}</p>}
          </div>
        )}
        <div className="flex gap-2">
          <button className="btn btn-primary" disabled={busy || !count} onClick={save}>{busy ? "…" : `استيراد ${count || ""} سؤال`}</button>
          <button className="btn btn-ghost" onClick={onClose}>إلغاء</button>
        </div>
      </div>
    </Modal>
  );
}

function FaqForm({ item, sections, onDone }: { item: any; sections: FaqSection[]; onDone: () => void }) {
  const [f, setF] = useState(item);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const body = { question: f.question, answer: f.answer, video_url: f.video_url.trim(), active: f.active, section_id: f.section_id ?? null };
      if (f.id) await api(`/api/owner/support-faq/${f.id}`, { method: "PUT", body: { ...body, sort: f.sort } });
      else await api("/api/owner/support-faq", { body });
      toast("تم الحفظ");
      onDone();
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mb-4 space-y-3 rounded-2xl border border-violet-300 p-3 dark:border-violet-800">
      <Field label="القسم">
        <select className="input" value={f.section_id ?? ""} onChange={(e) => setF({ ...f, section_id: e.target.value ? Number(e.target.value) : null })}>
          <option value="">بدون قسم</option>
          {sections.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
        </select>
      </Field>
      <Field label="السؤال"><input className="input" maxLength={200} value={f.question} onChange={(e) => setF({ ...f, question: e.target.value })} /></Field>
      <Field label="الجواب"><textarea className="input min-h-[7rem]" maxLength={3000} value={f.answer} onChange={(e) => setF({ ...f, answer: e.target.value })} /></Field>
      <Field label="رابط فيديو الشرح (اختياري)" hint="يوتيوب أو إنستقرام — يبدأ بـ https://"><input className="input" dir="ltr" maxLength={300} value={f.video_url} onChange={(e) => setF({ ...f, video_url: e.target.value })} /></Field>
      <Toggle checked={f.active} onChange={(v) => setF({ ...f, active: v })} label="ظاهر للعملاء" />
      <div className="flex gap-2">
        <button className="btn btn-primary" disabled={busy || f.question.trim().length < 3 || !f.answer.trim()} onClick={save}>{busy ? "…" : "حفظ"}</button>
        <button className="btn btn-ghost" onClick={onDone}>إلغاء</button>
      </div>
    </div>
  );
}

function CannedManager() {
  const { data, reload } = useAsync(() => api<any[]>("/api/owner/support-canned"), []);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [editId, setEditId] = useState<number | null>(null);
  if (!data) return <Spinner />;
  const save = async () => {
    try {
      if (editId) await api(`/api/owner/support-canned/${editId}`, { method: "PUT", body: { title, body } });
      else await api("/api/owner/support-canned", { body: { title, body } });
      setTitle("");
      setBody("");
      setEditId(null);
      reload();
    } catch (e: any) {
      toast(e.message, "bad");
    }
  };
  return (
    <Card title="الردود الجاهزة">
      <p className="muted mb-3 text-sm">تظهر فوق مربع الرد في كل طلب — اضغطها وينكتب نصها، وتقدر تعدّله قبل الإرسال.</p>
      <div className="mb-4 space-y-2 rounded-2xl border border-[var(--border)] p-3">
        <input className="input" maxLength={60} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="اسم الرد (مثل: إعادة الربط)" />
        <textarea className="input min-h-[5rem]" maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} placeholder="نص الرد" />
        <div className="flex gap-2">
          <button className="btn btn-primary" disabled={!title.trim() || !body.trim()} onClick={save}>{editId ? "حفظ التعديل" : "إضافة"}</button>
          {editId && <button className="btn btn-ghost" onClick={() => { setEditId(null); setTitle(""); setBody(""); }}>إلغاء</button>}
        </div>
      </div>
      <div className="divide-y divide-[var(--border)]">
        {data.map((c) => (
          <div key={c.id} className="flex items-start gap-2 py-2.5">
            <div className="min-w-0 flex-1"><b className="block text-sm">⚡ {c.title}</b><p className="muted line-clamp-2 whitespace-pre-line text-xs">{c.body}</p></div>
            <button className="btn btn-ghost min-h-8 text-xs" onClick={() => { setEditId(c.id); setTitle(c.title); setBody(c.body); }}>تعديل</button>
            <button className="btn btn-ghost min-h-8 text-xs text-red-600" onClick={async () => { await api(`/api/owner/support-canned/${c.id}`, { method: "DELETE" }); reload(); }}>حذف</button>
          </div>
        ))}
      </div>
    </Card>
  );
}

function SupportSettings() {
  const { data, reload } = useAsync(() => api<{ response_time: string; default_response_time: string; incident: { active: boolean; text: string; tone: "info" | "warn" | "bad" } }>("/api/owner/support-settings"), []);
  const [rt, setRt] = useState<string | null>(null);
  const [inc, setInc] = useState<{ active: boolean; text: string; tone: "info" | "warn" | "bad" } | null>(null);
  if (!data) return <Spinner />;
  const incident = inc ?? data.incident;
  const save = async (body: Record<string, unknown>) => {
    try {
      await api("/api/owner/support-settings", { method: "PUT", body });
      toast("تم الحفظ");
      setRt(null);
      setInc(null);
      reload();
    } catch (e: any) {
      toast(e.message, "bad");
    }
  };
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card title="وقت الرد المتوقع">
        <Field label="النص اللي يشوفه العميل" hint={`فارغ = «${data.default_response_time}»`}>
          <input className="input" maxLength={160} value={rt ?? data.response_time} onChange={(e) => setRt(e.target.value)} />
        </Field>
        <button className="btn btn-primary mt-3" onClick={() => save({ response_time: (rt ?? data.response_time).trim() })}>حفظ</button>
      </Card>
      <Card title="إعلان عطل عام">
        <p className="muted mb-3 text-sm">شريط يظهر أعلى التطبيق لكل العملاء — مثل بطء مؤقت في إنستقرام أو صيانة. أوقفه لما تنحل المشكلة.</p>
        <div className="space-y-3">
          <Toggle checked={incident.active} onChange={(v) => setInc({ ...incident, active: v })} label="الإعلان ظاهر الحين" />
          <textarea className="input min-h-[5rem]" maxLength={300} value={incident.text} onChange={(e) => setInc({ ...incident, text: e.target.value })} placeholder="مثل: فيه بطء مؤقت في ردود إنستقرام، نشتغل على حله." />
          <div className="flex gap-1.5 text-xs">
            {([["info", "معلومة"], ["warn", "تنبيه"], ["bad", "عطل"]] as const).map(([k, l]) => (
              <button key={k} type="button" onClick={() => setInc({ ...incident, tone: k })} className={`rounded-lg border px-2.5 py-1 font-bold ${incident.tone === k ? "border-violet-500 bg-violet-500/10" : "border-[var(--border)] muted"}`}>{l}</button>
            ))}
          </div>
          {incident.text && <Alert tone={incident.tone}>{incident.text}</Alert>}
          <button className="btn btn-primary" onClick={() => save({ incident: { ...incident, text: incident.text.trim() } })}>حفظ الإعلان</button>
        </div>
      </Card>
    </div>
  );
}

/** Who wrote: the customer's name, login username(s), Instagram account and store. */
function Who({ t }: { t: any }) {
  return (
    <span className="text-xs">
      <b className="text-[var(--primary)]">{t.tenant_name}</b>
      <span className="muted">
        {t.tenant_usernames ? ` · اسم الحساب (الدخول): ${t.tenant_usernames}` : ""}
        {t.ig_username ? ` · @${t.ig_username}` : ""}
        {t.store_name ? ` · 🛍️ ${t.store_name}` : ""}
      </span>
    </span>
  );
}
