# النسخ الاحتياطي والاستعادة

## 1) إعدادات التطبيق (من داخل التطبيق)
الإعدادات › «تنزيل نسخة احتياطية» → ملف JSON يحتوي الإعدادات والحملات والقوالب فقط.
**لا يحتوي:** توكنات، كلمات مرور، جلسات، بيانات المتفاعلين.
الاستعادة: «استعادة من ملف» → تُنشأ الحملات كمسودات لتراجعها ثم تفعّلها.

## 2) قاعدة البيانات كاملة
```bash
npx wrangler d1 export hsn_autoreply --remote --output hsn-$(date +%F).sql
# الاستعادة إلى قاعدة جديدة:
npx wrangler d1 create hsn_autoreply_restore
npx wrangler d1 execute hsn_autoreply_restore --remote --file hsn-YYYY-MM-DD.sql
```
أو Time Travel خلال النافذة المتاحة في خطتك 🔎: `npx wrangler d1 time-travel restore hsn_autoreply --timestamp=2026-09-25T10:00:00Z`.
⚠️ ملف التصدير يحتوي التوكن **مشفّرًا** وبيانات شخصية — احفظه مشفّرًا.

## 3) الأسرار (لا تُصدَّر من Cloudflare بعد وضعها)
احفظ نسخة في مدير كلمات مرور من:
`TOKEN_ENC_KEY`, `PASSWORD_PEPPER`, `META_WEBHOOK_VERIFY_TOKEN`, `INSTAGRAM_APP_SECRET`.
فقدان `TOKEN_ENC_KEY` يعني إعادة ربط إنستقرام فقط. فقدان `PASSWORD_PEPPER` يعني إعادة تعيين حساب الإدارة (احذف صف `admin_users` بـ `wrangler d1 execute` ثم أعد الإعداد الأولي بـ `SETUP_TOKEN` جديد).

## 4) مفتاح توقيع Android (الأهم)
المجلد `~/hsn-autoreply-signing/` (keystore + كلمة المرور + البصمة):
- نسخة على USB مشفّر، ونسخة في مدير كلمات مرور (الملف كمرفق).
- لا تضعه في المستودع أو البريد أو المحادثات.
- للتحقق أن نسختك صحيحة: قارن `certificate-sha256.txt` مع البصمة المنشورة في ملاحظات كل GitHub Release.
- إن فُقد: لا يمكن تحديث التطبيق المثبت؛ الحل الوحيد مفتاح جديد + إلغاء تثبيت النسخة القديمة يدويًا.

## 5) الكود
المستودع على GitHub هو النسخة المرجعية. للاستعادة: `git clone` ثم اتبع DEPLOY.md.
