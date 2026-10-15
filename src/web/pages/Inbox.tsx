import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Alert, Badge, PageHeader, Spinner, fmtTime, toast } from "../components/ui";
import { UserAvatar } from "../components/UserAvatar";
import { Icon } from "../components/Icon";

const SOURCE: Record<string, string> = { bot: "🤖 تلقائي", manual: "✍️ ردك من هنا", app: "📱 من تطبيق إنستقرام" };

function left(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h} ساعة و${m} دقيقة` : `${m} دقيقة`;
}

function Thread({ id, onSent, onBack }: { id: number; onSent: () => void; onBack: () => void }) {
  const [data, setData] = useState<any>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // The reply box grows with the text (up to about 5 lines), then scrolls.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);
  const load = () => api(`/api/inbox/${id}`).then(setData).catch((e) => toast(e.message, "bad"));
  useEffect(() => {
    setData(null);
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  // Scroll only the conversation box (never the page) to the newest message.
  useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [data?.messages?.length]);

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
    <div className="flex flex-col">
      <div className="flex items-center gap-2.5 border-b border-[var(--border)] pb-3">
        <button type="button" className="btn btn-ghost h-10 w-10 shrink-0 p-0 lg:hidden" aria-label="رجوع للمحادثات" onClick={onBack}>
          <Icon name="arrowL" size={18} className="rotate-180" />
        </button>
        <UserAvatar url={p.profile_pic_url} name={p.username} size={40} />
        <div className="min-w-0 flex-1">
          {p.username ? (
            <a href={`https://www.instagram.com/${p.username}`} target="_blank" rel="noreferrer" className="block truncate font-bold hover:underline" dir="ltr" style={{ textAlign: "right" }}>@{p.username}</a>
          ) : (
            <span className="muted font-bold">حساب غير معروف</span>
          )}
          <div className="muted truncate text-xs">
            {data.flows.length ? data.flows.map((f: any) => `${f.campaign_name} · ${f.state === "content_sent" ? "استلم المحتوى" : "لم يكتمل"}${f.link_clicks ? " · ضغط الرابط" : ""}`).join(" | ") : "بدون حملات"}
          </div>
        </div>
        {p.username && (
          <a href={`https://www.instagram.com/${p.username}`} target="_blank" rel="noreferrer" className="btn btn-ghost h-10 shrink-0 px-2.5 text-xs" aria-label="فتح المحادثة في إنستقرام">
            <Icon name="instagram" size={17} /><span className="hidden sm:inline">إنستقرام</span>
          </a>
        )}
      </div>
      <div className="flex gap-1.5 overflow-x-auto py-2 [scrollbar-width:none]">
        {data.window_open ? (
          <span className="chip shrink-0 bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300"><Icon name="clock" size={13} />يمكن الرد · باقي {left(remaining)}</span>
        ) : (
          <span className="chip surface-2 muted shrink-0"><Icon name="clock" size={13} />انتهت مدة الرد</span>
        )}
        {p.last_follow_status && <span className="shrink-0"><Badge value={p.last_follow_status} /></span>}
      </div>
      <div ref={boxRef} className="-mx-3 h-[calc(100dvh-23rem)] min-h-[220px] space-y-2 overflow-y-auto overscroll-contain bg-[var(--surface-2)] px-3 py-3 sm:-mx-4 sm:px-4 lg:h-[56vh] lg:min-h-[280px]">
        {data.messages.map((m: any) => (
          <div key={m.id} className={`flex ${m.direction === "in" ? "justify-start" : "justify-end"}`}>
            <div className={`max-w-[86%] rounded-2xl px-3 py-2 text-[15px] leading-relaxed shadow-sm sm:max-w-[78%] sm:px-3.5 sm:py-2.5 sm:text-sm ${m.direction === "in" ? "rounded-br-md border border-[var(--border)] bg-[var(--surface)]" : "rounded-bl-md bg-gradient-to-br from-violet-600 to-indigo-500 text-white"}`}>
              {m.direction === "out" && SOURCE[m.source] && <div className="mb-0.5 text-[10.5px] opacity-75">{SOURCE[m.source]}</div>}
              <div className="whitespace-pre-wrap break-words">{m.text || <span className="opacity-60">(مرفق أو رسالة بدون نص)</span>}</div>
              <div className={`mt-1 text-[10.5px] ${m.direction === "in" ? "muted" : "opacity-75"}`}>{fmtTime(m.created_at)}</div>
            </div>
          </div>
        ))}
      </div>
      {data.window_open ? (
        <div className="border-t border-[var(--border)] pt-2.5">
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              className="input min-h-[44px] min-w-0 flex-1 resize-none rounded-3xl py-2.5 leading-snug"
              rows={1}
              maxLength={1000}
              value={text}
              aria-label="ردك"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send();
              }}
              placeholder="اكتب ردك…"
            />
            <button className="btn btn-primary h-11 w-11 shrink-0 rounded-full p-0 sm:w-auto sm:px-5" disabled={busy || !text.trim()} onClick={send} aria-label="إرسال">
              <Icon name="send" size={18} /><span className="hidden sm:inline">{busy ? "…" : "إرسال"}</span>
            </button>
          </div>
          <div className="muted mt-1.5 text-[11px]">يُرسل من حسابك · تقدر ترد خلال {left(remaining)} (24 ساعة من آخر رسالة منه).</div>
        </div>
      ) : (
        <div className="pt-3"><Alert tone="info">مرّت 24 ساعة على آخر رسالة من هذا الشخص، وإنستقرام ما يسمح بالرد لين يراسلك مرة ثانية.</Alert></div>
      )}
    </div>
  );
}

export function InboxPage() {
  const [list, setList] = useState<any[] | null>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const load = () => api<any[]>(`/api/inbox?q=${encodeURIComponent(q)}`).then(setList).catch((e) => toast(e.message, "bad"));
  // Fill missing / expired profile pictures once per visit (small batches, official User Profile API).
  useEffect(() => {
    let stop = false;
    (async () => {
      for (let i = 0; i < 4 && !stop; i++) {
        const r = await api<{ checked: number; updated: number }>("/api/inbox/avatars", { body: {} }).catch(() => null);
        if (!r || !r.checked) break;
        if (r.updated) load();
      }
    })();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  return (
    <div className="space-y-4">
      <div className={open !== null ? "hidden lg:block" : ""}>
        <PageHeader title="الرسائل" subtitle="المحادثات التي بدأتها الأتمتة أو وصلتك عبر الخاص. الرد اليدوي متاح خلال 24 ساعة من آخر رسالة من الشخص." />
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
        <div className={`card min-w-0 p-2 sm:p-3 ${open !== null ? "hidden lg:block" : ""}`}>
          <input className="input mb-2" placeholder="بحث باسم الحساب…" value={q} onChange={(e) => setQ(e.target.value)} />
          {!list ? (
            <Spinner />
          ) : !list.length ? (
            <p className="muted py-6 text-center text-sm">لا توجد محادثات بعد. ستظهر هنا بعد أول رسالة.</p>
          ) : (
            <div className="divide-y divide-[var(--border)]">
              {list.map((c) => (
                <button key={c.id} onClick={() => setOpen(c.id)} className={`flex w-full items-start gap-2.5 rounded-xl px-2 py-2.5 text-right transition hover:bg-[var(--surface-2)] ${open === c.id ? "bg-violet-500/10 shadow-[inset_-3px_0_0_#7c3aed]" : ""}`}>
                  <UserAvatar url={c.profile_pic_url} name={c.username} size={40} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 truncate font-bold" dir="ltr">{c.username ? `@${c.username}` : "حساب غير معروف"}</span>
                      {c.unread > 0 && <span className="rounded-full bg-pink-600 px-1.5 text-[11px] text-white">{c.unread}</span>}
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
        <div className={`card min-w-0 p-3 sm:p-4 ${open === null ? "hidden lg:block" : ""}`}>
          {open === null ? (
            <p className="muted py-10 text-center text-sm">اختر محادثة من القائمة.</p>
          ) : (
            <Thread id={open} onSent={load} onBack={() => setOpen(null)} />
          )}
        </div>
      </div>
    </div>
  );
}
