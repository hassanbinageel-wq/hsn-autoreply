import { DmMenuEditor, MenuHelp } from "../components/DmMenuEditor";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { askText } from "../components/Confirm";
import { Alert, Badge, PageHeader, Spinner, fmtTime, toast } from "../components/ui";
import { UserAvatar } from "../components/UserAvatar";
import { Icon } from "../components/Icon";

export const LABELS: Record<string, { text: string; cls: string; icon: string }> = {
  inquiry: { text: "استفسار", icon: "❓", cls: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300" },
  order: { text: "طلب", icon: "🛒", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" },
  complaint: { text: "شكوى", icon: "⚠️", cls: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300" },
  other: { text: "أخرى", icon: "💬", cls: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300" },
};

/** A built-in label, or one the merchant typed (shown with a tag icon). */
const labelInfo = (label: string) => LABELS[label] ?? { text: label, icon: "🏷️", cls: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300" };

function LabelChip({ label, auto }: { label: string | null; auto?: boolean }) {
  const l = label ? labelInfo(label) : null;
  if (!l) return null;
  return <span className={`chip shrink-0 !py-0 text-[10.5px] ${l.cls}`} title={auto ? "تصنيف تلقائي من كلام الشخص — تقدر تغيّره" : undefined}>{l.icon} {l.text}{auto ? " ·تلقائي" : ""}</span>;
}

const SOURCE: Record<string, string> = { bot: "🤖 تلقائي", manual: "✍️ ردك من هنا", app: "📱 من تطبيق إنستقرام" };

function left(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h} ساعة و${m} دقيقة` : `${m} دقيقة`;
}

function Thread({ id, onSent, onBack, custom }: { id: number; onSent: () => void; onBack: () => void; custom: string[] }) {
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
        <select
          className="input !h-8 !min-h-0 !w-auto shrink-0 !py-0 text-xs"
          aria-label="تصنيف المحادثة"
          value={p.inbox_label ?? ""}
          onChange={async (e) => {
            let v: string | null = e.target.value || null;
            if (v === "__new") {
              v = (await askText({ title: "تصنيف جديد", label: "اكتب اسم التصنيف (مثل: عميل مهم، بانتظار الدفع)", confirmLabel: "حفظ" }))?.trim().slice(0, 24) || null;
              if (!v) return;
            }
            await api(`/api/inbox/${id}/label`, { method: "PUT", body: { label: v } }).catch((err) => toast(err.message, "bad"));
            await load();
            onSent();
          }}
        >
          <option value="">🏷️ بدون تصنيف</option>
          {Object.entries(LABELS).map(([k, l]) => <option key={k} value={k}>{l.icon} {l.text}{p.inbox_label === k && p.inbox_label_source === "auto" ? " (تلقائي)" : ""}</option>)}
          {[...new Set([...custom, ...(p.inbox_label && !LABELS[p.inbox_label] ? [p.inbox_label] : [])])].map((c) => <option key={c} value={c}>🏷️ {c}</option>)}
          <option value="__new">✏️ تصنيف جديد…</option>
        </select>
      </div>
      <div ref={boxRef} className="-mx-3 h-[calc(100dvh-23rem)] min-h-[220px] space-y-2 overflow-y-auto overscroll-contain bg-[var(--surface-2)] px-3 py-3 sm:-mx-4 sm:px-4 lg:h-[56vh] lg:min-h-[280px]">
        {data.messages.map((m: any) => (
          <div key={m.id} className={`flex ${m.direction === "in" ? "justify-start" : "justify-end"}`}>
            <div className={`max-w-[86%] rounded-2xl px-3 py-2 text-[15px] leading-relaxed shadow-sm sm:max-w-[78%] sm:px-3.5 sm:py-2.5 sm:text-sm ${m.direction === "in" ? "rounded-br-md border border-[var(--border)] bg-[var(--surface)]" : "rounded-bl-md bg-gradient-to-br from-violet-600 to-indigo-500 text-white"}`}>
              {m.direction === "out" && SOURCE[m.source] && <div className="mb-0.5 text-[10.5px] opacity-75">{SOURCE[m.source]}{m.sent_by ? ` · ${m.sent_by}` : ""}</div>}
              <div className="whitespace-pre-wrap break-words">{m.text || <span className="opacity-60">(مرفق أو رسالة بدون نص)</span>}</div>
              <div className={`mt-1 text-[10.5px] ${m.direction === "in" ? "muted" : "opacity-75"}`}>{fmtTime(m.created_at)}</div>
            </div>
          </div>
        ))}
      </div>
      {data.window_open ? (
        <div className="border-t border-[var(--border)] pt-2.5">
          <SavedReplies onPick={(body) => { setText((t) => (t.trim() ? `${t.trim()}\n${body}` : body)); inputRef.current?.focus(); }} username={p.username} />
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
  const [view, setView] = useState<"chats" | "menu">(() => (location.hash.includes("view=menu") ? "menu" : "chats"));
  const [help, setHelp] = useState(false);
  if (view === "menu")
    return (
      <div className="space-y-4">
        <PageHeader
          title="الرسائل"
          subtitle="رسالة بأزرار توصل للي يراسلك أو يكتب كلمة تحددها، وكل زر يفتح محتوى ورابط وأزرار جديدة."
          actions={<button type="button" className="min-h-10 px-1 text-sm font-bold underline decoration-red-500 decoration-1 underline-offset-[6px] hover:text-red-600" onClick={() => setHelp(true)}>كيف تشتغل؟</button>}
        />
        <MenuHelp open={help} onClose={() => setHelp(false)} />
        <InboxTabs view={view} setView={setView} />
        <DmMenuEditor />
      </div>
    );
  return <Chats tabs={<InboxTabs view={view} setView={setView} />} />;
}

function InboxTabs({ view, setView }: { view: "chats" | "menu"; setView: (v: "chats" | "menu") => void }) {
  return (
    <div className="flex gap-1.5">
      {([["chats", "المحادثات"], ["menu", "القائمة التلقائية"]] as const).map(([k, l]) => (
        <button key={k} type="button" onClick={() => setView(k)} className={`rounded-xl border px-3 py-1.5 text-sm font-bold ${view === k ? "border-violet-500 bg-violet-500/10 text-violet-700 dark:text-violet-300" : "border-[var(--border)] muted"}`}>{l}</button>
      ))}
    </div>
  );
}

function Chats({ tabs }: { tabs: React.ReactNode }) {
  const [list, setList] = useState<any[] | null>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [label, setLabel] = useState("");
  const [counts, setCounts] = useState<Record<string, number>>({});
  // Labels the merchant typed themselves (anything that is not a built-in one).
  const custom = Object.keys(counts).filter((k) => k !== "none" && !LABELS[k]).sort();
  const load = () => {
    api<Array<{ label: string | null; n: number }>>("/api/inbox-labels").then((r) => setCounts(Object.fromEntries(r.map((x) => [x.label ?? "none", x.n])))).catch(() => undefined);
    return api<any[]>(`/api/inbox?q=${encodeURIComponent(q)}&label=${encodeURIComponent(label)}`).then(setList).catch((e) => toast(e.message, "bad"));
  };
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
  }, [q, label]);

  return (
    <div className="space-y-4">
      <div className={open !== null ? "hidden lg:block" : ""}>
        <PageHeader title="الرسائل" subtitle="المحادثات التي بدأتها الأتمتة أو وصلتك عبر الخاص. الرد اليدوي متاح خلال 24 ساعة من آخر رسالة من الشخص." />
        <div className="mt-3">{tabs}</div>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
        <div className={`card min-w-0 p-2 sm:p-3 ${open !== null ? "hidden lg:block" : ""}`}>
          <input className="input mb-2" placeholder="بحث باسم الحساب…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="mb-2 flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none]" role="group" aria-label="تصفية حسب التصنيف">
            {[["", "الكل", ""], ...Object.entries(LABELS).map(([k, l]) => [k, l.text, l.icon]), ...custom.map((c) => [c, c, "🏷️"]), ["none", "بدون تصنيف", "🏷️"]].map(([k, t, ic]) => (
              <button key={k} type="button" aria-pressed={label === k} onClick={() => setLabel(k)} className={`chip shrink-0 ${label === k ? "grad text-white" : "surface-2"}`}>
                {ic} {t}{k && counts[k] ? <span className="opacity-75"> {counts[k]}</span> : null}
              </button>
            ))}
          </div>
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
                    <div className="mt-0.5 flex items-center gap-1.5">
                      <LabelChip label={c.inbox_label} auto={c.inbox_label_source === "auto"} />
                      {c.window_open && <span className="text-[10px] text-emerald-600">● يمكن الرد</span>}
                    </div>
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
            <Thread id={open} onSent={load} onBack={() => setOpen(null)} custom={custom} />
          )}
        </div>
      </div>
    </div>
  );
}

/** Saved replies: tap to insert into the reply box; add, edit and delete in place. {{username}} is filled in. */
function SavedReplies({ onPick, username }: { onPick: (body: string) => void; username: string | null }) {
  const [items, setItems] = useState<any[] | null>(null);
  const [edit, setEdit] = useState<any | null>(null);
  const load = () => api<any[]>("/api/saved-replies").then(setItems).catch(() => setItems([]));
  useEffect(() => {
    load();
  }, []);
  const save = async () => {
    try {
      const body = { title: edit.title, body: edit.body };
      if (edit.id) await api(`/api/saved-replies/${edit.id}`, { method: "PUT", body });
      else await api("/api/saved-replies", { body });
      setEdit(null);
      load();
    } catch (e: any) {
      toast(e.message, "bad");
    }
  };
  if (!items) return null;
  return (
    <div className="mb-2">
      <div className="flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none]">
        {items.map((r) => (
          <span key={r.id} className="chip surface-2 shrink-0 !pe-1">
            <button
              type="button"
              title={r.body}
              onClick={() => {
                onPick(r.body.replace(/\{\{\s*username\s*\}\}/g, username ? `@${username}` : ""));
                api(`/api/saved-replies/${r.id}/use`, { body: {} }).catch(() => undefined);
              }}
            >
              ⚡ {r.title}
            </button>
            <button type="button" className="muted ms-1 rounded px-1 hover:bg-[var(--surface)]" aria-label={`تعديل ${r.title}`} onClick={() => setEdit({ ...r })}>✎</button>
          </span>
        ))}
        <button type="button" className="chip shrink-0 border border-dashed border-[var(--border)]" onClick={() => setEdit({ title: "", body: "" })}>+ رد محفوظ</button>
      </div>
      {edit && (
        <div className="surface-2 mt-1 space-y-2 rounded-2xl p-3">
          <input className="input" placeholder="اسم مختصر (مثل: السعر، الشحن، المقاسات)" maxLength={60} value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
          <textarea className="input min-h-[5rem]" placeholder="نص الرد… تقدر تكتب {{username}} ويتعبّى باسم الشخص" maxLength={1000} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} />
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary min-h-9 text-sm" disabled={!edit.title.trim() || !edit.body.trim()} onClick={save}>حفظ</button>
            <button type="button" className="btn btn-ghost min-h-9 text-sm" onClick={() => setEdit(null)}>إلغاء</button>
            {edit.id && (
              <button type="button" className="btn btn-danger min-h-9 text-sm" onClick={async () => {
                await api(`/api/saved-replies/${edit.id}`, { method: "DELETE" }).catch((e) => toast(e.message, "bad"));
                setEdit(null);
                load();
              }}>حذف</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
