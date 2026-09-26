/**
 * Minimal template rendering: {{variable}} or {{variable|fallback text}}.
 * Only values from official data (webhook username, connected account) are used.
 * Output is plain text sent to Instagram — never inserted as HTML.
 */
export const TEMPLATE_VARIABLES = {
  username: "اسم مستخدم الشخص (من بيانات الحدث إن توفر)",
  account_username: "اسم حسابك",
  account_link: "رابط حسابك في إنستقرام",
  content_url: "رابط المحتوى النهائي (يظهر فقط في رسالة المحتوى)",
  first_name: "الاسم (غير متاح دائمًا — استخدم نصًا بديلًا)",
} as const;

export type TemplateVars = Partial<Record<keyof typeof TEMPLATE_VARIABLES, string | undefined | null>>;

const VAR_RE = /\{\{\s*([a-z_]+)\s*(?:\|([^}]*))?\}\}/g;

export function renderTemplate(tpl: string, vars: TemplateVars): string {
  return (tpl ?? "")
    .replace(VAR_RE, (_m, name: string, fallback?: string) => {
      const v = (vars as Record<string, string | undefined | null>)[name];
      if (v !== undefined && v !== null && String(v).trim() !== "") return String(v);
      return (fallback ?? "").trim();
    })
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Phrases that claim content was already delivered — not allowed in public replies of follow-gated campaigns. */
const DELIVERY_CLAIMS = [/أرسلت/, /ارسلت/, /أرسلنا/, /ارسلنا/, /تم الإرسال/, /تم الارسال/, /وصلك/, /sent you/i, /check.*sent/i];

export function claimsDelivery(text: string): boolean {
  return DELIVERY_CLAIMS.some((re) => re.test(text ?? ""));
}

export const LINK_BUTTON_TITLE = "فتح الرابط 🔗";

/** The content link as a tappable button: the campaign URL, or else the first web link written in the text. */
export function contentLinkButton(text: string, finalUrl: string | null | undefined): { title: string; url: string; text: string } | undefined {
  const url = finalUrl?.trim() || text.match(/https?:\/\/[^\s<>"']+/i)?.[0];
  if (!url || !/^https?:\/\//i.test(url)) return undefined;
  const without = text
    .split(url)
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const body = without || "تفضل 🎁";
  // Template text is limited to 640 characters; longer messages keep the plain-text form.
  if (body.length > 640) return undefined;
  return { title: LINK_BUTTON_TITLE, url, text: body };
}

/**
 * Public replies rotate between several phrasings: the same sentence under hundreds of comments can look like
 * spam to Instagram. One phrasing per line.
 */
export const MAX_PUBLIC_VARIANTS = 20;
export const MAX_PUBLIC_VARIANT_LENGTH = 300;

/** Neutral phrasings (never claim delivery) used when a follow-gated reply must not say "sent". */
export const SAFE_PUBLIC_REPLIES = [
  "شيّك الخاص لإكمال الخطوات 🙌",
  "تفقّد رسائلك الخاصة 📩",
  "كمّل معنا في الخاص 💬",
  "الخطوات عندك في الخاص 👌",
  "شوف الخاص 🙌",
];

export function publicReplyVariants(text: string | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of (text ?? "").split(/\r?\n/)) {
    const v = line.trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out.slice(0, MAX_PUBLIC_VARIANTS);
}

/** Deterministic pick (same flow → same phrasing, so a retry never changes the text); consecutive flows rotate. */
export function pickVariant<T>(list: readonly T[], seed: number): T {
  return list[Math.abs(Math.trunc(seed)) % list.length];
}
