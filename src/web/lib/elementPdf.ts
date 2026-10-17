import { canvasesToPdf } from "./pdf";

/**
 * A page section as a real PDF file (A4 pages). The browser draws the section itself (html-to-image), so Arabic
 * text, fonts and colours come out as on screen; images from other sites (e.g. Instagram thumbnails) are left
 * out because the page is not allowed to read them. Elements marked `no-print` are skipped.
 */
export async function elementToPdf(source: HTMLElement, opts: { title?: string; subtitle?: string } = {}): Promise<Blob> {
  const { toCanvas } = await import("html-to-image");
  // With a title: a copy of the section under a heading, drawn off screen at the section's width.
  let el = source;
  let holder: HTMLElement | null = null;
  if (opts.title) {
    holder = document.createElement("div");
    holder.dir = "rtl";
    holder.style.cssText = `position:fixed;top:0;left:-20000px;width:${source.getBoundingClientRect().width}px;padding:8px;background:${getComputedStyle(document.body).backgroundColor || "#fff"}`;
    const h = document.createElement("div");
    h.style.cssText = "margin:0 4px 14px";
    h.innerHTML = `<div style="font:800 22px Cairo, sans-serif">${esc(opts.title)}</div>${opts.subtitle ? `<div class="muted" style="font-size:13px;margin-top:4px">${esc(opts.subtitle)}</div>` : ""}`;
    holder.append(h, source.cloneNode(true));
    document.body.append(holder);
    el = holder;
  }
  try {
    // The off-screen copy is drawn as if it sat at the page origin.
    return await draw(el, toCanvas, holder ? { position: "static", left: "0", top: "0" } : undefined);
  } finally {
    holder?.remove();
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

async function draw(el: HTMLElement, toCanvas: typeof import("html-to-image").toCanvas, style?: Partial<CSSStyleDeclaration>): Promise<Blob> {
  const bg = getComputedStyle(document.body).backgroundColor || "#ffffff";
  const src = await toCanvas(el, {
    style,
    fontEmbedCSS: await appFontsCss(),
    pixelRatio: 2,
    backgroundColor: bg,
    filter: (n) => {
      const e = n as HTMLElement;
      if (e.classList?.contains("no-print")) return false;
      if (e.tagName === "IMG") {
        const u = (e as HTMLImageElement).currentSrc || (e as HTMLImageElement).src;
        return u.startsWith(location.origin) || u.startsWith("data:") || u.startsWith("blob:");
      }
      return true;
    },
  });
  // A4 pages with a margin; the content keeps its width and is cut into page-high slices.
  const margin = Math.round(src.width * 0.04);
  const pageW = src.width + margin * 2;
  const pageH = Math.round((pageW * 841.89) / 595.28);
  const sliceH = pageH - margin * 2;
  const pages: HTMLCanvasElement[] = [];
  for (let y = 0; y < src.height; y += sliceH) {
    const h = Math.min(sliceH, src.height - y);
    const c = document.createElement("canvas");
    c.width = pageW;
    c.height = pageH;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, pageW, pageH);
    ctx.drawImage(src, 0, y, src.width, h, margin, margin, src.width, h);
    pages.push(c);
  }
  return canvasesToPdf(pages);
}

let fontsCss: Promise<string> | null = null;

/**
 * The app's own fonts (bundled, same origin) as @font-face rules with inline data, so the drawn copy uses them.
 * Built here rather than by html-to-image, whose own font step is blocked by the page's security policy.
 * Only the Arabic and basic Latin subsets are included.
 */
function appFontsCss(): Promise<string> {
  fontsCss ??= (async () => {
    const out: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // another site's stylesheet
      }
      for (const r of Array.from(rules)) {
        if (!(r instanceof CSSFontFaceRule)) continue;
        const srcProp = r.style.getPropertyValue("src");
        const m = srcProp.match(/url\(["']?([^"')]+\.woff2)["']?\)/);
        if (!m || !/arabic|latin(?!-ext)/.test(m[1])) continue;
        try {
          const url = new URL(m[1], sheet.href ?? location.href).href;
          const blob = await (await fetch(url)).blob();
          const data: string = await new Promise((res, rej) => {
            const fr = new FileReader();
            fr.onload = () => res(String(fr.result));
            fr.onerror = () => rej(fr.error);
            fr.readAsDataURL(blob);
          });
          out.push(r.cssText.replace(srcProp, `url(${data}) format("woff2")`));
        } catch {
          /* a missing font only falls back to the system font */
        }
      }
    }
    return out.join("\n");
  })();
  return fontsCss;
}
