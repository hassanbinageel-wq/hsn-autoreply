/**
 * Motion paths for the winner reel. Purely visual: the winner is already chosen (and saved) on the server;
 * a path only decides how the list moves before it stops with the winner under the arrow.
 *
 * Each style returns `y(t)`: the (fractional) list index under the arrow at t seconds. Consecutive winners use
 * different styles (number of swings and the landing), so the second pick never moves exactly like the first.
 */
export type ReelStyle = "sweep" | "spin" | "jumps" | "pendulum";
export const REEL_STYLES: ReelStyle[] = ["sweep", "spin", "jumps", "pendulum"];

export interface ReelPath {
  style: ReelStyle;
  duration: number;
  /** True when the reel loops over the list (no current style does; the list top and bottom stay visible). */
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

/** Total motion time: fast random swings that slow down, then a stop on the winner. */
export const REEL_SECONDS = 6;

const inOutSine = (x: number) => -(Math.cos(Math.PI * x) - 1) / 2;
const outCubic = (x: number) => 1 - Math.pow(1 - x, 3);

/**
 * Every style: the list runs up and down to random places, fast at first and slower each time,
 * for REEL_SECONDS in total, ending exactly on the winner. Styles only change the number of swings
 * and how the last swing lands, so consecutive winners still look different.
 */
export function buildReelPath(style: ReelStyle, n: number, target: number, rand: () => number = Math.random): ReelPath {
  const last = Math.max(0, n - 1);
  if (n <= 1) return { style, duration: REEL_SECONDS, wrap: false, at: () => 0 };

  const cfg = {
    sweep: { swings: 11, ease: inOutSine, land: outBack, landDur: 1.4 },
    spin: { swings: 13, ease: inOutCubic, land: outQuint, landDur: 1.3 },
    jumps: { swings: 9, ease: outBack, land: outElastic, landDur: 1.6 },
    pendulum: { swings: 10, ease: inOutSine, land: outCubic, landDur: 1.5 },
  }[style];

  // Durations grow geometrically (fast → slow) and add up to the time before the landing.
  const growth = 1.22;
  const weights = Array.from({ length: cfg.swings }, (_, i) => Math.pow(growth, i));
  const total = weights.reduce((a, w) => a + w, 0);
  const runTime = REEL_SECONDS - cfg.landDur;

  // Random stops, alternating up and down, each far enough from the previous one to read as a swing.
  const minJump = Math.min(last, Math.max(2, last * 0.3));
  let pos = rand() * last;
  const start = pos;
  let up = rand() < 0.5;
  const segs: Seg[] = [];
  for (let i = 0; i < cfg.swings; i++) {
    const room = up ? pos : last - pos;
    let to: number;
    if (room >= minJump) to = up ? pos - minJump - rand() * (room - minJump) : pos + minJump + rand() * (room - minJump);
    else to = up ? pos + minJump + rand() * Math.max(0, last - pos - minJump) : pos - minJump - rand() * Math.max(0, pos - minJump);
    to = clamp(to, 0, last);
    up = to < pos ? false : true; // next swing goes the other way
    pos = to;
    segs.push({ to, dur: (runTime * weights[i]) / total, ease: cfg.ease });
  }
  segs.push({ to: target, dur: cfg.landDur, ease: cfg.land });
  const f = segments(start, segs);
  return { style, duration: REEL_SECONDS, wrap: false, at: (t) => (t >= REEL_SECONDS ? target : clamp(f(t), -0.6, last + 0.6)) };
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
