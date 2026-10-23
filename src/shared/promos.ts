import { MESSAGE_LINKS } from "./plans";

/** Owner settings for message top-ups and the "out of messages" window (owner tenant setting "topup_settings"). */
export type TopupSettings = {
  /** Purchases allowed per customer per usage cycle (0 = no limit). */
  max_per_cycle: number;
  /** Show the «اشحن رسائل» button from this share of the cycle's messages (%). */
  show_at_pct: number;
  /** The window in the middle of the screen when a customer runs out of messages. */
  popup: { enabled: boolean; title: string; body: string; cta: string; cancel: string };
};

export const DEFAULT_TOPUP_SETTINGS: TopupSettings = {
  max_per_cycle: 0,
  show_at_pct: 90,
  popup: {
    enabled: true,
    title: "خلصت رسائل دورتك",
    body: "ردودك التلقائية متوقفة لين يتجدد العدّاد. تقدر تشحن رسائل إضافية الحين وترجع حملاتك تشتغل على طول.",
    cta: "اشحن رسائل",
    cancel: "لاحقًا",
  },
};

export function topupSettingsOf(v: Partial<TopupSettings> | null | undefined): TopupSettings {
  const d = DEFAULT_TOPUP_SETTINGS;
  return { ...d, ...(v ?? {}), popup: { ...d.popup, ...(v?.popup ?? {}) } };
}

/** Looks of an offer box (gradient + text colors). */
export const OFFER_THEMES: Record<string, { label: string; bg: string; fg: string; accent: string }> = {
  violet: { label: "بنفسجي شيّك", bg: "linear-gradient(135deg,#7c3aed 0%,#c026d3 55%,#f97316 100%)", fg: "#ffffff", accent: "#fde68a" },
  sunset: { label: "غروب", bg: "linear-gradient(135deg,#f97316 0%,#e11d48 100%)", fg: "#ffffff", accent: "#fef3c7" },
  emerald: { label: "زمردي", bg: "linear-gradient(135deg,#059669 0%,#0ea5e9 100%)", fg: "#ffffff", accent: "#d1fae5" },
  midnight: { label: "ليلي ذهبي", bg: "linear-gradient(135deg,#0f172a 0%,#312e81 100%)", fg: "#ffffff", accent: "#fbbf24" },
  rose: { label: "وردي", bg: "linear-gradient(135deg,#ec4899 0%,#8b5cf6 100%)", fg: "#ffffff", accent: "#fce7f3" },
};

/** Where an offer can take the customer (or any https:// address). */
export const OFFER_LINKS: Array<{ to: string; label: string }> = [{ to: "/subscription?topup=1", label: "شحن الرسائل" }, ...MESSAGE_LINKS];

export const isOfferLink = (v: string) => OFFER_LINKS.some((l) => l.to === v) || /^https:\/\/[^\s"'<>]{3,300}$/.test(v);

export type Offer = {
  id: number;
  title: string;
  body: string | null;
  cta: string | null;
  link: string;
  theme: string;
  icon: string | null;
  starts_at: number | null;
  ends_at: number;
};
