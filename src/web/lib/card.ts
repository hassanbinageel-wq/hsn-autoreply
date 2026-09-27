import { CARD_SIZES, cardDateLine, fillCard, prizeFor, type CardDesign, type CardVars } from "../../shared/card";

const FONT = `"Segoe UI", Tahoma, "Noto Naskh Arabic", "Noto Sans Arabic", Arial, sans-serif`;
const ltr = (t: string) => `⁦${t}⁩`;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
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
    out.push(line);
  }
  return out;
}

/** Keeps @usernames left-to-right inside Arabic lines. */
const isolateHandles = (t: string) => t.replace(/@[A-Za-z0-9._]+/g, (m) => ltr(m));

/**
 * Draws the congratulation card at full resolution (1080 wide). Only local images (uploaded backgrounds as data URLs)
 * are drawn, so the canvas can always be exported.
 */
export async function renderCard(d: CardDesign, v: CardVars): Promise<HTMLCanvasElement> {
  const size = CARD_SIZES[d.size];
  const c = document.createElement("canvas");
  c.width = size.w;
  c.height = size.h;
  const ctx = c.getContext("2d")!;
  ctx.direction = "rtl";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // background
  const g = ctx.createLinearGradient(0, 0, size.w, size.h);
  g.addColorStop(0, d.bg1);
  g.addColorStop(1, d.bg2);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size.w, size.h);
  if (d.background_image) {
    try {
      const img = await loadImage(d.background_image);
      const scale = Math.max(size.w / img.width, size.h / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, (size.w - w) / 2, (size.h - h) / 2, w, h);
      ctx.fillStyle = `rgba(0,0,0,${d.background_dim})`;
      ctx.fillRect(0, 0, size.w, size.h);
    } catch {
      /* keep the gradient */
    }
  }
  // decorative frame + sparkles
  ctx.strokeStyle = d.accent;
  ctx.globalAlpha = 0.85;
  ctx.lineWidth = 6;
  ctx.strokeRect(40, 40, size.w - 80, size.h - 80);
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.5;
  ctx.strokeRect(58, 58, size.w - 116, size.h - 116);
  ctx.globalAlpha = 1;
  const star = (x: number, y: number, r: number) => {
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (Math.PI / 4) * i;
      const rr = i % 2 ? r * 0.35 : r;
      ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fillStyle = d.accent;
    ctx.fill();
  };
  [[140, 150, 16], [size.w - 150, 190, 22], [190, size.h - 210, 14], [size.w - 170, size.h - 160, 18]].forEach(([x, y, r]) => star(x, y, r));

  const cx = size.w / 2;
  const maxW = size.w - 220;
  const scaleY = size.h / 1350;
  let y = 190 * scaleY;

  // contest title
  ctx.fillStyle = d.accent;
  ctx.font = `700 46px ${FONT}`;
  for (const line of wrap(ctx, d.title, maxW)) {
    ctx.fillText(line, cx, y);
    y += 60;
  }
  y += 40 * scaleY;
  // trophy
  ctx.font = `140px ${FONT}`;
  ctx.fillText("🏆", cx, y + 60);
  y += 190 * scaleY + 40;
  // headline
  ctx.fillStyle = d.text_color;
  ctx.font = `800 82px ${FONT}`;
  for (const line of wrap(ctx, d.headline, maxW)) {
    ctx.fillText(line, cx, y);
    y += 96;
  }
  y += 30 * scaleY;
  // winner handle
  ctx.fillStyle = d.accent;
  ctx.font = `800 70px ${FONT}`;
  ctx.fillText(ltr(v.username ? `@${v.username}` : "الفائز"), cx, y);
  y += 110 * scaleY;
  // body
  ctx.fillStyle = d.text_color;
  ctx.font = `500 44px ${FONT}`;
  for (const line of wrap(ctx, isolateHandles(fillCard(d.body, d, v)), maxW)) {
    ctx.fillText(line, cx, y);
    y += 62;
  }
  // prize box
  const prize = prizeFor(d, v.position);
  if (prize) {
    y += 40 * scaleY;
    ctx.font = `700 50px ${FONT}`;
    const lines = wrap(ctx, prize, maxW - 80);
    const boxH = 90 + lines.length * 64;
    ctx.fillStyle = "rgba(255,255,255,0.10)";
    ctx.strokeStyle = d.accent;
    ctx.lineWidth = 3;
    const bx = 110;
    const bw = size.w - 220;
    ctx.beginPath();
    ctx.roundRect(bx, y, bw, boxH, 28);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = d.accent;
    ctx.font = `600 34px ${FONT}`;
    ctx.fillText(`🎁 ${d.prize_label}`, cx, y + 44);
    ctx.fillStyle = d.text_color;
    ctx.font = `700 50px ${FONT}`;
    let py = y + 100;
    for (const l of lines) {
      ctx.fillText(l, cx, py);
      py += 64;
    }
    y += boxH;
  }
  // date + footer at the bottom
  const date = cardDateLine(d, v);
  ctx.fillStyle = d.text_color;
  ctx.globalAlpha = 0.85;
  ctx.font = `500 36px ${FONT}`;
  if (date) ctx.fillText(`📅 ${date}`, cx, size.h - 190);
  const footer = fillCard(d.footer, d, v);
  if (footer) {
    ctx.font = `600 38px ${FONT}`;
    ctx.fillText(isolateHandles(footer), cx, size.h - 125);
  }
  ctx.globalAlpha = 1;
  return c;
}

export function canvasToJpegDataUrl(c: HTMLCanvasElement, quality = 0.88): string {
  return c.toDataURL("image/jpeg", quality);
}

/** Re-encodes an uploaded background to a bounded JPEG data URL (max 1080px wide). */
export async function compressBackground(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, 1080 / img.width);
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    let q = 0.82;
    let out = c.toDataURL("image/jpeg", q);
    while (out.length > 1_300_000 && q > 0.4) {
      q -= 0.1;
      out = c.toDataURL("image/jpeg", q);
    }
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}
