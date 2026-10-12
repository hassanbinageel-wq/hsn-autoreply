import { useEffect, useState, type ReactNode } from "react";
import { AR_LABELS } from "../../shared/states";

export function Card({ children, className = "", title, action }: { children: ReactNode; className?: string; title?: ReactNode; action?: ReactNode }) {
  return (
    <section className={`card ${title || action ? "" : "p-4 sm:p-5"} ${className}`}>
      {(title || action) && (
        <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3.5 sm:px-5">
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
      <div>
        <h1 className="text-2xl font-extrabold leading-tight sm:text-[26px]">{title}</h1>
        {subtitle && <p className="muted mt-1 text-sm">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
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
export function Stat({ label, value, hint, tone = "default", icon, accent = "violet" }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "default" | "good" | "warn" | "bad"; icon?: ReactNode; accent?: keyof typeof STAT_ACCENT }) {
  const color = { default: "", good: "text-emerald-600 dark:text-emerald-400", warn: "text-amber-600 dark:text-amber-400", bad: "text-red-600 dark:text-red-400" }[tone];
  return (
    <div className="card p-4">
      <div className="muted flex items-center gap-2.5 text-[13px] font-semibold">
        {icon && <span className={`flex h-9 w-9 items-center justify-center rounded-xl ${STAT_ACCENT[accent]}`}>{icon}</span>}
        {label}
      </div>
      <div className={`font-display mt-2 text-[26px] font-extrabold leading-tight tabular-nums ${color}`}>{value}</div>
      {hint && <div className="muted mt-1 text-xs">{hint}</div>}
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

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} className="card max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-b-none p-5 sm:m-4 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
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
export function ToastHost() {
  const [t, setT] = useState<{ text: string; tone: string } | null>(null);
  useEffect(() => {
    toastSetter = setT;
    return () => {
      toastSetter = null;
    };
  }, []);
  useEffect(() => {
    if (!t) return;
    const id = setTimeout(() => setT(null), 3500);
    return () => clearTimeout(id);
  }, [t]);
  if (!t) return null;
  return (
    <div className="fixed inset-x-0 bottom-24 z-50 flex justify-center px-4 sm:bottom-6" aria-live="polite">
      <div className={`rounded-2xl px-4 py-3 text-sm font-semibold shadow-xl ${TONES[t.tone] ?? TONES.info}`}>{t.text}</div>
    </div>
  );
}

/** Formats UTC milliseconds in the configured time zone (default Asia/Aden). */
export function fmtTime(ms: number | null | undefined, tz = currentTz()): string {
  if (!ms) return "—";
  try {
    return new Intl.DateTimeFormat("ar", { timeZone: tz, dateStyle: "medium", timeStyle: "short" }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
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
