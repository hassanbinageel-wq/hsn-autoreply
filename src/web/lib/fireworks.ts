/**
 * Fireworks particle engine drawn onto any 2D canvas: rockets with a glowing trail rise, burst into sparks
 * (sphere, ring, willow or crackle shells) that fall with gravity, flicker and fade. Additive blending gives the glow.
 * `update` must be called once per frame; the caller clears / paints the background.
 */
type Rocket = { x: number; y: number; vx: number; vy: number; targetY: number; hue: number; trail: Array<[number, number]> };
type Spark = { x: number; y: number; vx: number; vy: number; life: number; decay: number; hue: number; light: number; size: number; drag: number; grav: number; trail: Array<[number, number]>; flash?: boolean };

const HUES = [0, 28, 45, 120, 185, 210, 280, 320];

export class Fireworks {
  private rockets: Rocket[] = [];
  private sparks: Spark[] = [];
  /** Called with a 0..1 loudness whenever a shell bursts (for sound). */
  onBurst?: (power: number) => void;

  constructor(private w: number, private h: number, private scale = 1) {}

  resize(w: number, h: number, scale = this.scale) {
    this.w = w;
    this.h = h;
    this.scale = scale;
  }

  get active() {
    return this.rockets.length + this.sparks.length > 0;
  }

  launch(x = this.w * (0.12 + Math.random() * 0.76), targetY = this.h * (0.1 + Math.random() * 0.35)) {
    const s = this.scale;
    const dist = this.h - targetY;
    this.rockets.push({
      x,
      y: this.h + 10,
      vx: (Math.random() - 0.5) * 1.4 * s,
      vy: -Math.sqrt(2 * 0.12 * s * dist) * (1.02 + Math.random() * 0.08),
      targetY,
      hue: HUES[Math.floor(Math.random() * HUES.length)],
      trail: [],
    });
  }

  burstAt(x: number, y: number, hue = HUES[Math.floor(Math.random() * HUES.length)]) {
    const s = this.scale;
    const kind = Math.random();
    const n = 110 + Math.floor(Math.random() * 60);
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * 2 * i) / n + Math.random() * 0.05;
      let sp: number;
      let drag = 0.975;
      let grav = 0.07;
      let decay = 0.009 + Math.random() * 0.011;
      if (kind < 0.3) sp = 6 + Math.random() * 0.5; // ring
      else if (kind < 0.5) {
        sp = Math.random() * 5 + 2; // willow: long, drooping gold
        drag = 0.965;
        grav = 0.05;
        decay = 0.005 + Math.random() * 0.004;
      } else sp = Math.random() * 7.5 + 1; // sphere
      const h = kind >= 0.3 && kind < 0.5 ? 42 : Math.random() < 0.2 ? hue + 40 : hue;
      this.sparks.push({ x, y, vx: Math.cos(a) * sp * s, vy: Math.sin(a) * sp * s, life: 1, decay, hue: h, light: 55 + Math.random() * 25, size: (1.6 + Math.random() * 1.6) * s, drag, grav: grav * s, trail: [] });
    }
    if (kind > 0.8) {
      // crackle: small white glitter
      for (let i = 0; i < 40; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = Math.random() * 3 * s;
        this.sparks.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, decay: 0.02 + Math.random() * 0.02, hue: 50, light: 95, size: 1.2 * s, drag: 0.94, grav: 0.02 * s, trail: [] });
      }
    }
    this.sparks.push({ x, y, vx: 0, vy: 0, life: 1, decay: 0.07, hue, light: 95, size: 30 * s, drag: 1, grav: 0, trail: [], flash: true });
    this.onBurst?.(0.6 + Math.random() * 0.4);
  }

  update(ctx: CanvasRenderingContext2D) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i];
      r.trail.push([r.x, r.y]);
      if (r.trail.length > 12) r.trail.shift();
      r.x += r.vx;
      r.y += r.vy;
      r.vy += 0.12 * this.scale;
      ctx.beginPath();
      ctx.moveTo(r.trail[0][0], r.trail[0][1]);
      for (const [tx, ty] of r.trail) ctx.lineTo(tx, ty);
      ctx.strokeStyle = `hsla(${r.hue},100%,78%,0.9)`;
      ctx.lineWidth = 2.6 * this.scale;
      ctx.stroke();
      if (r.y <= r.targetY || r.vy >= -0.5) {
        this.burstAt(r.x, r.y, r.hue);
        this.rockets.splice(i, 1);
      }
    }
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.trail.push([s.x, s.y]);
      if (s.trail.length > 6) s.trail.shift();
      s.vx *= s.drag;
      s.vy = s.vy * s.drag + s.grav;
      s.x += s.vx;
      s.y += s.vy;
      s.life -= s.decay;
      if (s.life <= 0) {
        this.sparks.splice(i, 1);
        continue;
      }
      if (s.flash) {
        const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.size * 3);
        g.addColorStop(0, `hsla(${s.hue},100%,92%,${s.life * 0.9})`);
        g.addColorStop(1, `hsla(${s.hue},100%,50%,0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.size * 3, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      const flicker = s.life < 0.45 && Math.random() < 0.18 ? 0.25 : 1;
      ctx.beginPath();
      ctx.moveTo(s.trail[0][0], s.trail[0][1]);
      for (const [tx, ty] of s.trail) ctx.lineTo(tx, ty);
      ctx.strokeStyle = `hsla(${s.hue},100%,${s.light}%,${Math.min(1, s.life * 1.2) * flicker})`;
      ctx.lineWidth = s.size;
      ctx.stroke();
    }
    ctx.restore();
  }
}
