# خطوات التشغيل — كلها من المتصفح (بدون كمبيوتر)

⏱️ الوقت المتوقع: 45–60 دقيقة (بدون وقت مراجعة Meta).
🔐 قاعدة: لا ترسل أي كلمة مرور أو سر في أي محادثة. كل سر يُلصق مباشرة في خانة «Secret» في GitHub.

مكان إضافة الأسرار والمتغيرات في GitHub:
`github.com/hassanbinageel-wq/hsn-autoreply` › **Settings › Secrets and variables › Actions** — تبويب **Secrets** للأسرار، وتبويب **Variables** للمتغيرات.

---

## المرحلة 1 — Cloudflare (الخادم)

1. سجّل في [dash.cloudflare.com](https://dash.cloudflare.com/sign-up) (مجاني، **لا تضف بطاقة دفع**).
2. **Workers & Pages** › افتح أي صفحة Workers مرة واحدة لتفعيل النطاق المجاني؛ ستجد اسمك الفرعي مثل `hassan.workers.dev`.
   رابط خادمك سيكون: `https://hsn-autoreply.<اسمك-الفرعي>.workers.dev`
3. **Storage & Databases › D1 › Create** › الاسم: `hsn_autoreply` › انسخ **Database ID**.
4. انسخ **Account ID** (من صفحة Workers & Pages على اليمين).
5. **My Profile › API Tokens › Create Token** › قالب **«Edit Cloudflare Workers»** › أضف صلاحية **Account › D1 › Edit** › أنشئه وانسخه.

في GitHub:

| النوع | الاسم | القيمة |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | التوكن من الخطوة 5 |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | من الخطوة 4 |
| Secret | `SETUP_TOKEN` | اخترع عبارة طويلة (20+ حرفًا) واحفظها — تستخدمها مرة واحدة |
| Variable | `D1_DATABASE_ID` | من الخطوة 3 |
| Variable | `PUBLIC_BASE_URL` | `https://hsn-autoreply.<اسمك>.workers.dev` |
| Variable | `VITE_API_BASE` | نفس الرابط |
| Variable | `INSTAGRAM_APP_ID` | اكتب `0` مؤقتًا (تغيّره في المرحلة 3) |

6. **Actions › Deploy (Cloudflare) › Run workflow**. انتظر العلامة الخضراء ✅.
7. افتح رابط الخادم ← نموذج «الإعداد الأولي» ← أدخل `SETUP_TOKEN` + اسم مستخدم + كلمة مرور قوية (12+).
8. احذف السر `SETUP_TOKEN` من GitHub (سيُحذف من الخادم في النشر القادم).

✅ الآن لديك: **رابط PWA** يعمل (افتحه في Chrome › «تثبيت التطبيق») + وضع المحاكاة.

---

## المرحلة 2 — مفتاح توقيع Android + APK

1. أنشئ توكن GitHub مخصص: [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)
   - Repository access: **Only select repositories › hsn-autoreply**
   - Permissions › Repository › **Secrets: Read and write** (فقط)
   - مدة: 7 أيام.
2. أضف Secrets:
   - `GH_SECRETS_TOKEN` = التوكن السابق
   - `BACKUP_PASSPHRASE` = عبارة سر تخترعها (12+ حرفًا) **واحفظها في مكان آمن** — تفتح بها النسخة الاحتياطية.
3. **Actions › Create signing key (one-time) › Run workflow** › اكتب `CREATE`.
4. بعد ✅ افتح نفس التشغيل › **Artifacts** › نزّل `hsn-signing-backup-ENCRYPTED` **فورًا** (يُحذف بعد يوم) واحفظه في مكانين (Google Drive + بريدك مثلًا — هو مشفّر). يُفتح بتطبيق مثل ZArchiver بعبارة `BACKUP_PASSPHRASE`.
5. احذف السر `GH_SECRETS_TOKEN` (لم يعد لازمًا).
6. **Actions › Android release › Run workflow** › version: `1.0.0` › build_type: `release`.
7. بعد ✅: **Releases** › `v1.0.0` › نزّل `hsn-autoreply-v1.0.0.apk` على جوالك وثبّته (المستودع خاص؛ تحتاج أن تكون مسجلًا في GitHub).

⚠️ لا تشغّل «Create signing key» مرة ثانية ولا تفقد النسخة الاحتياطية: المفتاح نفسه يلزم لكل تحديث قادم.

---

## المرحلة 3 — Meta (الربط الحقيقي بإنستقرام)

المتطلب: حسابك في إنستقرام **احترافي** (Business أو Creator).

1. [developers.facebook.com/apps](https://developers.facebook.com/apps) › Create App › **Business**.
2. أضف منتج **Instagram** › **API setup with Instagram login**.
3. انسخ **Instagram App ID** و **Instagram App Secret**.
4. في GitHub: عدّل المتغير `INSTAGRAM_APP_ID`، وأضف Secrets:
   - `INSTAGRAM_APP_SECRET` = السر من Meta
   - `META_WEBHOOK_VERIFY_TOKEN` = عبارة تخترعها (تلصقها في Meta بالخطوة 6)
5. شغّل **Deploy (Cloudflare)** مرة أخرى.
6. في Meta:
   - **Business login settings › OAuth redirect URI:** `https://<رابطك>/oauth/instagram/callback`
   - **Deauthorize callback:** `https://<رابطك>/meta/deauthorize`
   - **Data deletion request URL:** `https://<رابطك>/meta/data-deletion`
   - **Webhooks:** Callback `https://<رابطك>/webhooks/instagram` + Verify token (نفس العبارة) › اشترك في `comments`, `messages`, `messaging_postbacks`
   - **App settings › Basic:** Privacy Policy `https://<رابطك>/privacy` ، Terms `https://<رابطك>/terms`
   - **Roles › Instagram Testers:** أضف حسابك واقبل الدعوة من إنستقرام (الإعدادات › التطبيقات والمواقع).
   - حوّل التطبيق إلى **Live**.
7. في تطبيقك: **الربط › ربط عبر Instagram** ← وافق ← **تشخيص الربط** (كل البنود ✅).

---

## المرحلة 4 — التجربة الحية ثم الإطلاق
1. أنشئ حملة كمسودة وجرّبها في **المحاكاة**.
2. فعّلها على **منشور واحد تختاره للتجربة**، وعلّق عليه **من حساب آخر**.
3. راقب **سجل العمليات**:
   - إن ظهر الحدث وأُرسل الرد ✅ جاهز.
   - إن لم يصل أي حدث من الحساب الآخر ← تحتاج **App Review** للصلاحيات الثلاث + **Business Verification** (Advanced Access) — انظر [META_SETUP.md](META_SETUP.md). هذه خطوة مراجعة من Meta تأخذ أيامًا.
4. بعد أول تحقق متابعة ستظهر «التحقق من المتابعة: مدعوم» في صفحة الربط.

## بديل الكمبيوتر
إن توفر لديك كمبيوتر، الطرق اليدوية موجودة في [DEPLOY.md](DEPLOY.md) و [RELEASE.md](RELEASE.md).
