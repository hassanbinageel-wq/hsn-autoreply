import "@fontsource/cairo/arabic-400.css";
import "@fontsource/cairo/arabic-600.css";
import "@fontsource/cairo/arabic-700.css";
import "@fontsource/cairo/arabic-800.css";
import "@fontsource/cairo/latin-600.css";
import "@fontsource/cairo/latin-800.css";
import "@fontsource/reem-kufi/arabic-700.css";
import "@fontsource/reem-kufi/latin-700.css";
import "@fontsource/lalezar/arabic-400.css";
import "@fontsource/lalezar/latin-400.css";
import { CARD_FONTS, CARD_SIZES, cardDateLine, fillCard, prizeFor, type CardDesign, type CardVars } from "../../shared/card";

/**
 * Congratulation card renderer (canvas → JPEG). Three layouts share one block engine: each block measures its
 * height, then the blocks are spread vertically to fit portrait, square or story sizes.
 * Everything is drawn with vectors and bundled fonts, so the result looks the same on every device.
 */

const FALLBACK = `"IBM Plex Sans Arabic", "Segoe UI", Tahoma, Arial, sans-serif`;
const ltr = (t: string) => `⁦${t}⁩`;
const isolateHandles = (t: string) => t.replace(/@[A-Za-z0-9._]+/g, (m) => ltr(m));

// ---------- colors ----------
function hex(c: string): [number, number, number] {
  const m = c.replace("#", "");
  return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
}
const rgba = (c: string, a: number) => {
  const [r, g, b] = hex(c);
  return `rgba(${r},${g},${b},${a})`;
};
function mix(c: string, to: string, k: number) {
  const a = hex(c);
  const b = hex(to);
  return "#" + a.map((v, i) => Math.round(v + (b[i] - v) * k).toString(16).padStart(2, "0")).join("");
}
const lighten = (c: string, k: number) => mix(c, "#ffffff", k);
const darken = (c: string, k: number) => mix(c, "#000000", k);
const luminance = (c: string) => {
  const [r, g, b] = hex(c).map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const onColor = (c: string) => (luminance(c) > 0.45 ? "#1a1408" : "#ffffff");

function seeded(seed: number) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Reads a picked file as a data: URL (the app's CSP allows data: images, not blob:). */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

async function ensureFonts(d: CardDesign) {
  const f = CARD_FONTS[d.font] ?? CARD_FONTS.cairo;
  const sample = "مبروك الفوز abc 123";
  const loads = [`${f.weight} 60px "${f.display}"`, `400 40px "${f.body}"`, `600 40px "${f.body}"`, `700 40px "${f.body}"`, `600 40px "Cairo"`].map((x) =>
    document.fonts?.load(x, sample).catch(() => undefined),
  );
  await Promise.race([Promise.all(loads), new Promise((r) => setTimeout(r, 2500))]);
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines = 6): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = "";
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (ctx.measureText(test).width > maxWidth && line) {
        out.push(line);
        line = w;
      } else line = test;
    }
    if (line) out.push(line);
  }
  return out.slice(0, maxLines);
}

function fit(ctx: CanvasRenderingContext2D, text: string, font: (px: number) => string, px: number, maxW: number, min = 24) {
  let s = px;
  ctx.font = font(s);
  while (s > min && ctx.measureText(text).width > maxW) {
    s -= 2;
    ctx.font = font(s);
  }
  return s;
}

// ---------- vector pieces ----------
function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, points = 4, inner = 0.38) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const a = (Math.PI / points) * i - Math.PI / 2;
    const rr = i % 2 ? r * inner : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
}

/** Gold rosette medal with ribbons and the winner's position number. */
function medal(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, accent: string, ribbon: string, num: string, font: string) {
  // ribbons
  for (const side of [-1, 1]) {
    ctx.save();
    ctx.translate(cx + side * r * 0.3, cy + r * 0.4);
    ctx.rotate(side * 0.3);
    const w = r * 0.62;
    const h = r * 1.65;
    const g = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
    g.addColorStop(0, darken(ribbon, 0.25));
    g.addColorStop(0.5, ribbon);
    g.addColorStop(1, darken(ribbon, 0.3));
    ctx.beginPath();
    ctx.moveTo(-w / 2, 0);
    ctx.lineTo(w / 2, 0);
    ctx.lineTo(w / 2, h);
    ctx.lineTo(0, h - w * 0.45);
    ctx.lineTo(-w / 2, h);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = lighten(accent, 0.55);
    ctx.lineWidth = r * 0.035;
    ctx.beginPath();
    ctx.moveTo(-w / 2 + r * 0.07, 0);
    ctx.lineTo(-w / 2 + r * 0.07, h - r * 0.08);
    ctx.moveTo(w / 2 - r * 0.07, 0);
    ctx.lineTo(w / 2 - r * 0.07, h - r * 0.08);
    ctx.stroke();
    ctx.restore();
  }
  // glow
  const glow = ctx.createRadialGradient(cx, cy, r * 0.6, cx, cy, r * 1.9);
  glow.addColorStop(0, rgba(accent, 0.45));
  glow.addColorStop(1, rgba(accent, 0));
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 1.9, 0, Math.PI * 2);
  ctx.fill();
  // serrated rosette
  const gold = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
  gold.addColorStop(0, lighten(accent, 0.55));
  gold.addColorStop(0.45, accent);
  gold.addColorStop(1, darken(accent, 0.4));
  star(ctx, cx, cy, r * 1.12, 28, 0.88);
  ctx.fillStyle = gold;
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = r * 0.25;
  ctx.shadowOffsetY = r * 0.08;
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  // disc
  const disc = ctx.createLinearGradient(cx, cy - r, cx, cy + r);
  disc.addColorStop(0, lighten(accent, 0.25));
  disc.addColorStop(1, darken(accent, 0.3));
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.86, 0, Math.PI * 2);
  ctx.fillStyle = disc;
  ctx.fill();
  ctx.lineWidth = r * 0.045;
  ctx.strokeStyle = lighten(accent, 0.65);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.74, 0, Math.PI * 2);
  ctx.lineWidth = r * 0.02;
  ctx.strokeStyle = rgba(darken(accent, 0.5), 0.5);
  ctx.stroke();
  // shine
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.86, 0, Math.PI * 2);
  ctx.clip();
  const shine = ctx.createLinearGradient(cx - r, cy - r, cx + r * 0.2, cy + r * 0.2);
  shine.addColorStop(0, "rgba(255,255,255,0.35)");
  shine.addColorStop(0.5, "rgba(255,255,255,0)");
  ctx.fillStyle = shine;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  ctx.restore();
  // number + small stars
  ctx.fillStyle = onColor(accent) === "#ffffff" ? "#fffdf5" : darken(accent, 0.7);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `800 ${Math.round(r * 0.95)}px "Cairo", ${FALLBACK}`;
  ctx.shadowColor = "rgba(0,0,0,0.25)";
  ctx.shadowBlur = r * 0.06;
  ctx.fillText(num, cx, cy + r * 0.06);
  ctx.shadowBlur = 0;
  ctx.shadowColor = "transparent";
  star(ctx, cx, cy - r * 0.56, r * 0.1, 5, 0.45);
  ctx.fill();
  void font;
}

function calendarIcon(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, color: string) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = s * 0.1;
  ctx.beginPath();
  ctx.roundRect(x - s / 2, y - s / 2 + s * 0.08, s, s * 0.9, s * 0.15);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - s / 2, y - s * 0.12);
  ctx.lineTo(x + s / 2, y - s * 0.12);
  ctx.moveTo(x - s * 0.25, y - s * 0.55);
  ctx.lineTo(x - s * 0.25, y - s * 0.3);
  ctx.moveTo(x + s * 0.25, y - s * 0.55);
  ctx.lineTo(x + s * 0.25, y - s * 0.3);
  ctx.stroke();
  ctx.restore();
}

// ---------- backgrounds & decorations ----------
function background(ctx: CanvasRenderingContext2D, d: CardDesign, W: number, H: number) {
  const g = ctx.createLinearGradient(0, 0, W * 0.4, H);
  g.addColorStop(0, d.bg1);
  g.addColorStop(1, d.bg2);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const rg = ctx.createRadialGradient(W / 2, H * 0.3, 0, W / 2, H * 0.3, Math.max(W, H) * 0.7);
  rg.addColorStop(0, rgba(d.accent, 0.22));
  rg.addColorStop(1, rgba(d.accent, 0));
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, W, H);
  // vignette
  const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.8);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, luminance(d.bg1) > 0.5 ? "rgba(120,90,30,0.12)" : "rgba(0,0,0,0.35)");
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);
}

function confetti(ctx: CanvasRenderingContext2D, d: CardDesign, W: number, H: number, n: number, rand: () => number, avoid?: { x: number; y: number; w: number; h: number }) {
  const colors = [d.accent, lighten(d.accent, 0.5), d.text_color, lighten(d.bg2, 0.4)];
  for (let i = 0; i < n; i++) {
    const x = rand() * W;
    const y = rand() * H;
    if (avoid && x > avoid.x && x < avoid.x + avoid.w && y > avoid.y && y < avoid.y + avoid.h && rand() < 0.85) continue;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rand() * Math.PI);
    ctx.globalAlpha = 0.35 + rand() * 0.5;
    ctx.fillStyle = colors[Math.floor(rand() * colors.length)];
    const k = rand();
    if (k < 0.45) ctx.fillRect(-9, -4, 18, 8);
    else if (k < 0.75) {
      ctx.beginPath();
      ctx.arc(0, 0, 5 + rand() * 4, 0, Math.PI * 2);
      ctx.fill();
    } else {
      star(ctx, 0, 0, 9 + rand() * 6, 4, 0.35);
      ctx.fill();
    }
    ctx.restore();
  }
}

function royalFrame(ctx: CanvasRenderingContext2D, d: CardDesign, W: number, H: number) {
  const m = 44;
  ctx.save();
  ctx.strokeStyle = d.accent;
  ctx.lineWidth = 3;
  ctx.globalAlpha = 0.9;
  ctx.strokeRect(m, m, W - 2 * m, H - 2 * m);
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(m + 16, m + 16, W - 2 * (m + 16), H - 2 * (m + 16));
  ctx.globalAlpha = 1;
  // corner ornaments
  const L = 70;
  for (const [cx, cy, sx, sy] of [
    [m, m, 1, 1],
    [W - m, m, -1, 1],
    [m, H - m, 1, -1],
    [W - m, H - m, -1, -1],
  ]) {
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(cx + sx * L, cy + sy * 0);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx, cy + sy * L);
    ctx.stroke();
    ctx.save();
    ctx.translate(cx + sx * 34, cy + sy * 34);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = d.accent;
    ctx.fillRect(-7, -7, 14, 14);
    ctx.restore();
  }
  // subtle diamond lattice
  ctx.globalAlpha = 0.05;
  ctx.lineWidth = 1;
  for (let i = -H; i < W + H; i += 60) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + H, H);
    ctx.moveTo(i + H, 0);
    ctx.lineTo(i, H);
    ctx.stroke();
  }
  ctx.restore();
}

function modernDeco(ctx: CanvasRenderingContext2D, d: CardDesign, W: number, H: number, pos: number, displayFont: string) {
  ctx.save();
  // giant faint position number
  ctx.globalAlpha = 0.05;
  ctx.fillStyle = d.text_color;
  ctx.font = `800 ${Math.round(H * 0.55)}px "Cairo", ${FALLBACK}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(String(pos).padStart(2, "0"), -W * 0.04, H * 0.98);
  // circles
  ctx.globalAlpha = 0.12;
  ctx.strokeStyle = d.accent;
  ctx.lineWidth = 3;
  for (const [x, y, r] of [
    [W * 0.92, H * 0.08, 220],
    [W * 0.92, H * 0.08, 300],
    [W * 0.05, H * 0.55, 140],
  ]) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  // accent bar at the top
  ctx.globalAlpha = 1;
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, d.accent);
  g.addColorStop(1, lighten(d.accent, 0.5));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, 14);
  ctx.restore();
  void displayFont;
}

function sunburst(ctx: CanvasRenderingContext2D, d: CardDesign, cx: number, cy: number, R: number) {
  ctx.save();
  ctx.translate(cx, cy);
  const g = ctx.createRadialGradient(0, 0, 40, 0, 0, R);
  g.addColorStop(0, rgba(d.accent, 0.3));
  g.addColorStop(1, rgba(d.accent, 0));
  ctx.fillStyle = g;
  for (let i = 0; i < 24; i++) {
    ctx.rotate((Math.PI * 2) / 24);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-R * 0.09, -R);
    ctx.lineTo(R * 0.09, -R);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function streamers(ctx: CanvasRenderingContext2D, d: CardDesign, W: number, H: number, rand: () => number) {
  ctx.save();
  ctx.lineWidth = 7;
  ctx.lineCap = "round";
  const cols = [d.accent, lighten(d.bg2, 0.45), d.text_color];
  for (let i = 0; i < 7; i++) {
    const left = i % 2 === 0;
    const x0 = left ? -20 : W + 20;
    const y0 = 60 + rand() * H * 0.25;
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = cols[i % cols.length];
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    const dir = left ? 1 : -1;
    ctx.bezierCurveTo(x0 + dir * 120, y0 + 80, x0 + dir * 40, y0 + 170, x0 + dir * (170 + rand() * 60), y0 + 240);
    ctx.stroke();
  }
  ctx.restore();
}

// ---------- block engine ----------
interface Block {
  h: number;
  gapBefore?: number;
  draw: (y: number) => void;
}

export async function renderCard(d: CardDesign, v: CardVars): Promise<HTMLCanvasElement> {
  await ensureFonts(d);
  const size = CARD_SIZES[d.size];
  const W = size.w;
  const H = size.h;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  ctx.direction = "rtl";
  ctx.textBaseline = "middle";
  const F = CARD_FONTS[d.font] ?? CARD_FONTS.cairo;
  const display = (px: number) => `${F.weight} ${px}px "${F.display}", ${FALLBACK}`;
  const body = (w: number, px: number) => `${w} ${px}px "${F.body}", ${FALLBACK}`;
  const layout = d.layout ?? "royal";
  const rand = seeded([...(d.title + d.headline + layout)].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7));
  const onAccent = onColor(d.accent);
  const cx = W / 2;

  background(ctx, d, W, H);
  if (d.background_image) {
    try {
      const img = await loadImage(d.background_image);
      const scale = Math.max(W / img.width, H / img.height);
      ctx.drawImage(img, (W - img.width * scale) / 2, (H - img.height * scale) / 2, img.width * scale, img.height * scale);
      ctx.fillStyle = `rgba(0,0,0,${d.background_dim})`;
      ctx.fillRect(0, 0, W, H);
    } catch {
      /* keep the gradient */
    }
  }
  if (layout === "royal") royalFrame(ctx, d, W, H);
  if (layout === "modern") modernDeco(ctx, d, W, H, v.position, F.display);
  if (layout === "festive") {
    confetti(ctx, d, W, H, 90, rand, { x: 120, y: H * 0.25, w: W - 240, h: H * 0.6 });
    streamers(ctx, d, W, H, rand);
  }

  const prize = prizeFor(d, v.position);
  const date = cardDateLine(d, v);
  const footer = fillCard(d.footer, d, v);
  const handle = v.username ? `@${v.username}` : "الفائز";
  const modern = layout === "modern";
  const margin = modern ? 110 : 120;
  const maxW = W - margin * 2;
  const align: CanvasTextAlign = modern ? "right" : "center";
  const tx = modern ? W - margin : cx;
  const topY = modern ? 110 : 120;
  const bottomY = H - (footer || date ? 210 : 110);

  const build = (k: number): Block[] => {
    const blocks: Block[] = [];
    // contest title
    if (d.title) {
      ctx.font = body(600, Math.round(38 * k));
      const t = d.title;
      const tw = Math.min(ctx.measureText(t).width, maxW - 160);
      blocks.push({
        h: 64 * k,
        draw: (y) => {
          const my = y + 32 * k;
          ctx.textAlign = align;
          ctx.font = body(600, Math.round(38 * k));
          fit(ctx, t, (px) => body(600, px), Math.round(38 * k), maxW - 160);
          if (modern) {
            const w = Math.min(ctx.measureText(t).width + 56, maxW);
            ctx.fillStyle = rgba(d.accent, 0.16);
            ctx.beginPath();
            ctx.roundRect(W - margin - w, my - 30 * k, w, 60 * k, 30 * k);
            ctx.fill();
            ctx.fillStyle = d.accent;
            ctx.fillText(t, W - margin - 28, my + 2);
          } else {
            ctx.fillStyle = d.accent;
            ctx.fillText(t, cx, my);
            ctx.strokeStyle = rgba(d.accent, 0.7);
            ctx.lineWidth = 2;
            for (const s of [-1, 1]) {
              ctx.beginPath();
              ctx.moveTo(cx + s * (tw / 2 + 24), my);
              ctx.lineTo(cx + s * (tw / 2 + 90), my);
              ctx.stroke();
              star(ctx, cx + s * (tw / 2 + 100), my, 8, 4, 0.4);
              ctx.fillStyle = d.accent;
              ctx.fill();
            }
          }
        },
      });
    }
    // medal (royal / festive) — modern shows the number as a badge next to the headline instead
    if (!modern) {
      const r = 118 * k;
      blocks.push({
        h: r * 2 + r * 1.25,
        gapBefore: 1,
        draw: (y) => {
          const my = y + r * 1.15;
          if (layout === "festive") sunburst(ctx, d, cx, my, r * 3.6);
          medal(ctx, cx, my, r, d.accent, darken(d.accent, 0.12), String(v.position), F.display);
        },
      });
    }
    // headline
    const headSize = Math.round((modern ? 108 : 92) * k);
    ctx.font = display(headSize);
    const headLines = wrap(ctx, fillCard(d.headline, d, v), maxW, 2);
    blocks.push({
      h: headLines.length * headSize * 1.2,
      gapBefore: 1,
      draw: (y) => {
        ctx.textAlign = align;
        ctx.font = display(headSize);
        ctx.fillStyle = d.text_color;
        ctx.shadowColor = "rgba(0,0,0,0.25)";
        ctx.shadowBlur = 16;
        headLines.forEach((l, i) => ctx.fillText(l, tx, y + headSize * 0.6 + i * headSize * 1.2));
        ctx.shadowBlur = 0;
        ctx.shadowColor = "transparent";
      },
    });
    // winner handle in a pill
    const hs = Math.round(62 * k);
    blocks.push({
      h: hs * 1.9,
      draw: (y) => {
        const my = y + hs * 0.95;
        const text = ltr(handle);
        fit(ctx, text, (px) => body(700, px), hs, maxW - 120, 30);
        const w = Math.min(ctx.measureText(text).width + 110, maxW);
        const x0 = modern ? W - margin - w : cx - w / 2;
        ctx.beginPath();
        ctx.roundRect(x0, my - hs * 0.85, w, hs * 1.7, hs * 0.85);
        if (modern) {
          ctx.fillStyle = d.accent;
          ctx.fill();
        } else {
          ctx.fillStyle = rgba(d.accent, 0.14);
          ctx.fill();
          ctx.lineWidth = 3;
          ctx.strokeStyle = d.accent;
          ctx.stroke();
        }
        ctx.fillStyle = modern ? onAccent : d.text_color;
        ctx.textAlign = "center";
        ctx.fillText(text, x0 + w / 2, my + 2);
      },
    });
    // body
    const bs = Math.round(40 * k);
    ctx.font = body(400, bs);
    const bodyLines = wrap(ctx, isolateHandles(fillCard(d.body, d, v)), maxW, 4);
    if (bodyLines.length)
      blocks.push({
        h: bodyLines.length * bs * 1.45,
        draw: (y) => {
          ctx.textAlign = align;
          ctx.font = body(400, bs);
          ctx.fillStyle = rgba(d.text_color.length === 7 ? d.text_color : "#ffffff", 0.9);
          bodyLines.forEach((l, i) => ctx.fillText(l, tx, y + bs * 0.72 + i * bs * 1.45));
        },
      });
    // prize
    if (prize) {
      const ps = Math.round(52 * k);
      ctx.font = body(700, ps);
      const pl = wrap(ctx, prize, maxW - 120, 2);
      const boxH = 70 * k + pl.length * ps * 1.25 + 40 * k;
      blocks.push({
        h: boxH + 24 * k,
        gapBefore: 1,
        draw: (y0) => {
          const y = y0 + 24 * k;
          const bx = margin;
          const bw = W - margin * 2;
          const label = `🎁 ${d.prize_label}`;
          if (layout === "modern") {
            const g = ctx.createLinearGradient(bx, y, bx + bw, y + boxH);
            g.addColorStop(0, d.accent);
            g.addColorStop(1, lighten(d.accent, 0.3));
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.roundRect(bx, y, bw, boxH, 30);
            ctx.fill();
            ctx.fillStyle = rgba(onAccent, 0.75);
            ctx.textAlign = "right";
            ctx.font = body(600, Math.round(32 * k));
            ctx.fillText(label, bx + bw - 40, y + 44 * k);
            ctx.fillStyle = onAccent;
            ctx.font = body(700, ps);
            pl.forEach((l, i) => ctx.fillText(l, bx + bw - 40, y + 70 * k + ps * 0.75 + i * ps * 1.25));
            return;
          }
          ctx.beginPath();
          if (layout === "festive") {
            // ticket shape with side notches
            const r = 26;
            const nr = 22;
            ctx.moveTo(bx + r, y);
            ctx.lineTo(bx + bw - r, y);
            ctx.arcTo(bx + bw, y, bx + bw, y + r, r);
            ctx.lineTo(bx + bw, y + boxH / 2 - nr);
            ctx.arc(bx + bw, y + boxH / 2, nr, -Math.PI / 2, Math.PI / 2, true);
            ctx.lineTo(bx + bw, y + boxH - r);
            ctx.arcTo(bx + bw, y + boxH, bx + bw - r, y + boxH, r);
            ctx.lineTo(bx + r, y + boxH);
            ctx.arcTo(bx, y + boxH, bx, y + boxH - r, r);
            ctx.lineTo(bx, y + boxH / 2 + nr);
            ctx.arc(bx, y + boxH / 2, nr, Math.PI / 2, -Math.PI / 2, true);
            ctx.lineTo(bx, y + r);
            ctx.arcTo(bx, y, bx + r, y, r);
            ctx.closePath();
          } else ctx.roundRect(bx, y, bw, boxH, 26);
          ctx.fillStyle = luminance(d.bg1) > 0.5 ? rgba("#ffffff", 0.6) : rgba("#ffffff", 0.08);
          ctx.fill();
          ctx.lineWidth = 3;
          ctx.strokeStyle = d.accent;
          ctx.setLineDash(layout === "festive" ? [14, 10] : []);
          ctx.stroke();
          ctx.setLineDash([]);
          // label tab on the top edge
          ctx.font = body(700, Math.round(30 * k));
          const lw = ctx.measureText(label).width + 50;
          ctx.fillStyle = d.accent;
          ctx.beginPath();
          ctx.roundRect(cx - lw / 2, y - 26 * k, lw, 52 * k, 26 * k);
          ctx.fill();
          ctx.fillStyle = onAccent;
          ctx.textAlign = "center";
          ctx.fillText(label, cx, y + 1);
          ctx.fillStyle = d.text_color;
          ctx.font = body(700, ps);
          pl.forEach((l, i) => ctx.fillText(l, cx, y + 60 * k + ps * 0.7 + i * ps * 1.25));
        },
      });
    }
    return blocks;
  };

  // shrink until the blocks fit, then spread the free space
  let k = Math.min(1, W / 1080);
  let blocks = build(k);
  const avail = bottomY - topY;
  const total = (b: Block[]) => b.reduce((a, x) => a + x.h, 0);
  while (total(blocks) + blocks.length * 18 > avail && k > 0.55) {
    k -= 0.05;
    blocks = build(k);
  }
  const free = avail - total(blocks);
  const gaps = blocks.length - 1 + blocks.filter((b) => b.gapBefore).length;
  const gap = Math.max(14, Math.min(free / Math.max(1, gaps + 1), 90));
  let y = topY + Math.max(0, (free - gap * gaps) / 2);
  blocks.forEach((b, i) => {
    if (i > 0) y += gap * (b.gapBefore ? 2 : 1);
    b.draw(y);
    y += b.h;
  });

  // logo on top of everything, where the owner placed it
  if (d.logo_image) {
    try {
      const img = await loadImage(d.logo_image);
      const lw = W * d.logo_size;
      const lh = (img.height / img.width) * lw;
      const x = d.logo_x * W - lw / 2;
      const y = d.logo_y * H - lh / 2;
      ctx.save();
      ctx.globalAlpha = d.logo_opacity;
      if (d.logo_shape !== "original") {
        const side = Math.min(lw, lh);
        const cxl = d.logo_x * W;
        const cyl = d.logo_y * H;
        ctx.beginPath();
        if (d.logo_shape === "circle") ctx.arc(cxl, cyl, side / 2, 0, Math.PI * 2);
        else ctx.roundRect(cxl - lw / 2, cyl - lh / 2, lw, lh, side * 0.18);
        ctx.clip();
        const s = d.logo_shape === "circle" ? Math.max(side / img.width, side / img.height) : 1;
        if (d.logo_shape === "circle") ctx.drawImage(img, cxl - (img.width * s) / 2, cyl - (img.height * s) / 2, img.width * s, img.height * s);
        else ctx.drawImage(img, x, y, lw, lh);
      } else ctx.drawImage(img, x, y, lw, lh);
      ctx.restore();
    } catch {
      /* ignore a broken logo */
    }
  }

  // bottom: date + account
  ctx.textAlign = "center";
  const dateY = H - (footer ? 170 : 120);
  if (date) {
    ctx.font = body(500, 34);
    ctx.fillStyle = rgba(d.text_color.length === 7 ? d.text_color : "#ffffff", 0.85);
    const tw = ctx.measureText(date).width;
    if (modern) {
      ctx.textAlign = "right";
      ctx.fillText(date, W - margin, dateY);
      calendarIcon(ctx, W - margin - tw - 30, dateY, 30, d.accent);
    } else {
      ctx.fillText(date, cx - 20, dateY);
      calendarIcon(ctx, cx + tw / 2 + 12, dateY, 30, d.accent);
    }
  }
  if (footer) {
    const fy = H - 105;
    ctx.font = body(700, 36);
    const text = isolateHandles(footer);
    const fw = ctx.measureText(text).width;
    ctx.fillStyle = d.text_color;
    if (modern) {
      ctx.textAlign = "right";
      ctx.fillText(text, W - margin, fy);
    } else {
      ctx.textAlign = "center";
      ctx.fillText(text, cx, fy);
      ctx.strokeStyle = rgba(d.accent, 0.6);
      ctx.lineWidth = 2;
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(cx + s * (fw / 2 + 20), fy);
        ctx.lineTo(cx + s * (fw / 2 + 80), fy);
        ctx.stroke();
      }
    }
  }
  return c;
}

export function canvasToJpegDataUrl(c: HTMLCanvasElement, quality = 0.9): string {
  return c.toDataURL("image/jpeg", quality);
}

/** Re-encodes an uploaded logo (max 600px, keeps transparency as PNG; falls back to WebP/JPEG when too large). */
export async function compressLogo(file: File): Promise<string> {
  {
    const img = await loadImage(await fileToDataUrl(file));
    let max = 600;
    for (;;) {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.width * scale));
      c.height = Math.max(1, Math.round(img.height * scale));
      c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
      const png = c.toDataURL("image/png");
      if (png.length <= 650_000) return png;
      const webp = c.toDataURL("image/webp", 0.85);
      if (webp.startsWith("data:image/webp") && webp.length <= 650_000) return webp;
      if (max <= 250) return c.toDataURL("image/jpeg", 0.8);
      max -= 120;
    }
  }
}

/** Re-encodes an uploaded background to a bounded JPEG data URL (max 1080px wide). */
export async function compressBackground(file: File): Promise<string> {
  {
    const img = await loadImage(await fileToDataUrl(file));
    const scale = Math.min(1, 1080 / img.width);
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    let q = 0.82;
    let out = c.toDataURL("image/jpeg", q);
    while (out.length > 1_100_000 && q > 0.3) {
      q -= 0.1;
      out = c.toDataURL("image/jpeg", q);
    }
    return out;
  }
}
