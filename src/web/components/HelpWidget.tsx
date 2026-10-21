import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { normText } from "../lib/text";
import { isNative, openExternal } from "../platform";
import { Icon } from "./Icon";
import { Alert } from "./ui";

export interface SupportCenter {
  faq: Array<{ id: number; question: string; answer: string; video_url: string | null }>;
  response_time: string;
  incident: { text: string; tone: "info" | "warn" | "bad" } | null;
}

/** The FAQ, response time and incident banner (refreshed every 5 minutes while the app is open). */
export function useSupportCenter(): SupportCenter | null {
  const [data, setData] = useState<SupportCenter | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => api<SupportCenter>("/api/public/support").then((d) => live && setData(d)).catch(() => undefined);
    load();
    const t = setInterval(load, 5 * 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return data;
}

/** The service-wide incident notice set by the owner, on top of every page. */
export function IncidentBanner({ center }: { center: SupportCenter | null }) {
  if (!center?.incident) return null;
  return (
    <div className="mb-4">
      <Alert tone={center.incident.tone}>📢 {center.incident.text}</Alert>
    </div>
  );
}

/**
 * Floating help button (bottom-left): search the FAQ (with video links), the expected response time, and
 * «فتح طلب دعم». The owner sees the same FAQ with a link to manage it.
 */
export function HelpWidget({ center, isOwner }: { center: SupportCenter | null; isOwner: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [shown, setShown] = useState<number | null>(null);
  const faq = center?.faq ?? [];
  const results = useMemo(() => {
    const nq = normText(q);
    if (!nq) return faq;
    const words = nq.split(/\s+/).filter(Boolean);
    return faq.filter((f) => {
      const hay = normText(`${f.question} ${f.answer}`);
      return words.every((w) => hay.includes(w));
    });
  }, [faq, q]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  const go = (to: string) => {
    setOpen(false);
    location.hash = to;
  };
  const video = (url: string) => (isNative ? openExternal(url) : window.open(url, "_blank", "noopener"));
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="مركز المساعدة"
        className="grad fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom))] left-4 z-40 flex h-12 w-12 items-center justify-center rounded-full text-xl font-extrabold text-white shadow-lg shadow-violet-500/40 lg:bottom-6 lg:left-6 lg:h-14 lg:w-14"
      >
        {open ? <Icon name="x" size={22} /> : "؟"}
      </button>
      {open && (
        <div role="dialog" aria-label="مركز المساعدة" className="card fixed bottom-[calc(9.5rem+env(safe-area-inset-bottom))] left-4 right-4 z-40 flex max-h-[min(70vh,560px)] flex-col overflow-hidden p-0 shadow-2xl sm:right-auto sm:w-[380px] lg:bottom-24 lg:left-6">
          <div className="grad p-4 text-white">
            <b className="font-display block text-lg">كيف نقدر نساعدك؟</b>
            <span className="text-xs text-white/85">{center?.response_time}</span>
            <div className="relative mt-3">
              <input autoFocus className="w-full rounded-xl border-0 bg-white/95 px-3 py-2.5 pr-9 text-sm text-slate-900 outline-none placeholder:text-slate-500" value={q} onChange={(e) => { setQ(e.target.value); setShown(null); }} placeholder="ابحث في الأسئلة الشائعة" aria-label="بحث" />
              <Icon name="search" size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500" />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {center?.incident && <div className="p-1"><Alert tone={center.incident.tone}>{center.incident.text}</Alert></div>}
            {!center ? (
              <p className="muted p-4 text-center text-sm">جارٍ التحميل…</p>
            ) : !results.length ? (
              <p className="muted p-4 text-center text-sm">{faq.length ? "ما لقينا سؤال مطابق — افتح طلب دعم ونرد عليك." : "افتح طلب دعم ونرد عليك."}</p>
            ) : (
              results.map((f) => (
                <div key={f.id} className="rounded-xl">
                  <button type="button" onClick={() => setShown(shown === f.id ? null : f.id)} aria-expanded={shown === f.id} className="flex w-full items-start gap-2 rounded-xl px-2.5 py-2.5 text-right text-sm font-bold hover:bg-[var(--surface-2)]">
                    <Icon name="chev" size={14} className={`mt-1 shrink-0 transition ${shown === f.id ? "rotate-180" : ""}`} />
                    <span className="flex-1">{f.question}</span>
                    {f.video_url && <span aria-label="فيه فيديو">🎬</span>}
                  </button>
                  {shown === f.id && (
                    <div className="px-3 pb-3 pr-8 text-sm leading-relaxed">
                      <p className="muted whitespace-pre-line">{f.answer}</p>
                      {f.video_url && (
                        <button type="button" className="btn btn-ghost mt-2 min-h-9 text-xs" onClick={() => video(f.video_url!)}>
                          <Icon name="play" size={14} />شاهد الفيديو
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
          <div className="flex gap-2 border-t border-[var(--border)] p-3">
            {isOwner ? (
              <button type="button" className="btn btn-primary flex-1" onClick={() => go("/owner?tab=support")}>إدارة الدعم والأسئلة</button>
            ) : (
              <>
                <button type="button" className="btn btn-primary flex-1" onClick={() => go("/support?new=1")}><Icon name="plus" size={15} />فتح طلب دعم</button>
                <button type="button" className="btn btn-ghost" onClick={() => go("/support")}>طلباتي</button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
