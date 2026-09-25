# دليل إعداد Meta (Instagram API with Instagram Login)

> **تاريخ المراجعة: 2026-09-25.** إصدار Graph API المعتمد افتراضيًا: **v26.0** (صدر 2026-07-29). الإصدار قابل للتغيير من `META_API_VERSION` في `wrangler.jsonc` دون تعديل الكود.
>
> **ملاحظة شفافية:** بيئة البناء التي أُنجز فيها المشروع كانت تمنع الوصول المباشر إلى `developers.facebook.com`، فتمت المراجعة عبر نتائج البحث ومصادر ثانوية ومعرفة سابقة بالوثائق. **راجع كل بند مُعلَّم بـ 🔎 في الوثائق الرسمية قبل الإطلاق**، ولوحة تطبيقك في Meta هي المرجع النهائي.

## 1) الحساب المطلوب

- حساب إنستقرام **احترافي** (Business أو Creator). الحساب الشخصي غير مدعوم.
- مسار الربط المستخدم: **Instagram Login** (المضيف `graph.instagram.com`) — لا يحتاج صفحة فيسبوك. لا نخلطه مع Facebook Login (`graph.facebook.com`).

## 2) إنشاء التطبيق

1. [developers.facebook.com/apps](https://developers.facebook.com/apps) › Create App › نوع **Business**.
2. أضف منتج **Instagram** › «API setup with Instagram login».
3. احفظ **Instagram App ID** و **Instagram App Secret** (يختلفان عن App ID الرئيسي للتطبيق).
4. في «Business login settings»:
   - **OAuth redirect URI:** `https://<worker>.workers.dev/oauth/instagram/callback`
   - **Deauthorize callback URL:** `https://<worker>.workers.dev/meta/deauthorize`
   - **Data deletion request URL:** `https://<worker>.workers.dev/meta/data-deletion`
5. في App settings › Basic:
   - **Privacy Policy URL:** `https://<worker>.workers.dev/privacy`
   - **Terms of Service URL:** `https://<worker>.workers.dev/terms`
   - **User data deletion:** `https://<worker>.workers.dev/data-deletion`

🔎 نطاق `*.workers.dev` مجاني وHTTPS. معظم التطبيقات تقبله، لكن إن رفضت Meta النطاق أثناء المراجعة فالبديل: نطاق خاص مربوط بـ Cloudflare (قد يكون له تكلفة تسجيل سنوية؛ Cloudflare لا يفرض رسومًا إضافية لربطه بـ Worker).

## 3) الصلاحيات (Scopes)

| الصلاحية | لماذا |
|---|---|
| `instagram_business_basic` | الملف الأساسي، المنشورات، الستوري |
| `instagram_business_manage_comments` | Webhook التعليقات والرد العام عليها |
| `instagram_business_manage_messages` | Private Replies، الرسائل، Webhook الرسائل، **User Profile API** (التحقق من المتابعة) |

🔎 الأسماء القديمة (`business_basic` … ) أُوقفت في 2025؛ الكود يستخدم الأسماء الجديدة.

## 4) OAuth (ما ينفّذه الكود)

1. الخادم يولّد `state` عشوائيًا (32 بايت)، يخزّن **هاشه** فقط، صالح 10 دقائق ولمرة واحدة.
2. يُفتح `https://www.instagram.com/oauth/authorize?...&scope=...&state=...` في **متصفح النظام** (Custom Tabs على Android) — لا WebView ولا طلب كلمة مرور داخل التطبيق.
3. Callback: `POST https://api.instagram.com/oauth/access_token` → توكن قصير.
4. `GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token` → توكن طويل (≈60 يومًا).
5. `GET /me?fields=user_id,username,name,profile_picture_url,account_type`.
6. التوكن يُشفَّر AES-256-GCM بمفتاح `TOKEN_ENC_KEY` ويُربط (AAD) بمعرّف الحساب.
7. اشتراك Webhooks: `POST /me/subscribed_apps?subscribed_fields=comments,messages,messaging_postbacks,message_reactions`.
8. تجديد يومي عبر Cron: `GET /refresh_access_token?grant_type=ig_refresh_token` للتوكنات التي تنتهي خلال 15 يومًا (يجب أن يكون عمر التوكن ≥ 24 ساعة).

- **PKCE:** 🔎 لم نجد دعمًا موثّقًا لـ PKCE في Instagram Login، لذلك لا نفترضه. الحماية عبر `state` لمرة واحدة + تبادل الكود على الخادم فقط بالسر.
- العودة للتطبيق: صفحة النتيجة تحتوي رابط `com.hsn.autoreply://oauth-done?status=ok|error` **بدون أي أسرار**؛ التطبيق يعيد قراءة الحالة من الخادم ولا يثق ببيانات الرابط.

## 5) Webhooks

في لوحة Meta › Instagram › Webhooks:

- **Callback URL:** `https://<worker>.workers.dev/webhooks/instagram`
- **Verify token:** نفس قيمة السر `META_WEBHOOK_VERIFY_TOKEN`.
- اشترك في الحقول: `comments`, `messages`, `messaging_postbacks` (و `message_reactions` اختياري — يُسجَّل ولا يُعد مشغلًا).

الخادم:
- `GET` يعيد `hub.challenge` فقط عند تطابق verify token.
- `POST` يتحقق من `X-Hub-Signature-256` (HMAC-SHA256 على **الجسم الخام** بـ Instagram App Secret) ويرفض التوقيع الخاطئ بـ 401.
- يحفظ الأحداث والمهام في معاملة D1 واحدة **قبل** الرد 200؛ عند فشل الحفظ يرد 500 فتعيد Meta الإرسال.
- الأحداث المكررة تُتجاهل بقيود UNIQUE (`comment:<id>`، `msg:<mid>`…).

🔎 **مهم:** Meta ترسل Webhooks فقط عندما يكون التطبيق في وضع **Live**. وبحسب مستوى الوصول:
- **Standard Access:** يعمل مع الحسابات التي لها دور في التطبيق (أنت كمالك/Tester). تحقق في لوحتك إن كانت أحداث التعليقات/الرسائل من **مستخدمين آخرين** على حسابك تصل في Standard Access؛ في كثير من الحالات يلزم **Advanced Access**.
- **Advanced Access:** يتطلب **App Review** لكل صلاحية + **Business Verification**. جهّز فيديو screencast يوضح: الربط، إنشاء حملة، رد خاص على تعليق، التحقق من المتابعة، صفحة الخصوصية وحذف البيانات.

## 6) قواعد المراسلة المطبّقة في الكود

| القاعدة | التطبيق |
|---|---|
| Private Reply | رد خاص **واحد** لكل تعليق، خلال **7 أيام** من التعليق (مفتاح فريد `private_reply` لكل تعليق + فحص العمر قبل الإرسال) |
| الرد الخاص لا يفتح نافذة محادثة | لذلك لا نرسل رسالة ثانية قبل أن يرد الشخص («ابدأ») |
| نافذة المراسلة | 24 ساعة من آخر رسالة **من المستخدم**؛ خارجها يُوقف الإرسال ويُسجّل `messaging_window_closed` |
| Quick Replies | تُستخدم في رسائل الـ DM داخل النافذة فقط؛ الرد الخاص نص فقط، مع بديل نصي دائمًا («اكتب: تحقق») |
| المتابعة ليست إذن مراسلة | لا يوجد أي إرسال مبني على المتابعة وحدها |
| Story mention | 🔎 يصل كرسالة بمرفق `story_mention` عبر حقل `messages`. منشن من **حساب خاص** قد لا يصل أو لا يتضمن محتوى القصة. المنشن في منشور/تعليق عام أو Tag على صورة **لا** يفتح محادثة ولا يعامَل كحدث مراسلة |
| Story reply | رسالة تحتوي `reply_to.story.id`؛ مشاهدة الستوري أو الإعجاب بها ليست أحداثًا قابلة للمراسلة |
| الرسائل الجماعية | غير موجودة في النظام إطلاقًا |

## 7) User Profile API والتحقق من المتابعة

انظر [FOLLOW_GATE.md](FOLLOW_GATE.md).

## 8) الأخطاء المعروفة ومعالجتها (تصنيف تقريبي)

| الكود | المعالجة |
|---|---|
| 4, 17, 32, 613, 429 | `rate_limited` → إعادة مع backoff واحترام `Retry-After` / `X-Business-Use-Case-Usage` |
| 190 | `auth` → الحساب `needs_reauth`، إلغاء المهام، إيقاف آمن |
| 10 / subcode 2534022 | `window_closed` → انتهاء المسار |
| 230 | `no_consent` → «يلزم تفاعل المستخدم أولًا» |
| 10, 200-299 أخرى | `permission` → «الميزة غير متاحة لهذا الربط» |
| 1, 2, 5xx | `retryable` |
| انقطاع بعد الإرسال | `uncertain` → لا إعادة تلقائية؛ مراجعة يدوية من السجل |
| غير ذلك | `permanent` |

🔎 أكواد Meta تتغير؛ راقب «سجل العمليات» بعد الإطلاق وعدّل `classifyError` في `src/worker/meta/client.ts` إن لزم.
