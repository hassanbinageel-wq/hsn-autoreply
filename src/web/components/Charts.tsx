import { useId, useMemo, useState } from "react";

/** Smooth curve through points (cubic Bézier with horizontal tangents). */
function curve(pts: Array<[number, number]>) {
  if (!pts.length) return "";
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const cx = (x0 + x1) / 2;
    d += ` C${cx},${y0} ${cx},${y1} ${x1},${y1}`;
  }
  return d;
}

export function Sparkline({ values, color = "#7c3aed", width = 96, height = 36 }: { values: number[]; color?: string; width?: number; height?: number }) {
  const id = useId().replace(/:/g, "");
  if (values.length < 2 || values.every((v) => v === 0)) return null;
  const max = Math.max(...values) || 1;
  const pts = values.map((v, i) => [3 + (i * (width - 6)) / (values.length - 1), height - 3 - (v / max) * (height - 6)] as [number, number]);
  const line = curve(pts);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden style={{ transform: "scaleX(-1)" }}>
      <defs>
        <linearGradient id={`s${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity=".3" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${pts.at(-1)![0]},${height} L${pts[0][0]},${height} Z`} fill={`url(#s${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" />
    </svg>
  );
}

export interface Series {
  label: string;
  color: string;
  values: number[];
}

/**
 * Area chart for daily values. Time runs right → left (Arabic reading order): the oldest day is on the right.
 * Hovering / tapping shows the values of the nearest day.
 */
export function AreaChart({ series, labels, height = 240 }: { series: Series[]; labels: string[]; height?: number }) {
  const W = 760;
  const H = height;
  const padX = 24;
  const bottom = 28;
  const id = useId().replace(/:/g, "");
  const [hover, setHover] = useState<number | null>(null);
  const n = labels.length;
  const max = Math.max(1, ...series.flatMap((s) => s.values)) * 1.15;
  const x = (i: number) => (n === 1 ? W / 2 : W - padX - (i * (W - 2 * padX)) / (n - 1));
  const y = (v: number) => 10 + (1 - v / max) * (H - bottom - 10);
  const paths = useMemo(
    () =>
      series.map((s) => {
        const pts = s.values.map((v, i) => [x(i), y(v)] as [number, number]);
        const line = curve(pts);
        return { line, fill: `${line} L${pts.at(-1)?.[0] ?? 0},${H - bottom} L${pts[0]?.[0] ?? 0},${H - bottom} Z` };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, n, max, H],
  );
  const step = Math.max(1, Math.ceil(n / 8));
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let best = 0;
    for (let i = 1; i < n; i++) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    setHover(best);
  };
  const hx = hover != null ? x(hover) : 0;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label="نشاط يومي">
        <defs>
          {series.map((s, i) => (
            <linearGradient key={i} id={`g${id}${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={s.color} stopOpacity=".22" />
              <stop offset="1" stopColor={s.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        {[0, 1, 2, 3].map((i) => (
          <line key={i} x1={0} x2={W} y1={10 + (i * (H - bottom - 10)) / 3} y2={10 + (i * (H - bottom - 10)) / 3} stroke="var(--border)" strokeDasharray="4 6" />
        ))}
        {paths.map((p, i) => (
          <g key={i}>
            <path d={p.fill} fill={`url(#g${id}${i})`} />
            <path d={p.line} fill="none" stroke={series[i].color} strokeWidth={3} strokeLinecap="round" />
          </g>
        ))}
        {labels.map((l, i) =>
          i % step === 0 || i === n - 1 ? (
            <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize={12} fill="var(--muted)">
              {l}
            </text>
          ) : null,
        )}
        {hover != null && (
          <g>
            <line x1={hx} x2={hx} y1={10} y2={H - bottom} stroke="#7c3aed" strokeDasharray="3 4" />
            {series.map((s, i) => (
              <circle key={i} cx={hx} cy={y(s.values[hover])} r={5.5} fill="var(--surface)" stroke={s.color} strokeWidth={3} />
            ))}
          </g>
        )}
      </svg>
      {hover != null && (
        <div
          className="pointer-events-none absolute top-2 rounded-xl bg-[var(--text)] px-3 py-2 text-xs text-[var(--surface)] shadow-xl"
          style={{ left: `clamp(0px, calc(${(hx / W) * 100}% - 70px), calc(100% - 150px))`, width: 150 }}
        >
          <div className="opacity-70">{labels[hover]}</div>
          {series.map((s) => (
            <div key={s.label} className="font-display flex items-center gap-1.5 font-bold">
              <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
              {s.values[hover].toLocaleString("en-US")} {s.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
