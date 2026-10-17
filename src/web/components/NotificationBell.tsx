import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Link } from "../App";
import { Icon } from "./Icon";
import { fmtTime } from "./ui";

/** Important notifications (stock, disconnected account, failures, subscription, story suggestions) behind the bell. */
const KIND_ICON: Record<string, string> = { stock: "📦", story: "📣", reauth: "🔌", failures: "⚠️", spike: "🔥", expiry: "⏳", usage: "📊", domain: "🌐" };

export function NotificationBell({ route }: { route: string }) {
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<any[] | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const refresh = () => api<{ unread: number }>("/api/app-notifications/unread").then((r) => setUnread(r.unread)).catch(() => undefined);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => setOpen(false), [route]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const toggle = async () => {
    if (open) return setOpen(false);
    setOpen(true);
    const r = await api<{ items: any[]; unread: number }>("/api/app-notifications").catch(() => ({ items: [], unread: 0 }));
    setItems(r.items);
    if (r.unread) {
      await api("/api/app-notifications/read", { body: {} }).catch(() => undefined);
      setUnread(0);
    }
  };
  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        onClick={toggle}
        className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface)]"
        aria-label={`الإشعارات المهمة${unread ? ` (${unread} جديد)` : ""}`}
        aria-expanded={open}
      >
        <Icon name="bell" size={18} />
        {unread > 0 && <span className="absolute -left-1 -top-1 min-w-[18px] rounded-full bg-pink-600 px-1 text-center text-[10px] font-bold leading-[18px] text-white">{unread > 9 ? "9+" : unread}</span>}
      </button>
      {open && (
        <div className="card fixed inset-x-3 top-16 z-50 max-h-[70vh] overflow-hidden p-0 shadow-xl sm:absolute sm:inset-x-auto sm:left-0 sm:top-12 sm:w-96" role="dialog" aria-label="الإشعارات المهمة">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
            <b className="text-sm">الإشعارات المهمة</b>
            <Link to="/settings" className="muted text-xs hover:underline">تيليجرام والإعدادات</Link>
          </div>
          <div className="max-h-[calc(70vh-3rem)] divide-y divide-[var(--border)] overflow-y-auto">
            {!items ? (
              <p className="muted p-6 text-center text-sm">…</p>
            ) : !items.length ? (
              <p className="muted p-6 text-center text-sm">ما فيه إشعارات بعد. هنا يوصلك تنبيه المخزون، انقطاع الربط، فشل الرسائل، وانتهاء الاشتراك، واقتراحات مثل «حان وقت ستوري».</p>
            ) : (
              items.map((n) => (
                <Link key={n.id} to={n.link || "/"} className={`flex gap-3 px-4 py-3 text-right transition hover:bg-[var(--surface-2)] ${n.read_at ? "" : "bg-violet-500/5"}`}>
                  <span className="text-lg leading-6" aria-hidden>{KIND_ICON[n.kind] ?? "🔔"}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold">{n.title.replace(/^\p{Extended_Pictographic}️?\s*/u, "")}</div>
                    {n.body && <p className="muted mt-0.5 whitespace-pre-line text-xs leading-relaxed">{n.body}</p>}
                    <div className="muted mt-1 text-[10.5px]">{fmtTime(n.created_at)}</div>
                  </div>
                  {!n.read_at && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-pink-600" aria-label="جديد" />}
                </Link>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
