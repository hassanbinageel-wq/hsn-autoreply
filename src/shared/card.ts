/** Congratulation card designs for draw winners (shared by the editor, the renderer and the server). */
import { z } from "zod";

export const CARD_SIZES = {
  portrait: { w: 1080, h: 1350, label: "منشور طولي 4:5" },
  square: { w: 1080, h: 1080, label: "مربع 1:1" },
  story: { w: 1080, h: 1920, label: "ستوري 9:16" },
} as const;

export const CARD_THEMES = {
  gold: { label: "ذهبي فاخر", bg1: "#1a1206", bg2: "#3b2a0a", accent: "#f5c542", text: "#fff8e6" },
  violet: { label: "بنفسجي", bg1: "#2e1065", bg2: "#7e22ce", accent: "#f0abfc", text: "#ffffff" },
  night: { label: "ليلي", bg1: "#020617", bg2: "#1e3a8a", accent: "#38bdf8", text: "#f8fafc" },
  sunset: { label: "غروب", bg1: "#7c2d12", bg2: "#db2777", accent: "#fde047", text: "#fff7ed" },
  emerald: { label: "زمردي", bg1: "#022c22", bg2: "#047857", accent: "#fcd34d", text: "#ecfdf5" },
  ivory: { label: "عاجي فاتح", bg1: "#fffaf0", bg2: "#efe2c2", accent: "#b7862c", text: "#2b2111" },
  rose: { label: "وردي ذهبي", bg1: "#3b0a1e", bg2: "#9d174d", accent: "#fbcfe8", text: "#fff1f2" },
} as const;

export const CARD_LAYOUTS = {
  royal: "فاخر (إطار وزخارف)",
  modern: "عصري (رقم كبير وكتل ملونة)",
  festive: "احتفالي (قصاصات وأشعة)",
} as const;

export const CARD_FONTS = {
  cairo: { label: "Cairo — عصري عريض", display: "Cairo", body: "Cairo", weight: 800 },
  kufi: { label: "Reem Kufi — كوفي أنيق", display: "Reem Kufi", body: "IBM Plex Sans Arabic", weight: 700 },
  lalezar: { label: "Lalezar — احتفالي", display: "Lalezar", body: "IBM Plex Sans Arabic", weight: 400 },
  plex: { label: "IBM Plex — رسمي هادئ", display: "IBM Plex Sans Arabic", body: "IBM Plex Sans Arabic", weight: 700 },
} as const;

export const cardDesignSchema = z.object({
  size: z.enum(["portrait", "square", "story"]).default("portrait"),
  layout: z.enum(["royal", "modern", "festive"]).default("royal"),
  font: z.enum(["cairo", "kufi", "lalezar", "plex"]).default("cairo"),
  theme: z.enum(["gold", "violet", "night", "sunset", "emerald", "ivory", "rose", "custom"]).default("gold"),
  bg1: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#1a1206"),
  bg2: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#3b2a0a"),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#f5c542"),
  text_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#fff8e6"),
  // Optional uploaded background (re-encoded JPEG data URL, bounded in size).
  background_image: z.string().max(1_400_000).regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/).nullable().optional(),
  background_dim: z.number().min(0).max(0.9).default(0.45),
  // Optional logo placed by the owner: centre position as a fraction of the card, width as a fraction of the card width.
  logo_image: z.string().max(700_000).regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/).nullable().optional(),
  logo_x: z.number().min(0).max(1).default(0.5),
  logo_y: z.number().min(0).max(1).default(0.1),
  logo_size: z.number().min(0.05).max(0.6).default(0.18),
  logo_shape: z.enum(["original", "circle", "rounded"]).default("original"),
  logo_opacity: z.number().min(0.2).max(1).default(1),
  title: z.string().trim().max(80).default("مسابقة الحساب"),
  headline: z.string().trim().max(60).default("مبروك الفوز! 🎉"),
  body: z.string().trim().max(300).default("تهانينا {{username}}\nأنت الفائز {{position}} في {{contest}}"),
  prize_label: z.string().trim().max(30).default("الجائزة"),
  prizes: z.array(z.string().trim().max(80)).max(20).default(["جائزة المركز الأول"]),
  date_mode: z.enum(["draw", "custom", "none"]).default("draw"),
  custom_date: z.string().trim().max(40).default(""),
  show_day: z.boolean().default(true),
  footer: z.string().trim().max(60).default("@{{account}}"),
  // Text of the message sent with the card (DM, or the private reply with a button to the card).
  message_text: z.string().trim().max(600).default("مبروك {{username}} 🎉 فزت بالمركز {{position}} في {{contest}}!\nالجائزة: {{prize}}\nتواصل معنا هنا لاستلامها."),
  // Public reply under the winner's comment (used when a private message is no longer allowed).
  public_reply_text: z.string().trim().max(600).default("مبروك {{username}} 🎉 فزت بالمركز {{position}} في {{contest}}! راسلنا على الخاص لاستلام جائزتك 🎁"),
});
export type CardDesign = z.infer<typeof cardDesignSchema>;
/** One D1 row holds the whole design (max 2 MB): background + logo together must stay below this. */
export const CARD_IMAGES_MAX = 1_800_000;
export const cardDesignInputSchema = cardDesignSchema.refine(
  (d) => (d.background_image?.length ?? 0) + (d.logo_image?.length ?? 0) <= CARD_IMAGES_MAX,
  { message: "حجم صورة الخلفية مع الشعار كبير — استخدم صورًا أصغر", path: ["logo_image"] },
);
export const DEFAULT_CARD: CardDesign = cardDesignSchema.parse({});

export const CARD_VARIABLES: Record<string, string> = {
  username: "اسم مستخدم الفائز (@...)",
  position: "المركز كلمة (الأول، الثاني…)",
  position_number: "المركز رقمًا",
  prize: "الجائزة حسب المركز",
  contest: "اسم المسابقة / السحب",
  date: "التاريخ",
  day: "اليوم",
  account: "اسم حسابك",
};

export interface CardVars {
  username: string | null;
  position: number;
  contest: string;
  account: string | null;
  drawnAt: number | null; // ms
  timezone?: string | null;
}

export function ordinalAr(n: number): string {
  const o = ["الأول", "الثاني", "الثالث", "الرابع", "الخامس", "السادس", "السابع", "الثامن", "التاسع", "العاشر"];
  return o[n - 1] ?? `رقم ${n}`;
}

export function prizeFor(d: CardDesign, position: number): string {
  const list = d.prizes.filter((p) => p.trim());
  if (!list.length) return "";
  return list[Math.min(position, list.length) - 1];
}

function dateParts(ms: number, tz?: string | null): { date: string; day: string } {
  const opt = (o: Intl.DateTimeFormatOptions) => {
    try {
      return new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-latn", { ...o, timeZone: tz || undefined }).format(new Date(ms));
    } catch {
      return new Intl.DateTimeFormat("ar", o).format(new Date(ms));
    }
  };
  return { date: opt({ year: "numeric", month: "long", day: "numeric" }), day: opt({ weekday: "long" }) };
}

/** Replaces {{variables}} for the card and the message. */
export function fillCard(tpl: string, d: CardDesign, v: CardVars): string {
  const when = v.drawnAt ?? Date.now();
  const { date, day } = dateParts(when, v.timezone);
  const values: Record<string, string> = {
    username: v.username ? `@${v.username}` : "الفائز",
    position: ordinalAr(v.position),
    position_number: String(v.position),
    prize: prizeFor(d, v.position),
    contest: v.contest,
    date: d.date_mode === "custom" && d.custom_date ? d.custom_date : date,
    day,
    account: v.account ?? "",
  };
  return tpl.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k: string) => values[k] ?? m).trim();
}

/** The date line printed on the card (or null when hidden). */
export function cardDateLine(d: CardDesign, v: CardVars): string | null {
  if (d.date_mode === "none") return null;
  const { date, day } = dateParts(v.drawnAt ?? Date.now(), v.timezone);
  const text = d.date_mode === "custom" && d.custom_date ? d.custom_date : date;
  return d.show_day ? `${day} ${text}` : text;
}
