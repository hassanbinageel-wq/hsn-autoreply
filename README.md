# HSN AutoReply

أتمتة حساب إنستقرام الاحترافي (تعليقات، ردود الستوري، منشن الستوري) عبر **واجهة Meta الرسمية فقط** — بدون ManyChat، وبدون خدمات ذكاء اصطناعي مدفوعة. الردود مبنية على كلمات وقواعد وقوالب، وتعمل على الخادم حتى لو أغلقت التطبيق والجوال.

- **تطبيق Android (APK موقّع)** عبر Capacitor.
- **نسخة ويب قابلة للتثبيت (PWA)**.
- كلاهما يتصل بنفس الخادم وقاعدة البيانات: **Cloudflare Workers + Hono + D1**.

> ⚠️ المشروع لا يُعدّ «متصلًا بإنستقرام» حتى تُكمل إعداد تطبيق Meta وتربط حسابك فعليًا — انظر [docs/EXTERNAL_STEPS.md](docs/EXTERNAL_STEPS.md).

## المزايا

| الميزة | التفاصيل |
|---|---|
| حملات التعليقات | كلمة/عبارة/مطابقة كاملة/يحتوي، كلمات متعددة واستثناءات، جميع التعليقات كخيار صريح، نطاق منشورات محددة، رد خاص واحد (Private Reply) + رد عام اختياري |
| ردود الستوري | تمييز الرد على الستوري (`reply_to.story`) عن الرسائل العادية |
| منشن الستوري | عبر إشعار المراسلة الرسمي (`story_mention`)، مع منع التكرار وحد لكل مستخدم |
| **اشتراط المتابعة** | تحقق حقيقي عبر User Profile API (`is_user_follow_business`) — لا يُسلَّم المحتوى قبل `true`، و«غير معروف»/الخطأ ≠ «غير متابع» |
| آلة حالات | `trigger_received → awaiting_user_interaction → checking_follow → awaiting_follow → ready_to_deliver → delivering → content_sent` (+ expired/failed/cancelled/verification_unavailable) |
| طابور دائم | D1 + Cron كل دقيقة، lease ذري، backoff+jitter، Retry-After، حالة `uncertain` بدل الإعادة العمياء |
| الأمان | Webhook HMAC-SHA256، توكنات مشفّرة AES-GCM، PBKDF2+pepper، كوكي HttpOnly/Secure/SameSite + CSRF، Bearer للتطبيق، CORS مقيّد |
| وضع التجربة | محاكاة كاملة عبر نفس المحرك دون أي إرسال حقيقي |
| الواجهة | عربية RTL، فاتح/داكن، للجوال أولًا |

## البنية

```
src/
  shared/        منطق مشترك: التطبيع والمطابقة، الحالات، القوالب، Zod، CSV
  worker/        الخادم (Hono): API، Webhooks، OAuth، المحرك (engine/)، عميل Meta (meta/)
  web/           الواجهة (React + Tailwind) للويب وAndroid
migrations/      مخطط D1
android/         مشروع Capacitor Android
test/            اختبارات داخل Workers runtime + D1 (بدون شبكة)
.github/workflows  CI، إصدار APK موقّع، نشر Cloudflare
docs/            الأدلة
```

## التشغيل محليًا

```bash
npm ci
cp .dev.vars.example .dev.vars        # قيم تطوير فقط
npm run db:migrate:local
npm run build:web && npx wrangler dev # http://localhost:8787
npm test                              # 75 اختبارًا
```

## الأدلة

| الدليل | المحتوى |
|---|---|
| [docs/DEPLOY.md](docs/DEPLOY.md) | النشر على Cloudflare، الأسرار، الترحيلات، الرجوع عند الفشل |
| [docs/META_SETUP.md](docs/META_SETUP.md) | إعداد تطبيق Meta، الصلاحيات، OAuth، Webhooks، المراجعة |
| [docs/FOLLOW_GATE.md](docs/FOLLOW_GATE.md) | كيف يعمل التحقق من المتابعة وقيوده |
| [docs/CAMPAIGNS.md](docs/CAMPAIGNS.md) | إنشاء حملة تعليقات وستوري ومنشن |
| [docs/RELEASE.md](docs/RELEASE.md) | إنتاج APK موقّع، التحديث، مفتاح التوقيع |
| [docs/BACKUP.md](docs/BACKUP.md) | النسخ الاحتياطي والاستعادة |
| [docs/FREE_TIER.md](docs/FREE_TIER.md) | حدود الخطط المجانية وروابطها |
| [docs/TEST_REPORT.md](docs/TEST_REPORT.md) | تقرير البناء والاختبارات |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | المخطط والحالات ومنع التكرار |
| [docs/EXTERNAL_STEPS.md](docs/EXTERNAL_STEPS.md) | **الخطوات الخارجية المتبقية** |
