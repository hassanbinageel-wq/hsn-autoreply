/**
 * Date (and time) picker built from plain selects. The native <input type="datetime-local"> renders its Arabic
 * placeholder letters reversed in the Android WebView ("موي/رهش/ةنس") and its format depends on the browser, so
 * the app uses this instead: day, month name, year, hour, minute and ص/م, always in that order.
 *
 * Works on wall-clock strings — "YYYY-MM-DDTHH:mm" (or "YYYY-MM-DD" with dateOnly) — and "" for no date, so each
 * caller keeps its own time-zone conversion.
 */
const MONTHS = [
  "يناير",
  "فبراير",
  "مارس",
  "أبريل",
  "مايو",
  "يونيو",
  "يوليو",
  "أغسطس",
  "سبتمبر",
  "أكتوبر",
  "نوفمبر",
  "ديسمبر",
];
const pad = (n: number) => String(n).padStart(2, "0");

function parse(v: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(v);
  return m
    ? {
        y: +m[1],
        mo: +m[2],
        d: +m[3],
        h: m[4] ? +m[4] : 0,
        mi: m[5] ? +m[5] : 0,
      }
    : null;
}
const daysIn = (y: number, mo: number) =>
  new Date(Date.UTC(y, mo, 0)).getUTCDate();

export function DateTimeField({
  value,
  onChange,
  dateOnly = false,
  label,
  emptyLabel = "اختر التاريخ والوقت",
  clearable = true,
}: {
  value: string;
  onChange: (v: string) => void;
  dateOnly?: boolean;
  /** Accessible name of the group (the visible label is the surrounding Field). */
  label: string;
  emptyLabel?: string;
  clearable?: boolean;
}) {
  const p = parse(value);
  const emit = (q: {
    y: number;
    mo: number;
    d: number;
    h: number;
    mi: number;
  }) => {
    const d = Math.min(q.d, daysIn(q.y, q.mo));
    onChange(
      dateOnly
        ? `${q.y}-${pad(q.mo)}-${pad(d)}`
        : `${q.y}-${pad(q.mo)}-${pad(d)}T${pad(q.h)}:${pad(q.mi)}`,
    );
  };
  if (!p) {
    return (
      <button
        type="button"
        className="input flex items-center justify-between text-right text-[var(--muted)]"
        aria-label={`${label}: ${emptyLabel}`}
        onClick={() => {
          // Start from the next full hour today; the person adjusts from there.
          const n = new Date(Date.now() + 3_600_000);
          emit({
            y: n.getFullYear(),
            mo: n.getMonth() + 1,
            d: n.getDate(),
            h: dateOnly ? 0 : n.getHours(),
            mi: 0,
          });
        }}
      >
        <span>{emptyLabel}</span>
        <span aria-hidden>📅</span>
      </button>
    );
  }
  const year = new Date().getFullYear();
  const years = Array.from(new Set([p.y, year - 1, year, year + 1, year + 2])).sort();
  const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
  const pm = p.h >= 12;
  // Fixed rows so nothing wraps unpredictably in narrow columns: date on one row, time on the next.
  const sel = "input !w-full min-w-0 !px-2 text-center";
  const minutes = Array.from(new Set([...Array.from({ length: 12 }, (_, i) => i * 5), p.mi])).sort((a, b) => a - b);
  return (
    <div className="surface-2 space-y-2 rounded-xl border border-[var(--border)] p-2.5" role="group" aria-label={label}>
      <div className="grid grid-cols-[3rem_minmax(0,1fr)] items-center gap-2">
        <span className="muted text-xs font-semibold">التاريخ</span>
        <div className="grid grid-cols-[minmax(0,4.2rem)_minmax(0,1fr)_minmax(0,5.2rem)] gap-1.5">
          <select className={sel} aria-label="اليوم" value={p.d} onChange={(e) => emit({ ...p, d: +e.target.value })}>
            {Array.from({ length: daysIn(p.y, p.mo) }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <select className={sel} aria-label="الشهر" value={p.mo} onChange={(e) => emit({ ...p, mo: +e.target.value })}>
            {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
          <select className={sel} aria-label="السنة" value={p.y} onChange={(e) => emit({ ...p, y: +e.target.value })}>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>
      {!dateOnly && (
        <div className="grid grid-cols-[3rem_minmax(0,1fr)] items-center gap-2">
          <span className="muted text-xs font-semibold">الوقت</span>
          <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_minmax(0,4.2rem)] items-center gap-1.5">
            <select className={sel} aria-label="الساعة" value={h12} onChange={(e) => emit({ ...p, h: (+e.target.value % 12) + (pm ? 12 : 0) })}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => <option key={h} value={h}>{h}</option>)}
            </select>
            <span aria-hidden className="font-bold">:</span>
            <select className={sel} aria-label="الدقيقة" value={p.mi} onChange={(e) => emit({ ...p, mi: +e.target.value })}>
              {minutes.map((m) => <option key={m} value={m}>{pad(m)}</option>)}
            </select>
            <select className={sel} aria-label="صباحًا أو مساءً" value={pm ? "pm" : "am"} onChange={(e) => emit({ ...p, h: (p.h % 12) + (e.target.value === "pm" ? 12 : 0) })}>
              <option value="am">ص</option>
              <option value="pm">م</option>
            </select>
          </div>
        </div>
      )}
      {clearable && (
        <div className="flex justify-end">
          <button type="button" className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-red-600 hover:bg-red-500/10 dark:text-red-400" onClick={() => onChange("")}>
            ✕ مسح التاريخ
          </button>
        </div>
      )}
    </div>
  );
}
