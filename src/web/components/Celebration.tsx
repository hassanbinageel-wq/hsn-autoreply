import { useEffect, useRef } from "react";

/**
 * Fireworks: rockets launch from the bottom with a glowing trail, burst into coloured sparks that fall with gravity,
 * flicker and fade (additive blending for the glow). Purely decorative; respects "reduce motion".
 */
export function Celebration({ onEnd, duration = 4200 }: { onEnd?: () => void; duration?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = () => innerWidth;
    const H = () => innerHeight;
    const resize = () => {
      canvas.width = W() * dpr;
      canvas.height = H() * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      const t = setTimeout(() => onEnd?.(), 600);
      return () => clearTimeout(t);
    }
    const hues = [0, 30, 45, 120, 190, 280, 320];
    type Rocket = { x: number; y: number; vx: number; vy: number; targetY: number; hue: number; trail: Array<[number, number]> };
    type Spark = { x: number; y: number; vx: number; vy: number; life: number; decay: number; hue: number; light: number; size: number; trail: Array<[number, number]> };
    const rockets: Rocket[] = [];
    const sparks: Spark[] = [];

    const launch = () => {
      const x = W() * (0.15 + Math.random() * 0.7);
      const targetY = H() * (0.12 + Math.random() * 0.35);
      rockets.push({ x, y: H() + 10, vx: (Math.random() - 0.5) * 1.2, vy: -(9 + Math.random() * 4), targetY, hue: hues[Math.floor(Math.random() * hues.length)], trail: [] });
    };
    const explode = (r: Rocket) => {
      const n = 90 + Math.floor(Math.random() * 50);
      const ring = Math.random() < 0.35;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = ring ? 5.5 + Math.random() * 0.6 : Math.random() * 7 + 1;
        const hue = Math.random() < 0.2 ? r.hue + 40 : r.hue;
        sparks.push({ x: r.x, y: r.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, decay: 0.009 + Math.random() * 0.012, hue, light: 55 + Math.random() * 25, size: 1.6 + Math.random() * 1.4, trail: [] });
      }
      // central flash
      sparks.push({ x: r.x, y: r.y, vx: 0, vy: 0, life: 1, decay: 0.08, hue: r.hue, light: 95, size: 28, trail: [] });
    };

    const schedule = [0, 250, 700, 1000, 1500, 1800, 2300, 2700, 3100].map((t) => setTimeout(launch, t));
    const start = performance.now();
    let raf = 0;
    const frame = (now: number) => {
      // fade previous frame for motion trails, then draw with additive glow
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "rgba(0,0,0,0.28)";
      ctx.fillRect(0, 0, W(), H());
      ctx.globalCompositeOperation = "lighter";

      for (let i = rockets.length - 1; i >= 0; i--) {
        const r = rockets[i];
        r.trail.push([r.x, r.y]);
        if (r.trail.length > 10) r.trail.shift();
        r.x += r.vx;
        r.y += r.vy;
        r.vy += 0.12;
        ctx.beginPath();
        ctx.moveTo(r.trail[0][0], r.trail[0][1]);
        for (const [tx, ty] of r.trail) ctx.lineTo(tx, ty);
        ctx.strokeStyle = `hsla(${r.hue},100%,75%,0.9)`;
        ctx.lineWidth = 2.2;
        ctx.stroke();
        if (r.y <= r.targetY || r.vy >= -1) {
          explode(r);
          rockets.splice(i, 1);
        }
      }
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i];
        s.trail.push([s.x, s.y]);
        if (s.trail.length > 5) s.trail.shift();
        s.vx *= 0.975;
        s.vy = s.vy * 0.975 + 0.075;
        s.x += s.vx;
        s.y += s.vy;
        s.life -= s.decay;
        if (s.life <= 0) {
          sparks.splice(i, 1);
          continue;
        }
        const flicker = Math.random() < 0.15 && s.life < 0.5 ? 0.3 : 1;
        if (s.size > 10) {
          const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.size * 3);
          g.addColorStop(0, `hsla(${s.hue},100%,90%,${s.life * 0.9})`);
          g.addColorStop(1, `hsla(${s.hue},100%,50%,0)`);
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.size * 3, 0, Math.PI * 2);
          ctx.fill();
          continue;
        }
        ctx.beginPath();
        ctx.moveTo(s.trail[0][0], s.trail[0][1]);
        for (const [tx, ty] of s.trail) ctx.lineTo(tx, ty);
        ctx.strokeStyle = `hsla(${s.hue},100%,${s.light}%,${s.life * flicker})`;
        ctx.lineWidth = s.size;
        ctx.lineCap = "round";
        ctx.stroke();
      }
      ctx.globalCompositeOperation = "source-over";
      if (now - start < duration || sparks.length || rockets.length) raf = requestAnimationFrame(frame);
      else onEnd?.();
    };
    raf = requestAnimationFrame(frame);
    addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(raf);
      schedule.forEach(clearTimeout);
      removeEventListener("resize", resize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <canvas ref={ref} className="pointer-events-none fixed inset-0 z-[80] h-full w-full" aria-hidden />;
}
