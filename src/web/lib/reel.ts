/**
 * Motion paths for the winner reel. Purely visual: the winner is already chosen (and saved) on the server;
 * a path only decides how the list moves before it stops with the winner under the arrow.
 *
 * Each style returns `y(t)`: the (fractional) list index under the arrow at t seconds. Consecutive winners use
 * different styles, so the second pick never moves like the first.
 */
export type ReelStyle = "sweep" | "spin" | "jumps" | "pendulum";
export const REEL_STYLES: ReelStyle[] = ["sweep", "spin", "jumps", "pendulum"];

export interface ReelPath {
  style: ReelStyle;
  duration: number;
  /** Spin loops over the list; the other styles stay inside it (its top and bottom are visible). */
  wrap: boolean;
  at: (t: number) => number;
}

/** Style for a winner position; `offset` (e.g. the draw id) varies the first style between draws. */
export function styleFor(position: number, offset = 0): ReelStyle {
  return REEL_STYLES[(((position - 1 + offset) % REEL_STYLES.length) + REEL_STYLES.length) % REEL_STYLES.length];
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const inOutCubic = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const outQuint = (x: number) => 1 - Math.pow(1 - x, 5);
const outBack = (x: number) => {
  const c1 = 1.25;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};
const outElastic = (x: number) => (x === 0 || x === 1 ? x : Math.pow(2, -9 * x) * Math.sin((x * 10 - 0.75) * ((2 * Math.PI) / 3.2)) + 1);

interface Seg {
  to: number;
  dur: number;
  ease: (x: number) => number;
}

function segments(y0: number, segs: Seg[]): (t: number) => number {
  return (t) => {
    let from = y0;
    let t0 = 0;
    for (const s of segs) {
      if (t <= t0 + s.dur) return from + (s.to - from) * s.ease(clamp((t - t0) / s.dur, 0, 1));
      from = s.to;
      t0 += s.dur;
    }
    return from;
  };
}

export function buildReelPath(style: ReelStyle, n: number, target: number, rand: () => number = Math.random): ReelPath {
  const last = Math.max(0, n - 1);
  const r = () => rand() * last;
  if (n <= 1) return { style, duration: 3, wrap: false, at: () => 0 };

  if (style === "sweep") {
    // top ↔ bottom ↔ middle, a few random stops, then settles with a small overshoot
    const segs: Seg[] = [
      { to: last, dur: 1.1, ease: inOutCubic },
      { to: 0, dur: 1.2, ease: inOutCubic },
      { to: last / 2, dur: 0.8, ease: inOutCubic },
      { to: r(), dur: 0.75, ease: inOutCubic },
      { to: r(), dur: 0.7, ease: inOutCubic },
      { to: target, dur: 2.0, ease: outBack },
    ];
    const f = segments(r(), segs);
    return { style, duration: segs.reduce((a, s) => a + s.dur, 0), wrap: false, at: (t) => clamp(f(t), -0.6, last + 0.6) };
  }

  if (style === "spin") {
    // slot machine: a short pull back, then a fast spin that slows down onto the winner
    const k = 70 + Math.floor(rand() * 40); // rows travelled (independent of the list size)
    const start = target + 2 - k;
    const pull = 0.45;
    const spin = 5.6;
    return {
      style,
      duration: pull + spin,
      wrap: true,
      at: (t) => (t < pull ? start - 2 * inOutCubic(t / pull) : start - 2 + k * outQuint(clamp((t - pull) / spin, 0, 1))),
    };
  }

  if (style === "jumps") {
    // jumps between random places with short pauses, then an elastic stop
    const segs: Seg[] = [];
    for (let i = 0; i < 5; i++) {
      const to = r();
      segs.push({ to, dur: 0.5 - i * 0.03, ease: outBack }, { to, dur: 0.22, ease: (x) => x });
    }
    segs.push({ to: target, dur: 1.9, ease: outElastic });
    const f = segments(r(), segs);
    return { style, duration: segs.reduce((a, s) => a + s.dur, 0), wrap: false, at: (t) => clamp(f(t), -0.6, last + 0.6) };
  }

  // pendulum: big up/down swings across the list that shrink until it rests on the winner
  const T = 6.6;
  const amp = Math.max(target, last - target, 3);
  const freq = 0.5 + rand() * 0.15;
  const phase = rand() < 0.5 ? 0 : Math.PI;
  return {
    style,
    duration: T,
    wrap: false,
    at: (t) => {
      const u = clamp(t / T, 0, 1);
      return clamp(target + amp * Math.pow(1 - u, 2.2) * Math.cos(2 * Math.PI * freq * t + phase), 0, last);
    },
  };
}

/** Visual order of the reel: every eligible name once (capped), shuffled, with the winner at a random place. */
export function reelNames(names: string[], winner: string, max = 1500, rand: () => number = Math.random): { list: string[]; target: number } {
  const uniq = Array.from(new Set(names.filter((x) => x && x !== winner)));
  for (let i = uniq.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [uniq[i], uniq[j]] = [uniq[j], uniq[i]];
  }
  const list = uniq.slice(0, max - 1);
  const target = Math.floor(rand() * (list.length + 1));
  list.splice(target, 0, winner);
  return { list, target };
}
