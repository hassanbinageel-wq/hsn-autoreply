import { fromB64, timingSafeEqual, b64url } from "./lib/crypto";

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

export const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** The legal operator of the service, exactly as in the commercial registration (Meta business verification matches it). */
export const OPERATOR = { name: "شركة ارقام المستديرة للدعاية والاعلان", cr: "7042872536", country: "المملكة العربية السعودية" };
const operatorFooter = () =>
  `<footer style="margin-top:32px;padding-top:14px;border-top:1px solid rgba(127,127,127,.25);font-size:.85rem;opacity:.75;text-align:center">HSN AutoReply خدمة تقدّمها ${esc(OPERATOR.name)} — الرقم الوطني الموحد (السجل التجاري): ${esc(OPERATOR.cr)} — ${esc(OPERATOR.country)}</footer>`;

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<title>${esc(title)} — HSN AutoReply</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif;max-width:760px;margin:0 auto;padding:24px 16px;line-height:1.8;background:#fff;color:#111}
@media (prefers-color-scheme:dark){body{background:#0b0f14;color:#e7ecf2}a{color:#7cc4ff}}
h1{font-size:1.5rem}.btn{display:inline-block;padding:14px 22px;border-radius:12px;background:#6d28d9;color:#fff;text-decoration:none;font-weight:700}
.muted{opacity:.75;font-size:.95rem}</style></head><body>${body}${operatorFooter()}</body></html>`;
}

export function privacyPage(baseUrl: string): string {
  return layout(
    "سياسة الخصوصية",
    `<h1>سياسة الخصوصية — HSN AutoReply</h1>
<p>مشغّل الخدمة والمسؤول عن البيانات: ${esc(OPERATOR.name)}، الرقم الوطني الموحد ${esc(OPERATOR.cr)}، ${esc(OPERATOR.country)}.</p>
<p>HSN AutoReply أداة يستخدمها صاحب الحساب لأتمتة الرد على التعليقات وردود الستوري والإشارات في حسابه الاحترافي على إنستقرام عبر واجهة Meta الرسمية.</p>
<h2>البيانات التي نعالجها</h2>
<ul>
<li>معرّفات Instagram الرسمية للمستخدمين الذين يعلّقون أو يراسلون الحساب (Instagram-scoped ID) واسم المستخدم عند توفره في الحدث.</li>
<li>نص التعليق أو الرسالة المستلمة لغرض المطابقة مع كلمات الحملة.</li>
<li>إيميل صاحب الحساب (عميل الخدمة) إذا أضافه: يُستخدم فقط لتأكيده ولإرسال رابط استرجاع كلمة المرور وإشعار تغييرها — بدون رسائل تسويقية، ولا يُشارك مع أي جهة. يُرسل الإيميل عبر مزوّد الإرسال Resend.</li>
<li>نتيجة التحقق من متابعة الحساب (متابع/غير متابع/غير معروف) عبر User Profile API الرسمي عند السماح بذلك.</li>
<li>حالة الرسائل المرسلة (قبول Meta للطلب أو فشله).</li>
<li>نص الرسائل المتبادلة في المحادثات الخاصة مع الحساب، لعرضها لصاحب الحساب في صندوق الرسائل داخل الأداة.</li>
<li>عدد مرات فتح رابط المحتوى المرسل (عبر رابط تحويل يمر بخادم الأداة) ونوع نظام الجهاز التقريبي (أندرويد/آيفون/غيره) من بيانات المتصفح، لأغراض الإحصائيات — بدون عنوان IP.</li>
<li>إذا ربط صاحب الحساب متجره (سلة) بصلاحيات قراءة فقط: بيانات المنتجات (الاسم والسعر وسعر التكلفة والرابط والصورة) وبيانات الطلبات اللازمة للتحليل فقط (المبلغ والخصم والشحن والضريبة، الحالة، كود الخصم، طريقة الدفع، المدينة، المنتجات، الوقت، ورمز مشفّر باتجاه واحد لمعرّف العميل لتمييز العميل الجديد من المتكرر) — بدون اسم المشتري أو جواله أو بريده أو عنوانه التفصيلي.</li>
<li>إذا استخدم صاحب الحساب جدولة النشر: الصور والفيديوهات اللي يرفعها لحسابه هو، تُحفظ بشكل خاص لين يُنشر المنشور ثم تُحذف تلقائيًا (أو بعد يوم من الإلغاء أو الفشل).</li>
<li>إذا سمح صاحب الحساب بصلاحية الإحصاءات: أرقام إنستقرام المجمّعة لمنشورات حسابه هو فقط (المشاهدات، الوصول، الإعجابات، الحفظ، المشاركات) وإحصاءات جمهور متابعيه المجمّعة (العمر، الجنس، الدول) كما تعيدها Meta، دون ربطها بأي شخص.</li>
</ul>
<h2>ما لا نفعله</h2>
<ul><li>لا نطلب كلمة مرور إنستقرام أبدًا.</li><li>لا نبيع البيانات أو نشاركها مع أي طرف ثالث.</li><li>لا نجمع قوائم المتابعين ولا نستخدم scraping.</li></ul>
<h2>الاحتفاظ والحذف</h2>
<p>تُحذف السجلات تلقائيًا بعد مدة الاحتفاظ المحددة في الإعدادات (افتراضيًا 90 يومًا)، مع الإبقاء على معرّفات منع التكرار فقط للمدة اللازمة. يمكنك طلب حذف بياناتك عبر <a href="${esc(baseUrl)}/data-deletion">صفحة حذف البيانات</a>.</p>
<p class="muted">آخر تحديث: 2026-09-27</p>`,
  );
}

export function termsPage(): string {
  return layout(
    "شروط الاستخدام",
    `<h1>شروط الاستخدام</h1><p>تُستخدم الأداة فقط من صاحب الحساب المتصل ووفق سياسات Meta وInstagram. يُمنع استخدامها في الرسائل الجماعية غير المرغوبة أو التحايل على حدود المنصة.</p>`,
  );
}

export function dataDeletionPage(): string {
  return layout(
    "حذف البيانات",
    `<h1>تعليمات حذف البيانات</h1>
<ol><li>إذا كنت مستخدمًا راسلت الحساب: أرسل رسالة للحساب تطلب حذف بياناتك، أو أزل الأذونات من إعدادات إنستقرام › التطبيقات والمواقع، وسيصلنا طلب الحذف تلقائيًا من Meta.</li>
<li>صاحب الحساب يستطيع حذف كل البيانات من داخل التطبيق: الإعدادات › حذف البيانات.</li></ol>`,
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
<p class="muted">لا تُمرَّر أي بيانات حساسة عبر هذا الرابط؛ التطبيق يتحقق من حالة الربط من الخادم مباشرة.</p>`,
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





/** Temporary test page: shows the campaign tags (UTM) a link arrived with — no tracking, nothing stored. */
export function utmCheckPage(q: Record<string, string | undefined>): string {
  const row = (k: string, label: string) =>
    `<tr><td style="padding:8px 10px;opacity:.75">${label}</td><td style="padding:8px 10px;font-weight:700;direction:ltr;text-align:left">${q[k] ? esc(q[k]) : '<span style="color:#dc2626">— ما وصل</span>'}</td></tr>`;
  const ok = q.utm_source && q.utm_medium && q.utm_campaign;
  return layout(
    "فحص روابط الحملات",
    `<h1>🔎 فحص وسوم الحملة (UTM)</h1>
<p style="padding:12px 14px;border-radius:12px;font-weight:700;${ok ? "background:#dcfce7;color:#166534" : "background:#fee2e2;color:#991b1b"}">${ok ? "✅ الرابط وصل ومعه وسوم الحملة — Google Analytics بيعرف إن الزائر جاء من هذي الحملة." : "❌ الرابط وصل بدون وسوم الحملة — تأكد إن «وسوم Google Analytics (UTM)» مفعّل في الحملة."}</p>
<table style="width:100%;border-collapse:collapse;border:1px solid rgba(127,127,127,.3);border-radius:12px">
${row("utm_source", "المصدر")}${row("utm_medium", "الوسيط")}${row("utm_campaign", "اسم الحملة")}
</table>
<p class="muted">صفحة تجريبية مؤقتة للتأكد من الخدمة — ما تحفظ أي بيانات.</p>`,
  );
}
