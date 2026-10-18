import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Alert, Card, PageHeader, Spinner, fmtTime, toast } from "../components/ui";

/**
 * In-app support. Customers: their conversations with the service owner (new question, replies).
 * Owner (inside the owner panel): every customer's conversations, reply, close.
 */
export function SupportPage() {
  return (
    <div className="space-y-5">
      <PageHeader title="الدعم" subtitle="اسأل أو بلّغ عن مشكلة — يوصلنا على طول، ويوصلك الرد هنا وفي جرس الإشعارات." />
      <SupportInbox mode="customer" />
    </div>
  );
}

export function SupportInbox({ mode }: { mode: "customer" | "owner" }) {
  const base = mode === "owner" ? "/api/owner/support" : "/api/support";
  const [list, setList] = useState<any[] | null>(null);
  const [open, setOpen] = useState<number | null>(() => Number(new URLSearchParams(location.hash.split("?")[1] ?? "").get("thread")) || null);
  const [creating, setCreating] = useState(false);
  const load = () => api<any[]>(base).then(setList).catch((e) => toast(e.message, "bad"));
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
      <div className={`card min-w-0 p-2 sm:p-3 ${open !== null || creating ? "hidden lg:block" : ""}`}>
        {mode === "customer" && <button className="btn btn-primary mb-2 w-full" onClick={() => { setCreating(true); setOpen(null); }}>+ رسالة جديدة للدعم</button>}
        {!list ? <Spinner /> : !list.length ? (
          <p className="muted py-6 text-center text-sm">{mode === "owner" ? "ما فيه رسائل دعم من العملاء بعد." : "ما عندك محادثات بعد. اكتب لنا أي سؤال أو مشكلة."}</p>
        ) : (
          <div className="divide-y divide-[var(--border)]">
            {list.map((t) => (
              <button key={t.id} onClick={() => { setOpen(t.id); setCreating(false); }} className={`flex w-full flex-col gap-0.5 rounded-xl px-2.5 py-2.5 text-right transition hover:bg-[var(--surface-2)] ${open === t.id ? "bg-violet-500/10" : ""}`}>
                <div className="flex items-center gap-2">
                  <b className="min-w-0 flex-1 truncate text-sm">{t.subject}</b>
                  {!!t.unread && <span className="h-2 w-2 shrink-0 rounded-full bg-pink-600" aria-label="جديد" />}
                  <span className={`chip shrink-0 !py-0 text-[10px] ${t.status === "open" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" : "surface-2 muted"}`}>{t.status === "open" ? "مفتوحة" : "مغلقة"}</span>
                </div>
                {mode === "owner" && <Who t={t} />}
                <span className="muted truncate text-xs">{t.last_from === "owner" ? "↩ " : ""}{t.last_body}</span>
                <span className="muted text-[10.5px]">{fmtTime(t.updated_at)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className={`card min-w-0 p-3 sm:p-4 ${open === null && !creating ? "hidden lg:block" : ""}`}>
        {creating ? (
          <NewThread onDone={(id) => { setCreating(false); load(); if (id) setOpen(id); }} />
        ) : open === null ? (
          <p className="muted py-10 text-center text-sm">اختر محادثة.</p>
        ) : (
          <Thread key={open} id={open} base={base} mode={mode} onBack={() => setOpen(null)} onChange={load} />
        )}
      </div>
    </div>
  );
}

function NewThread({ onDone }: { onDone: (id?: number) => void }) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      const r = await api<{ id: number }>("/api/support", { body: { subject, body } });
      toast("وصلت رسالتك ✅ بنرد عليك قريب");
      onDone(r.id);
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <b>رسالة جديدة للدعم</b>
      <input className="input" placeholder="الموضوع (مثل: الحملة ما ترد، سؤال عن الباقات…)" maxLength={120} value={subject} onChange={(e) => setSubject(e.target.value)} />
      <textarea className="input min-h-[9rem]" placeholder="اكتب التفاصيل…" maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} />
      <p className="muted text-xs">لا تكتب كلمات مرور أو أكواد سرية في الرسالة.</p>
      <div className="flex gap-2">
        <button className="btn btn-primary" disabled={busy || subject.trim().length < 3 || !body.trim()} onClick={send}>{busy ? "…" : "إرسال"}</button>
        <button className="btn btn-ghost" onClick={() => onDone()}>إلغاء</button>
      </div>
    </div>
  );
}

function Thread({ id, base, mode, onBack, onChange }: { id: number; base: string; mode: "customer" | "owner"; onBack: () => void; onChange: () => void }) {
  const [data, setData] = useState<any>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const load = () => api(`${base}/${id}`).then(setData).catch((e) => toast(e.message, "bad"));
  useEffect(() => {
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [data?.messages?.length]);
  const send = async (close = false) => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await api(`${base}/${id}/reply`, { body: mode === "owner" ? { body: text, close } : { body: text } });
      setText("");
      await load();
      onChange();
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  if (!data) return <Spinner />;
  const mine = mode === "owner" ? "owner" : "customer";
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--border)] pb-3">
        <button className="btn btn-ghost h-9 w-9 p-0 lg:hidden" aria-label="رجوع" onClick={onBack}>→</button>
        <div className="min-w-0 flex-1">
          <b className="block truncate">{data.thread.subject}</b>
          {mode === "owner" && <Who t={data.thread} />}
        </div>
        {mode === "owner" && (
          <button className="btn btn-ghost min-h-9 text-xs" onClick={async () => { await api(`${base}/${id}/status`, { body: { status: data.thread.status === "open" ? "closed" : "open" } }); await load(); onChange(); }}>
            {data.thread.status === "open" ? "إغلاق" : "إعادة فتح"}
          </button>
        )}
      </div>
      <div ref={box} className="-mx-3 h-[50vh] min-h-[240px] space-y-2 overflow-y-auto bg-[var(--surface-2)] px-3 py-3 sm:-mx-4 sm:px-4">
        {data.messages.map((m: any) => (
          <div key={m.id} className={`flex ${m.sender === mine ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed shadow-sm ${m.sender === mine ? "bg-gradient-to-br from-violet-600 to-indigo-500 text-white" : "border border-[var(--border)] bg-[var(--surface)]"}`}>
              <div className="mb-0.5 text-[10.5px] opacity-75">{m.sender === "owner" ? "🎧 الدعم" : mode === "owner" ? data.thread.tenant_name : "أنت"}</div>
              <div className="whitespace-pre-wrap break-words">{m.body}</div>
              <div className="mt-1 text-[10.5px] opacity-70">{fmtTime(m.created_at)}</div>
            </div>
          </div>
        ))}
      </div>
      {data.thread.status === "closed" && mode === "customer" && <div className="pt-2"><Alert tone="info">المحادثة مغلقة — إذا كتبت رسالة تنفتح من جديد.</Alert></div>}
      <div className="flex items-end gap-2 border-t border-[var(--border)] pt-2.5">
        <textarea className="input min-h-[44px] flex-1 resize-none" rows={2} maxLength={2000} placeholder="اكتب ردك…" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="flex flex-col gap-1">
          <button className="btn btn-primary" disabled={busy || !text.trim()} onClick={() => send(false)}>{busy ? "…" : "إرسال"}</button>
          {mode === "owner" && <button className="btn btn-ghost min-h-8 text-[11px]" disabled={busy || !text.trim()} onClick={() => send(true)}>إرسال وإغلاق</button>}
        </div>
      </div>
    </div>
  );
}

/** Owner panel tab. */
export function OwnerSupportTab() {
  return (
    <Card title="رسائل الدعم من العملاء">
      <SupportInbox mode="owner" />
    </Card>
  );
}

/** Who wrote: the customer's name, login username(s), Instagram account and store. */
function Who({ t }: { t: any }) {
  return (
    <span className="text-xs">
      <b className="text-[var(--primary)]">{t.tenant_name}</b>
      <span className="muted">
        {t.tenant_usernames ? ` · اسم المتجر (الدخول): ${t.tenant_usernames}` : ""}
        {t.ig_username ? ` · @${t.ig_username}` : ""}
        {t.store_name ? ` · 🛍️ ${t.store_name}` : ""}
      </span>
    </span>
  );
}
