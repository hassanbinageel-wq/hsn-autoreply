import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Alert, Badge, PageHeader, Spinner, fmtTime, toast } from "../components/ui";

const SOURCE: Record<string, string> = { bot: "🤖 تلقائي", manual: "✍️ ردك من هنا", app: "📱 من تطبيق إنستقرام" };

function left(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h} ساعة و${m} دقيقة` : `${m} دقيقة`;
}

function Thread({ id, onSent }: { id: number; onSent: () => void }) {
  const [data, setData] = useState<any>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const load = () => api(`/api/inbox/${id}`).then(setData).catch((e) => toast(e.message, "bad"));
  useEffect(() => {
    setData(null);
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => endRef.current?.scrollIntoView({ block: "end" }), [data?.messages?.length]);

  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await api(`/api/inbox/${id}/send`, { body: { text } });
      setText("");
      await load();
      onSent();
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <Spinner />;
  const p = data.participant;
  const remaining = data.window_expires_at ? data.window_expires_at - Date.now() : 0;
  return (
    <div className="flex h-full min-h-[60vh] flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] pb-3">
        {p.username ? (
          <a href={`https://www.instagram.com/${p.username}`} target="_blank" rel="noreferrer" className="text-lg font-bold hover:underline" dir="ltr">@{p.username}</a>
        ) : (
          <span className="muted text-lg font-bold">حساب غير معروف</span>
        )}
        {p.last_follow_status && <Badge value={p.last_follow_status} />}
        {data.flows.map((f: any) => (
          <span key={f.id} className="surface-2 rounded-full px-2 py-0.5 text-xs">
            {f.campaign_name} · {f.state === "content_sent" ? "استلم ✅" : "لم يكتمل"}{f.link_clicks ? " · 🔗 ضغط الرابط" : ""}
          </span>
        ))}
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto py-3">
        {data.messages.map((m: any) => (
          <div key={m.id} className={`flex ${m.direction === "in" ? "justify-start" : "justify-end"}`}>
            <div className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${m.direction === "in" ? "surface-2 rounded-br-md" : "rounded-bl-md bg-gradient-to-l from-violet-600 to-indigo-500 text-white"}`}>
              <div className="whitespace-pre-wrap break-words">{m.text || <span className="opacity-60">(مرفق أو رسالة بدون نص)</span>}</div>
              <div className={`mt-1 text-[10px] ${m.direction === "in" ? "muted" : "opacity-70"}`}>
                {m.direction === "out" ? `${SOURCE[m.source] ?? ""} · ` : ""}
                {fmtTime(m.created_at)}
              </div>
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      {data.window_open ? (
        <div className="border-t border-[var(--border)] pt-3">
          <div className="muted mb-1 text-xs">يمكنك الرد خلال {left(remaining)} (نافذة 24 ساعة من آخر رسالة من الشخص).</div>
          <div className="flex gap-2">
            <textarea
              className="input min-h-[44px] flex-1"
              rows={2}
              maxLength={1000}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send();
              }}
              placeholder="اكتب ردك…"
            />
            <button className="btn btn-primary self-end" disabled={busy || !text.trim()} onClick={send}>إرسال</button>
          </div>
        </div>
      ) : (
        <Alert tone="info">مرّت 24 ساعة على آخر رسالة من هذا الشخص — إنستقرام لا يسمح بالرد حتى يراسلك مرة أخرى.</Alert>
      )}
    </div>
  );
}

export function InboxPage() {
  const [list, setList] = useState<any[] | null>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const load = () => api<any[]>(`/api/inbox?q=${encodeURIComponent(q)}`).then(setList).catch((e) => toast(e.message, "bad"));
  useEffect(() => {
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  return (
    <div className="space-y-4">
      <PageHeader title="الرسائل" subtitle="المحادثات التي بدأتها الأتمتة أو وصلتك عبر الخاص. الرد اليدوي متاح خلال 24 ساعة من آخر رسالة من الشخص." />
      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        <div className={`card p-3 ${open !== null ? "hidden lg:block" : ""}`}>
          <input className="input mb-2" placeholder="بحث باسم الحساب…" value={q} onChange={(e) => setQ(e.target.value)} />
          {!list ? (
            <Spinner />
          ) : !list.length ? (
            <p className="muted py-6 text-center text-sm">لا توجد محادثات بعد. ستظهر هنا بعد أول رسالة.</p>
          ) : (
            <div className="divide-y divide-[var(--border)]">
              {list.map((c) => (
                <button key={c.id} onClick={() => setOpen(c.id)} className={`flex w-full items-start gap-2 py-2.5 text-right ${open === c.id ? "bg-[var(--surface-2)]" : ""}`}>
                  <div className="h-9 w-9 shrink-0 rounded-full bg-gradient-to-br from-violet-600 via-fuchsia-600 to-orange-500" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-bold" dir="ltr">{c.username ? `@${c.username}` : "حساب غير معروف"}</span>
                      {c.unread > 0 && <span className="rounded-full bg-brand-600 px-1.5 text-[11px] text-white">{c.unread}</span>}
                      <span className="muted mr-auto shrink-0 text-[11px]">{fmtTime(c.last_message_at)}</span>
                    </div>
                    <div className="muted truncate text-xs">
                      {c.last_direction === "out" ? "↩ " : ""}
                      {c.last_text ?? ""}
                    </div>
                    {c.window_open && <div className="text-[10px] text-emerald-600">● يمكن الرد</div>}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className={`card p-4 ${open === null ? "hidden lg:block" : ""}`}>
          {open === null ? (
            <p className="muted py-10 text-center text-sm">اختر محادثة من القائمة.</p>
          ) : (
            <>
              <button className="btn btn-ghost mb-2 lg:hidden" onClick={() => setOpen(null)}>→ رجوع</button>
              <Thread id={open} onSent={load} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
