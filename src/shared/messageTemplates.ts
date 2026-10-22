/**
 * Ready-made owner messages (editable by the owner): notices to every customer, and private messages to one.
 * Placeholders are filled per customer when sent.
 */
export type MessageTemplate = { label: string; title: string; body: string; link: string; days: number };
export type MessageTemplates = { notice: MessageTemplate[]; private: MessageTemplate[] };

export const MESSAGE_PLACEHOLDERS: Array<{ key: string; hint: string }> = [
  { key: "{الاسم}", hint: "اسم العميل" },
  { key: "{الباقة}", hint: "باقته" },
  { key: "{الأيام_المتبقية}", hint: "كم يوم باقي على اشتراكه" },
  { key: "{تاريخ_الانتهاء}", hint: "تاريخ انتهاء اشتراكه" },
];

export const DEFAULT_MESSAGE_TEMPLATES: MessageTemplates = {
  notice: [
    { label: "صيانة مجدولة", title: "🛠️ صيانة مجدولة للخدمة", body: "بنسوي تحسينات على الخدمة يوم … من الساعة … إلى …. ممكن تتأخر الردود التلقائية خلالها، والتعليقات اللي توصل وقتها بنرد عليها بعد ما نخلص.", link: "/", days: 7 },
    { label: "توقف مؤقت", title: "⏸️ الردود التلقائية متوقفة مؤقتًا", body: "الردود بترجع تلقائيًا قريب، والتعليقات الفائتة بنرد عليها أول ما ترجع. ما يحتاج تسوي أي شي.", link: "/", days: 3 },
    { label: "رجعت الخدمة", title: "✅ رجعت الخدمة تشتغل بشكل طبيعي", body: "الردود التلقائية رجعت، وجاري الرد على التعليقات اللي وصلت خلال التوقف.", link: "/", days: 3 },
    { label: "ميزة جديدة", title: "✨ ميزة جديدة في شيّك", body: "أضفنا لك …. تقدر تجربها الحين من صفحة ….", link: "/", days: 30 },
    { label: "عرض للجميع", title: "🎁 عرض خاص لفترة محدودة", body: "خصم …% على كل الباقات لين …. استخدم الكود … في صفحة «اشتراكي والباقات».", link: "/subscription", days: 7 },
    { label: "نصيحة الأسبوع", title: "💡 نصيحة تزيد تفاعلك", body: "الحملات اللي فيها كلمة واضحة في الكابشن (مثل: اكتب «تم») تجيب تعليقات أكثر. جرّبها في منشورك الجاي.", link: "/campaigns/new", days: 7 },
    { label: "إجازة / عيد", title: "🌙 كل عام وأنتم بخير", body: "الخدمة شغّالة طول الإجازة، وردود حملاتك تكمل تلقائي. الدعم يرد عليكم بعد العيد إن شاء الله.", link: "/", days: 7 },
  ],
  private: [
    { label: "تجديد الاشتراك", title: "⏳ اشتراكك ينتهي قريب", body: "هلا {الاسم} 👋\nاشتراكك في باقة {الباقة} ينتهي بعد {الأيام_المتبقية} يوم ({تاريخ_الانتهاء}). جدّده من «اشتراكي» عشان ما تتوقف ردودك التلقائية.", link: "/subscription", days: 30 },
    { label: "انتهى الاشتراك", title: "⛔ انتهى اشتراكك", body: "هلا {الاسم}\nانتهى اشتراكك والردود التلقائية متوقفة. جدّد من «اشتراكي» وترجع حملاتك تشتغل على طول.", link: "/subscription", days: 30 },
    { label: "حصلت على عرض", title: "🎁 عرض خاص لك", body: "هلا {الاسم} 🌟\nحصلت على خصم …% على تجديد أو ترقية باقتك. استخدم الكود … في «اشتراكي والباقات» قبل ….", link: "/subscription", days: 7 },
    { label: "أيام هدية", title: "🎉 أضفنا لك أيام مجانية", body: "هلا {الاسم}\nأضفنا … يوم مجانًا على اشتراكك، صار ينتهي {تاريخ_الانتهاء}. شكرًا إنك معنا 💜", link: "/subscription", days: 30 },
    { label: "ترقية الباقة", title: "🚀 تفاعلك يكبر!", body: "هلا {الاسم}\nلاحظنا إنك قربت توصل حد رسائل باقة {الباقة}. الترقية تضمن ما تتوقف ردودك وقت الذروة.", link: "/subscription", days: 30 },
    { label: "أعد ربط إنستقرام", title: "🔗 حسابك في إنستقرام يحتاج إعادة ربط", body: "هلا {الاسم}\nالربط مع إنستقرام انقطع، فالردود التلقائية متوقفة. ادخل «الربط» واضغط «إعادة الربط» — ياخذ دقيقة.", link: "/connection", days: 30 },
    { label: "ما عندك حملة", title: "👋 جاهز تبدأ أول حملة؟", body: "هلا {الاسم}\nحسابك جاهز بس ما فيه حملة شغّالة. سوّ حملة على منشورك الجاي وخل الردود تشتغل عنك.", link: "/campaigns/new", days: 30 },
    { label: "وحشتنا", title: "💜 وحشتنا يا {الاسم}", body: "صار لك فترة ما دخلت. إذا فيه شي مضايقك أو تحتاج مساعدة، اكتب لنا من «الدعم» ونخدمك.", link: "/support", days: 30 },
    { label: "شكر", title: "🙏 شكرًا لك", body: "هلا {الاسم}\nشكرًا على ثقتك واشتراكك في {الباقة}. أي اقتراح أو ملاحظة، يسعدنا نسمعها من «الدعم».", link: "/", days: 30 },
  ],
};

/** Fills the placeholders for one customer. */
export function fillMessage(text: string, v: { name: string; plan: string | null; expiresAt: number | null }, now = Date.now()): string {
  const days = v.expiresAt ? Math.max(0, Math.ceil((v.expiresAt - now) / 86_400_000)) : null;
  const date = v.expiresAt ? new Date(v.expiresAt).toLocaleDateString("ar-SA-u-ca-gregory-nu-latn", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Riyadh" }) : null;
  return text
    .replaceAll("{الاسم}", v.name)
    .replaceAll("{الباقة}", v.plan ?? "—")
    .replaceAll("{الأيام_المتبقية}", days === null ? "—" : String(days))
    .replaceAll("{تاريخ_الانتهاء}", date ?? "—");
}
