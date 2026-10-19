import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AR_LABELS } from "../../shared/states";

export function Card({ children, className = "", title, action, id }: { children: ReactNode; className?: string; title?: ReactNode; action?: ReactNode; id?: string }) {
  return (
    <section id={id} className={`card ${title || action ? "" : "p-4 sm:p-5"} ${className}`}>
      {(title || action) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3.5 sm:px-5">
          {title && <h2 className="text-[15.5px] font-bold">{title}</h2>}
          {action}
        </div>
      )}
      {title || action ? <div className="p-4 sm:p-5">{children}</div> : children}
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-extrabold leading-tight sm:text-[26px]">{title}</h1>
        {subtitle && <p className="muted mt-1 text-sm">{subtitle}</p>}
      </div>
      {actions && <div className="flex min-w-0 max-w-full flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

const STAT_ACCENT: Record<string, string> = {
  violet: "bg-violet-500/10 text-violet-600 dark:text-violet-300",
  pink: "bg-pink-500/10 text-pink-600 dark:text-pink-300",
  green: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
  orange: "bg-orange-500/10 text-orange-600 dark:text-orange-300",
  sky: "bg-sky-500/10 text-sky-600 dark:text-sky-300",
};
/** A small "?" that explains a number: hover on desktop, tap on phones (the tap never triggers the card under it). */
export function InfoDot({ text, className = "" }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; above: boolean } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  // The box is placed on the screen itself (fixed), centred under the "?" and pushed back inside the
  // viewport with a 12px margin, so it is never cut off by the screen edge or by the card around it.
  const place = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const vw = window.innerWidth;
    const width = Math.min(280, vw - 24);
    const left = Math.min(Math.max(12, r.left + r.width / 2 - width / 2), vw - 12 - width);
    const above = r.bottom + 140 > window.innerHeight && r.top > 160;
    setPos({ left, top: above ? r.top - 8 : r.bottom + 8, width, above });
  };
  const show = () => {
    place();
    // Only one explanation at a time: tell the others to close.
    window.dispatchEvent(new CustomEvent("hsn:tip-open", { detail: ref.current }));
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const other = (e: Event) => (e as CustomEvent).detail !== ref.current && close();
    window.addEventListener("hsn:tip-open", other);
    const t = setTimeout(() => document.addEventListener("click", close), 0);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      clearTimeout(t);
      document.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("hsn:tip-open", other);
    };
  }, [open]);
  const toggle = (e: { stopPropagation: () => void; preventDefault: () => void }) => {
    e.stopPropagation();
    e.preventDefault();
    if (open) setOpen(false);
    else show();
  };
  return (
    <span
      ref={ref}
      role="button"
      tabIndex={0}
      aria-label={`شرح: ${text}`}
      aria-expanded={open}
      onClick={toggle}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && toggle(e)}
      onPointerEnter={(e) => e.pointerType === "mouse" && show()}
      onPointerLeave={(e) => e.pointerType === "mouse" && setOpen(false)}
      className={`relative inline-flex h-6 w-6 shrink-0 cursor-help items-center justify-center rounded-full bg-[var(--border)] text-[11px] font-bold text-[var(--text-2)] outline-none ${className}`}
    >
      ?
      {open && pos &&
        // On the page itself (not inside the card): a scaled or moved card would otherwise shift the box.
        createPortal(
          <span
            role="tooltip"
            dir="rtl"
            style={{ left: pos.left, top: pos.top, width: pos.width, transform: pos.above ? "translateY(-100%)" : undefined }}
            className="pointer-events-none fixed z-[60] rounded-xl bg-[#16122b] px-3 py-2 text-right text-xs font-normal leading-relaxed text-white shadow-lg dark:bg-white dark:text-[#16122b]"
          >
            {text}
          </span>,
          document.body,
        )}
    </span>
  );
}

export function Stat({ label, value, hint, tone = "default", icon, accent = "violet", info, onClick, actionLabel }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "default" | "good" | "warn" | "bad"; icon?: ReactNode; accent?: keyof typeof STAT_ACCENT; info?: string; onClick?: () => void; actionLabel?: string }) {
  const color = { default: "", good: "text-emerald-600 dark:text-emerald-400", warn: "text-amber-600 dark:text-amber-400", bad: "text-red-600 dark:text-red-400" }[tone];
  return (
    <div className={`card relative h-full p-4 ${onClick ? "transition hover:ring-1 hover:ring-[var(--color-brand-500)]" : ""}`}>
      {/* A clickable tile is one full-size button under the content; the "?" sits above it and never triggers it. */}
      {onClick && <button type="button" className="absolute inset-0 rounded-2xl" aria-label={actionLabel ?? `${label}: عرض التفاصيل`} onClick={onClick} />}
      <div className="muted pointer-events-none relative flex items-center gap-2.5 text-[13px] font-semibold">
        {icon && <span className={`flex h-9 w-9 items-center justify-center rounded-xl ${STAT_ACCENT[accent]}`}>{icon}</span>}
        <span className="flex-1">{label}</span>
        {info && <InfoDot text={info} className="pointer-events-auto" />}
      </div>
      <div className={`font-display pointer-events-none relative mt-2 text-[26px] font-extrabold leading-tight tabular-nums ${color}`}>{value}</div>
      {hint && <div className="muted pointer-events-none relative mt-1 text-xs">{hint}</div>}
    </div>
  );
}

const TONES: Record<string, string> = {
  good: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  warn: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  bad: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  info: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
  neutral: "surface-2 muted",
};
const STATUS_TONE: Record<string, string> = {
  accepted: "good", content_sent: "good", following: "good", active: "good", processed: "good", subscribed: "good", supported: "good",
  pending: "info", processing: "info", checking_follow: "info", delivering: "info", ready_to_deliver: "info", trigger_received: "info", draft: "neutral",
  retry_scheduled: "warn", uncertain: "warn", awaiting_follow: "warn", awaiting_user_interaction: "warn", not_following: "warn", paused: "warn",
  unknown: "warn", needs_interaction: "warn", temporary_error: "warn", ignored: "neutral", needs_reauth: "bad",
  failed: "bad", cancelled: "neutral", expired: "neutral", verification_unavailable: "bad", unsupported: "bad", disconnected: "bad",
};

export function Badge({ value, label }: { value: string | null | undefined; label?: string }) {
  if (!value) return <span className="muted text-xs">—</span>;
  const tone = STATUS_TONE[value] ?? "neutral";
  return <span className={`chip ${TONES[tone]}`}><span className="h-1.5 w-1.5 rounded-full bg-current" />{label ?? AR_LABELS[value] ?? value}</span>;
}

export function Toggle({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; description?: ReactNode; disabled?: boolean }) {
  return (
    <label className={`flex cursor-pointer items-start justify-between gap-4 py-2 ${disabled ? "opacity-60" : ""}`}>
      <span>
        <span className="block font-semibold">{label}</span>
        {description && <span className="muted block text-sm">{description}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-1 h-7 w-12 shrink-0 rounded-full transition ${checked ? "grad" : "bg-[var(--border)]"}`}
      >
        <span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all ${checked ? "right-6" : "right-1"}`} />
      </button>
    </label>
  );
}

export function Field({ label, hint, error, children }: { label: ReactNode; hint?: ReactNode; error?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="font-display block text-[13px] font-bold text-[var(--text-2)]">{label}</span>
      {children}
      {hint && <span className="muted block text-sm">{hint}</span>}
      {error && <span className="block text-sm text-red-600">{error}</span>}
    </label>
  );
}

export function Spinner({ label = "جارٍ التحميل…" }: { label?: string }) {
  return (
    <div className="muted flex items-center gap-2 py-6" role="status">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
      {label}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="card surface-2 p-6 text-center">
      <div className="font-bold">{title}</div>
      {children && <div className="muted mt-2 text-sm">{children}</div>}
    </div>
  );
}

export function Alert({ tone = "info", children }: { tone?: "info" | "warn" | "bad" | "good"; children: ReactNode }) {
  return <div className={`rounded-2xl border border-current/10 px-4 py-3 text-sm ${TONES[tone]}`}>{children}</div>;
}

export function Modal({ open, onClose, title, children, center = false }: { open: boolean; onClose: () => void; title: string; children: ReactNode; center?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className={`fixed inset-0 z-50 flex justify-center bg-black/50 ${center ? "items-center p-4" : "items-end sm:items-center"}`} onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={center ? "card max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl p-5" : "card max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-b-none p-5 sm:m-4 sm:rounded-2xl"}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-bold">{title}</h2>
          <button className="btn btn-ghost min-h-10 px-3" onClick={onClose} aria-label="إغلاق">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

let toastSetter: ((t: { text: string; tone: string } | null) => void) | null = null;
export function toast(text: string, tone: "good" | "bad" | "info" = "good") {
  toastSetter?.({ text, tone });
}
/** Success / info messages fade after a few seconds; errors stay until closed (they often explain what to fix). */
export function ToastHost() {
  const [t, setT] = useState<{ text: string; tone: string } | null>(null);
  useEffect(() => {
    toastSetter = setT;
    return () => {
      toastSetter = null;
    };
  }, []);
  useEffect(() => {
    if (!t || t.tone === "bad") return;
    const id = setTimeout(() => setT(null), 5000);
    return () => clearTimeout(id);
  }, [t]);
  // The live region is always in the page so screen readers announce every new message.
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex justify-center px-4 sm:bottom-6" role="status" aria-live="polite" aria-atomic="true">
      {t && (
        <div className={`pointer-events-auto flex max-w-lg items-start gap-3 rounded-2xl px-4 py-3 text-sm font-semibold shadow-xl ${TONES[t.tone] ?? TONES.info}`}>
          <span className="min-w-0 flex-1">{t.text}</span>
          {t.tone === "bad" && (
            <button type="button" className="-my-1 -ml-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg opacity-70 hover:opacity-100" aria-label="إغلاق الرسالة" onClick={() => setT(null)}>✕</button>
          )}
        </div>
      )}
    </div>
  );
}

/** Formats UTC milliseconds in the configured time zone (default Asia/Aden). */
// One date style everywhere: day, month name, year ("13 أكتوبر 2026"), Gregorian calendar and Latin digits, so the
// order never flips inside right-to-left text and nobody has to guess which number is the day or the month.
const AR = "ar-SA-u-ca-gregory-nu-latn";
export function fmtTime(ms: number | null | undefined, tz = currentTz()): string {
  if (!ms) return "—";
  try {
    return new Intl.DateTimeFormat(AR, { timeZone: tz, day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}
/** Date only: "13 أكتوبر 2026". */
export function fmtDate(ms: number | null | undefined, tz = currentTz()): string {
  if (!ms) return "—";
  try {
    return new Intl.DateTimeFormat(AR, { timeZone: tz, day: "numeric", month: "long", year: "numeric" }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}
let tzValue = "Asia/Aden";
export function setTz(tz: string) {
  tzValue = tz || "Asia/Aden";
}
export function currentTz() {
  return tzValue;
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    fn().then(
      (data) => alive && setState({ data, loading: false }),
      (e) => alive && setState({ error: e?.message ?? String(e), loading: false }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}

/** Hover (or tap/focus on touch) explanation box for a short label. */
export function Tip({ text, children, className = "" }: { text?: string; children: ReactNode; className?: string }) {
  const [pos, setPos] = useState<{ left: number; top: number; width: number; above: boolean } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!pos) return;
    const close = () => setPos(null);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [pos]);
  if (!text) return <span className={className}>{children}</span>;
  // Same placement as InfoDot: fixed on the screen, above the text, kept inside the viewport.
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const vw = window.innerWidth;
    const width = Math.min(260, vw - 24);
    const above = r.top > 150;
    setPos({ left: Math.min(Math.max(12, r.right - width), vw - 12 - width), top: above ? r.top - 8 : r.bottom + 8, width, above });
  };
  return (
    <span
      ref={ref}
      className={`relative inline cursor-help outline-none ${className}`}
      tabIndex={0}
      onPointerEnter={(e) => e.pointerType === "mouse" && show()}
      onPointerLeave={(e) => e.pointerType === "mouse" && setPos(null)}
      onFocus={show}
      onBlur={() => setPos(null)}
      onClick={(e) => {
        e.stopPropagation();
        if (pos) setPos(null);
        else show();
      }}
    >
      {children}
      {"\u200F"}
      <span className="muted mr-1 text-[0.75em]" aria-hidden>ⓘ</span>
      {pos &&
        createPortal(
          <span role="tooltip" dir="rtl" style={{ left: pos.left, top: pos.top, width: pos.width, transform: pos.above ? "translateY(-100%)" : undefined }} className="pointer-events-none fixed z-[60] rounded-xl bg-[#16122b] px-3 py-2 text-right text-xs font-normal leading-relaxed text-white no-underline shadow-lg dark:bg-white dark:text-[#16122b]">
            {text}
          </span>,
          document.body,
        )}
    </span>
  );
}
