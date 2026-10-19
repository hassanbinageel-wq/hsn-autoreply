/** What a subscription plan allows. `null` = unlimited. Edited by the owner (no code change needed). */
export interface PlanLimits {
  active_campaigns: number | null;
  monthly_messages: number | null;
  events: Array<"comment" | "story_reply" | "story_mention">;
  public_reply: boolean;
  link_tracking: boolean;
  inbox_manual: boolean;
  telegram: boolean;
  recover: boolean;
  csv_export: boolean;
  /** Draws created per month: 0 = none, null = unlimited. */
  draws_per_month: number | null;
  draw_video: boolean;
  cards: boolean;
  simulator: boolean;
  campaign_stats: boolean;
  undo: boolean;
  /** Scheduled publishing of posts / reels / stories (needs the content-publishing permission). */
  scheduling?: boolean;
  /** Store connection (Salla) and store analytics: orders and revenue per campaign / product. */
  store?: boolean;
  /** Staff logins the customer may add: 0 = none, null = up to the service maximum (10). */
  staff?: number | null;
}

/** The owner's own workspace: everything, no expiry. */
export const OWNER_LIMITS: PlanLimits = {
  active_campaigns: null,
  monthly_messages: null,
  events: ["comment", "story_reply", "story_mention"],
  public_reply: true,
  link_tracking: true,
  inbox_manual: true,
  telegram: true,
  recover: true,
  csv_export: true,
  draws_per_month: null,
  draw_video: true,
  cards: true,
  simulator: true,
  campaign_stats: true,
  undo: true,
  scheduling: true,
  store: true,
  staff: null,
};

export const FEATURE_LABELS: Record<string, string> = {
  public_reply: "الرد العام على التعليق",
  link_tracking: "تتبع الضغط على الرابط",
  inbox_manual: "الرد اليدوي من صندوق الرسائل",
  telegram: "إشعارات تيليجرام والتقرير اليومي",
  recover: "استرجاع التعليقات الفائتة",
  csv_export: "تصدير ملف CSV للسجلات",
  draw_video: "تسجيل فيديو السحب",
  cards: "بطاقات تهنئة الفائزين بشعارك",
  simulator: "المحاكاة (تجربة الحملة قبل التفعيل)",
  campaign_stats: "إحصائيات مفصلة لكل حملة",
  undo: "التراجع عن آخر العمليات",
  scheduling: "جدولة نشر المنشورات والريلز والستوري",
  store: "ربط المتجر (سلة) وتحليل الطلبات والمبيعات",
};

/** The four limit rows shown before the on/off features, by key. */
export const LIMIT_ROW_LABELS: Record<string, string> = {
  events: "الأحداث المدعومة",
  active_campaigns: "عدد الحملات النشطة",
  monthly_messages: "الرسائل شهريًا",
  draws_per_month: "السحوبات",
  staff: "الموظفين",
};

/** Default display order of every plan point (limits first, then features). */
export const DEFAULT_FEATURE_ORDER: string[] = [...Object.keys(LIMIT_ROW_LABELS), ...Object.keys(FEATURE_LABELS)];

/** The owner's saved order, cleaned: unknown keys dropped, duplicates removed, new points appended at the end. */
export function orderFeatures(order?: readonly string[] | null): string[] {
  const known = new Set(DEFAULT_FEATURE_ORDER);
  const out: string[] = [];
  for (const k of order ?? []) if (known.has(k) && !out.includes(k)) out.push(k);
  for (const k of DEFAULT_FEATURE_ORDER) if (!out.includes(k)) out.push(k);
  return out;
}

/** One-line explanation of each plan point, shown in a hover box on the plans. */
export const FEATURE_HINTS: Record<string, string> = {
  public_reply: "رد علني قصير تحت تعليق المتابع (مثل «أرسلنا لك في الخاص») بصيغ متنوعة، إضافةً للرسالة الخاصة.",
  link_tracking: "يحوّل رابطك لرابط تتبع، وتعرف كم شخص ضغط عليه فعلًا من كل حملة.",
  inbox_manual: "ترد بنفسك على أي محادثة من صندوق الرسائل داخل اللوحة، ضمن نافذة الرد المسموحة من Meta.",
  telegram: "تنبيه فوري على تيليجرام عند الأخطاء أو انقطاع الربط، وتقرير يومي بأداء حملاتك.",
  recover: "يجلب التعليقات اللي فاتت (مثل وقت انقطاع الربط) ويرد عليها تلقائيًا إذا ما زالت ضمن المدة المسموحة.",
  csv_export: "تنزيل سجل التفاعلات والرسائل كملف Excel/CSV للتحليل أو الحفظ.",
  draw_video: "تسجيل شاشة السحب كفيديو جاهز تنشره ستوري أو ريلز لإثبات النزاهة.",
  cards: "بطاقة تهنئة بتصميمك وشعارك تُرسل للفائز أو تنزّلها للنشر.",
  simulator: "تجرّب الحملة كأنك متابع يعلّق ويرد، وتشوف الرسائل بالضبط قبل ما تفعّلها — بدون إرسال أي شي حقيقي.",
  campaign_stats: "لكل حملة: عدد التعليقات والأشخاص، من استلم الرسالة، من ضغط الرابط، من تابع، وأداء كل منشور.",
  undo: "رجوع عن آخر 10 عمليات (حذف حملة، تعديل، إيقاف...) من صفحة السجل.",
  scheduling: "ترفع الصورة أو الفيديو وتحدد الوقت، والنظام ينشره على حسابك تلقائيًا عبر واجهة Meta الرسمية، ويقدر يشغّل حملة على المنشور أول ما يُنشر.",
  store: "تربط متجرك في سلة وتشوف كم طلب ومبيعات جابت كل حملة (بكود الخصم) ولكل منتج: تعليقات ← ضغطات ← طلبات.",
};

export const LIMIT_HINTS: Record<string, string> = {
  events: "أنواع التفاعل اللي يرد عليها النظام: تعليقات المنشورات والريلز، ردود الستوري، ومنشن حسابك في ستوري.",
  active_campaigns: "عدد الحملات اللي تقدر تشغّلها بنفس الوقت. الحملات الموقوفة والمسودات ما تنحسب.",
  monthly_messages: "مجموع الرسائل والردود اللي يرسلها النظام نيابةً عنك خلال الشهر الميلادي. يتجدد أول كل شهر.",
  draws_per_month: "عدد السحوبات اللي تقدر تسويها على متفاعلين حملاتك كل شهر، مع شاشة السحب الحيّة.",
  staff: "حسابات دخول لموظفيك، كل واحد بالأقسام اللي تحددها له بس (مثل الرد على الرسائل).",
};

export const EVENT_LABELS: Record<string, string> = { comment: "تعليقات", story_reply: "ردود الستوري", story_mention: "منشن الستوري" };

/** Activation code format: HSN-XXXX-XXXX-XXXX (no ambiguous characters). */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^HSN/, "");
}

/** The four currencies offered (symbol as shown to customers). YER_SAN = the Sana'a rate of the Yemeni rial. */
export const CURRENCIES: Array<{ code: string; label: string; name: string }> = [
  { code: "USD", label: "$", name: "دولار" },
  { code: "SAR", label: "ر.س", name: "ريال سعودي" },
  { code: "YER", label: "ر.ي", name: "ريال يمني" },
  { code: "YER_SAN", label: "ر.ي (صنعاء)", name: "ريال يمني / صنعاء" },
];
/** How many units of each currency equal 1 USD (set by the owner). */
export type ExchangeRates = Record<string, number>;
export const DEFAULT_RATES: ExchangeRates = { USD: 1, SAR: 3.75, YER: 1600, YER_SAN: 535 };

/** Converts an amount between the four currencies using the owner's rates (null if a rate is missing). */
export function convertPrice(amount: number, from: string, to: string, rates: ExchangeRates): number | null {
  if (from === to) return amount;
  const rf = from === "USD" ? 1 : rates[from];
  const rt = to === "USD" ? 1 : rates[to];
  if (!rf || !rt) return null;
  const v = (amount / rf) * rt;
  return to.startsWith("YER") ? Math.round(v) : Math.round(v * 100) / 100;
}
export const PRICE_PERIODS: Record<string, string> = { month: "شهريًا", quarter: "كل 3 أشهر", year: "سنويًا", once: "مرة واحدة" };

/** "99 ر.س / شهريًا" from the owner's structured price. */
export function formatAmount(amount: number, currency: string): string {
  const cur = CURRENCIES.find((c) => c.code === currency)?.label ?? currency;
  const n = Number.isInteger(amount) ? amount.toLocaleString("en-US") : amount.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return `${n} ${cur}`;
}
export function formatPrice(amount: number, currency: string, period: string): string {
  return `${formatAmount(amount, currency)} / ${PRICE_PERIODS[period] ?? PRICE_PERIODS.month}`;
}

/** App pages an owner message can open when tapped. */
export const MESSAGE_LINKS: Array<{ to: string; label: string }> = [
  { to: "/", label: "الرئيسية" },
  { to: "/subscription", label: "اشتراكي والباقات" },
  { to: "/campaigns", label: "الحملات" },
  { to: "/campaigns/new", label: "حملة جديدة" },
  { to: "/schedule", label: "الجدولة" },
  { to: "/analytics", label: "التحليلات" },
  { to: "/report", label: "التقرير الأسبوعي" },
  { to: "/store", label: "تحليل المتجر" },
  { to: "/connection", label: "الربط" },
  { to: "/inbox", label: "الرسائل" },
  { to: "/support", label: "الدعم" },
  { to: "/settings", label: "الإعدادات" },
];
