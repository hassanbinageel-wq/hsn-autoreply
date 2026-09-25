# الخطوات الخارجية المتبقية (بالترتيب)

هذه خطوات تحتاج حساباتك أو موافقتك ولا يمكن تنفيذها من بيئة التطوير. **لا ترسل كلمات مرور أو أسرار في أي محادثة** — كل سر يُدخل مباشرة في لوحة الخدمة أو عبر أمر تفاعلي.

## أ) GitHub
1. [ ] المستودع الخاص `hsn-autoreply` (إن لم يكن موجودًا بعد).
2. [ ] Settings › Actions › General: أبقِ «Fork pull request workflows» على الافتراضي (بدون أسرار)، وحد الإنفاق (Spending limit) = 0.
3. [ ] Settings › Environments: أنشئ `release` و`production`، ويفضل تفعيل «Required reviewers» = أنت.
4. [ ] Variables: `VITE_API_BASE`, `PUBLIC_BASE_URL`, `D1_DATABASE_ID`, `INSTAGRAM_APP_ID`.
5. [ ] Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`، وأسرار التوقيع عبر `scripts/create-signing-key.sh`.

## ب) Cloudflare ([DEPLOY.md](DEPLOY.md))
6. [ ] `wrangler login` ← `wrangler d1 create hsn_autoreply`.
7. [ ] `wrangler secret put` للأسرار الخمسة (APP_SECRET، VERIFY_TOKEN، TOKEN_ENC_KEY، PASSWORD_PEPPER، SETUP_TOKEN).
8. [ ] النشر (محليًا أو عبر Actions › Deploy) ← افتح الرابط ← الإعداد الأولي ← احذف `SETUP_TOKEN`.

## ج) Meta ([META_SETUP.md](META_SETUP.md))
9. [ ] إنشاء تطبيق Business + منتج Instagram (Instagram Login).
10. [ ] Redirect URI، Deauthorize، Data deletion، Privacy، Terms.
11. [ ] Webhooks: Callback URL + Verify token + الحقول `comments`, `messages`, `messaging_postbacks`.
12. [ ] أضف حسابك كـ Instagram Tester (أو مالك)، ثم «ربط عبر Instagram» من صفحة «الربط».
13. [ ] تحويل التطبيق إلى **Live** وتشغيل «تشخيص الربط».
14. [ ] اختبار حي **على حساب ومنشور تختارهما صراحة**: تعليق بكلمة الحملة من حساب آخر → تحقق من السجل.
15. [ ] إن لم تصل أحداث المستخدمين الآخرين: App Review للصلاحيات الثلاث + Business Verification (Advanced Access).
16. [ ] بعد أول تحقق متابعة ناجح ستظهر «التحقق من المتابعة: مدعوم» في صفحة الربط. إن ظهر «غير متاح» فالسبب مسجّل هناك.

## د) Android
17. [ ] `bash scripts/create-signing-key.sh hassanbinageel-wq/hsn-autoreply` على جهازك + نسخ احتياطية للمفتاح.
18. [ ] وسم `v1.0.0` ← Actions › Android release ← GitHub Release فيه APK + SHA-256.
19. [ ] تثبيت الـ APK على جوالك والتحقق من: الدخول، فتح Meta في المتصفح والعودة، زر الرجوع، انقطاع الإنترنت.
