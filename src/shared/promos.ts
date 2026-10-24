import { MESSAGE_LINKS } from "./plans";

/** Owner settings for message top-ups and the "out of messages" window (owner tenant setting "topup_settings"). */
export type TopupSettings = {
  /** Purchases allowed per customer per usage cycle (0 = no limit). */
  max_per_cycle: number;
  /** Show the «اشحن رسائل» button from this share of the cycle's messages (%). */
  show_at_pct: number;
  /** Usage notes on the bell at these shares of the cycle's messages (%), once each; used up (100%) always sends the ready message. */
  alert_steps: number[];
  /** The window in the middle of the screen: from `show_at`% of the messages used, `delay_min` minutes after the app opens, once a day. */
  popup: {
    enabled: boolean; title: string; body: string; cta: string; cancel: string;
    /** PNG/WEBP data URL; null = the default 📭 */ icon?: string | null;
    show_at: number;
    delay_min: number;
  };
};

export const DEFAULT_TOPUP_SETTINGS: TopupSettings = {
  max_per_cycle: 0,
  show_at_pct: 90,
  alert_steps: [85, 90, 95],
  popup: {
    enabled: true,
    show_at: 100,
    delay_min: 0,
    title: "خلصت رسائل دورتك",
    body: "ردودك التلقائية متوقفة لين يتجدد العدّاد. تقدر تشحن رسائل إضافية الحين وترجع حملاتك تشتغل على طول.",
    cta: "اشحن رسائل",
    cancel: "لاحقًا",
  },
};

export function topupSettingsOf(v: (Partial<Omit<TopupSettings, "popup">> & { popup?: Partial<TopupSettings["popup"]> }) | null | undefined): TopupSettings {
  const d = DEFAULT_TOPUP_SETTINGS;
  const steps = [...new Set((v?.alert_steps ?? d.alert_steps).filter((x) => Number.isInteger(x) && x >= 50 && x < 100))].sort((a, b) => a - b);
  return { ...d, ...(v ?? {}), alert_steps: steps, popup: { ...d.popup, ...(v?.popup ?? {}) } };
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
  /** A real card discount (%) the customer gets while the offer runs, on these plans (null = every plan). */
  discount_pct?: number | null;
  discount_plans?: string[] | null;
};

/** Ready offer contents the owner picks from (and edits, saved in the owner setting "offer_templates"). */
export type OfferTemplate = { label: string; title: string; body: string; cta: string; link: string; theme: string; icon: string; days: number };

export const DEFAULT_OFFER_TEMPLATES: OfferTemplate[] = [
  { label: "خصم على باقة", title: "خصم 30% على الباقة الاحترافية", body: "ردود أكثر وحملات أكثر بسعر أقل — لفترة محدودة.", cta: "اشترك الحين", link: "/subscription", theme: "violet", icon: "🔥", days: 3 },
  { label: "رسائل إضافية", title: "رسائل إضافية بسعر خاص", body: "اشحن رصيدك الحين وخل ردودك شغّالة طول الشهر.", cta: "اشحن الحين", link: "/subscription?topup=1", theme: "sunset", icon: "⚡", days: 2 },
  { label: "ترقية", title: "رقِّ باقتك وادفع الفرق بس", body: "تاريخ اشتراكك يبقى نفسه، وحدودك تكبر فورًا.", cta: "رقِّ الحين", link: "/subscription", theme: "emerald", icon: "🚀", days: 5 },
  { label: "ميزة جديدة", title: "ميزة جديدة: القائمة التلقائية", body: "خل متابعينك يختارون من أزرار في الخاص ويوصلهم الرد فورًا.", cta: "جرّبها", link: "/inbox", theme: "midnight", icon: "✨", days: 7 },
  { label: "عرض نهاية الأسبوع", title: "عرض نهاية الأسبوع 🎉", body: "خصم خاص لين نهاية الجمعة — لا يفوتك.", cta: "استفد الحين", link: "/subscription", theme: "rose", icon: "🎉", days: 2 },
  { label: "أول حملة", title: "جاهز لأول حملة؟", body: "سوّ حملة على منشورك الجاي في دقيقة وخل الردود تشتغل عنك.", cta: "ابدأ حملة", link: "/campaigns/new", theme: "violet", icon: "🎁", days: 7 },
];
