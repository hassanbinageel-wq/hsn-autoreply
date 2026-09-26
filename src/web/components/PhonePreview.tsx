import { useEffect, useRef, useState } from "react";

export interface ChatMsg {
  from: "bot" | "user";
  text: string;
  buttons?: string[];
  note?: string; // small grey caption (e.g. "رد خاص على التعليق")
}

export interface CommentMsg {
  username: string;
  text: string;
  isOwner?: boolean;
}

export interface PhonePreviewProps {
  accountUsername: string;
  avatarUrl?: string | null;
  postImage?: string | null;
  postCaption?: string | null;
  comments?: CommentMsg[];
  dm: ChatMsg[];
  defaultTab?: "post" | "comments" | "dm";
  footnote?: string;
}

function Avatar({ url, size = 28 }: { url?: string | null; size?: number }) {
  return url ? (
    <img src={url} alt="" referrerPolicy="no-referrer" className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />
  ) : (
    <div className="shrink-0 rounded-full bg-gradient-to-br from-violet-600 via-fuchsia-600 to-orange-500" style={{ width: size, height: size }} />
  );
}

/** Instagram-like phone mockup used as a live preview. Pure presentation — nothing is sent. */
export function PhonePreview(p: PhonePreviewProps) {
  const [tab, setTab] = useState<"post" | "comments" | "dm">(p.defaultTab ?? "dm");
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight; // always show the latest message
  }, [p.dm, p.comments, tab]);
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="w-[300px] rounded-[2.5rem] border-[10px] border-slate-900 bg-black shadow-2xl dark:border-slate-700" dir="rtl">
        <div className="mx-auto mt-2 h-5 w-24 rounded-full bg-slate-900 dark:bg-slate-700" aria-hidden />
        {/* header */}
        <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2.5 text-white">
          <span className="text-lg" aria-hidden>›</span>
          <Avatar url={p.avatarUrl} />
          <span className="truncate text-sm font-bold" dir="ltr">{p.accountUsername}</span>
          <span className="mr-auto text-sm opacity-70" aria-hidden>📞 🎥</span>
        </div>
        {/* body */}
        <div ref={bodyRef} className="h-[460px] overflow-y-auto scroll-smooth px-3 py-3 text-[13px] leading-relaxed text-white">
          {tab === "post" && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Avatar url={p.avatarUrl} size={24} />
                <span className="text-xs font-bold" dir="ltr">{p.accountUsername}</span>
              </div>
              {p.postImage ? (
                <img src={p.postImage} alt="" referrerPolicy="no-referrer" className="aspect-[4/5] w-full rounded-md object-cover" />
              ) : (
                <div className="flex aspect-[4/5] w-full items-center justify-center rounded-md bg-gradient-to-br from-violet-700/60 via-fuchsia-700/50 to-orange-600/50 text-4xl">🎬</div>
              )}
              <div className="text-xs opacity-80">♡ 💬 ➤</div>
              {p.postCaption && <div className="line-clamp-3 text-xs opacity-90">{p.postCaption}</div>}
            </div>
          )}
          {tab === "comments" && (
            <div className="space-y-3">
              {(p.comments ?? []).length === 0 && <div className="py-10 text-center text-xs opacity-60">لا توجد تعليقات في هذا النوع من الحملات</div>}
              {(p.comments ?? []).map((c, i) => (
                <div key={i} className={`flex gap-2 ${c.isOwner ? "mr-8" : ""}`}>
                  {c.isOwner ? <Avatar url={p.avatarUrl} size={24} /> : <div className="h-6 w-6 shrink-0 rounded-full bg-slate-600" />}
                  <div>
                    <span className="ml-1 text-xs font-bold" dir="ltr">{c.username}</span>
                    <span className="whitespace-pre-wrap">{c.text}</span>
                    <div className="text-[10px] opacity-50">الآن · رد</div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {tab === "dm" && (
            <div className="flex flex-col gap-2.5">
              {p.dm.map((m, i) =>
                m.from === "bot" ? (
                  <div key={i} className="flex items-end gap-1.5">
                    <Avatar url={p.avatarUrl} size={22} />
                    <div className="max-w-[80%]">
                      {m.note && <div className="mb-0.5 text-[10px] opacity-50">{m.note}</div>}
                      <div className="rounded-2xl rounded-br-md bg-[#262626] px-3 py-2">
                        <div className="whitespace-pre-wrap break-words">{m.text}</div>
                        {m.buttons?.map((b) => (
                          <div key={b} className="mt-2 rounded-lg bg-white/10 py-1.5 text-center text-xs font-semibold">{b}</div>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div key={i} className="flex justify-end">
                    <div className="max-w-[75%] rounded-2xl rounded-bl-md bg-gradient-to-l from-violet-600 to-indigo-500 px-3 py-2 whitespace-pre-wrap break-words">
                      {m.text}
                    </div>
                  </div>
                ),
              )}
            </div>
          )}
        </div>
        {/* input bar */}
        <div className="flex items-center gap-2 border-t border-white/10 px-3 py-2.5 text-white/60">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-sky-500 text-white" aria-hidden>📷</span>
          <span className="text-xs">مراسلة…</span>
        </div>
        <div className="mx-auto mb-2 h-1 w-24 rounded-full bg-white/40" aria-hidden />
      </div>
      <div className="surface-2 flex rounded-full p-1 text-sm" role="tablist">
        {([
          ["post", "المنشور"],
          ["comments", "التعليقات"],
          ["dm", "الخاص"],
        ] as const).map(([k, v]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`rounded-full px-4 py-1.5 font-semibold ${tab === k ? "bg-[var(--surface)] shadow" : "muted"}`}>
            {v}
          </button>
        ))}
      </div>
      {p.footnote && <p className="muted max-w-[300px] text-center text-xs">{p.footnote}</p>}
    </div>
  );
}
