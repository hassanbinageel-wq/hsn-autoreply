/**
 * Arabic-friendly PDF export without external libraries: each page is drawn on a canvas (the browser shapes Arabic
 * text correctly), encoded as JPEG, and wrapped in a minimal PDF (one full-page image per A4 page).
 */

const A4 = { w: 595.28, h: 841.89 }; // points
const PX = { w: 1240, h: 1754 }; // ~150 dpi canvas

export interface PdfLine {
  text: string;
  size?: number; // px at 150dpi
  bold?: boolean;
  color?: string;
  gap?: number; // extra space after the line
  box?: boolean; // light background box (for winners)
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/\s+/);
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

/** Lays out RTL lines over as many canvases (pages) as needed. */
export function renderPages(lines: PdfLine[], footer: string): HTMLCanvasElement[] {
  const pages: HTMLCanvasElement[] = [];
  const margin = 90;
  const width = PX.w - margin * 2;
  let canvas!: HTMLCanvasElement;
  let ctx!: CanvasRenderingContext2D;
  let y = 0;
  const newPage = () => {
    canvas = document.createElement("canvas");
    canvas.width = PX.w;
    canvas.height = PX.h;
    ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, PX.w, PX.h);
    ctx.direction = "rtl";
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    y = margin;
    pages.push(canvas);
  };
  newPage();
  for (const l of lines) {
    const size = l.size ?? 28;
    ctx.font = `${l.bold ? "700" : "400"} ${size}px "Segoe UI", Tahoma, "Noto Naskh Arabic", "Noto Sans Arabic", Arial, sans-serif`;
    const wrapped = wrap(ctx, l.text, width - (l.box ? 40 : 0));
    const h = wrapped.length * size * 1.5 + (l.box ? 30 : 0);
    if (y + h > PX.h - margin - 40) newPage();
    ctx.font = `${l.bold ? "700" : "400"} ${size}px "Segoe UI", Tahoma, "Noto Naskh Arabic", "Noto Sans Arabic", Arial, sans-serif`;
    if (l.box) {
      ctx.fillStyle = "#f3f0ff";
      ctx.fillRect(margin, y, width, h);
      y += 15;
    }
    ctx.fillStyle = l.color ?? "#111827";
    for (const w of wrapped) {
      ctx.fillText(w, PX.w - margin - (l.box ? 20 : 0), y);
      y += size * 1.5;
    }
    y += (l.box ? 15 : 0) + (l.gap ?? 6);
  }
  pages.forEach((p, i) => {
    const c = p.getContext("2d")!;
    c.font = `400 20px Tahoma, Arial, sans-serif`;
    c.fillStyle = "#6b7280";
    c.direction = "rtl";
    c.textAlign = "right";
    c.fillText(`${footer} — صفحة ${i + 1} من ${pages.length}`, PX.w - margin, PX.h - margin + 10);
  });
  return pages;
}

function dataUrlBytes(url: string): Uint8Array {
  const b64 = url.slice(url.indexOf(",") + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Builds a PDF whose pages are the given canvases (JPEG, DCTDecode). */
export function canvasesToPdf(pages: HTMLCanvasElement[]): Blob {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let pos = 0;
  const push = (b: Uint8Array | string) => {
    const u = typeof b === "string" ? enc.encode(b) : b;
    chunks.push(u);
    pos += u.length;
  };
  const obj = (n: number, body: () => void) => {
    offsets[n] = pos;
    push(`${n} 0 obj\n`);
    body();
    push("\nendobj\n");
  };
  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  const n = pages.length;
  // object numbers: 1 catalog, 2 pages, then for page i: 3+3i page, 4+3i image, 5+3i content
  const pageIds = pages.map((_, i) => 3 + i * 3);
  obj(1, () => push("<< /Type /Catalog /Pages 2 0 R >>"));
  obj(2, () => push(`<< /Type /Pages /Count ${n} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`));
  pages.forEach((canvas, i) => {
    const pid = 3 + i * 3;
    const img = dataUrlBytes(canvas.toDataURL("image/jpeg", 0.9));
    const content = `q ${A4.w.toFixed(2)} 0 0 ${A4.h.toFixed(2)} 0 0 cm /Im${i} Do Q`;
    obj(pid, () =>
      push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.w} ${A4.h}] /Resources << /XObject << /Im${i} ${pid + 1} 0 R >> >> /Contents ${pid + 2} 0 R >>`),
    );
    obj(pid + 1, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.length} >>\nstream\n`);
      push(img);
      push("\nendstream");
    });
    obj(pid + 2, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
  });
  const total = 3 + n * 3;
  const xref = pos;
  push(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let i = 1; i < total; i++) push(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  return new Blob(chunks as BlobPart[], { type: "application/pdf" });
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
