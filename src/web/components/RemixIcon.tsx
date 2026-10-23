import { useEffect, useState } from "react";

/**
 * Remix Icon (https://remixicon.com, Apache-2.0), bundled from the npm package — nothing is loaded from another site.
 * The glyph list and the font are fetched only when an icon is shown (the login banner points, the owner's editor),
 * and only the woff2 font is used.
 */
let glyphs: Promise<Map<string, string>> | null = null;
function loadGlyphs(): Promise<Map<string, string>> {
  glyphs ??= Promise.all([import("remixicon/fonts/remixicon.css?raw"), import("remixicon/fonts/remixicon.woff2?url")]).then(async ([css, font]) => {
    const map = new Map<string, string>();
    for (const m of css.default.matchAll(/\.ri-([a-z0-9-]+):before\s*{\s*content:\s*"\\([0-9a-f]+)"/g)) map.set(m[1], String.fromCodePoint(parseInt(m[2], 16)));
    if (typeof FontFace !== "undefined" && ![...document.fonts].some((f) => f.family === "remixicon")) {
      const face = new FontFace("remixicon", `url(${font.default}) format("woff2")`, { display: "swap" });
      document.fonts.add(face);
      await face.load().catch(() => undefined);
    }
    return map;
  });
  return glyphs;
}

/** "rocket-line", "ri-rocket-line" or "ri:rocket-line" → "rocket-line". */
export const remixName = (v: string) => v.trim().toLowerCase().replace(/^ri[:-]/, "");

/** The glyph of an icon (loads the list and the font) — for drawing on a canvas; null when unknown. */
export const remixGlyph = async (name: string) => (await loadGlyphs()).get(remixName(name)) ?? null;

/** Whether a Remix Icon name exists (loads the list). */
export const remixExists = async (name: string) => (await loadGlyphs()).has(remixName(name));

export function RemixIcon({ name, size = 20, className = "" }: { name: string; size?: number; className?: string }) {
  const [ch, setCh] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadGlyphs().then((m) => live && setCh(m.get(remixName(name)) ?? null)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [name]);
  return (
    <i aria-hidden className={`inline-flex items-center justify-center not-italic leading-none ${className}`} style={{ fontFamily: "remixicon", fontSize: size, width: size, height: size }}>
      {ch ?? ""}
    </i>
  );
}
