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
