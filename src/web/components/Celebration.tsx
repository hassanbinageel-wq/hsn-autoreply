import { useEffect, useRef } from "react";

/**
 * Light celebration overlay: rising bubbles + a few firework bursts (~3.5s), drawn on one canvas.
 * Purely decorative; respects "reduce motion".
 */
export function Celebration({ onEnd, duration = 3500 }: { onEnd?: () => void; duration?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      canvas.width = innerWidth * dpr;
      canvas.height = innerHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    if (reduce) {
      const t = setTimeout(() => onEnd?.(), 600);
      return () => clearTimeout(t);
    }
    const W = () => innerWidth;
    const H = () => innerHeight;
    const colors = ["#a78bfa", "#f472b6", "#fb923c", "#facc15", "#34d399", "#60a5fa"];
    type Bubble = { x: number; y: number; r: number; vy: number; drift: number; phase: number; hue: string };
    type Spark = { x: number; y: number; vx: number; vy: number; life: number; color: string };
    const bubbles: Bubble[] = Array.from({ length: 34 }, () => ({
      x: Math.random() * W(),
      y: H() * 0.55 + Math.random() * H() * 0.8,
      r: 6 + Math.random() * 18,
      vy: 1.2 + Math.random() * 2.2,
      drift: 0.6 + Math.random() * 1.4,
      phase: Math.random() * Math.PI * 2,
      hue: colors[Math.floor(Math.random() * colors.length)],
    }));
    const sparks: Spark[] = [];
    const burst = (x: number, y: number) => {
      const color = colors[Math.floor(Math.random() * colors.length)];
      for (let i = 0; i < 46; i++) {
        const a = (Math.PI * 2 * i) / 46;
        const sp = 2 + Math.random() * 3.5;
        sparks.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, color });
      }
    };
    const bursts = [300, 800, 1300, 1900, 2500].map((t, i) =>
      setTimeout(() => burst(W() * (0.2 + 0.6 * ((i * 37) % 10) / 10), H() * (0.18 + 0.25 * (i % 2))), t),
    );
    const start = performance.now();
    let raf = 0;
    const frame = (now: number) => {
      const t = now - start;
      ctx.clearRect(0, 0, W(), H());
      for (const b of bubbles) {
        b.y -= b.vy;
        b.phase += 0.03;
        const x = b.x + Math.sin(b.phase) * b.drift * 10;
        ctx.beginPath();
        ctx.arc(x, b.y, b.r, 0, Math.PI * 2);
        ctx.fillStyle = b.hue + "33";
        ctx.strokeStyle = b.hue + "aa";
        ctx.lineWidth = 1.5;
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x - b.r * 0.35, b.y - b.r * 0.35, b.r * 0.22, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffffaa";
        ctx.fill();
      }
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i];
        s.x += s.vx;
        s.y += s.vy;
        s.vy += 0.05;
        s.vx *= 0.985;
        s.life -= 0.016;
        if (s.life <= 0) {
          sparks.splice(i, 1);
          continue;
        }
        ctx.globalAlpha = Math.max(0, s.life);
        ctx.fillStyle = s.color;
        ctx.fillRect(s.x, s.y, 3, 3);
        ctx.globalAlpha = 1;
      }
      if (t < duration) raf = requestAnimationFrame(frame);
      else onEnd?.();
    };
    raf = requestAnimationFrame(frame);
    addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(raf);
      bursts.forEach(clearTimeout);
      removeEventListener("resize", resize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <canvas ref={ref} className="pointer-events-none fixed inset-0 z-[60] h-full w-full" aria-hidden />;
}
