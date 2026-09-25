# إصدار APK موقّع وتحديث التطبيق

## مرة واحدة: مفتاح التوقيع

**من المتصفح (بدون كمبيوتر):** workflow «Create signing key (one-time)» — الخطوات في [EXTERNAL_STEPS.md](EXTERNAL_STEPS.md#المرحلة-2--مفتاح-توقيع-android--apk).

**أو من جهازك:**

على جهازك (يحتاج JDK 17+ و openssl، و `gh` اختياريًا):

```bash
bash scripts/create-signing-key.sh hassanbinageel-wq/hsn-autoreply
```

- يُنشئ `~/hsn-autoreply-signing/hsn-autoreply-release.jks` (خارج المستودع) وكلمة مرور عشوائية.
- إن كان `gh` مسجلًا يضع الأسرار مباشرة في GitHub: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` — دون طباعتها.
- **انسخ المجلد احتياطيًا في مكانين آمنين** (USB مشفّر + مدير كلمات مرور). فقدان المفتاح = لا يمكن تحديث التطبيق المثبت. لا تغيّر المفتاح بين الإصدارات.
- لا يُرفع keystore أو كلمة مروره للمستودع (`.gitignore` يمنع `*.jks`, `*.keystore`).

وأضف متغير المستودع `VITE_API_BASE` = رابط الـ Worker (https).

## كل إصدار

1. حدّث `version` في `package.json` واكتب ملاحظات التغيير في `docs/changelog/vX.Y.Z.md` (اختياري).
2. أنشئ وسمًا وادفعه:
   ```bash
   git tag v1.0.0 && git push origin v1.0.0
   ```
   أو من GitHub › Actions › **Android release** › Run workflow (أدخل الإصدار).
3. الـ workflow: اختبارات → بناء الواجهة → `cap sync` → `assembleRelease` موقّع → `apksigner verify` → SHA-256 → GitHub Release يحوي الـ APK وملف `.sha256` وبصمة الشهادة.

`versionCode` يُحسب تلقائيًا: `MAJOR×1,000,000 + MINOR×1,000 + PATCH` فيزيد مع كل إصدار.

## ملاحظات
- **debug APK ليس إصدارًا نهائيًا.** خيار `build_type=debug` في التشغيل اليدوي ينتج ملفًا باسم `…-DEBUG-not-for-release.apk` كـ artifact مؤقت فقط (7 أيام) ولا يُنشر كـ Release.
- المستودع **خاص**: تنزيل ملف الإصدار يتطلب حساب GitHub مخوّلًا. لا نضع Token في أي رابط.
- إن أردت تنزيلًا دون حساب GitHub: ارفع الـ APK يدويًا لمكان عام تتحكم به (مثل Cloudflare R2 بحدوده المجانية أو صفحة Release في مستودع عام منفصل يحتوي الـ APK فقط) وضع رابطه في `APK_DOWNLOAD_URL`. **التبعات:** أي شخص يملك الرابط يستطيع تنزيل التطبيق وتفكيكه — وهذا آمن نسبيًا لأن الـ APK لا يحتوي أي أسرار (فقط عنوان الخادم العام)، لكن لوحة الإدارة تبقى محمية بكلمة المرور.
- **iOS:** غير مشمول في التوزيع المجاني؛ استخدم PWA.

## التثبيت
1. نزّل `hsn-autoreply-vX.Y.Z.apk` وقارن SHA-256: `sha256sum hsn-autoreply-vX.Y.Z.apk`.
2. اسمح بالتثبيت من المصدر عند الطلب.
3. التحديثات تُثبت فوق القديمة لأن المفتاح ثابت.
