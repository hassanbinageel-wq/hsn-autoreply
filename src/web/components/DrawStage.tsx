import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Fireworks } from "../lib/fireworks";
import { buildReelPath, reelNames, type ReelStyle } from "../lib/reel";
import { Sfx } from "../lib/sfx";
import { saveFile } from "../lib/save";

/**
 * Full-screen winner reveal, drawn entirely on one 1080×1920 canvas (story format) so it can be recorded as a video:
 * a reel of all participant names moves up and down (a different motion for each winner) and stops with the
 * winner under the arrows, then the winner is revealed with fireworks. The winner was already chosen on the server.
 */
const W = 1080;
const H = 1920;
const FONT = `"IBM Plex Sans Arabic", "Segoe UI", Tahoma, Arial, sans-serif`;
const ROW = 118;
const WIN = { x: 80, y: 560, w: 920, h: 900 };
const CY = WIN.y + WIN.h / 2;
const INTRO = 2.1; // 3-2-1
const HOLD = 1.0; // winner glows under the arrow before the reveal
const REC_AFTER_REVEAL = 5.5;

const ltr = (t: string) => `⁦${t}⁩`;
const hueOf = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
};
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const easeOut = (x: number) => 1 - Math.pow(1 - clamp(x, 0, 1), 3);

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function fitText(ctx: CanvasRenderingContext2D, text: string, weight: number, size: number, maxW: number, min = 28) {
  let s = size;
  ctx.font = `${weight} ${s}px ${FONT}`;
  while (s > min && ctx.measureText(text).width > maxW) {
    s -= 2;
    ctx.font = `${weight} ${s}px ${FONT}`;
  }
  return s;
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (ctx.measureText(t).width > maxW && line) {
      out.push(line);
      line = w;
      if (out.length === maxLines) break;
    } else line = t;
  }
  if (out.length < maxLines && line) out.push(line);
  if (out.length === maxLines && words.join(" ").length > out.join(" ").length) out[maxLines - 1] = out[maxLines - 1].replace(/\s*\S*$/, " …");
  return out;
}

function avatar(ctx: CanvasRenderingContext2D, name: string, x: number, y: number, r: number, ring?: string) {
  const h = hueOf(name);
  const g = ctx.createLinearGradient(x - r, y - r, x + r, y + r);
  g.addColorStop(0, `hsl(${h},75%,60%)`);
  g.addColorStop(1, `hsl(${(h + 50) % 360},70%,42%)`);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  if (ring) {
    ctx.lineWidth = r * 0.09;
    ctx.strokeStyle = ring;
    ctx.stroke();
  }
  ctx.fillStyle = "#fff";
  ctx.font = `700 ${Math.round(r * 0.95)}px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText((name.replace(/[^A-Za-z0-9]/g, "")[0] ?? "★").toUpperCase(), x, y + r * 0.04);
}

export interface StageWinner {
  author_username: string | null;
  text?: string | null;
  position: number;
}

export function DrawStage({
  title,
  drawName,
  account,
  names,
  total,
  winner,
  style,
  record,
  onClose,
  onVideo,
}: {
  title: string;
  drawName: string;
  account: string | null;
  names: string[];
  total: number;
  winner: StageWinner;
  style: ReelStyle;
  record: boolean;
  onClose: () => void;
  onVideo?: (blob: Blob, filename: string) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const sfxRef = useRef<Sfx | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const [muted, setMuted] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [rec, setRec] = useState<"off" | "rec" | "done" | "unsupported">(record ? "rec" : "off");
  const [recSecs, setRecSecs] = useState(0);
  const [video, setVideo] = useState<{ blob: Blob; name: string } | null>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    const reduce = !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const winName = winner.author_username ?? "مشارك";
    const { list, target } = reelNames(names, winName);
    const n = list.length;
    const path = buildReelPath(style, n, target);
    const MOTION = reduce ? 0.8 : path.duration;
    const tReveal = INTRO + MOTION + HOLD;
    const sfx = new Sfx();
    sfxRef.current = sfx;
    const fw = new Fireworks(W, H, 1.6);
    fw.onBurst = (p) => sfx.boom(p);
    const bokeh = Array.from({ length: 36 }, () => ({ x: Math.random() * W, y: Math.random() * H, r: 6 + Math.random() * 26, s: 4 + Math.random() * 10, h: [270, 300, 45, 200][Math.floor(Math.random() * 4)] }));
    const date = new Date().toLocaleDateString("ar-SA-u-ca-gregory-nu-latn", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    const shows = [0, 0.25, 0.7, 1.1, 1.5, 1.9, 2.4, 2.8, 3.3, 3.8, 4.4];

    // ---------- recording ----------
    let recorder: MediaRecorder | null = null;
    const chunks: Blob[] = [];
    let recStart = 0;
    if (record) {
      const types = ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
      const mime = typeof MediaRecorder !== "undefined" ? types.find((t) => MediaRecorder.isTypeSupported?.(t)) : undefined;
      if (!mime || !canvas.captureStream) setRec("unsupported");
      else {
        try {
          const stream = canvas.captureStream(30);
          sfx.stream?.getAudioTracks().forEach((t) => stream.addTrack(t));
          recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
          recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
          recorder.onstop = () => {
            const blob = new Blob(chunks, { type: mime.split(";")[0] });
            const ext = mime.startsWith("video/mp4") ? "mp4" : "webm";
            const safe = (winner.author_username ?? "winner").replace(/[^A-Za-z0-9._-]/g, "");
            const v = { blob, name: `draw-winner-${winner.position}-${safe}.${ext}` };
            setVideo(v);
            setRec("done");
            onVideo?.(v.blob, v.name);
          };
          recorder.start(500);
          recRef.current = recorder;
          recStart = performance.now();
        } catch {
          setRec("unsupported");
        }
      }
    }
    const stopRec = () => {
      if (recorder && recorder.state === "recording") recorder.stop();
    };

    // ---------- drawing ----------
    const bg = (t: number, reveal: number) => {
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, "#0c0624");
      g.addColorStop(0.55, "#1b0b3d");
      g.addColorStop(1, "#070311");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      const rg = ctx.createRadialGradient(W / 2, CY, 0, W / 2, CY, 900);
      rg.addColorStop(0, `rgba(139,92,246,${0.35 + 0.15 * reveal})`);
      rg.addColorStop(1, "rgba(139,92,246,0)");
      ctx.fillStyle = rg;
      ctx.fillRect(0, 0, W, H);
      for (const b of bokeh) {
        const y = ((b.y - t * b.s) % H + H) % H;
        ctx.beginPath();
        ctx.arc(b.x, y, b.r, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${b.h},90%,70%,0.06)`;
        ctx.fill();
      }
      if (reveal > 0) {
        // slow light rays behind the winner
        ctx.save();
        ctx.translate(W / 2, 760);
        ctx.rotate(t * 0.15);
        ctx.globalAlpha = 0.09 * reveal;
        const rayFill = ctx.createRadialGradient(0, 0, 80, 0, 0, 1100);
        rayFill.addColorStop(0, "rgba(253,230,138,1)");
        rayFill.addColorStop(1, "rgba(253,230,138,0)");
        ctx.fillStyle = rayFill;
        for (let i = 0; i < 16; i++) {
          ctx.rotate((Math.PI * 2) / 16);
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(-45, -1200);
          ctx.lineTo(45, -1200);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
      }
    };

    const header = (alpha: number) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.direction = "rtl";
      // pill with the draw name
      ctx.font = `600 34px ${FONT}`;
      const pill = `🎁 ${drawName}`;
      const pw = Math.min(900, ctx.measureText(pill).width + 70);
      roundRect(ctx, W / 2 - pw / 2, 150, pw, 70, 35);
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      ctx.fill();
      ctx.strokeStyle = "rgba(252,211,77,0.45)";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = "#fde68a";
      fitText(ctx, pill, 600, 34, pw - 50, 22);
      ctx.fillText(pill, W / 2, 186);
      ctx.fillStyle = "#fff";
      fitText(ctx, `اختيار ${title}`, 700, 84, 960);
      ctx.fillText(`اختيار ${title}`, W / 2, 320);
      ctx.fillStyle = "rgba(255,255,255,0.65)";
      ctx.font = `400 38px ${FONT}`;
      ctx.fillText(`من بين ${total.toLocaleString("en-US")} مشارك`, W / 2, 415);
      ctx.restore();
    };

    let lastIdx = Number.NaN;
    const reel = (y: number, alpha: number, glow: number) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      roundRect(ctx, WIN.x, WIN.y, WIN.w, WIN.h, 56);
      ctx.fillStyle = "rgba(255,255,255,0.045)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.lineWidth = 2;
      ctx.stroke();
      // highlight band under the arrows
      const bandH = ROW + 14;
      roundRect(ctx, WIN.x + 26, CY - bandH / 2, WIN.w - 52, bandH, 34);
      const bg2 = ctx.createLinearGradient(WIN.x, 0, WIN.x + WIN.w, 0);
      bg2.addColorStop(0, "rgba(251,191,36,0.10)");
      bg2.addColorStop(0.5, `rgba(251,191,36,${0.2 + glow * 0.25})`);
      bg2.addColorStop(1, "rgba(251,191,36,0.10)");
      ctx.fillStyle = bg2;
      ctx.fill();
      ctx.shadowColor = "rgba(251,191,36,0.9)";
      ctx.shadowBlur = 20 + glow * 40;
      ctx.strokeStyle = "#fbbf24";
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.shadowBlur = 0;

      ctx.save();
      roundRect(ctx, WIN.x, WIN.y, WIN.w, WIN.h, 56);
      ctx.clip();
      const first = Math.floor(y) - 5;
      for (let i = first; i <= first + 11; i++) {
        let idx = i;
        if (path.wrap) idx = ((i % n) + n) % n;
        else if (i < 0 || i >= n) continue;
        const d = i - y;
        const ry = CY + d * ROW;
        const ad = Math.abs(d);
        const sc = 1 + 0.28 * Math.max(0, 1 - ad);
        const a = 1 - Math.min(1, ad / 4.2) * 0.88;
        const name = list[idx];
        ctx.globalAlpha = alpha * a;
        ctx.font = `${ad < 0.5 ? 700 : 600} ${Math.round(46 * sc)}px ${FONT}`;
        const label = ltr(`@${name}`);
        const tw = Math.min(ctx.measureText(label).width, 640);
        const ar = 34 * sc;
        const gw = tw + ar * 2 + 26;
        const x0 = W / 2 - gw / 2;
        avatar(ctx, name, x0 + gw - ar, ry, ar, ad < 0.5 ? "#fde68a" : undefined);
        ctx.fillStyle = ad < 0.5 ? "#fff" : "rgba(255,255,255,0.9)";
        ctx.font = `${ad < 0.5 ? 700 : 600} ${Math.round(46 * sc)}px ${FONT}`;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.direction = "ltr";
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0 - 4, ry - ROW, tw + 8, ROW * 2);
        ctx.clip();
        ctx.fillText(label, x0, ry + 2);
        ctx.restore();
        ctx.direction = "rtl";
      }
      ctx.restore();
      ctx.globalAlpha = alpha;
      // arrows (both sides)
      for (const side of [-1, 1]) {
        const ax = side < 0 ? WIN.x - 6 : WIN.x + WIN.w + 6;
        ctx.beginPath();
        ctx.moveTo(ax - side * 8, CY);
        ctx.lineTo(ax + side * 44, CY - 34);
        ctx.lineTo(ax + side * 44, CY + 34);
        ctx.closePath();
        ctx.fillStyle = "#fbbf24";
        ctx.shadowColor = "rgba(251,191,36,0.9)";
        ctx.shadowBlur = 18;
        ctx.fill();
        ctx.shadowBlur = 0;
      }
      // position rail: where we are in the whole list (top … bottom)
      if (n > 1) {
        const rx = WIN.x + 30;
        const top = WIN.y + 70;
        const bottom = WIN.y + WIN.h - 70;
        ctx.fillStyle = "rgba(255,255,255,0.12)";
        roundRect(ctx, rx - 3, top, 6, bottom - top, 3);
        ctx.fill();
        const p = clamp((path.wrap ? ((y % n) + n) % n : y) / (n - 1), 0, 1);
        ctx.fillStyle = "#fbbf24";
        roundRect(ctx, rx - 6, top + p * (bottom - top) - 22, 12, 44, 6);
        ctx.fill();
      }
      ctx.restore();
      const idx = Math.round(y);
      if (idx !== lastIdx) {
        if (!Number.isNaN(lastIdx)) sfx.tick();
        lastIdx = idx;
      }
    };

    const revealPanel = (k: number, t: number) => {
      const a = easeOut(k);
      ctx.save();
      ctx.globalAlpha = a;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.direction = "rtl";
      const cy = 760 + (1 - a) * 60;
      // winner badge
      ctx.font = `700 44px ${FONT}`;
      const badge = `🏆 ${title}`;
      const bw = ctx.measureText(badge).width + 90;
      roundRect(ctx, W / 2 - bw / 2, cy - 330, bw, 88, 44);
      const gg = ctx.createLinearGradient(W / 2 - bw / 2, 0, W / 2 + bw / 2, 0);
      gg.addColorStop(0, "#f59e0b");
      gg.addColorStop(1, "#fde68a");
      ctx.fillStyle = gg;
      ctx.fill();
      ctx.fillStyle = "#3b1d00";
      ctx.fillText(badge, W / 2, cy - 284);
      // avatar with a pulsing ring
      const pulse = 1 + 0.03 * Math.sin(t * 4);
      ctx.beginPath();
      ctx.arc(W / 2, cy, 150 * pulse + 18, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(251,191,36,0.18)";
      ctx.fill();
      avatar(ctx, winName, W / 2, cy, 150 * pulse, "#fbbf24");
      // name
      const handle = ltr(winner.author_username ? `@${winner.author_username}` : "مشارك");
      ctx.fillStyle = "#fff";
      ctx.shadowColor = "rgba(0,0,0,0.5)";
      ctx.shadowBlur = 20;
      fitText(ctx, handle, 700, 104, 960, 48);
      ctx.fillText(handle, W / 2, cy + 260);
      ctx.shadowBlur = 0;
      ctx.font = `600 52px ${FONT}`;
      ctx.fillStyle = "#fde68a";
      ctx.fillText("مبروك الفوز! 🎉", W / 2, cy + 370);
      if (winner.text) {
        ctx.font = `400 40px ${FONT}`;
        const lines = wrapLines(ctx, `«${winner.text}»`, 880, 3);
        roundRect(ctx, 100, cy + 440, W - 200, 60 + lines.length * 58, 36);
        ctx.fillStyle = "rgba(255,255,255,0.07)";
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        lines.forEach((l, i) => ctx.fillText(l, W / 2, cy + 470 + 29 + i * 58));
      }
      ctx.restore();
    };

    const footer = () => {
      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.direction = "rtl";
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.font = `400 34px ${FONT}`;
      ctx.fillText(date, W / 2, H - 150);
      if (account) {
        ctx.fillStyle = "rgba(255,255,255,0.8)";
        ctx.font = `600 38px ${FONT}`;
        ctx.fillText(ltr(`@${account}`), W / 2, H - 95);
      }
      ctx.restore();
    };

    let raf = 0;
    let start = 0;
    let beeped = -1;
    let revealedOnce = false;
    let fired = 0;
    let stopped = false;
    let shownSecs = 0;
    const frame = (now: number) => {
      if (!start) start = now;
      const t = (now - start) / 1000;
      const reveal = clamp((t - tReveal) / 0.7, 0, 1);
      bg(t, reveal);
      header(1 - reveal);
      // countdown
      if (t < INTRO) {
        const c = 3 - Math.floor(t / 0.7);
        if (c !== beeped) {
          beeped = c;
          sfx.beep(false);
        }
        reel(path.at(0), 0.35, 0);
        const k = (t % 0.7) / 0.7;
        ctx.save();
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.globalAlpha = 1 - k * 0.6;
        ctx.fillStyle = "#fff";
        ctx.shadowColor = "rgba(251,191,36,0.9)";
        ctx.shadowBlur = 50;
        ctx.font = `700 ${Math.round(360 * (1.25 - k * 0.35))}px ${FONT}`;
        ctx.fillText(String(c), W / 2, CY + 10);
        ctx.restore();
      } else if (reveal < 1) {
        const mt = Math.min(t - INTRO, MOTION);
        const y = reduce ? target : path.at(Math.min(mt, path.duration));
        if (beeped !== 0) {
          beeped = 0;
          sfx.beep(true);
        }
        const glow = t > INTRO + MOTION ? 0.5 + 0.5 * Math.sin((t - INTRO - MOTION) * 12) : 0;
        reel(y, 1 - reveal, glow);
      }
      if (reveal > 0) {
        if (!revealedOnce) {
          revealedOnce = true;
          setRevealed(true);
          sfx.fanfare();
          if (!reduce) fw.burstAt(W / 2, 520, 45);
        }
        if (!reduce) {
          while (fired < shows.length && t - tReveal >= shows[fired]) {
            fw.launch();
            fired++;
          }
        }
        fw.update(ctx);
        revealPanel(reveal, t);
      }
      footer();
      if (recorder && !stopped && t > tReveal + REC_AFTER_REVEAL) {
        stopped = true;
        stopRec();
      }
      if (recorder && recorder.state === "recording") {
        const secs = Math.floor((performance.now() - recStart) / 1000);
        if (secs !== shownSecs) setRecSecs((shownSecs = secs));
      }
      raf = requestAnimationFrame(frame);
    };

    let cancelled = false;
    const fontsReady = Promise.race([
      Promise.all([`400 40px "IBM Plex Sans Arabic"`, `600 40px "IBM Plex Sans Arabic"`, `700 40px "IBM Plex Sans Arabic"`].map((f) => document.fonts?.load(f))).catch(() => undefined),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
    fontsReady.then(() => {
      if (!cancelled) raf = requestAnimationFrame(frame);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stopRec();
      sfx.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (sfxRef.current) sfxRef.current.muted = muted;
  }, [muted]);

  const side = "flex h-14 w-14 items-center justify-center rounded-full bg-white/10 text-2xl text-white backdrop-blur hover:bg-white/20 disabled:opacity-40";
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-[#05020d]">
      <canvas ref={ref} width={W} height={H} className="h-auto max-h-[100dvh] w-auto max-w-[100vw]" style={{ aspectRatio: "9 / 16", height: "min(100dvh, calc(100vw * 16 / 9))" }} aria-label={`اختيار ${title}`} />
      <div className="absolute right-3 top-1/2 flex -translate-y-1/2 flex-col items-center gap-3">
        <button className={side} title={muted ? "تشغيل الصوت" : "كتم الصوت"} onClick={() => setMuted((m) => !m)}>
          {muted ? "🔇" : "🔊"}
        </button>
        {rec === "rec" && (
          <button className={`${side} flex-col !text-xs`} title="إيقاف التسجيل" onClick={() => recRef.current?.state === "recording" && recRef.current.stop()}>
            <span className="h-3 w-3 animate-pulse rounded-full bg-red-500" />
            <span className="mt-1 font-mono">{recSecs}s</span>
          </button>
        )}
        {rec === "done" && video && (
          <button className={`${side} !bg-red-600 hover:!bg-red-500`} title="حفظ فيديو السحب" onClick={() => saveFile(video.blob, video.name, "فيديو السحب").catch(() => undefined)}>
            🎥
          </button>
        )}
        {rec === "unsupported" && (
          <span className="max-w-[4.5rem] text-center text-[10px] leading-tight text-white/60">التسجيل غير مدعوم في هذا المتصفح</span>
        )}
        {revealed && (
          <button className={`${side} !bg-white !text-violet-900 hover:!bg-violet-50`} title="متابعة" onClick={onClose}>
            ✓
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}
