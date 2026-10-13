import { fromB64, timingSafeEqual, b64url } from "./lib/crypto";
import { FEATURE_HINTS, FEATURE_LABELS, LIMIT_HINTS, type PlanLimits } from "../shared/plans";

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

export const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — HSN AutoReply</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif;max-width:760px;margin:0 auto;padding:24px 16px;line-height:1.8;background:#fff;color:#111}
@media (prefers-color-scheme:dark){body{background:#0b0f14;color:#e7ecf2}a{color:#7cc4ff}}
h1{font-size:1.5rem}.btn{display:inline-block;padding:14px 22px;border-radius:12px;background:#6d28d9;color:#fff;text-decoration:none;font-weight:700}
.muted{opacity:.75;font-size:.95rem}</style></head><body>${body}</body></html>`;
}

export function privacyPage(baseUrl: string): string {
  return layout(
    "سياسة الخصوصية",
    `<h1>سياسة الخصوصية — HSN AutoReply</h1>
<p>HSN AutoReply أداة يستخدمها صاحب الحساب لأتمتة الرد على التعليقات وردود الستوري والإشارات في حسابه الاحترافي على إنستقرام عبر واجهة Meta الرسمية.</p>
<h2>البيانات التي نعالجها</h2>
<ul>
<li>معرّفات Instagram الرسمية للمستخدمين الذين يعلّقون أو يراسلون الحساب (Instagram-scoped ID) واسم المستخدم عند توفره في الحدث.</li>
<li>نص التعليق أو الرسالة المستلمة لغرض المطابقة مع كلمات الحملة.</li>
<li>نتيجة التحقق من متابعة الحساب (متابع/غير متابع/غير معروف) عبر User Profile API الرسمي عند السماح بذلك.</li>
<li>حالة الرسائل المرسلة (قبول Meta للطلب أو فشله).</li>
<li>نص الرسائل المتبادلة في المحادثات الخاصة مع الحساب، لعرضها لصاحب الحساب في صندوق الرسائل داخل الأداة.</li>
<li>عدد مرات فتح رابط المحتوى المرسل (عبر رابط تحويل يمر بخادم الأداة) لأغراض الإحصائيات.</li>
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

interface PricingPlan {
  id: string;
  name: string;
  price_label: string | null;
  description: string | null;
  limits: PlanLimits;
}

const EV: Record<string, string> = { comment: "التعليقات", story_reply: "ردود الستوري", story_mention: "منشن الستوري" };
const FEAT = Object.entries(FEATURE_LABELS);

/** Public pricing page: the plans as the owner configured them, and how to get an activation code. */
export function pricingPage(plans: PricingPlan[], contact: string | null, baseUrl: string): string {
  const n = (v: number | null, unit: string) => (v === null ? `غير محدود` : `${v.toLocaleString("en-US")} ${unit}`);
  const cards = plans
    .map((p, i) => {
      const l = p.limits;
      const tip = (html: string, hint: string | undefined, off = false) =>
        `<span class="tip" tabindex="0"><span${off ? ' class="off"' : ""}>${html}</span>${hint ? `<i>ⓘ</i><span class="box" role="tooltip">${esc(hint)}</span>` : ""}</span>`;
      const rows = [
        tip(`✅ ${EV.comment}${l.events.length > 1 ? ` + ${l.events.filter((e) => e !== "comment").map((e) => EV[e] ?? e).join(" + ")}` : ""}`, LIMIT_HINTS.events),
        tip(`✅ الحملات النشطة: ${n(l.active_campaigns, "")}`, LIMIT_HINTS.active_campaigns),
        tip(`✅ الرسائل شهريًا: ${n(l.monthly_messages, "رسالة")}`, LIMIT_HINTS.monthly_messages),
        l.draws_per_month === 0 ? tip("— السحوبات", LIMIT_HINTS.draws_per_month, true) : tip(`✅ السحوبات: ${l.draws_per_month === null ? "غير محدودة" : `${l.draws_per_month} شهريًا`}`, LIMIT_HINTS.draws_per_month),
        ...FEAT.map(([k, label]) => ((l as unknown as Record<string, unknown>)[k] ? tip(`✅ ${esc(label)}`, FEATURE_HINTS[k]) : tip(`— ${esc(label)}`, FEATURE_HINTS[k], true))),
      ];
      return `<div class="plan${i === plans.length - 1 ? " top" : ""}"><h2>${esc(p.name)}</h2>
<div class="price">${esc(p.price_label || "تواصل معنا")}</div>${p.description ? `<p class="muted">${esc(p.description)}</p>` : ""}
<ul>${rows.map((r) => `<li>${r}</li>`).join("")}</ul></div>`;
    })
    .join("");
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>الباقات — HSN AutoReply</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif;margin:0;background:#f6f5fb;color:#16122b;line-height:1.7}
@media (prefers-color-scheme:dark){body{background:#0d0b18;color:#ece9f8}.plan{background:#17142a!important;border-color:#2a2545!important}}
.wrap{max-width:1040px;margin:0 auto;padding:32px 16px}.hero{text-align:center;margin-bottom:28px}
h1{font-size:2rem;margin:.2em 0}.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.plan{background:#fff;border:1px solid #ebe8f4;border-radius:20px;padding:22px}.plan.top{border:2px solid #7c3aed}
.plan h2{margin:0;font-size:1.3rem}.price{font-size:1.5rem;font-weight:800;color:#7c3aed;margin:.3em 0}
ul{list-style:none;padding:0;margin:12px 0 0}li{padding:4px 0;font-size:.95rem}.off{opacity:.45}
.tip{position:relative;cursor:help;outline:none}.tip i{font-style:normal;font-size:.75em;opacity:.5;margin-inline-start:5px}
.tip .box{position:absolute;bottom:calc(100% + 8px);right:0;z-index:5;width:250px;max-width:78vw;padding:9px 12px;border-radius:12px;background:#16122b;color:#fff;font-size:.82rem;line-height:1.6;box-shadow:0 8px 24px rgba(0,0,0,.18);opacity:0;visibility:hidden;transition:opacity .15s}
.tip:hover .box,.tip:focus .box{opacity:1;visibility:visible}
@media (prefers-color-scheme:dark){.tip .box{background:#fff;color:#16122b}}.muted{opacity:.7;font-size:.92rem}
.btn{display:inline-block;padding:13px 22px;border-radius:14px;background:linear-gradient(135deg,#7c3aed,#c026d3 55%,#f97316);color:#fff;text-decoration:none;font-weight:700;margin:6px}
.btn.ghost{background:none;border:1px solid #7c3aed;color:#7c3aed}.steps{max-width:640px;margin:28px auto 0}</style></head>
<body><div class="wrap"><div class="hero"><h1>HSN AutoReply</h1>
<p class="muted">ردود تلقائية على تعليقات وستوري إنستقرام عبر واجهة Meta الرسمية — بدون كلمة مرور، بدون أي أدوات غير رسمية.</p></div>
<div class="grid">${cards}</div>
<div class="steps"><h2>كيف تشترك؟</h2><ol><li>تواصل معنا واختر الباقة والمدة، وبعد الدفع يصلك <b>كود تفعيل</b>.</li>
<li>أنشئ حسابك بالكود من صفحة التسجيل، أو أدخله من «اشتراكي» إذا عندك حساب.</li><li>اربط حساب إنستقرام الاحترافي عبر تسجيل الدخول الرسمي من Meta وابدأ حملاتك.</li></ol>
<p style="text-align:center">${contact ? `<a class="btn" href="${esc(contact)}" rel="noopener">تواصل معنا للاشتراك</a>` : ""}<a class="btn ghost" href="${esc(baseUrl)}/#/register">عندي كود — أنشئ حسابي</a></p>
<p class="muted" style="text-align:center"><a href="${esc(baseUrl)}/privacy">الخصوصية</a> · <a href="${esc(baseUrl)}/terms">الشروط</a></p></div></div></body></html>`;
}
