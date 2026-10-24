import { fromB64, timingSafeEqual, b64url } from "./lib/crypto";

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

export const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** The legal operator of the service, exactly as in the commercial registration (Meta business verification matches it). */
export const OPERATOR = {
  name: "شركة ارقام المستديرة للدعاية والاعلان",
  nameEn: "Arqam Al-Mustadeerah Advertising Company",
  cr: "7042872536",
  country: "المملكة العربية السعودية",
  countryEn: "Kingdom of Saudi Arabia",
  email: "support@shayyek.sa",
};

export type Lang = "ar" | "en";
/** `?lang=en` shows the English version of a public page; anything else is Arabic. */
export const pageLang = (q: string | undefined): Lang => (q === "en" ? "en" : "ar");
const href = (path: string, lang: Lang) => (lang === "en" ? `${path}?lang=en` : path);

const operatorFooter = (lang: Lang) =>
  `<footer style="margin-top:32px;padding-top:14px;border-top:1px solid rgba(127,127,127,.25);font-size:.85rem;opacity:.75;text-align:center">${
    lang === "en"
      ? `Shayyek (شيّك) is a service provided by ${esc(OPERATOR.nameEn)} (${esc(OPERATOR.name)}) — Unified National Number (Commercial Registration): ${esc(OPERATOR.cr)} — ${esc(OPERATOR.countryEn)} — <a href="mailto:${OPERATOR.email}">${OPERATOR.email}</a>`
      : `شيّك (Shayyek) خدمة تقدّمها ${esc(OPERATOR.name)} — الرقم الوطني الموحد (السجل التجاري): ${esc(OPERATOR.cr)} — ${esc(OPERATOR.country)} — <a href="mailto:${OPERATOR.email}">${OPERATOR.email}</a>`
  }<br><a href="${href("/terms", lang)}">${lang === "en" ? "Terms" : "الشروط"}</a> · <a href="${href("/privacy", lang)}">${lang === "en" ? "Privacy" : "الخصوصية"}</a> · <a href="${href("/refund", lang)}">${lang === "en" ? "Refunds" : "الاسترجاع"}</a> · <a href="${href("/data-deletion", lang)}">${lang === "en" ? "Data deletion" : "حذف البيانات"}</a></footer>`;

/**
 * A simple page. With `path`, it is a public legal page: an Arabic/English switch on top, and the English
 * version is left-to-right.
 */
function layout(title: string, body: string, extraHead = "", lang: Lang = "ar", path?: string): string {
  const en = lang === "en";
  const sw = path ? `<p style="text-align:${en ? "right" : "left"};margin:0 0 8px"><a href="${en ? path : `${path}?lang=en`}" lang="${en ? "ar" : "en"}">${en ? "العربية" : "English"}</a></p>` : "";
  return `<!doctype html><html lang="${lang}" dir="${en ? "ltr" : "rtl"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<title>${esc(title)} — ${en ? "Shayyek" : "شيّك"}</title>${extraHead}
<style>@font-face{font-family:"Thmanyah Sans";font-weight:400;font-display:swap;src:url(/fonts/thmanyahsans-Regular.woff2) format("woff2")}
@font-face{font-family:"Thmanyah Sans";font-weight:700;font-display:swap;src:url(/fonts/thmanyahsans-Bold.woff2) format("woff2")}
body{font-family:"Thmanyah Sans",system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif;max-width:760px;margin:0 auto;padding:24px 16px;line-height:1.8;background:#fff;color:#111}
@media (prefers-color-scheme:dark){body{background:#0b0f14;color:#e7ecf2}a{color:#7cc4ff}}
h1{font-size:1.5rem}h2{font-size:1.15rem;margin-top:1.6em}.btn{display:inline-block;padding:14px 22px;border-radius:12px;background:#6d28d9;color:#fff;text-decoration:none;font-weight:700}
.muted{opacity:.75;font-size:.95rem}</style></head><body>${sw}${body}${operatorFooter(lang)}</body></html>`;
}

const contact = (lang: Lang) =>
  lang === "en"
    ? `<h2>Contact us</h2><p>Email: <a href="mailto:${OPERATOR.email}">${OPERATOR.email}</a> — or the «Support» page inside your account. We usually reply within one business day.</p>`
    : `<h2>تواصل معنا</h2><p>الإيميل: <a href="mailto:${OPERATOR.email}">${OPERATOR.email}</a> — أو صفحة «الدعم» داخل حسابك. نرد عادةً خلال يوم عمل.</p>`;

export function privacyPage(baseUrl: string, lang: Lang = "ar"): string {
  const del = `${esc(baseUrl)}${href("/data-deletion", lang)}`;
  if (lang === "en")
    return layout(
      "Privacy Policy",
      `<h1>Privacy Policy — Shayyek</h1>
<p>Service operator and data controller: ${esc(OPERATOR.nameEn)} (${esc(OPERATOR.name)}), Unified National Number ${esc(OPERATOR.cr)}, ${esc(OPERATOR.countryEn)}.</p>
<p>Shayyek is a tool that the owner of a professional Instagram account uses to automate replies to comments, story replies and mentions on their own account through Meta's official API.</p>
<h2>Data we process</h2>
<ul>
<li>Official Instagram-scoped IDs of people who comment on or message the account, and their username when it is included in the event.</li>
<li>The text of the received comment or message, to match it against the campaign keywords.</li>
<li>The text of direct-message conversations with the account, to show them to the account owner in the inbox inside the tool.</li>
<li>Whether a person follows the account (follower / not a follower / unknown), through the official User Profile API, when allowed.</li>
<li>The delivery status of sent messages (Meta accepted or rejected the request).</li>
<li>How many times a sent content link was opened (through a redirect link on the tool's server) and the approximate device type (Android / iPhone / other) from the browser data, for statistics — without the IP address.</li>
<li>Account data of our customers (account owners): username, store or account name, a one-way hash of the password, and their email if they add it. The email is used only to confirm it, to send a password-recovery link and password-change notices — no marketing — and it is sent through the email provider Resend.</li>
<li>Support messages and the attachments a customer sends to us from the «Support» page, to answer them.</li>
<li>Payments: card payments are processed by the licensed payment gateway Moyasar. We never see or store card numbers; we keep only the amount, the plan or message pack, the status and the transaction reference.</li>
<li>If the account owner connects their store (Salla) with read-only permissions: product data (name, price, cost price, link, image) and only the order data needed for analytics (amount, discount, shipping, tax, status, coupon, payment method, city, products, time, and a one-way hash of the customer ID to tell new from returning customers) — without the buyer's name, phone, email or detailed address.</li>
<li>If the account owner uses scheduled publishing: the photos and videos they upload for their own account, kept privately until the post is published and then deleted automatically (or one day after a cancellation or failure).</li>
<li>If the account owner allows the insights permission: aggregated Instagram numbers for their own posts (views, reach, likes, saves, shares) and aggregated audience data (age, gender, countries) as returned by Meta, not linked to any person.</li>
</ul>
<h2>Service providers</h2>
<p>Cloudflare (hosting and database), Meta (Instagram API), Resend (account emails), Moyasar (card payments) and Salla (only if the customer connects their store). Each receives only what its part of the service needs.</p>
<h2>What we never do</h2>
<ul><li>We never ask for an Instagram password.</li><li>We do not sell or share data with third parties for advertising.</li><li>We do not collect follower lists and do not use scraping.</li></ul>
<h2>Retention and deletion</h2>
<p>Logs are deleted automatically after the retention period set in the settings (90 days by default), keeping only the de-duplication IDs for as long as needed. You can request the deletion of your data through the <a href="${del}">data deletion page</a>, and account owners can delete their account and all its data from the settings.</p>
${contact(lang)}
<p class="muted">Last updated: 2026-10-24. If the Arabic and English versions differ, the Arabic version prevails.</p>`,
      "",
      lang,
      "/privacy",
    );
  return layout(
    "سياسة الخصوصية",
    `<h1>سياسة الخصوصية — شيّك</h1>
<p>مشغّل الخدمة والمسؤول عن البيانات: ${esc(OPERATOR.name)}، الرقم الوطني الموحد ${esc(OPERATOR.cr)}، ${esc(OPERATOR.country)}.</p>
<p>شيّك أداة يستخدمها صاحب الحساب لأتمتة الرد على التعليقات وردود الستوري والإشارات في حسابه الاحترافي على إنستقرام عبر واجهة Meta الرسمية.</p>
<h2>البيانات التي نعالجها</h2>
<ul>
<li>معرّفات Instagram الرسمية للمستخدمين الذين يعلّقون أو يراسلون الحساب (Instagram-scoped ID) واسم المستخدم عند توفره في الحدث.</li>
<li>نص التعليق أو الرسالة المستلمة لغرض المطابقة مع كلمات الحملة.</li>
<li>نص الرسائل المتبادلة في المحادثات الخاصة مع الحساب، لعرضها لصاحب الحساب في صندوق الرسائل داخل الأداة.</li>
<li>نتيجة التحقق من متابعة الحساب (متابع/غير متابع/غير معروف) عبر User Profile API الرسمي عند السماح بذلك.</li>
<li>حالة الرسائل المرسلة (قبول Meta للطلب أو فشله).</li>
<li>عدد مرات فتح رابط المحتوى المرسل (عبر رابط تحويل يمر بخادم الأداة) ونوع نظام الجهاز التقريبي (أندرويد/آيفون/غيره) من بيانات المتصفح، لأغراض الإحصائيات — بدون عنوان IP.</li>
<li>بيانات حساب عملائنا (أصحاب الحسابات): اسم المستخدم، اسم المتجر أو الحساب، كلمة المرور مخزّنة بتشفير أحادي الاتجاه، والإيميل إذا أضافه — يُستخدم الإيميل فقط لتأكيده ولإرسال رابط استرجاع كلمة المرور وإشعار تغييرها، بدون رسائل تسويقية، ويُرسل عبر مزوّد الإرسال Resend.</li>
<li>رسائل الدعم والمرفقات التي يرسلها العميل لنا من صفحة «الدعم»، للرد عليها.</li>
<li>المدفوعات: الدفع بالبطاقة تعالجه بوابة الدفع المرخّصة «ميسّر» (Moyasar). لا نرى رقم البطاقة ولا نخزّنه؛ نحتفظ فقط بالمبلغ والباقة أو حزمة الرسائل وحالة العملية ورقمها المرجعي.</li>
<li>إذا ربط صاحب الحساب متجره (سلة) بصلاحيات قراءة فقط: بيانات المنتجات (الاسم والسعر وسعر التكلفة والرابط والصورة) وبيانات الطلبات اللازمة للتحليل فقط (المبلغ والخصم والشحن والضريبة، الحالة، كود الخصم، طريقة الدفع، المدينة، المنتجات، الوقت، ورمز مشفّر باتجاه واحد لمعرّف العميل لتمييز العميل الجديد من المتكرر) — بدون اسم المشتري أو جواله أو بريده أو عنوانه التفصيلي.</li>
<li>إذا استخدم صاحب الحساب جدولة النشر: الصور والفيديوهات اللي يرفعها لحسابه هو، تُحفظ بشكل خاص لين يُنشر المنشور ثم تُحذف تلقائيًا (أو بعد يوم من الإلغاء أو الفشل).</li>
<li>إذا سمح صاحب الحساب بصلاحية الإحصاءات: أرقام إنستقرام المجمّعة لمنشورات حسابه هو فقط (المشاهدات، الوصول، الإعجابات، الحفظ، المشاركات) وإحصاءات جمهور متابعيه المجمّعة (العمر، الجنس، الدول) كما تعيدها Meta، دون ربطها بأي شخص.</li>
</ul>
<h2>مزوّدو الخدمة</h2>
<p>Cloudflare (الاستضافة وقاعدة البيانات)، Meta (واجهة إنستقرام)، Resend (إيميلات الحساب)، ميسّر (الدفع بالبطاقة)، وسلة (فقط إذا ربط العميل متجره). كل جهة تستلم فقط ما يلزم لدورها في الخدمة.</p>
<h2>ما لا نفعله</h2>
<ul><li>لا نطلب كلمة مرور إنستقرام أبدًا.</li><li>لا نبيع البيانات ولا نشاركها مع أي طرف ثالث لأغراض إعلانية.</li><li>لا نجمع قوائم المتابعين ولا نستخدم scraping.</li></ul>
<h2>الاحتفاظ والحذف</h2>
<p>تُحذف السجلات تلقائيًا بعد مدة الاحتفاظ المحددة في الإعدادات (افتراضيًا 90 يومًا)، مع الإبقاء على معرّفات منع التكرار فقط للمدة اللازمة. يمكنك طلب حذف بياناتك عبر <a href="${del}">صفحة حذف البيانات</a>، ويستطيع صاحب الحساب حذف حسابه وكل بياناته من الإعدادات.</p>
${contact(lang)}
<p class="muted">آخر تحديث: 2026-10-24</p>`,
    "",
    lang,
    "/privacy",
  );
}

export function termsPage(lang: Lang = "ar"): string {
  if (lang === "en")
    return layout(
      "Terms of Use",
      `<h1>Terms of Use — Shayyek</h1>
<p>These terms govern the use of Shayyek, provided by ${esc(OPERATOR.nameEn)} (${esc(OPERATOR.name)}), Unified National Number ${esc(OPERATOR.cr)}. By creating an account or using the service you agree to them.</p>
<h2>1. The service</h2>
<p>Shayyek automates replies to comments, story replies, mentions and direct messages on the customer's own professional Instagram account through Meta's official APIs, with an inbox, statistics and related tools. The service depends on Meta's platform: we do not control its availability, limits or policy changes, and some features may change or stop if Meta changes them.</p>
<h2>2. Your account</h2>
<ul><li>You must be legally able to contract and own (or be authorised to manage) the connected Instagram account, which must be a professional (business or creator) account.</li>
<li>You are responsible for keeping your login details safe and for everything done through your account and your staff accounts.</li>
<li>We never ask for your Instagram password; the connection is made through Meta's official login.</li></ul>
<h2>3. Acceptable use</h2>
<p>You agree to follow Meta's and Instagram's policies (including the Platform Terms and the Community Standards on spam) and the laws of the Kingdom of Saudi Arabia. It is not allowed to: send unsolicited bulk messages, message people who have not interacted with your account, get around platform limits, send unlawful, misleading or offensive content, or try to access other customers' data or attack the service.</p>
<h2>4. Plans and payment</h2>
<ul><li>Plans are paid in advance, monthly. Prices are in Saudi riyals and include 15% VAT, and they are shown before payment.</li>
<li>Payment is by card through the licensed gateway Moyasar, by bank transfer, or by an activation code. Plans do not renew automatically and nothing is charged again without your action.</li>
<li>Each plan has usage limits (such as the number of automatic messages per period) shown on the plans page.</li>
<li>You can upgrade to a higher plan during your subscription by paying the difference, calculated automatically; the end date stays the same. Moving to a lower plan is only possible after the subscription ends.</li>
<li>Extra message packs: with an active plan you can buy extra messages for the current usage period (30 days of the subscription). They are added at once, used after your plan's own messages, and expire when the period's counter renews — they do not carry over.</li>
<li>Offers and discounts shown in the app are valid until the time shown on them, and only for the accounts they are shown to.</li>
<li>Refunds follow the <a href="${href("/refund", lang)}">refund and cancellation policy</a>.</li></ul>
<h2>5. Suspension and termination</h2>
<p>We may suspend or close an account that breaks these terms or Meta's policies, or whose use puts the service or other customers at risk, after notice where possible. You may stop using the service and delete your account and its data at any time from the settings.</p>
<h2>6. Liability</h2>
<p>The service is provided «as is». We work to keep it available and accurate, but we are not liable for indirect losses, lost profits, or restrictions that Meta places on your account because of how it is used. Our total liability for any claim does not exceed the amount you paid for the current subscription period.</p>
<h2>7. Your content</h2>
<p>The content of your campaigns, replies and conversations stays yours. You give us only the permission needed to process it to run the service, as described in the <a href="${href("/privacy", lang)}">privacy policy</a>.</p>
<h2>8. Changes</h2>
<p>We may update these terms; material changes are announced inside the service before they take effect. Continuing to use the service after that means accepting them.</p>
<h2>9. Governing law</h2>
<p>These terms are governed by the laws of the Kingdom of Saudi Arabia, and the competent courts there decide any dispute. If the Arabic and English versions differ, the Arabic version prevails.</p>
${contact(lang)}
<p class="muted">Last updated: 2026-10-23</p>`,
      "",
      lang,
      "/terms",
    );
  return layout(
    "شروط الاستخدام",
    `<h1>شروط الاستخدام — شيّك</h1>
<p>تنظّم هذه الشروط استخدام «شيّك» التي تقدّمها ${esc(OPERATOR.name)}، الرقم الوطني الموحد ${esc(OPERATOR.cr)}. بإنشاء حساب أو استخدام الخدمة فأنت توافق عليها.</p>
<h2>1. الخدمة</h2>
<p>شيّك تؤتمت الرد على التعليقات وردود الستوري والإشارات والرسائل الخاصة في حساب إنستقرام الاحترافي الخاص بالعميل عبر واجهات Meta الرسمية، مع صندوق رسائل وإحصائيات وأدوات مرتبطة. تعتمد الخدمة على منصة Meta: لا نتحكم في توفرها أو حدودها أو تغيّر سياساتها، وقد تتغير بعض الميزات أو تتوقف إذا غيّرتها Meta.</p>
<h2>2. حسابك</h2>
<ul><li>يجب أن تكون أهلًا للتعاقد، ومالكًا لحساب إنستقرام المربوط أو مفوّضًا بإدارته، وأن يكون الحساب احترافيًا (تجاري أو صانع محتوى).</li>
<li>أنت مسؤول عن حماية بيانات دخولك وعن كل ما يتم عبر حسابك وحسابات موظفيك.</li>
<li>لا نطلب كلمة مرور إنستقرام أبدًا؛ الربط يتم عبر تسجيل الدخول الرسمي من Meta.</li></ul>
<h2>3. الاستخدام المقبول</h2>
<p>تلتزم بسياسات Meta وإنستقرام (ومنها شروط المنصة ومعايير المجتمع الخاصة بالرسائل غير المرغوبة) وبأنظمة المملكة العربية السعودية. ويُمنع: إرسال رسائل جماعية غير مرغوبة، أو مراسلة من لم يتفاعل مع حسابك، أو التحايل على حدود المنصة، أو إرسال محتوى مخالف للأنظمة أو مضلّل أو مسيء، أو محاولة الوصول لبيانات عملاء آخرين أو مهاجمة الخدمة.</p>
<h2>4. الباقات والدفع</h2>
<ul><li>الباقات تُدفع مقدمًا بشكل شهري. الأسعار بالريال السعودي شاملة ضريبة القيمة المضافة 15%، وتظهر قبل الدفع.</li>
<li>الدفع بالبطاقة عبر بوابة الدفع المرخّصة «ميسّر»، أو بالتحويل البنكي، أو بكود تفعيل. لا تتجدد الباقات تلقائيًا، ولا يُخصم أي مبلغ مرة ثانية بدون إجراء منك.</li>
<li>لكل باقة حدود استخدام (مثل عدد الرسائل التلقائية في الفترة) موضّحة في صفحة الباقات.</li>
<li>تقدر تترقى لباقة أعلى أثناء اشتراكك بدفع الفرق المحسوب تلقائيًا، ويبقى تاريخ الانتهاء نفسه. والانتقال لباقة أقل يكون بعد انتهاء الاشتراك فقط.</li>
<li>حزم الرسائل الإضافية: مع باقة فعّالة تقدر تشتري رسائل إضافية لفترة الاستخدام الحالية (30 يومًا من اشتراكك). تنضاف فورًا وتُستخدم بعد رسائل باقتك، وتنتهي مع تجدد عدّاد الفترة ولا تُرحَّل للفترة التالية.</li>
<li>العروض والخصومات اللي تظهر داخل التطبيق صالحة حتى الوقت الموضّح عليها، وللحسابات اللي ظهرت لها فقط.</li>
<li>الاسترجاع حسب <a href="/refund">سياسة الاسترجاع والإلغاء</a>.</li></ul>
<h2>5. الإيقاف والإنهاء</h2>
<p>يحق لنا إيقاف أو إغلاق الحساب الذي يخالف هذه الشروط أو سياسات Meta، أو يعرّض الخدمة أو العملاء الآخرين للخطر، مع إشعارك متى أمكن. ويحق لك التوقف عن استخدام الخدمة وحذف حسابك وبياناته في أي وقت من الإعدادات.</p>
<h2>6. حدود المسؤولية</h2>
<p>تُقدَّم الخدمة «كما هي». نعمل على أن تكون متاحة ودقيقة، لكننا لا نتحمل الخسائر غير المباشرة أو فوات الأرباح أو القيود التي تفرضها Meta على حسابك بسبب طريقة استخدامه. ولا تتجاوز مسؤوليتنا الإجمالية عن أي مطالبة المبلغ الذي دفعته عن فترة الاشتراك الحالية.</p>
<h2>7. محتواك</h2>
<p>محتوى حملاتك وردودك ومحادثاتك يبقى ملكك، وتمنحنا فقط الإذن اللازم لمعالجته لتشغيل الخدمة كما في <a href="/privacy">سياسة الخصوصية</a>.</p>
<h2>8. التعديلات</h2>
<p>قد نحدّث هذه الشروط، ونعلن التغييرات الجوهرية داخل الخدمة قبل سريانها. استمرارك في الاستخدام بعدها يعني موافقتك عليها.</p>
<h2>9. النظام المطبّق</h2>
<p>تخضع هذه الشروط لأنظمة المملكة العربية السعودية، وتختص محاكمها بأي نزاع.</p>
${contact(lang)}
<p class="muted">آخر تحديث: 2026-10-23</p>`,
    "",
    lang,
    "/terms",
  );
}

/** Refund and cancellation policy (required by the card payment gateway). Draft — the owner reviews the wording. */
export function refundPage(lang: Lang = "ar"): string {
  if (lang === "en")
    return layout(
      "Refund and Cancellation Policy",
      `<h1>Refund and Cancellation Policy</h1>
<p>Shayyek is a digital subscription (a software service) paid in advance for one month (30 days). Prices are in Saudi riyals, include VAT, and are shown before payment.</p>
<h2>Activation</h2><p>The plan is activated automatically after a successful card payment. If you already have an active subscription, the new period is added after its end date. There is no automatic renewal and no recurring charge on your card.</p>
<h2>Refunds</h2><ul>
<li>You may request a full refund within <b>3 days</b> of payment if the service has not sent any automatic reply from your account since the payment.</li>
<li>If the service cannot be provided because of a fault on our side, we compensate you with extra days or refund the remaining period — your choice.</li>
<li>Otherwise the current period is not refunded, and your subscription continues until it ends.</li>
<li>A suspension caused by breaking Meta's policies or the terms of use is not eligible for a refund.</li></ul>
<h2>How to request</h2><p>Request the refund from the «Support» page inside your account, or by email to <a href="mailto:${OPERATOR.email}">${OPERATOR.email}</a>, with the transaction number. The amount goes back to the same card used for the payment, usually within 5 to 14 business days depending on the issuing bank.</p>
<h2>Upgrading to a higher plan</h2><p>You can upgrade at any time from the «My subscription» page and pay only the difference, calculated automatically: the higher plan for the days left in your subscription, less what is left of your current plan (its days left, reduced if you have used more of this period's messages than the time that has passed). After you pay it by card, the plan changes at once and the end date stays the same. You cannot move to a lower plan while your subscription is active; you can choose it after it ends.</p>
<h2>Cancellation</h2><p>Because the subscription does not renew automatically, simply do not renew. You can also delete your account and data at any time from the settings.</p>
<p class="muted">Payment by bank transfer follows the same periods, and the amount is returned by bank transfer. If the Arabic and English versions differ, the Arabic version prevails.</p>`,
      "",
      lang,
      "/refund",
    );
  return layout(
    "سياسة الاسترجاع والإلغاء",
    `<h1>سياسة الاسترجاع والإلغاء</h1>
<p>شيّك اشتراك رقمي (خدمة برمجية) يُدفع مقدمًا لمدة شهر (30 يومًا). الأسعار بالريال السعودي شاملة الضريبة وتظهر قبل الدفع.</p>
<h2>التفعيل</h2><p>تتفعّل الباقة تلقائيًا بعد نجاح الدفع بالبطاقة، وإذا كان عندك اشتراك فعّال تُضاف المدة الجديدة بعد تاريخ انتهائه. لا يوجد تجديد تلقائي ولا خصم متكرر من بطاقتك.</p>
<h2>الاسترجاع</h2><ul>
<li>يحق لك طلب استرجاع كامل المبلغ خلال <b>3 أيام</b> من الدفع إذا لم تُرسل الخدمة أي رد تلقائي من حسابك بعد الدفع.</li>
<li>إذا تعذّر تقديم الخدمة بسبب خلل من جهتنا، نعوّضك بأيام إضافية أو نسترجع لك المبلغ عن المدة المتبقية — حسب اختيارك.</li>
<li>بعد ذلك لا يُسترجع مبلغ المدة الجارية، ويستمر اشتراكك حتى نهايتها.</li>
<li>توقّف الخدمة بسبب مخالفة سياسات Meta أو شروط الاستخدام لا يستحق استرجاعًا.</li></ul>
<h2>طريقة الطلب</h2><p>اطلب الاسترجاع من صفحة «الدعم» داخل حسابك، أو بالإيميل على <a href="mailto:${OPERATOR.email}">${OPERATOR.email}</a>، مع رقم العملية. يُعاد المبلغ إلى نفس البطاقة المستخدمة في الدفع، ويصل عادةً خلال 5 إلى 14 يوم عمل حسب البنك المُصدِر.</p>
<h2>الترقية لباقة أعلى</h2><p>تقدر تترقى في أي وقت من صفحة «اشتراكي» وتدفع الفرق فقط، ويُحسب تلقائيًا: سعر الباقة الأعلى للأيام الباقية من اشتراكك، ناقص المتبقي من باقتك الحالية (أيامها الباقية، وتقل إذا استهلكت من رسائل الفترة أكثر من الوقت اللي مضى). بعد دفعه بالبطاقة تترقى باقتك فورًا ويبقى تاريخ الانتهاء نفسه. لا يمكن الانتقال لباقة أقل أثناء الاشتراك، وتقدر تختارها بعد انتهائه.</p>
<h2>الإلغاء</h2><p>لأن الاشتراك لا يتجدد تلقائيًا، يكفي ألا تجدّد. يمكنك أيضًا حذف حسابك وبياناتك في أي وقت من الإعدادات.</p>
<p class="muted">الدفع بالتحويل البنكي يخضع لنفس المدد، ويُعاد المبلغ بتحويل بنكي.</p>`,
    "",
    lang,
    "/refund",
  );
}

export function dataDeletionPage(lang: Lang = "ar"): string {
  if (lang === "en")
    return layout(
      "Data Deletion",
      `<h1>Data deletion instructions</h1>
<ol><li>If you messaged or commented on an account that uses Shayyek: send the account a message asking to delete your data, or remove the permissions from Instagram › Settings › Apps and websites — Meta then sends us the deletion request automatically.</li>
<li>Account owners (our customers) can delete all their data from inside the app: Settings › Delete data, or delete the whole account.</li>
<li>Or email us at <a href="mailto:${OPERATOR.email}">${OPERATOR.email}</a> with your Instagram username, and we will delete the related data and confirm.</li></ol>`,
      "",
      lang,
      "/data-deletion",
    );
  return layout(
    "حذف البيانات",
    `<h1>تعليمات حذف البيانات</h1>
<ol><li>إذا كنت مستخدمًا راسلت أو علّقت على حساب يستخدم شيّك: أرسل رسالة للحساب تطلب حذف بياناتك، أو أزل الأذونات من إعدادات إنستقرام › التطبيقات والمواقع، وسيصلنا طلب الحذف تلقائيًا من Meta.</li>
<li>صاحب الحساب (عميل الخدمة) يستطيع حذف كل البيانات من داخل التطبيق: الإعدادات › حذف البيانات، أو حذف الحساب كاملًا.</li>
<li>أو راسلنا على <a href="mailto:${OPERATOR.email}">${OPERATOR.email}</a> مع اسم مستخدمك في إنستقرام، ونحذف البيانات المرتبطة ونؤكد لك.</li></ol>`,
    "",
    lang,
    "/data-deletion",
  );
}

export function deletionStatusPage(code: string): string {
  return layout("حالة الحذف", `<h1>طلب الحذف</h1><p>رمز التأكيد: <code>${esc(code)}</code></p><p>تمت معالجة الطلب وحذف البيانات المرتبطة.</p>`);
}

export function oauthResultPage(ok: boolean, message: string, client: "web" | "app", deepLink: string): string {
  const target = client === "app" ? `${deepLink}?status=${ok ? "ok" : "error"}` : `/#/connection?status=${ok ? "ok" : "error"}`;
  return layout(
    ok ? "تم الربط" : "تعذر الربط",
    `<h1>${ok ? "✅ تم ربط الحساب" : "⚠️ تعذر ربط الحساب"}</h1>
<p>${esc(message)}</p>
<p><a class="btn" href="${esc(target)}">${client === "app" ? "العودة إلى التطبيق" : "العودة إلى لوحة التحكم"}</a></p>
<p class="muted">${client === "app" ? "ترجع للتطبيق تلقائيًا خلال ثوانٍ — إذا ما رجعت، اضغط الزر. " : ""}لا تُمرَّر أي بيانات حساسة عبر هذا الرابط؛ التطبيق يتحقق من حالة الربط من الخادم مباشرة.</p>`,
    // Back to the app (or the dashboard) on its own after a moment; the button stays for browsers that block it.
    // (A meta refresh, since the page's CSP allows no scripts.)
    `<meta http-equiv="refresh" content="2;url=${esc(target)}">`,
  );
}

/** Parses and verifies a Meta signed_request (deauthorize / data-deletion callbacks). */
export async function parseSignedRequest(signed: string, appSecret: string): Promise<Record<string, unknown> | null> {
  const [sig, payload] = (signed ?? "").split(".", 2);
  if (!sig || !payload || !appSecret) return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(appSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))));
  if (!timingSafeEqual(expected, sig)) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(fromB64(payload)));
    if (data?.algorithm && String(data.algorithm).toUpperCase() !== "HMAC-SHA256") return null;
    return data;
  } catch {
    return null;
  }
}





